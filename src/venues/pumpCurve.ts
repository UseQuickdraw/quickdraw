// pump.fun bonding curve (pre-migration), via the pinned @pump-fun/pump-sdk.
//
// Instruction choice (SDK 4.3.1):
//   buy  -> buy_exact_quote_in_v3 (exact SOL in, min tokens out; prices a buy
//           that crosses the remaining supply into the pool-to-be)
//   sell -> sell_v3
//   Cashback coins are refused by v3 (6094), so they use buy_v2 / sell_v2.
//
// Curves priced in another token (PUMP, say) trade through a Jupiter route
// built here: SOL <-> quote token on that token's SOL pool, then the curve's
// own v3 instruction as a Jupiter "wrapped" pump leg (the reverse for sells).
// Cashback coins are refused there: their v2 instructions have no such leg.
import { SystemProgram, type AccountInfo, type AccountMeta, type AddressLookupTableAccount, type Connection, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { transferFeeAt, type QuoteTransferFee } from '@pump-fun/pump-sdk/swap';
import {
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
  isLegacyQuoteMint,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '@pump-fun/pump-sdk';
import { tokenAccountMint, tokenAmount, type MintInfo } from '../solana/tokens';
import { JUPITER_PROGRAM_ID, SWAP, routeMinOut, routeV2Instruction, slippageBps, type RouteLeg } from './jupiter';
import { assertPlainToken } from './raydiumClmm';
import { hopAtas, nonSolQuoteNamed, routeCuFloor, openRoute, type Route, type SolLeg } from './routes';
import { VenueError, impactPct, lessSlippage, plusSlippage, type Market, type Quote, type VenueAdapter } from './types';

const PROTOCOL_TTL_MS = 60_000;
let protocol: { global: Global; feeConfig: FeeConfig; at: number } | null = null;

/** Test hook. */
export function __resetCurveProtocolCache(): void {
  protocol = null;
}

class CurveMarket implements Market {
  readonly venue: 'PUMP_CURVE' | 'PUMP_CURVE_ROUTED';
  private curveInfo: AccountInfo<Buffer>;
  private curve: BondingCurve;
  private curveBaseBalance: BN;
  readonly curveBaseAta: PublicKey;

  /** The quote token's Token-2022 transfer fee (a PreStock, say), priced by the SDK as the program charges it. */
  private readonly quoteFee: QuoteTransferFee | null;

  constructor(
    readonly mint: MintInfo,
    readonly address: PublicKey,
    curveInfo: AccountInfo<Buffer>,
    curveBaseAtaInfo: AccountInfo<Buffer> | null,
    private global: Global,
    private feeConfig: FeeConfig,
    private readonly route: Route | null = null,
    /** The quote token's program (Token-2022 for PUMP); SPL Token for SOL curves. */
    private readonly quoteTokenProgram: PublicKey = TOKEN_PROGRAM_ID,
  ) {
    this.venue = route ? 'PUMP_CURVE_ROUTED' : 'PUMP_CURVE';
    this.quoteFee = route?.quoteFee ? transferFeeAt(route.quoteFee.config, route.quoteFee.epoch) : null;
    this.curveInfo = curveInfo;
    this.curve = PUMP_SDK.decodeBondingCurve(curveInfo);
    this.curveBaseAta = getAssociatedTokenAddressSync(mint.mint, address, true, mint.tokenProgram);
    this.curveBaseBalance = tokenAmount(curveBaseAtaInfo);
  }

  get bondingCurve(): BondingCurve {
    return this.curve;
  }

  /** The quote token's symbol when trades route through it. */
  get routedVia(): string | null {
    return this.route?.symbol ?? null;
  }

  /** The SOL <-> quote-token leg of a routed curve. */
  get leg(): SolLeg | null {
    return this.route?.leg ?? null;
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

  watchAccounts(): PublicKey[] {
    return [this.address, this.curveBaseAta, ...(this.route?.leg.watchAccounts() ?? [])];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    if (this.route?.leg.apply(pubkey, info)) return;
    if (pubkey.equals(this.address)) {
      this.curveInfo = info;
      this.curve = PUMP_SDK.decodeBondingCurve(info);
    } else if (pubkey.equals(this.curveBaseAta)) {
      this.curveBaseBalance = tokenAmount(info);
    }
  }

  /** Lets the venue refresh protocol accounts without re-opening every market. */
  setProtocol(global: Global, feeConfig: FeeConfig): void {
    this.global = global;
    this.feeConfig = feeConfig;
  }

  tradable(): boolean {
    return !this.curve.complete;
  }

  /** The last real price: a completed curve's reserves are emptied by the migration, which isn't a price of 0. */
  private lastSpot = 0;

  private spotPerRaw(): number {
    const t = Number(this.curve.virtualTokenReserves.toString());
    const q = Number(this.curve.virtualQuoteReserves.toString());
    if (t > 0 && q > 0 && !this.curve.complete) this.lastSpot = q / t;
    return this.lastSpot;
  }

  /** Raw lamports per raw coin, through the route when there is one. */
  private spotLamportsPerRaw(): number {
    return this.spotPerRaw() * (this.route ? this.route.leg.lamportsPerToken() : 1);
  }

  spotLamportsPerToken(): number {
    return this.spotLamportsPerRaw() * 10 ** this.mint.decimals;
  }

  private assertTradable(): void {
    if (this.curve.complete) throw new VenueError('Bonding curve is complete (migrating to PumpSwap)', 'CURVE_COMPLETE');
  }

  quoteBuy(lamportsIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    const base = { global: this.global, feeConfig: this.feeConfig, mintSupply: this.curve.tokenTotalSupply, bondingCurve: this.curve };
    if (this.route) {
      const quoteIn = new BN(this.route.leg.quote(BigInt(lamportsIn.toString()), true).toString());
      const out = quoteIn.isZero() ? quoteIn : getBuyV3TokenAmountFromQuoteAmount({ ...base, amount: quoteIn, curveBaseTokenBalance: this.curveBaseBalance, quoteTransferFee: this.quoteFee });
      if (out.isZero()) throw new VenueError('Buy amount too small for this curve', 'EMPTY');
      const minOut = BN.max(routeMinOut(out, slippageBps(slippagePct)), new BN(1));
      return { side: 'buy', inAmount: lamportsIn, out, minOut, maxIn: lamportsIn, priceImpactPct: impactPct('buy', lamportsIn, out, this.spotLamportsPerRaw()) };
    }
    if (this.curve.isCashbackCoin) {
      // buy_v2: exact tokens out, cost capped at quoteAmount + slippage.
      const out = getBuyTokenAmountFromSolAmount({ ...base, amount: lamportsIn, quoteMint: this.curve.quoteMint });
      return {
        side: 'buy',
        inAmount: lamportsIn,
        out,
        minOut: out,
        maxIn: plusSlippage(lamportsIn, slippagePct),
        priceImpactPct: impactPct('buy', lamportsIn, out, this.spotPerRaw()),
      };
    }
    const out = getBuyV3TokenAmountFromQuoteAmount({ ...base, amount: lamportsIn, curveBaseTokenBalance: this.curveBaseBalance });
    if (out.isZero()) throw new VenueError('Buy amount too small for this curve', 'EMPTY');
    return {
      side: 'buy',
      inAmount: lamportsIn,
      out,
      minOut: lessSlippage(out, slippagePct, 1),
      maxIn: lamportsIn,
      priceImpactPct: impactPct('buy', lamportsIn, out, this.spotPerRaw()),
    };
  }

  quoteSell(tokensIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    // The curve pays sells from its real SOL. Asking for more underflows on
    // chain ("Overflow" 6024), so refuse it here with a clear reason.
    const gross = tokensIn.mul(this.curve.virtualQuoteReserves).div(this.curve.virtualTokenReserves.add(tokensIn));
    if (gross.gt(this.curve.realQuoteReserves)) {
      throw new VenueError(`The curve does not hold enough ${this.route?.symbol ?? 'SOL'} for this sell. Try a smaller %.`, 'EMPTY');
    }
    const out = getSellSolAmountFromTokenAmount({
      global: this.global,
      feeConfig: this.feeConfig,
      mintSupply: this.curve.tokenTotalSupply,
      bondingCurve: this.curve,
      amount: tokensIn,
      // What lands: the curve amount less the quote's transfer fee.
      quoteTransferFee: this.quoteFee,
    });
    if (this.route) {
      if (out.isZero()) throw new VenueError('Sell amount too small for this curve', 'EMPTY');
      const sol = new BN(this.route.leg.quote(BigInt(out.toString()), false).toString());
      return { side: 'sell', inAmount: tokensIn, out: sol, minOut: routeMinOut(sol, slippageBps(slippagePct)), maxIn: tokensIn, priceImpactPct: impactPct('sell', sol, tokensIn, this.spotLamportsPerRaw()) };
    }
    return {
      side: 'sell',
      inAmount: tokensIn,
      out,
      minOut: lessSlippage(out, slippagePct),
      maxIn: tokensIn,
      priceImpactPct: impactPct('sell', out, tokensIn, this.spotPerRaw()),
    };
  }

  private wsolAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  }

  private quoteAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.curve.quoteMint, user, true, this.quoteTokenProgram);
  }

  private baseAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.mint.mint, user, true, this.mint.tokenProgram);
  }

  /**
   * The curve as a Jupiter wrapped pump leg, laid out as in Jupiter's own
   * transactions: the program, the v3 instruction's accounts as the SDK builds
   * them (the user no longer signing), then the user and a trailing Jupiter
   * program id. Buy and sell v3 take the same accounts.
   */
  private async curveLeg(user: PublicKey, side: 'buy' | 'sell'): Promise<RouteLeg> {
    const ixs: TransactionInstruction[] = await PUMP_SDK.sellV3Instructions({
      bondingCurve: this.curve,
      mint: this.mint.mint,
      user,
      amount: new BN(1),
      quoteAmount: new BN(0),
      slippage: 0,
      tokenProgram: this.mint.tokenProgram,
      quoteTokenProgram: this.quoteTokenProgram,
    });
    const ix = ixs.find((i) => i.programId.equals(PUMP_PROGRAM_ID));
    if (!ix) throw new VenueError('pump.fun SDK built no curve instruction', 'UNSUPPORTED');
    // A quote with a transfer fee: the program harvests withheld fees into its mint, which must then be writable.
    const keys: AccountMeta[] = ix.keys.map((k) => ({ pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable || (this.quoteFee !== null && k.pubkey.equals(this.curve.quoteMint)) }));
    return {
      swap: side === 'buy' ? SWAP.pumpWrappedBuyV7() : SWAP.pumpWrappedSellV6(),
      accounts: [
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ...keys,
        { pubkey: user, isSigner: false, isWritable: true },
        { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    };
  }

  private async buildRoutedBuy(user: PublicKey, userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number): Promise<TransactionInstruction[]> {
    const wsol = this.wsolAta(user);
    const ixs: TransactionInstruction[] = [];
    if (!userAta) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, this.baseAta(user), user, this.mint.mint, this.mint.tokenProgram));
    ixs.push(
      // The route passes through our quote-token account (and any hop's); they're created once and stay.
      ...hopAtas(user, this.route!.leg),
      createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.curve.quoteMint, this.quoteTokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports: BigInt(q.inAmount.toString()) }),
      createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID),
      routeV2Instruction({
        user,
        source: wsol,
        destination: this.baseAta(user),
        sourceMint: NATIVE_MINT,
        destinationMint: this.mint.mint,
        sourceTokenProgram: TOKEN_PROGRAM_ID,
        destinationTokenProgram: this.mint.tokenProgram,
        inAmount: q.inAmount,
        quotedOut: q.out,
        slippageBps: slippageBps(slippagePct),
        legs: [...this.route!.leg.jupiterLegs(user, true), await this.curveLeg(user, 'buy')],
      }),
      // Unwraps anything not spent, plus the account rent.
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    );
    return ixs;
  }

  private async buildRoutedSell(user: PublicKey, q: Quote, slippagePct: number): Promise<TransactionInstruction[]> {
    const wsol = this.wsolAta(user);
    return [
      ...hopAtas(user, this.route!.leg),
      createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.curve.quoteMint, this.quoteTokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      routeV2Instruction({
        user,
        source: this.baseAta(user),
        destination: wsol,
        sourceMint: this.mint.mint,
        destinationMint: NATIVE_MINT,
        sourceTokenProgram: this.mint.tokenProgram,
        destinationTokenProgram: TOKEN_PROGRAM_ID,
        inAmount: q.inAmount,
        quotedOut: q.out,
        slippageBps: slippageBps(slippagePct),
        legs: [await this.curveLeg(user, 'sell'), ...this.route!.leg.jupiterLegs(user, false)],
      }),
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    ];
  }

  async buildBuy(user: PublicKey, userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number) {
    this.assertTradable();
    if (this.route) return this.buildRoutedBuy(user, userAta, q, slippagePct);
    const common = { bondingCurve: this.curve, associatedUserAccountInfo: userAta, mint: this.mint.mint, user, slippage: slippagePct, tokenProgram: this.mint.tokenProgram, quoteTokenProgram: TOKEN_PROGRAM_ID };
    if (this.curve.isCashbackCoin) {
      return PUMP_SDK.buyV2Instructions({ ...common, global: this.global, bondingCurveAccountInfo: this.curveInfo, amount: q.out, quoteAmount: q.inAmount });
    }
    return PUMP_SDK.buyExactQuoteInV3Instructions({ ...common, amount: q.out, quoteAmount: q.inAmount });
  }

  async buildSell(user: PublicKey, _userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number) {
    this.assertTradable();
    if (this.route) return this.buildRoutedSell(user, q, slippagePct);
    const common = { bondingCurve: this.curve, mint: this.mint.mint, user, amount: q.inAmount, quoteAmount: q.out, slippage: slippagePct, tokenProgram: this.mint.tokenProgram, quoteTokenProgram: TOKEN_PROGRAM_ID };
    if (this.curve.isCashbackCoin) {
      return PUMP_SDK.sellV2Instructions({ ...common, global: this.global, bondingCurveAccountInfo: this.curveInfo });
    }
    return PUMP_SDK.sellV3Instructions(common);
  }

  cuFloor(): number {
    return routeCuFloor(this.route);
  }

  selfAccounts(user: PublicKey): PublicKey[] {
    // SOL curves move lamports directly; routed ones wrap SOL on the way.
    return this.route ? [this.wsolAta(user)] : [];
  }
}

async function loadProtocol(conn: Connection, extra: PublicKey[]): Promise<{ infos: (AccountInfo<Buffer> | null)[] }> {
  const fresh = protocol && Date.now() - protocol.at < PROTOCOL_TTL_MS;
  const keys = fresh ? extra : [...extra, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA];
  const infos = await conn.getMultipleAccountsInfo(keys, 'confirmed');
  if (!fresh) {
    const [g, f] = infos.slice(extra.length);
    if (!g || !f) throw new VenueError('pump.fun global/fee config not found', 'NOT_FOUND');
    protocol = { global: PUMP_SDK.decodeGlobal(g), feeConfig: PUMP_SDK.decodeFeeConfig(f), at: Date.now() };
  }
  return { infos: infos.slice(0, extra.length) };
}

export const pumpCurve: VenueAdapter = {
  id: 'PUMP_CURVE',

  async open(conn, mint) {
    const curvePda = bondingCurvePda(mint.mint);
    const curveAta = getAssociatedTokenAddressSync(mint.mint, curvePda, true, mint.tokenProgram);
    const { infos } = await loadProtocol(conn, [curvePda, curveAta]);
    const [curveInfo, curveAtaInfo] = infos;
    // Missing, foreign, or emptied (closed after migration) -> not a curve venue.
    if (!curveInfo || !curveInfo.owner.equals(PUMP_PROGRAM_ID) || curveInfo.data.length === 0) return null;
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
    if (curve.complete) return null; // resolved to PumpSwap by the registry
    const { global, feeConfig } = protocol!;
    if (isLegacyQuoteMint(curve.quoteMint)) return new CurveMarket(mint, curvePda, curveInfo, curveAtaInfo ?? null, global, feeConfig);

    // Priced in another token: route SOL through that token's own SOL pool.
    if (curve.isCashbackCoin) throw new VenueError('This cashback pump.fun curve trades against another token (not supported yet)', 'UNSUPPORTED');
    const quoteInfo = await conn.getAccountInfo(curve.quoteMint, 'confirmed');
    if (!quoteInfo) throw new VenueError('Quote token not found on chain', 'NOT_FOUND');
    // A transfer fee on the quote is priced (see quoteFee); hooks and frozen accounts are still refused.
    assertPlainToken(curve.quoteMint, quoteInfo, { allowFee: true });
    const route = await openRoute(conn, curve.quoteMint, curvePda);
    if (!route || !route.leg.tokenProgram.equals(quoteInfo.owner)) throw await nonSolQuoteNamed(conn, curve.quoteMint);
    return new CurveMarket(mint, curvePda, curveInfo, curveAtaInfo ?? null, global, feeConfig, route, quoteInfo.owner);
  },

  ownsAccount: (owner) => owner.equals(PUMP_PROGRAM_ID),

  async mintOf(conn, account) {
    // The curve account doesn't store its mint; its token vault does. Some
    // free RPC tiers refuse this indexed call, so say what to do instead.
    let results;
    try {
      results = await Promise.all(
        [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) => conn.getTokenAccountsByOwner(account, { programId }, 'confirmed')),
      );
    } catch {
      throw new VenueError(
        "Couldn't find the token for this bonding curve: the RPC refused getTokenAccountsByOwner. Use an RPC that allows it (Helius does).",
        'NOT_FOUND',
      );
    }
    for (const r of results) {
      for (const { account: info } of r.value) {
        const mint = tokenAccountMint(info);
        if (bondingCurvePda(mint).equals(account)) return mint;
      }
    }
    return null;
  },

  allowedPrograms: () => [PUMP_PROGRAM_ID.toBase58(), JUPITER_PROGRAM_ID.toBase58()],
};

export type { CurveMarket };
