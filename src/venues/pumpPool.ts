// One PumpSwap pool's live state and pricing, shared by the PumpSwap venue (a
// coin's own pool) and by routes that use a token's SOL pool as their SOL leg.
// Pricing comes from the pinned SDK (`@pump-fun/pump-sdk/swap`).
import { PublicKey, SystemProgram, type AccountInfo, type AccountMeta, type Connection } from '@solana/web3.js';
import { MintLayout, NATIVE_MINT, getAssociatedTokenAddressSync, type RawMint } from '@solana/spl-token';
import BN from 'bn.js';
import {
  GLOBAL_CONFIG_PDA,
  type QuoteTransferFee,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  buyQuoteInput,
  canonicalPumpPoolPda,
  getBuybackFeeRecipient,
  sellBaseInput,
  transferFeeAt,
  userVolumeAccumulatorPda,
  type FeeConfig,
  type GlobalConfig,
  type Pool,
  type SwapSolanaState,
} from '@pump-fun/pump-sdk/swap';
import { PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda } from '@pump-fun/pump-sdk';
import { tokenAmount } from '../solana/tokens';
import { JUPITER_PROGRAM_ID, SWAP, type RouteLeg } from './jupiter';
import type { SolLeg } from './routes';
import type { TransferFee } from './transferFee';
import { VenueError } from './types';

const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0];

export class PumpPool {
  private poolInfo: AccountInfo<Buffer>;
  private pool_: Pool;
  private baseAmount: BN;
  private quoteAmount: BN;
  /** The quote token's Token-2022 transfer fee this epoch, priced by the SDK. */
  private quoteFee: QuoteTransferFee | null = null;

  constructor(
    readonly key: PublicKey,
    poolInfo: AccountInfo<Buffer>,
    baseVault: AccountInfo<Buffer>,
    quoteVault: AccountInfo<Buffer>,
    readonly globalConfig: GlobalConfig,
    readonly feeConfig: FeeConfig | null,
    readonly baseMintAccount: RawMint,
    readonly baseTokenProgram: PublicKey,
    readonly quoteTokenProgram: PublicKey,
  ) {
    this.poolInfo = poolInfo;
    this.pool_ = PUMP_AMM_SDK.decodePool(poolInfo);
    this.baseAmount = tokenAmount(baseVault);
    this.quoteAmount = tokenAmount(quoteVault);
  }

  /** Fetches a pool and everything pricing needs. Null when `key` isn't a PumpSwap pool. */
  static async load(conn: Connection, key: PublicKey, poolInfo?: AccountInfo<Buffer> | null): Promise<PumpPool | null> {
    const [info, globalInfo, feeInfo] = await conn.getMultipleAccountsInfo([key, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA], 'confirmed');
    const pi = poolInfo ?? info;
    if (!pi || !pi.owner.equals(PUMP_AMM_PROGRAM_ID)) return null;
    const pool = PUMP_AMM_SDK.decodePoolNullable(pi);
    if (!pool) return null;
    if (!globalInfo) throw new VenueError('PumpSwap global config not found', 'NOT_FOUND');
    const [baseVault, quoteVault, baseMint, quoteMint] = await conn.getMultipleAccountsInfo(
      [pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount, pool.baseMint, pool.quoteMint],
      'confirmed',
    );
    if (!baseVault || !quoteVault || !baseMint || !quoteMint) throw new VenueError('Pool vaults not found', 'NOT_FOUND');
    return new PumpPool(
      key,
      pi,
      baseVault,
      quoteVault,
      PUMP_AMM_SDK.decodeGlobalConfig(globalInfo),
      feeInfo ? PUMP_AMM_SDK.decodeFeeConfig(feeInfo) : null,
      MintLayout.decode(baseMint.data.subarray(0, MintLayout.span)),
      baseMint.owner,
      quoteMint.owner,
    );
  }

  get pool(): Pool {
    return this.pool_;
  }

  /** Prices a quote token that charges a transfer fee (routed pools only: the direct builders assume none). */
  setQuoteTransferFee(fee: TransferFee | null): void {
    this.quoteFee = fee ? transferFeeAt(fee.config, fee.epoch) : null;
  }

  watchAccounts(): PublicKey[] {
    return [this.key, this.pool_.poolBaseTokenAccount, this.pool_.poolQuoteTokenAccount];
  }

  /** True when `pubkey` was one of this pool's accounts. */
  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): boolean {
    if (pubkey.equals(this.key)) {
      this.poolInfo = info;
      this.pool_ = PUMP_AMM_SDK.decodePool(info);
    } else if (pubkey.equals(this.pool_.poolBaseTokenAccount)) {
      this.baseAmount = tokenAmount(info);
    } else if (pubkey.equals(this.pool_.poolQuoteTokenAccount)) {
      this.quoteAmount = tokenAmount(info);
    } else {
      return false;
    }
    return true;
  }

  tradable(): boolean {
    return !this.baseAmount.isZero() && !this.quoteAmount.isZero();
  }

  /** Raw quote per raw base at the current price (vault balance + virtual quote reserves). */
  spotQuotePerBase(): number {
    const base = Number(this.baseAmount.toString());
    const quote = Number(this.quoteAmount.add(this.pool_.virtualQuoteReserves).toString());
    return base > 0 ? quote / base : 0;
  }

  private pricing() {
    const p = this.pool_;
    return {
      baseReserve: this.baseAmount,
      quoteReserve: this.quoteAmount,
      virtualQuoteReserves: p.virtualQuoteReserves,
      globalConfig: this.globalConfig,
      baseMintAccount: this.baseMintAccount,
      baseMint: p.baseMint,
      coinCreator: p.coinCreator,
      creator: p.creator,
      feeConfig: this.feeConfig,
      quoteMint: p.quoteMint,
      isMayhemMode: p.isMayhemMode,
      creatorFeeBps: p.creatorFeeBps,
      quoteTransferFee: this.quoteFee,
    };
  }

  assertTradable(): void {
    if (!this.tradable()) throw new VenueError('Pool has no liquidity', 'EMPTY');
  }

  /**
   * Base out for an exact quote in (and the most quote a capped buy may
   * spend). `exactInV2` prices it as buy_exact_quote_in_v2, the instruction
   * Jupiter's PumpSwap leg runs.
   */
  buy(quoteIn: BN, slippagePct: number, exactInV2 = false): { base: BN; maxQuote: BN } {
    this.assertTradable();
    const r = buyQuoteInput({ ...this.pricing(), quote: quoteIn, slippage: slippagePct, tradeV2: exactInV2 });
    return { base: r.base, maxQuote: r.maxQuote };
  }

  /** Quote out for an exact base in (and its floor at that slippage). */
  sell(baseIn: BN, slippagePct: number): { quote: BN; minQuote: BN } {
    this.assertTradable();
    const r = sellBaseInput({ ...this.pricing(), base: baseIn, slippage: slippagePct, feeBucketsTotal: this.pool_.protocolFees.add(this.pool_.creatorFees) });
    return { quote: r.uiQuote, minQuote: r.minQuote };
  }

  userBase(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.pool_.baseMint, user, true, this.baseTokenProgram);
  }

  userQuote(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.pool_.quoteMint, user, true, this.quoteTokenProgram);
  }

  /** The SDK's state object, for its own (direct, SOL-quoted) builders. */
  swapState(user: PublicKey, userBaseAccountInfo: AccountInfo<Buffer> | null): SwapSolanaState {
    return {
      globalConfig: this.globalConfig,
      feeConfig: this.feeConfig,
      poolKey: this.key,
      poolAccountInfo: this.poolInfo,
      pool: this.pool_,
      poolBaseAmount: this.baseAmount,
      poolQuoteAmount: this.quoteAmount,
      baseTokenProgram: this.baseTokenProgram,
      quoteTokenProgram: this.quoteTokenProgram,
      baseMint: this.pool_.baseMint,
      baseMintAccount: this.baseMintAccount,
      user,
      userBaseTokenAccount: this.userBase(user),
      userQuoteTokenAccount: this.userQuote(user),
      userBaseAccountInfo,
      // The SDK creates the WSOL ATA idempotently and closes it after the swap.
      userQuoteAccountInfo: null,
      quoteTransferFee: null,
    };
  }

  /**
   * The pool as a Jupiter PumpSwapBuyV4 / PumpSwapSellV4 leg, laid out as in
   * Jupiter's own transactions: the swap's accounts in Jupiter's order, a
   * buyback fee recipient's account for the quote token, and a trailing
   * Jupiter program id for "none".
   */
  jupiterLeg(user: PublicKey, side: 'buy' | 'sell'): RouteLeg {
    const p = this.pool_;
    const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
    const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
    // The program checks this one against the config's buyback fee recipients.
    const recipient = getBuybackFeeRecipient(this.globalConfig);
    return {
      swap: side === 'buy' ? SWAP.pumpSwapBuy() : SWAP.pumpSwapSell(),
      accounts: [
        r(PUMP_AMM_PROGRAM_ID),
        w(this.key),
        w(user),
        r(GLOBAL_CONFIG_PDA),
        r(p.baseMint),
        r(p.quoteMint),
        w(this.userBase(user)),
        w(this.userQuote(user)),
        w(p.poolBaseTokenAccount),
        w(p.poolQuoteTokenAccount),
        r(this.baseTokenProgram),
        r(this.quoteTokenProgram),
        r(SystemProgram.programId),
        w(userVolumeAccumulatorPda(user)),
        r(PUMP_AMM_FEE_CONFIG_PDA),
        w(getAssociatedTokenAddressSync(p.quoteMint, recipient, true, this.quoteTokenProgram)),
        r(EVENT_AUTHORITY),
        r(PUMP_AMM_PROGRAM_ID),
        w(user),
        r(JUPITER_PROGRAM_ID),
      ],
    };
  }
}

/**
 * A token's canonical PumpSwap pool as a leg of a route: against SOL, or
 * against the token its curve was priced in ("fromSol" then means from that
 * anchor, which reaches SOL through a leg of its own: see ChainLeg).
 */
export class PumpSwapSolLeg implements SolLeg {
  constructor(readonly pool: PumpPool) {}

  /** Null when the token has no canonical PumpSwap pool against SOL. */
  static async open(conn: Connection, token: PublicKey): Promise<PumpSwapSolLeg | null> {
    const pool = await PumpPool.load(conn, canonicalPumpPoolPda(token));
    if (!pool || !pool.pool.baseMint.equals(token) || !pool.pool.quoteMint.equals(NATIVE_MINT) || !pool.tradable()) return null;
    return new PumpSwapSolLeg(pool);
  }

  /**
   * A pump coin whose own pool is priced in another token (its curve's quote
   * mint, e.g. BTC priced in WBTC), with the anchor it holds; null otherwise.
   */
  static async openOtherQuote(conn: Connection, token: PublicKey): Promise<{ leg: PumpSwapSolLeg; reserve: bigint } | null> {
    const curve = await conn.getAccountInfo(bondingCurvePda(token), 'confirmed');
    if (!curve || !curve.owner.equals(PUMP_PROGRAM_ID) || curve.data.length === 0) return null;
    const quoteMint = PUMP_SDK.decodeBondingCurve(curve).quoteMint;
    if (quoteMint.equals(NATIVE_MINT) || quoteMint.equals(PublicKey.default)) return null;
    const pool = await PumpPool.load(conn, canonicalPumpPoolPda(token, quoteMint));
    if (!pool || !pool.pool.baseMint.equals(token) || !pool.pool.quoteMint.equals(quoteMint) || !pool.tradable()) return null;
    // The quote vault, as the anchor this pool holds.
    const vault = await conn.getAccountInfo(pool.pool.poolQuoteTokenAccount, 'confirmed');
    return { leg: new PumpSwapSolLeg(pool), reserve: BigInt(tokenAmount(vault).toString()) };
  }

  get tokenProgram(): PublicKey {
    return this.pool.baseTokenProgram;
  }

  /** What the pool is priced in: SOL, or another token. */
  get anchor(): PublicKey {
    return this.pool.pool.quoteMint;
  }

  get anchorProgram(): PublicKey {
    return this.pool.quoteTokenProgram;
  }

  watchAccounts(): PublicKey[] {
    return this.pool.watchAccounts();
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): boolean {
    return this.pool.apply(pubkey, info);
  }

  quote(amount: bigint, fromSol: boolean): bigint {
    const a = new BN(amount.toString());
    const out = fromSol ? this.pool.buy(a, 1, true).base : this.pool.sell(a, 1).quote;
    return BigInt(out.toString());
  }

  lamportsPerToken(): number {
    return this.pool.spotQuotePerBase();
  }

  /** The pools this leg trades on, to find lookup tables other traders use for them. */
  pools(): PublicKey[] {
    return [this.pool.key];
  }

  hops(): { mint: PublicKey; tokenProgram: PublicKey }[] {
    return [];
  }

  jupiterLegs(user: PublicKey, fromSol: boolean): RouteLeg[] {
    return [this.jupiterLeg(user, fromSol)];
  }

  jupiterLeg(user: PublicKey, fromSol: boolean): RouteLeg {
    return this.pool.jupiterLeg(user, fromSol ? 'buy' : 'sell');
  }
}
