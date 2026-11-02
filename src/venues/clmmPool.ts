// Coins whose own market is a concentrated-liquidity pool: Raydium CLMM or
// Orca Whirlpool against SOL or USDC, or a Raydium CLMM pool against some
// other token with its own SOL route (an xStock, say: SOL -> LLY -> coin).
// These are the same legs routed venues use to reach their quote token, here
// with the coin itself at the end, traded through our Jupiter route.
//
// It comes last among the venues: a coin with a curve or a PumpSwap,
// LaunchLab or CPMM pool trades there instead.
import { PublicKey, SystemProgram, type AccountInfo, type AddressLookupTableAccount, type Connection, type TransactionInstruction } from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import type { MintInfo } from '../solana/tokens';
import { JUPITER_PROGRAM_ID, routeMinOut, routeV2Instruction, slippageBps } from './jupiter';
import { CLMM_PROGRAM_ID, ClmmLeg, decodeClmmPool } from './raydiumClmm';
import { WHIRLPOOL_PROGRAM_ID, decodeWhirlpool } from './whirlpool';
import { ChainLeg, ROUTED_QUOTES, USDC_MINT, assertNoQuoteFee, hopAtas, nonSolQuote, openRoute, routeCuFloor, solRoute, type Route } from './routes';
import { VenueError, impactPct, type Market, type Quote, type VenueAdapter } from './types';

const QUOTE_MINTS = new Set([NATIVE_MINT.toBase58(), USDC_MINT.toBase58(), ...Object.keys(ROUTED_QUOTES)]);
/** PoolState's size, and where its two mints sit. */
const CLMM_POOL_LEN = 1544;
const CLMM_MINT_OFFSETS = [73, 105];

/**
 * The coin's deepest-looking Raydium CLMM pool against any other token, for a
 * coin opened from its mint (the page showed no pool). Best effort: RPCs
 * that refuse program scans just find none.
 */
async function clmmPoolOf(conn: Connection, mint: PublicKey): Promise<PublicKey | null> {
  try {
    const found = await Promise.all(
      CLMM_MINT_OFFSETS.map((offset) =>
        conn.getProgramAccounts(CLMM_PROGRAM_ID, {
          commitment: 'confirmed',
          dataSlice: { offset: 237, length: 16 }, // liquidity
          filters: [{ dataSize: CLMM_POOL_LEN }, { memcmp: { offset, bytes: mint.toBase58() } }],
        }),
      ),
    );
    const liquidity = (d: Buffer) => d.readBigUInt64LE(0) + (d.readBigUInt64LE(8) << 64n);
    const pools = found.flat().sort((a, b) => (liquidity(b.account.data) > liquidity(a.account.data) ? 1 : -1));
    return pools[0]?.pubkey ?? null;
  } catch {
    return null;
  }
}

/** The coin's CLMM pool against another quote token, behind that token's own route from SOL. */
async function quotedRoute(conn: Connection, mint: PublicKey, pool: PublicKey): Promise<Route | null> {
  const info = await conn.getAccountInfo(pool, 'confirmed');
  const p = info ? decodeClmmPool(info) : null;
  if (!p || !(p.mint0.equals(mint) || p.mint1.equals(mint))) return null;
  const quote = p.mint0.equals(mint) ? p.mint1 : p.mint0;
  const [quoteRoute, coin] = await Promise.all([openRoute(conn, quote, pool), ClmmLeg.open(conn, mint, quote)]);
  if (!coin) return null;
  if (!quoteRoute) throw nonSolQuote(quote);
  assertNoQuoteFee(quoteRoute);
  return {
    symbol: quoteRoute.symbol,
    leg: new ChainLeg(quoteRoute.leg, coin.leg),
    lookupTables: quoteRoute.lookupTables,
    tablesReady: quoteRoute.tablesReady,
    quoteFee: coin.leg.tokenFee,
  };
}

class ClmmPoolMarket implements Market {
  readonly venue = 'CLMM_ROUTED' as const;
  /** The coin's own pool: the route's last. */
  readonly address: PublicKey;

  constructor(
    readonly mint: MintInfo,
    private readonly route: Route,
  ) {
    this.address = route.leg.pools().at(-1)!;
  }

  watchAccounts(): PublicKey[] {
    return this.route.leg.watchAccounts();
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    this.route.leg.apply(pubkey, info);
  }

  /** Paused pools refuse quotes themselves, with their own reason. */
  tradable(): boolean {
    return true;
  }

  spotLamportsPerToken(): number {
    return this.route.leg.lamportsPerToken() * 10 ** this.mint.decimals;
  }

  quoteBuy(lamportsIn: BN, slippagePct: number): Quote {
    const out = new BN(this.route.leg.quote(BigInt(lamportsIn.toString()), true).toString());
    const minOut = routeMinOut(out, slippageBps(slippagePct));
    return { side: 'buy', inAmount: lamportsIn, out, minOut, maxIn: lamportsIn, priceImpactPct: impactPct('buy', lamportsIn, out, this.route.leg.lamportsPerToken()) };
  }

  quoteSell(tokensIn: BN, slippagePct: number): Quote {
    const out = new BN(this.route.leg.quote(BigInt(tokensIn.toString()), false).toString());
    const minOut = routeMinOut(out, slippageBps(slippagePct));
    return { side: 'sell', inAmount: tokensIn, out, minOut, maxIn: tokensIn, priceImpactPct: impactPct('sell', out, tokensIn, this.route.leg.lamportsPerToken()) };
  }

  private coinAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.mint.mint, user, true, this.mint.tokenProgram);
  }

  private wsolAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  }

  async buildBuy(user: PublicKey, userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number): Promise<TransactionInstruction[]> {
    const wsol = this.wsolAta(user);
    const ixs: TransactionInstruction[] = [];
    if (!userAta) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, this.coinAta(user), user, this.mint.mint, this.mint.tokenProgram));
    ixs.push(
      ...hopAtas(user, this.route.leg),
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports: BigInt(q.inAmount.toString()) }),
      createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID),
      routeV2Instruction({
        user,
        source: wsol,
        destination: this.coinAta(user),
        sourceMint: NATIVE_MINT,
        destinationMint: this.mint.mint,
        sourceTokenProgram: TOKEN_PROGRAM_ID,
        destinationTokenProgram: this.mint.tokenProgram,
        inAmount: q.inAmount,
        quotedOut: q.out,
        slippageBps: slippageBps(slippagePct),
        legs: this.route.leg.jupiterLegs(user, true),
      }),
      // Unwraps anything not spent, plus the account rent.
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    );
    return ixs;
  }

  async buildSell(user: PublicKey, _userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number): Promise<TransactionInstruction[]> {
    const wsol = this.wsolAta(user);
    return [
      ...hopAtas(user, this.route.leg),
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      routeV2Instruction({
        user,
        source: this.coinAta(user),
        destination: wsol,
        sourceMint: this.mint.mint,
        destinationMint: NATIVE_MINT,
        sourceTokenProgram: this.mint.tokenProgram,
        destinationTokenProgram: TOKEN_PROGRAM_ID,
        inAmount: q.inAmount,
        quotedOut: q.out,
        slippageBps: slippageBps(slippagePct),
        legs: this.route.leg.jupiterLegs(user, false),
      }),
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    ];
  }

  selfAccounts(user: PublicKey): PublicKey[] {
    return [this.wsolAta(user)];
  }

  lookupTables(): AddressLookupTableAccount[] {
    return this.route.lookupTables;
  }

  whenTablesReady(): Promise<void> {
    return this.route.tablesReady;
  }

  setLean(on: boolean): void {
    this.route.leg.setLean?.(on);
  }

  /** A transfer fee leaves withheld tokens behind, which keep the account open. */
  canCloseTokenAccount(): boolean {
    return !this.route.quoteFee;
  }

  cuFloor(): number {
    return routeCuFloor(this.route);
  }
}

export const clmmPool: VenueAdapter = {
  id: 'CLMM_ROUTED',

  async open(conn: Connection, mint: MintInfo, hint) {
    // Its deepest usable pool against SOL or USDC, whichever the page showed;
    // otherwise the page's pool (or the deepest found) against another token.
    const own = await openRoute(conn, mint.mint);
    if (own) return new ClmmPoolMarket(mint, own);
    const pool = hint?.account ?? (await clmmPoolOf(conn, mint.mint));
    const route = pool ? await quotedRoute(conn, mint.mint, pool) : null;
    return route ? new ClmmPoolMarket(mint, route) : null;
  },

  ownsAccount: (owner) => owner.equals(CLMM_PROGRAM_ID) || owner.equals(WHIRLPOOL_PROGRAM_ID),

  async mintOf(conn, _account, info) {
    const clmm = decodeClmmPool(info);
    const orca = clmm ? null : decodeWhirlpool(info);
    const pair = clmm ? [clmm.mint0, clmm.mint1] : orca ? [orca.mintA, orca.mintB] : null;
    if (!pair) return null;
    // The coin is the side that isn't a quote token.
    if (QUOTE_MINTS.has(pair[0]!.toBase58())) return pair[1]!;
    if (QUOTE_MINTS.has(pair[1]!.toBase58())) return pair[0]!;
    // Neither is (a coin paired with an xStock, say): the quote token is the side with its own way to SOL.
    const [route0, route1] = await Promise.all(pair.map((m) => solRoute(conn, m).catch(() => null)));
    if (route0 && !route1) return pair[1]!;
    if (route1 && !route0) return pair[0]!;
    throw new VenueError("Can't tell which side of this pool is the coin: open it from its mint", 'UNSUPPORTED');
  },

  allowedPrograms: () => [JUPITER_PROGRAM_ID.toBase58()],
};
