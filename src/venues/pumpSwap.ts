// PumpSwap AMM (post-migration), via the pinned SDK's `@pump-fun/pump-sdk/swap`
// subpath (the standalone pump-swap-sdk was folded into it).
//
// SOL pools: buys use the SDK's quote-input builder (v1 `buy`: exact tokens
// out, cost capped at the quote + slippage); sells use base-input (`sell`, min
// SOL out). The SDK wraps SOL into our WSOL ATA and closes it again in the
// same tx.
//
// Pools quoted in another token (a coin paired with a pump coin, say) trade
// through a Jupiter route built here: SOL <-> quote token on that token's own
// SOL pool, then quote token <-> coin on this pool (the reverse for sells).
// A quote token with a Token-2022 transfer fee (the PreStocks, say) is priced
// by the SDK, which models what the program grosses up and what lands.
import {
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
  type AddressLookupTableAccount,
  type Connection,
  type PublicKey,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda } from '@pump-fun/pump-sdk';
import { PUMP_AMM_PROGRAM_ID, PUMP_AMM_SDK, canonicalPumpPoolPda } from '@pump-fun/pump-sdk/swap';
import type { MintInfo } from '../solana/tokens';
import { JUPITER_PROGRAM_ID, routeMinOut, routeV2Instruction, slippageBps } from './jupiter';
import { PumpPool } from './pumpPool';
import { hopAtas, nonSolQuoteNamed, routeCuFloor, openRoute, transferFeeOf, type Route, type SolLeg } from './routes';
import { VenueError, impactPct, type Market, type Quote, type VenueAdapter } from './types';

class PoolMarket implements Market {
  readonly venue: 'PUMPSWAP' | 'PUMPSWAP_ROUTED';

  constructor(
    readonly mint: MintInfo,
    readonly address: PublicKey,
    private readonly pool: PumpPool,
    private readonly route: Route | null = null,
  ) {
    this.venue = route ? 'PUMPSWAP_ROUTED' : 'PUMPSWAP';
  }

  /** The quote token's symbol when trades route through it. */
  get routedVia(): string | null {
    return this.route?.symbol ?? null;
  }

  /** The SOL <-> quote-token leg of a routed pool. */
  get leg(): SolLeg | null {
    return this.route?.leg ?? null;
  }

  watchAccounts(): PublicKey[] {
    return [...this.pool.watchAccounts(), ...(this.route?.leg.watchAccounts() ?? [])];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    if (!this.pool.apply(pubkey, info)) this.route?.leg.apply(pubkey, info);
  }

  lookupTables(): AddressLookupTableAccount[] {
    return this.route?.lookupTables ?? [];
  }

  setLean(on: boolean): void {
    this.route?.leg.setLean?.(on);
  }

  whenTablesReady(): Promise<void> {
    return this.route?.tablesReady ?? Promise.resolve();
  }

  tradable(): boolean {
    return this.pool.tradable();
  }

  /** Raw lamports per raw coin. */
  private spotPerRaw(): number {
    return this.pool.spotQuotePerBase() * (this.route ? this.route.leg.lamportsPerToken() : 1);
  }

  spotLamportsPerToken(): number {
    return this.spotPerRaw() * 10 ** this.mint.decimals;
  }

  quoteBuy(lamportsIn: BN, slippagePct: number): Quote {
    if (this.route) {
      const quoteIn = new BN(this.route.leg.quote(BigInt(lamportsIn.toString()), true).toString());
      if (quoteIn.isZero()) throw new VenueError('Buy amount too small for this pool', 'EMPTY');
      const out = this.pool.buy(quoteIn, slippagePct, true).base;
      if (out.isZero()) throw new VenueError('Buy amount too small for this pool', 'EMPTY');
      const minOut = BN.max(routeMinOut(out, slippageBps(slippagePct)), new BN(1));
      return { side: 'buy', inAmount: lamportsIn, out, minOut, maxIn: lamportsIn, priceImpactPct: impactPct('buy', lamportsIn, out, this.spotPerRaw()) };
    }
    const r = this.pool.buy(lamportsIn, slippagePct);
    return { side: 'buy', inAmount: lamportsIn, out: r.base, minOut: r.base, maxIn: r.maxQuote, priceImpactPct: impactPct('buy', lamportsIn, r.base, this.spotPerRaw()) };
  }

  quoteSell(tokensIn: BN, slippagePct: number): Quote {
    const r = this.pool.sell(tokensIn, slippagePct);
    if (this.route) {
      if (r.quote.isZero()) throw new VenueError('Sell amount too small for this pool', 'EMPTY');
      const out = new BN(this.route.leg.quote(BigInt(r.quote.toString()), false).toString());
      const minOut = routeMinOut(out, slippageBps(slippagePct));
      return { side: 'sell', inAmount: tokensIn, out, minOut, maxIn: tokensIn, priceImpactPct: impactPct('sell', out, tokensIn, this.spotPerRaw()) };
    }
    return { side: 'sell', inAmount: tokensIn, out: r.quote, minOut: r.minQuote, maxIn: tokensIn, priceImpactPct: impactPct('sell', r.quote, tokensIn, this.spotPerRaw()) };
  }

  private wsolAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  }

  /** Accounts the routed path passes through: the quote token's and any hop's, created once and kept. */
  private routeAtas(user: PublicKey): TransactionInstruction[] {
    const quoteMint = this.pool.pool.quoteMint;
    return [
      ...hopAtas(user, this.route!.leg),
      createAssociatedTokenAccountIdempotentInstruction(user, this.pool.userQuote(user), user, quoteMint, this.pool.quoteTokenProgram),
    ];
  }

  // The SDK builders re-derive amounts from the same cached state, so they match the quote.
  async buildBuy(user: PublicKey, userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number) {
    this.pool.assertTradable();
    if (!this.route) return PUMP_AMM_SDK.buyQuoteInput(this.pool.swapState(user, userAta), q.inAmount, slippagePct);
    const wsol = this.wsolAta(user);
    const ixs: TransactionInstruction[] = [];
    if (!userAta) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, this.pool.userBase(user), user, this.mint.mint, this.mint.tokenProgram));
    ixs.push(
      ...this.routeAtas(user),
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports: BigInt(q.inAmount.toString()) }),
      createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID),
      routeV2Instruction({
        user,
        source: wsol,
        destination: this.pool.userBase(user),
        sourceMint: NATIVE_MINT,
        destinationMint: this.mint.mint,
        sourceTokenProgram: TOKEN_PROGRAM_ID,
        destinationTokenProgram: this.mint.tokenProgram,
        inAmount: q.inAmount,
        quotedOut: q.out,
        slippageBps: slippageBps(slippagePct),
        legs: [...this.route.leg.jupiterLegs(user, true), this.pool.jupiterLeg(user, 'buy')],
      }),
      // Unwraps anything not spent, plus the account rent.
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    );
    return ixs;
  }

  async buildSell(user: PublicKey, userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number) {
    this.pool.assertTradable();
    if (!this.route) return PUMP_AMM_SDK.sellBaseInput(this.pool.swapState(user, userAta), q.inAmount, slippagePct);
    const wsol = this.wsolAta(user);
    return [
      ...this.routeAtas(user),
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      routeV2Instruction({
        user,
        source: this.pool.userBase(user),
        destination: wsol,
        sourceMint: this.mint.mint,
        destinationMint: NATIVE_MINT,
        sourceTokenProgram: this.mint.tokenProgram,
        destinationTokenProgram: TOKEN_PROGRAM_ID,
        inAmount: q.inAmount,
        quotedOut: q.out,
        slippageBps: slippageBps(slippagePct),
        legs: [this.pool.jupiterLeg(user, 'sell'), ...this.route.leg.jupiterLegs(user, false)],
      }),
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    ];
  }

  cuFloor(): number {
    return routeCuFloor(this.route);
  }

  selfAccounts(user: PublicKey): PublicKey[] {
    return [this.wsolAta(user)];
  }
}

/**
 * The pool a pump coin graduated into: keyed by the quote mint its bonding
 * curve traded against (SOL, or another coin).
 */
async function graduatedPool(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const curve = await conn.getAccountInfo(bondingCurvePda(mint), 'confirmed');
  if (!curve || !curve.owner.equals(PUMP_PROGRAM_ID) || curve.data.length === 0) return canonicalPumpPoolPda(mint);
  return canonicalPumpPoolPda(mint, PUMP_SDK.decodeBondingCurve(curve).quoteMint);
}

export const pumpSwap: VenueAdapter = {
  id: 'PUMPSWAP',

  async open(conn: Connection, mint: MintInfo, hint) {
    const pool = await PumpPool.load(conn, hint?.account ?? (await graduatedPool(conn, mint.mint)));
    if (!pool || !pool.pool.baseMint.equals(mint.mint)) return null;
    const quoteMint = pool.pool.quoteMint;
    if (quoteMint.equals(NATIVE_MINT)) return new PoolMarket(mint, pool.key, pool);

    // The SDK prices a transfer fee on the quote token, not on the coin.
    const mintInfo = await conn.getAccountInfo(mint.mint, 'confirmed');
    if (!mintInfo) throw new VenueError('Mint not found on chain', 'NOT_FOUND');
    if (await transferFeeOf(conn, mint, mintInfo)) throw new VenueError('This coin charges a transfer fee in a PumpSwap pool (not supported yet)', 'UNSUPPORTED');
    const route = await openRoute(conn, quoteMint, pool.key);
    if (!route || !route.leg.tokenProgram.equals(pool.quoteTokenProgram)) throw await nonSolQuoteNamed(conn, quoteMint);
    pool.setQuoteTransferFee(route.quoteFee);
    return new PoolMarket(mint, pool.key, pool, route);
  },

  ownsAccount: (owner) => owner.equals(PUMP_AMM_PROGRAM_ID),

  async mintOf(_conn, _account, info) {
    const pool = PUMP_AMM_SDK.decodePoolNullable(info);
    return pool ? pool.baseMint : null;
  },

  allowedPrograms: () => [PUMP_AMM_PROGRAM_ID.toBase58(), JUPITER_PROGRAM_ID.toBase58()],
};

export type { PoolMarket };
