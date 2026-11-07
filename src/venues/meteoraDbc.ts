// Meteora Dynamic Bonding Curve: the launch curve behind Bags, Believe,
// Jupiter Studio and other launchpads. Built from the program's source
// (MeteoraAg/dynamic-bonding-curve: state/virtual_pool.rs, state/config.rs,
// curve.rs, base_fee/*, instructions/swap/*); no SDK.
//
// The curve is a stack of up to 20 concentrated-liquidity segments in Q64
// sqrt-price space. SOL-paired curves trade directly with swap2:
//   buy  -> exact in (or partial fill when the buy would pass the end of the
//           curve: it takes what's left and the rest of the SOL comes back)
//   sell -> exact in
// wrapping into our WSOL ATA and closing it in the same tx. Curves quoted in
// another token trade through our Jupiter route (SOL <-> that token, then the
// curve), as the routed LaunchLab venue does.
//
// Fees follow the config: a fixed, time-scheduled or rate-limited base fee,
// plus a volatility fee, on the quote side (or on whichever token comes out).
// When the curve fills, the pool migrates to Meteora DAMM v2 and the DAMM v2
// venue takes the coin over.
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  type AccountInfo,
  type AccountMeta,
  type AddressLookupTableAccount,
  type Connection,
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
import bs58 from 'bs58';
import type { MintInfo } from '../solana/tokens';
import { JUPITER_PROGRAM_ID, SWAP, routeMinOut, routeV2Instruction, slippageBps, type RouteLeg } from './jupiter';
import {
  ChainClock,
  deltaBase,
  deltaBaseU64,
  deltaQuote,
  deltaQuoteU64,
  excludeFee,
  includeFee,
  nextSqrtPriceFromInput,
  priceFromSqrt,
  rateLimitedFee,
  readU128,
  readU64,
  scheduledFee,
  variableFee,
} from './meteoraMath';
import { assertNoQuoteFee, hopAtas, nonSolQuoteNamed, openRoute, routeCuFloor, transferFeeOf, type Route, type SolLeg, type TransferFee } from './routes';
import { transferFeeOnRaw } from './transferFee';
import { VenueError, impactPct, lessSlippage, type Market, type Quote, type VenueAdapter } from './types';

export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], DBC_PROGRAM_ID)[0];
/** Holds every curve's vaults; also the creator of the DAMM v2 pools curves migrate into. */
export const DBC_POOL_AUTHORITY = pda('pool_authority');
const EVENT_AUTHORITY = pda('__event_authority');

const SWAP2 = Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]);
const POOL_DISC = Buffer.from([213, 224, 5, 209, 98, 69, 119, 92]);
const CONFIG_DISC = Buffer.from([26, 108, 14, 123, 116, 230, 129, 43]);
const POOL_LEN = 424;
const CONFIG_LEN = 1048;
const CURVE_POINTS = 20;
const MAX_FEE_NUMERATOR = 990_000_000n;
const SWAP_MODE = { exactIn: 0, partialFill: 1 } as const;

// ----------------------------------------------------------------- layouts
// zero_copy. Offsets include the 8-byte Anchor discriminator.

export interface DbcPool {
  config: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseReserve: bigint;
  quoteReserve: bigint;
  sqrtPrice: bigint;
  activationPoint: bigint;
  isMigrated: boolean;
  /** 0 while trading on the curve; later steps run the migration. */
  migrationProgress: number;
  volatilityAccumulator: bigint;
}

const key = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));

export function decodeDbcPool(info: AccountInfo<Buffer>): DbcPool | null {
  const d = info.data;
  if (!info.owner.equals(DBC_PROGRAM_ID) || d.length < POOL_LEN || !d.subarray(0, 8).equals(POOL_DISC)) return null;
  return {
    volatilityAccumulator: readU128(d, 40),
    config: key(d, 72),
    baseMint: key(d, 136),
    baseVault: key(d, 168),
    quoteVault: key(d, 200),
    baseReserve: readU64(d, 232),
    quoteReserve: readU64(d, 240),
    sqrtPrice: readU128(d, 280),
    activationPoint: readU64(d, 296),
    isMigrated: d[305] === 1,
    migrationProgress: d[308]!,
  };
}

interface Segment {
  sqrtPrice: bigint;
  liquidity: bigint;
}

export interface DbcConfig {
  quoteMint: PublicKey;
  cliffFee: bigint;
  /** Scheduler: period frequency. Rate limiter: max limiter duration. */
  secondFactor: bigint;
  /** Scheduler: reduction factor. Rate limiter: reference amount. */
  thirdFactor: bigint;
  /** Scheduler: number of periods. Rate limiter: fee increment (bps). */
  firstFactor: number;
  /** 0/1: linear/exponential fee scheduler, 2: rate limiter. */
  baseFeeMode: number;
  dynamicFee: boolean;
  binStep: bigint;
  variableFeeControl: bigint;
  /** 0: fees in the quote token, 1: in whichever token comes out. */
  collectFeeMode: number;
  /** 0: DAMM v1, 1: DAMM v2. */
  migrationOption: number;
  /** 0: slots, 1: unix seconds. */
  activationType: number;
  migrationQuoteThreshold: bigint;
  migrationSqrtPrice: bigint;
  sqrtStartPrice: bigint;
  curve: Segment[];
}

export function decodeDbcConfig(info: AccountInfo<Buffer>): DbcConfig {
  const d = info.data;
  if (!info.owner.equals(DBC_PROGRAM_ID) || d.length < CONFIG_LEN || !d.subarray(0, 8).equals(CONFIG_DISC)) {
    throw new VenueError('Meteora bonding curve config not found', 'NOT_FOUND');
  }
  const curve: Segment[] = [];
  for (let i = 0; i < CURVE_POINTS; i++) curve.push({ sqrtPrice: readU128(d, 408 + 32 * i), liquidity: readU128(d, 424 + 32 * i) });
  return {
    quoteMint: key(d, 8),
    cliffFee: readU64(d, 104),
    secondFactor: readU64(d, 112),
    thirdFactor: readU64(d, 120),
    firstFactor: d.readUInt16LE(128),
    baseFeeMode: d[130]!,
    dynamicFee: d[136] !== 0,
    variableFeeControl: BigInt(d.readUInt32LE(148)),
    binStep: BigInt(d.readUInt16LE(152)),
    collectFeeMode: d[232]!,
    migrationOption: d[233]!,
    activationType: d[234]!,
    migrationQuoteThreshold: readU64(d, 264),
    migrationSqrtPrice: readU128(d, 280),
    sqrtStartPrice: readU128(d, 392),
    curve,
  };
}

/** The coin's curve, found by its base mint (pool addresses derive from a config the page may not show). */
async function dbcPoolByBase(conn: Connection, base: PublicKey): Promise<PublicKey | null> {
  try {
    const found = await conn.getProgramAccounts(DBC_PROGRAM_ID, {
      commitment: 'confirmed',
      dataSlice: { offset: 0, length: 8 },
      filters: [{ dataSize: POOL_LEN }, { memcmp: { offset: 0, bytes: bs58.encode(POOL_DISC) } }, { memcmp: { offset: 136, bytes: base.toBase58() } }],
    });
    return found[0]?.pubkey ?? null;
  } catch {
    // RPCs that refuse program scans find nothing; the pool address still opens it.
    return null;
  }
}

const toBN = (n: bigint) => new BN(n.toString());
const toBig = (n: BN) => BigInt(n.toString());

interface BuyResult {
  out: bigint;
  /** Quote units the curve takes (less than offered when the buy ends the curve). */
  spent: bigint;
  /** The buy reaches the end of the curve: only a partial fill can make it. */
  capped: boolean;
}

// ------------------------------------------------------------------ market

class DbcMarket implements Market {
  readonly venue: 'METEORA_DBC' | 'METEORA_DBC_ROUTED';
  private pool: DbcPool;
  private config: DbcConfig;

  constructor(
    readonly mint: MintInfo,
    readonly address: PublicKey,
    pool: DbcPool,
    configInfo: AccountInfo<Buffer>,
    private readonly quoteProgram: PublicKey,
    private readonly clock: ChainClock,
    private readonly route: Route | null,
    private readonly transferFee: TransferFee | null,
  ) {
    this.venue = route ? 'METEORA_DBC_ROUTED' : 'METEORA_DBC';
    this.pool = pool;
    this.config = decodeDbcConfig(configInfo);
  }

  get state(): DbcPool {
    return this.pool;
  }

  get curveConfig(): DbcConfig {
    return this.config;
  }

  get quoteMint(): PublicKey {
    return this.config.quoteMint;
  }

  /** The quote token's symbol when trades route through it. */
  get routedVia(): string | null {
    return this.route?.symbol ?? null;
  }

  /** The SOL <-> quote-token leg of a routed curve. */
  get leg(): SolLeg | null {
    return this.route?.leg ?? null;
  }

  watchAccounts(): PublicKey[] {
    return [this.address, this.pool.config, ...(this.route?.leg.watchAccounts() ?? [])];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    if (pubkey.equals(this.address)) this.pool = decodeDbcPool(info) ?? this.pool;
    else if (this.route?.leg.apply(pubkey, info)) return;
    else if (pubkey.equals(this.pool.config)) {
      try {
        this.config = decodeDbcConfig(info);
      } catch {
        // Keep the last good config; the on-chain minimum still protects the trade.
      }
    }
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
    return !this.pool.isMigrated && this.pool.migrationProgress === 0 && this.pool.quoteReserve < this.config.migrationQuoteThreshold;
  }

  private assertTradable(): void {
    if (!this.tradable()) throw new VenueError('The Meteora bonding curve is complete and migrating to its DAMM pool', 'CURVE_COMPLETE');
  }

  transferFeeOn(amount: BN): BN {
    return toBN(transferFeeOnRaw(this.transferFee, toBig(amount)));
  }

  canCloseTokenAccount(): boolean {
    return !this.transferFee;
  }

  // ------------------------------------------------------------- fees

  private point(): bigint {
    return this.clock.point(this.config.activationType);
  }

  /** Whether the rate limiter is in force for a buy now (it never applies to sells). */
  private rateLimited(buy: boolean): boolean {
    const c = this.config;
    if (c.baseFeeMode !== 2 || !buy) return false;
    if (c.thirdFactor === 0n && c.secondFactor === 0n && c.firstFactor === 0) return false;
    return this.point() <= this.pool.activationPoint + c.secondFactor;
  }

  /** Total fee numerator for an input that includes the fee (get_total_fee_numerator_from_included_fee_amount). */
  private feeNumerator(buy: boolean, included: bigint): bigint {
    const c = this.config;
    let base: bigint;
    if (c.baseFeeMode === 2) {
      base = this.rateLimited(buy)
        ? rateLimitedFee({ cliff: c.cliffFee, incrementBps: BigInt(c.firstFactor), referenceAmount: c.thirdFactor, maxFeeNumerator: MAX_FEE_NUMERATOR }, included)
        : c.cliffFee;
    } else if (c.secondFactor === 0n) {
      base = c.cliffFee;
    } else {
      const now = this.point();
      const period = now > this.pool.activationPoint ? (now - this.pool.activationPoint) / c.secondFactor : 0n;
      base = scheduledFee(c.baseFeeMode === 1, c.cliffFee, c.firstFactor, c.thirdFactor, period);
    }
    const total = base + variableFee({ initialized: c.dynamicFee, binStep: c.binStep, variableFeeControl: c.variableFeeControl, volatilityAccumulator: this.pool.volatilityAccumulator });
    return total > MAX_FEE_NUMERATOR ? MAX_FEE_NUMERATOR : total;
  }

  // ------------------------------------------------------------ curve

  /** calculate_quote_to_base_from_amount_in, stopping at the migration price. */
  private quoteToBase(amountIn: bigint): { out: bigint; left: bigint } {
    const c = this.config;
    const stop = c.migrationSqrtPrice;
    let cur = this.pool.sqrtPrice;
    let left = amountIn;
    let out = 0n;
    for (const seg of c.curve) {
      if (seg.sqrtPrice === 0n || seg.liquidity === 0n) break;
      const ref = stop < seg.sqrtPrice ? stop : seg.sqrtPrice;
      if (ref <= cur) continue;
      const maxIn = deltaQuote(cur, ref, seg.liquidity, true);
      if (left < maxIn) {
        const next = nextSqrtPriceFromInput(cur, seg.liquidity, left, false);
        out += deltaBaseU64(cur, next, seg.liquidity, false);
        left = 0n;
        break;
      }
      out += deltaBaseU64(cur, ref, seg.liquidity, false);
      cur = ref;
      left -= maxIn;
      if (ref === stop) break;
    }
    return { out, left };
  }

  /** calculate_base_to_quote_from_amount_in: down the segments, then the first one to the start price. */
  private baseToQuote(amountIn: bigint): { out: bigint; left: bigint } {
    const c = this.config;
    let cur = this.pool.sqrtPrice;
    let left = amountIn;
    let out = 0n;
    for (let i = c.curve.length - 2; i >= 0; i--) {
      const seg = c.curve[i]!;
      if (seg.sqrtPrice === 0n || seg.liquidity === 0n) continue;
      if (seg.sqrtPrice >= cur) continue;
      const l = c.curve[i + 1]!.liquidity;
      const maxIn = deltaBase(seg.sqrtPrice, cur, l, true);
      if (left < maxIn) {
        const next = nextSqrtPriceFromInput(cur, l, left, true);
        out += deltaQuoteU64(next, cur, l, false);
        left = 0n;
        break;
      }
      out += deltaQuoteU64(seg.sqrtPrice, cur, l, false);
      cur = seg.sqrtPrice;
      left -= maxIn;
    }
    if (left !== 0n) {
      const l0 = c.curve[0]!.liquidity;
      let next = nextSqrtPriceFromInput(cur, l0, left, true);
      if (next < c.sqrtStartPrice) {
        next = c.sqrtStartPrice;
        left -= deltaBaseU64(next, cur, l0, true);
      } else {
        left = 0n;
      }
      out += deltaQuoteU64(next, cur, l0, false);
    }
    return { out, left };
  }

  /** Tokens out of the curve for quote units in, as swap2 exact-in (or partial fill when capped). */
  private curveBuy(quoteIn: bigint): BuyResult {
    // The coin's own transfer fee comes off what the buyer receives; the quote side has none.
    const feesOnInput = this.config.collectFeeMode === 0;
    const numerator = this.feeNumerator(true, quoteIn);
    const net = feesOnInput ? excludeFee(numerator, quoteIn)[0] : quoteIn;
    const { out, left } = this.quoteToBase(net);
    let spent = quoteIn;
    if (left !== 0n) {
      const consumed = net - left;
      // A capped buy pays only for what it took; with fees on the input, they're charged on that.
      if (feesOnInput && this.config.baseFeeMode === 2 && this.rateLimited(true)) {
        throw new VenueError('This buy is bigger than what is left on the curve. Try a smaller amount.', 'EMPTY');
      }
      spent = feesOnInput ? includeFee(numerator, consumed) : consumed;
    }
    const received = feesOnInput ? out : excludeFee(numerator, out)[0];
    return { out: received - transferFeeOnRaw(this.transferFee, received), spent, capped: left !== 0n };
  }

  /** Quote units out of the curve for an exact token input, after fees. */
  private curveSell(tokensIn: bigint): bigint {
    const net = tokensIn - transferFeeOnRaw(this.transferFee, tokensIn);
    if (net <= 0n) throw new VenueError('Sell amount too small for this curve', 'EMPTY');
    const { out, left } = this.baseToQuote(net);
    if (left !== 0n) throw new VenueError(`The curve does not hold enough ${this.route?.symbol ?? 'SOL'} for this sell. Try a smaller %.`, 'EMPTY');
    return excludeFee(this.feeNumerator(false, net), out)[0];
  }

  private curveSpot(): number {
    return priceFromSqrt(this.pool.sqrtPrice);
  }

  private spotPerRaw(): number {
    return this.curveSpot() * (this.route ? this.route.leg.lamportsPerToken() : 1);
  }

  spotLamportsPerToken(): number {
    return this.spotPerRaw() * 10 ** this.mint.decimals;
  }

  quoteBuy(lamportsIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    const leg = this.route?.leg;
    const quoteIn = leg ? leg.quote(toBig(lamportsIn), true) : toBig(lamportsIn);
    if (quoteIn <= 0n) throw new VenueError('Buy amount too small for this curve', 'EMPTY');
    const r = this.curveBuy(quoteIn);
    // A routed partial fill would leave the unspent quote token in the wallet.
    if (r.capped && leg) throw new VenueError('This buy is bigger than what is left on the curve. Try a smaller amount.', 'EMPTY');
    if (r.out <= 0n) throw new VenueError('Buy amount too small for this curve', 'EMPTY');
    const out = toBN(r.out);
    const minOut = leg ? routeMinOut(out, slippageBps(slippagePct)) : lessSlippage(out, slippagePct, 1);
    const paid = r.capped ? toBN(r.spent) : lamportsIn;
    return { side: 'buy', inAmount: lamportsIn, out, minOut: BN.max(minOut, new BN(1)), maxIn: lamportsIn, priceImpactPct: impactPct('buy', paid, out, this.spotPerRaw()) };
  }

  quoteSell(tokensIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    const leg = this.route?.leg;
    const quoteOut = this.curveSell(toBig(tokensIn));
    if (leg && quoteOut === 0n) throw new VenueError('Sell amount too small for this curve', 'EMPTY');
    const out = toBN(leg ? leg.quote(quoteOut, false) : quoteOut);
    const minOut = leg ? routeMinOut(out, slippageBps(slippagePct)) : lessSlippage(out, slippagePct);
    return { side: 'sell', inAmount: tokensIn, out, minOut, maxIn: tokensIn, priceImpactPct: impactPct('sell', out, tokensIn, this.spotPerRaw()) };
  }

  // ------------------------------------------------------------ build

  private baseAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.mint.mint, user, true, this.mint.tokenProgram);
  }

  private quoteAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.config.quoteMint, user, true, this.quoteProgram);
  }

  private wsolAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  }

  /** swap2's accounts, the payer as given (a signer directly, the user's slot in a Jupiter leg). */
  private swapAccounts(user: PublicKey, payer: AccountMeta, buy: boolean): AccountMeta[] {
    const p = this.pool;
    const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    const [input, output] = buy ? [this.quoteAta(user), this.baseAta(user)] : [this.baseAta(user), this.quoteAta(user)];
    return [
      r(DBC_POOL_AUTHORITY),
      r(p.config),
      w(this.address),
      w(input),
      w(output),
      w(p.baseVault),
      w(p.quoteVault),
      r(p.baseMint),
      r(this.config.quoteMint),
      payer,
      r(this.mint.tokenProgram),
      r(this.quoteProgram),
      r(DBC_PROGRAM_ID), // referral_token_account: None
      r(EVENT_AUTHORITY),
      r(DBC_PROGRAM_ID),
    ];
  }

  private swapIx(user: PublicKey, buy: boolean, amountIn: BN, minOut: BN, mode: number): TransactionInstruction {
    // The rate limiter only lets one swap on the pool per tx, which it checks through the instructions sysvar.
    const sysvar = this.rateLimited(buy) ? [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }] : [];
    return new TransactionInstruction({
      programId: DBC_PROGRAM_ID,
      keys: [...this.swapAccounts(user, { pubkey: user, isSigner: true, isWritable: false }, buy), ...sysvar],
      data: Buffer.concat([SWAP2, amountIn.toArrayLike(Buffer, 'le', 8), minOut.toArrayLike(Buffer, 'le', 8), Buffer.from([mode])]),
    });
  }

  /** The curve as a Jupiter MeteoraDynamicBondingCurveSwap leg: its swap accounts, prefixed by the program id. */
  private curveLeg(user: PublicKey, buy: boolean): RouteLeg {
    if (this.rateLimited(buy)) throw new VenueError('This curve only takes direct swaps for now (launch rate limit). Try again in a minute.', 'UNSUPPORTED');
    return {
      swap: SWAP.meteoraDbc(),
      accounts: [{ pubkey: DBC_PROGRAM_ID, isSigner: false, isWritable: false }, ...this.swapAccounts(user, { pubkey: user, isSigner: false, isWritable: false }, buy)],
    };
  }

  private solLegs(user: PublicKey, fromSol: boolean): RouteLeg[] {
    return this.route!.leg.jupiterLegs(user, fromSol);
  }

  async buildBuy(user: PublicKey, userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number) {
    this.assertTradable();
    const wsol = this.wsolAta(user);
    const ixs: TransactionInstruction[] = [];
    if (!userAta) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, this.baseAta(user), user, this.mint.mint, this.mint.tokenProgram));
    // The routed path passes through our quote-token account; it's created once and stays.
    if (this.route) ixs.push(...hopAtas(user, this.route.leg), createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.config.quoteMint, this.quoteProgram));
    const capped = !this.route && this.curveBuy(toBig(q.inAmount)).capped;
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports: BigInt(q.inAmount.toString()) }),
      createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID),
      this.route
        ? routeV2Instruction({
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
            legs: [...this.solLegs(user, true), this.curveLeg(user, true)],
          })
        : this.swapIx(user, true, q.inAmount, q.minOut, capped ? SWAP_MODE.partialFill : SWAP_MODE.exactIn),
      // Unwraps anything not spent, plus the account rent.
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    );
    return ixs;
  }

  async buildSell(user: PublicKey, _userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number) {
    this.assertTradable();
    const wsol = this.wsolAta(user);
    const ixs: TransactionInstruction[] = [];
    if (this.route) ixs.push(...hopAtas(user, this.route.leg), createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.config.quoteMint, this.quoteProgram));
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      this.route
        ? routeV2Instruction({
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
            legs: [this.curveLeg(user, false), ...this.solLegs(user, false)],
          })
        : this.swapIx(user, false, q.inAmount, q.minOut, SWAP_MODE.exactIn),
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    );
    return ixs;
  }

  cuFloor(): number {
    return routeCuFloor(this.route);
  }

  selfAccounts(user: PublicKey): PublicKey[] {
    return [this.wsolAta(user)];
  }
}

// ----------------------------------------------------------------- adapter

export const meteoraDbc: VenueAdapter = {
  id: 'METEORA_DBC',

  async open(conn: Connection, mint: MintInfo, hint) {
    const address = hint?.account ?? (await dbcPoolByBase(conn, mint.mint));
    if (!address) return null;
    const [poolInfo, mintInfo] = await conn.getMultipleAccountsInfo([address, mint.mint], 'confirmed');
    const pool = poolInfo ? decodeDbcPool(poolInfo) : null;
    if (!pool || !pool.baseMint.equals(mint.mint)) return null;
    if (!mintInfo) throw new VenueError('Mint not found on chain', 'NOT_FOUND');

    const [configInfo, clockInfo] = await conn.getMultipleAccountsInfo([pool.config, new PublicKey(ChainClock.SYSVAR)], 'confirmed');
    if (!configInfo) throw new VenueError('Meteora bonding curve config not found', 'NOT_FOUND');
    const config = decodeDbcConfig(configInfo);
    const complete = pool.isMigrated || pool.migrationProgress !== 0 || pool.quoteReserve >= config.migrationQuoteThreshold;
    if (complete) {
      if (config.migrationOption !== 1) throw new VenueError('This coin graduated from its Meteora curve to a DAMM v1 pool (not supported yet)', 'UNSUPPORTED');
      // Migrated: the DAMM v2 venue picks it up from here. Not yet: say so, and the panel follows it over.
      if (pool.isMigrated) return null;
      throw new VenueError('The Meteora bonding curve is complete and migrating to its DAMM v2 pool', 'CURVE_COMPLETE');
    }
    const quoteMint = config.quoteMint;
    const routed = !quoteMint.equals(NATIVE_MINT);
    const quoteInfo = routed ? await conn.getAccountInfo(quoteMint, 'confirmed') : null;
    if (routed && !quoteInfo) throw new VenueError('Quote token not found on chain', 'NOT_FOUND');
    const [route, transferFee] = await Promise.all([routed ? openRoute(conn, quoteMint, address) : null, transferFeeOf(conn, mint, mintInfo)]);
    if (routed && !route) throw await nonSolQuoteNamed(conn, quoteMint);
    if (route) assertNoQuoteFee(route);
    return new DbcMarket(mint, address, pool, configInfo, quoteInfo?.owner ?? TOKEN_PROGRAM_ID, ChainClock.decode(clockInfo?.data), route, transferFee);
  },

  ownsAccount: (owner) => owner.equals(DBC_PROGRAM_ID),

  async mintOf(_conn, _account, info) {
    return decodeDbcPool(info)?.baseMint ?? null;
  },

  allowedPrograms: () => [DBC_PROGRAM_ID.toBase58(), JUPITER_PROGRAM_ID.toBase58()],
};

export type { DbcMarket };
