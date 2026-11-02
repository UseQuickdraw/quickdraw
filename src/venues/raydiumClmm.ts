// Raydium CLMM (concentrated liquidity) as a leg of a route: SOL <-> a token
// that trades against SOL on a CLMM pool (the xStocks, for example), or USDC
// <-> a token whose liquidity sits against USDC (see routes.ts).
//
// The swap maths is a port of the program's own (`swap_internal`,
// `compute_swap`, tick and liquidity maths, the tick-array bitmap) in BigInt,
// for exact-input swaps. Only what these pools use is supported, and anything
// else is refused rather than guessed: static fees (no dynamic fee), no limit
// orders on the price path, and quote tokens without transfer hooks. Finer
// pools whose arrays run past the pool's own bitmap read the bitmap
// extension account (tick_array_bitmap_extension.rs), as the program does. A Token-2022 transfer fee on the token
// is modelled as swap_v2 charges it: the pool swaps what's left of an input
// after the fee, and an output lands less the fee.
import { PublicKey, type AccountInfo, type AccountMeta, type Connection } from '@solana/web3.js';
import BN from 'bn.js';
import {
  AccountState,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getDefaultAccountState,
  getPausableConfig,
  getTransferFeeConfig,
  getTransferHook,
  unpackMint,
} from '@solana/spl-token';
import { JUPITER_PROGRAM_ID, SWAP, type RouteLeg } from './jupiter';
import type { SolLeg } from './routes';
import { transferFeeOf, transferFeeOnRaw, type TransferFee } from './transferFee';
import { VenueError } from './types';

export const CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** routes.ts imports this module, so USDC's mint is repeated here rather than imported. */
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

const Q64 = 1n << 64n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const MIN_TICK = -443636;
const MAX_TICK = 443636;
const MIN_SQRT_PRICE_X64 = 4295048016n;
const MAX_SQRT_PRICE_X64 = 79226673521066979257578248091n;
const FEE_RATE_DENOMINATOR = 1_000_000n;
const TICK_ARRAY_SIZE = 60;
const TICK_ARRAY_BITMAP_SIZE = 512;
/** Fee configs that exist on mainnet ("amm_config" PDAs, indexes 0..20). */
const AMM_CONFIG_COUNT = 21;
/** Tick arrays handed to the program per swap (the most the transaction has room for). */
const MAX_ARRAYS_PER_SWAP = 3;

/** Thrown where the program would fail, or where an exact answer needs state we don't model. */
class ClmmError extends VenueError {
  constructor(message: string) {
    super(message, 'UNSUPPORTED');
  }
}

// ------------------------------------------------------------------- maths

const divCeil = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** mul_div on u64 / U128 / U256 values: None (an error) when the result overflows `max`. */
function mulDiv(a: bigint, b: bigint, d: bigint, ceil: boolean, max: bigint): bigint {
  if (d === 0n) throw new ClmmError('CLMM maths: division by zero');
  const r = ceil ? divCeil(a * b, d) : (a * b) / d;
  if (r > max) throw new ClmmError('CLMM maths overflow');
  return r;
}

const TICK_RATIOS: [number, bigint][] = [
  [0x2, 0xfff97272373d4000n],
  [0x4, 0xfff2e50f5f657000n],
  [0x8, 0xffe5caca7e10f000n],
  [0x10, 0xffcb9843d60f7000n],
  [0x20, 0xff973b41fa98e800n],
  [0x40, 0xff2ea16466c9b000n],
  [0x80, 0xfe5dee046a9a3800n],
  [0x100, 0xfcbe86c7900bb000n],
  [0x200, 0xf987a7253ac65800n],
  [0x400, 0xf3392b0822bb6000n],
  [0x800, 0xe7159475a2caf000n],
  [0x1000, 0xd097f3bdfd2f2000n],
  [0x2000, 0xa9f746462d9f8000n],
  [0x4000, 0x70d869a156f31c00n],
  [0x8000, 0x31be135f97ed3200n],
  [0x10000, 0x9aa508b5b85a500n],
  [0x20000, 0x5d6af8dedc582cn],
  [0x40000, 0x2216e584f5fan],
];

export function sqrtPriceAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new ClmmError('CLMM tick out of range');
  const abs = Math.abs(tick);
  let ratio = abs & 0x1 ? 0xfffcb933bd6fb800n : Q64;
  for (const [bit, mul] of TICK_RATIOS) if (abs & bit) ratio = (ratio * mul) >> 64n;
  if (tick > 0) ratio = U128_MAX / ratio;
  return ratio;
}

export function tickAtSqrtPrice(sqrtPrice: bigint): number {
  if (sqrtPrice < MIN_SQRT_PRICE_X64 || sqrtPrice >= MAX_SQRT_PRICE_X64) throw new ClmmError('CLMM sqrt price out of range');
  const msb = sqrtPrice.toString(2).length - 1;
  const log2IntegerX32 = BigInt(msb - 64) << 32n;
  let bit = 0x8000_0000_0000_0000n;
  let log2FractionX64 = 0n;
  let r = msb >= 64 ? sqrtPrice >> BigInt(msb - 63) : sqrtPrice << BigInt(63 - msb);
  for (let precision = 0; bit > 0n && precision < 16; precision++) {
    r *= r;
    const more = r >> 127n;
    r >>= 63n + more;
    log2FractionX64 += bit * more;
    bit >>= 1n;
  }
  // i128 arithmetic shifts floor, as BigInt's do.
  const log2X32 = log2IntegerX32 + (log2FractionX64 >> 32n);
  const logSqrt10001X64 = log2X32 * 59543866431248n;
  const tickLow = Number((logSqrt10001X64 - 184467440737095516n) >> 64n);
  const tickHigh = Number((logSqrt10001X64 + 15793534762490258745n) >> 64n);
  if (tickLow === tickHigh) return tickLow;
  return sqrtPriceAtTick(tickHigh) <= sqrtPrice ? tickHigh : tickLow;
}

/** get_delta_amounts_for_swap: (amount_in rounded up, amount_out rounded down), or null on MaxTokenOverflow. */
function deltaAmountsForSwap(a: bigint, b: bigint, liquidity: bigint, zeroForOne: boolean): [bigint, bigint] | null {
  if (a > b) [a, b] = [b, a];
  if (a === 0n) throw new ClmmError('CLMM zero sqrt price');
  const amount1X64 = liquidity * (b - a);
  const product = a * b;
  const amountIn = zeroForOne ? divCeil(amount1X64 << 64n, product) : (amount1X64 + U64_MAX) >> 64n;
  const amountOut = zeroForOne ? amount1X64 >> 64n : (amount1X64 << 64n) / product;
  if (amountIn > U64_MAX || amountOut > U64_MAX) return null;
  return [amountIn, amountOut];
}

function nextSqrtPriceFromInput(sqrtPrice: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (sqrtPrice < MIN_SQRT_PRICE_X64 || sqrtPrice >= MAX_SQRT_PRICE_X64) throw new ClmmError('CLMM sqrt price out of range');
  if (liquidity === 0n) throw new ClmmError('CLMM pool has no liquidity in range');
  if (amountIn === 0n) return sqrtPrice;
  if (zeroForOne) {
    // get_next_sqrt_price_from_amount_0_rounding_up (add): never overflows U256 here.
    const numerator1 = liquidity << 64n;
    return divCeil(numerator1 * sqrtPrice, numerator1 + amountIn * sqrtPrice);
  }
  const next = sqrtPrice + (amountIn << 64n) / liquidity;
  if (next > U128_MAX) throw new ClmmError('CLMM maths overflow');
  return next;
}

interface StepResult {
  sqrtPriceNext: bigint;
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
}

/** compute_swap for an exact input. */
function computeSwap(current: bigint, target: bigint, liquidity: bigint, remaining: bigint, feeRate: bigint, zeroForOne: boolean, feeOnInput: boolean): StepResult {
  const forPrice = feeOnInput ? mulDiv(remaining, FEE_RATE_DENOMINATOR - feeRate, FEE_RATE_DENOMINATOR, false, U64_MAX) : remaining;
  const atTarget = deltaAmountsForSwap(target, current, liquidity, zeroForOne);
  let r: StepResult;
  if (atTarget && forPrice >= atTarget[0]) {
    r = { sqrtPriceNext: target, amountIn: atTarget[0], amountOut: atTarget[1], fee: 0n };
  } else {
    const next = nextSqrtPriceFromInput(current, liquidity, forPrice, zeroForOne);
    const amounts = deltaAmountsForSwap(next, current, liquidity, zeroForOne);
    if (!amounts) throw new ClmmError('CLMM amount overflow');
    r = { sqrtPriceNext: next, amountIn: amounts[0], amountOut: amounts[1], fee: 0n };
  }
  if (zeroForOne ? r.sqrtPriceNext < target : target < r.sqrtPriceNext) throw new ClmmError('CLMM price moved past its target');
  if (feeOnInput) {
    if (r.sqrtPriceNext !== target) {
      if (remaining < r.amountIn) throw new ClmmError('CLMM maths overflow');
      r.fee = remaining - r.amountIn;
    } else {
      r.fee = mulDiv(r.amountIn, feeRate, FEE_RATE_DENOMINATOR - feeRate, true, U64_MAX);
    }
  } else {
    r.fee = mulDiv(r.amountOut, feeRate, FEE_RATE_DENOMINATOR, true, U64_MAX);
    r.amountOut -= r.fee;
    if (r.sqrtPriceNext !== target) r.amountIn = remaining;
  }
  return r;
}

// ------------------------------------------------------------------ state

interface PoolState {
  ammConfig: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  vault0: PublicKey;
  vault1: PublicKey;
  observation: PublicKey;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrent: number;
  status: number;
  feeOn: number;
  bitmap: bigint;
  openTime: bigint;
  dynamicFee: boolean;
  /** The dynamic fee state, when the pool has one. */
  dyn: DynamicFee | null;
}

const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
const i128 = (d: Buffer, o: number) => BigInt.asIntN(128, u128(d, o));
const key = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));

export function decodeClmmPool(info: AccountInfo<Buffer>): PoolState | null {
  const d = info.data;
  if (!info.owner.equals(CLMM_PROGRAM_ID) || d.length < 1544) return null;
  let bitmap = 0n;
  for (let i = 15; i >= 0; i--) bitmap = (bitmap << 64n) | d.readBigUInt64LE(904 + i * 8);
  return {
    ammConfig: key(d, 9),
    mint0: key(d, 73),
    mint1: key(d, 105),
    vault0: key(d, 137),
    vault1: key(d, 169),
    observation: key(d, 201),
    tickSpacing: d.readUInt16LE(235),
    liquidity: u128(d, 237),
    sqrtPrice: u128(d, 253),
    tickCurrent: d.readInt32LE(269),
    status: d[389]!,
    feeOn: d[390]!,
    bitmap,
    openTime: d.readBigUInt64LE(1080),
    dynamicFee: d.subarray(1096, 1176).some((b) => b !== 0),
    dyn: decodeDynamicFee(d.subarray(1096, 1176)),
  };
}

interface Fees {
  trade: bigint;
}

/** DynamicFeeInfo (packed, 80 bytes at 1096 in the pool); null when the pool has none (all zero). */
export interface DynamicFee {
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  control: number;
  maxVolatility: number;
  indexReference: number;
  volatilityReference: number;
  volatility: number;
  lastUpdate: number;
}

export function decodeDynamicFee(b: Buffer): DynamicFee | null {
  if (!b.some((x) => x !== 0)) return null;
  return {
    filterPeriod: b.readUInt16LE(0),
    decayPeriod: b.readUInt16LE(2),
    reductionFactor: b.readUInt16LE(4),
    control: b.readUInt32LE(6),
    maxVolatility: b.readUInt32LE(10),
    indexReference: b.readInt32LE(14),
    volatilityReference: b.readUInt32LE(18),
    volatility: b.readUInt32LE(22),
    lastUpdate: Number(b.readBigUInt64LE(26)),
  };
}

/** The highest total fee rate (10%), and the scales of states/pool_fee.rs. */
const MAX_FEE_RATE = 100_000n;
const VOLATILITY_SCALE = 10_000;
const REDUCTION_DENOMINATOR = 10_000;
const CONTROL_DENOMINATOR = 100_000n;

/** tick_spacing_index_from_tick: which tick-spacing group a tick is in (rounding down). */
export function tickSpacingIndex(tick: number, spacing: number): number {
  return tick % spacing === 0 || tick >= 0 ? Math.trunc(tick / spacing) : Math.trunc(tick / spacing) - 1;
}

/** update_reference: hold within the filter period, decay within the decay period, reset after it. */
export function updateFeeReference(f: DynamicFee, groupIndex: number, now: number): void {
  const elapsed = Math.max(0, now - f.lastUpdate);
  if (elapsed < f.filterPeriod) return;
  f.indexReference = groupIndex;
  f.volatilityReference = elapsed < f.decayPeriod ? Math.floor((f.volatility * f.reductionFactor) / REDUCTION_DENOMINATOR) : 0;
  f.lastUpdate = now;
}

/** update_volatility_accumulator: the reference plus the groups crossed since it, capped. */
function updateVolatility(f: DynamicFee, groupIndex: number): void {
  const v = f.volatilityReference + Math.abs(f.indexReference - groupIndex) * VOLATILITY_SCALE;
  f.volatility = Math.min(v, f.maxVolatility);
}

/** get_total_fee_rate: the base rate plus ceil(control * (volatility * spacing)^2 / scale), capped at 10%. */
export function totalFeeRate(base: bigint, f: DynamicFee, spacing: number): bigint {
  const crossed = BigInt(f.volatility) * BigInt(spacing);
  const den = CONTROL_DENOMINATOR * BigInt(VOLATILITY_SCALE) * BigInt(VOLATILITY_SCALE);
  const num = BigInt(f.control) * crossed * crossed;
  let dynamic = (num + den - 1n) / den;
  if (dynamic > MAX_FEE_RATE) dynamic = MAX_FEE_RATE;
  const total = base + dynamic;
  return total > MAX_FEE_RATE ? MAX_FEE_RATE : total;
}

function decodeConfig(info: AccountInfo<Buffer>): Fees {
  if (!info.owner.equals(CLMM_PROGRAM_ID) || info.data.length < 57) throw new ClmmError('CLMM fee config not found');
  return { trade: BigInt(info.data.readUInt32LE(47)) };
}

interface Tick {
  tick: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
  limitOrders: boolean;
}

const TICK_LEN = 168;
const TICK_ARRAY_LEN = 10240;

function decodeTickArray(info: AccountInfo<Buffer>): { start: number; ticks: Tick[] } | null {
  const d = info.data;
  if (!info.owner.equals(CLMM_PROGRAM_ID) || d.length !== TICK_ARRAY_LEN) return null;
  const ticks = Array.from({ length: TICK_ARRAY_SIZE }, (_, i) => {
    const o = 44 + i * TICK_LEN;
    return {
      tick: d.readInt32LE(o),
      liquidityNet: i128(d, o + 4),
      liquidityGross: u128(d, o + 20),
      limitOrders: d.readBigUInt64LE(o + 124) > 0n || d.readBigUInt64LE(o + 132) > 0n,
    };
  });
  return { start: d.readInt32LE(40), ticks };
}

const isInitialized = (t: Tick) => t.liquidityGross > 0n || t.limitOrders;

const tickCount = (spacing: number) => TICK_ARRAY_SIZE * spacing;

function arrayStart(tick: number, spacing: number): number {
  const n = tickCount(spacing);
  let start = Math.trunc(tick / n);
  if (tick < 0 && tick % n !== 0) start -= 1;
  return start * n;
}

export function tickArrayPda(pool: PublicKey, start: number): PublicKey {
  const b = Buffer.alloc(4);
  b.writeInt32BE(start);
  return PublicKey.findProgramAddressSync([Buffer.from('tick_array'), pool.toBuffer(), b], CLMM_PROGRAM_ID)[0];
}

/** Every CLMM pool pairing these two mints, whatever its config or seed (empty if the RPC refuses the scan). */
async function clmmPoolsByMints(conn: Connection, a: PublicKey, b: PublicKey): Promise<PublicKey[]> {
  const [m0, m1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  try {
    const found = await conn.getProgramAccounts(CLMM_PROGRAM_ID, {
      commitment: 'confirmed',
      dataSlice: { offset: 0, length: 0 },
      filters: [{ dataSize: 1544 }, { memcmp: { offset: 73, bytes: m0.toBase58() } }, { memcmp: { offset: 105, bytes: m1.toBase58() } }],
    });
    return found.map((f) => f.pubkey);
  } catch {
    return [];
  }
}

export function clmmPoolPda(config: PublicKey, mintA: PublicKey, mintB: PublicKey): PublicKey {
  const [m0, m1] = Buffer.compare(mintA.toBuffer(), mintB.toBuffer()) < 0 ? [mintA, mintB] : [mintB, mintA];
  return PublicKey.findProgramAddressSync([Buffer.from('pool'), config.toBuffer(), m0.toBuffer(), m1.toBuffer()], CLMM_PROGRAM_ID)[0];
}

export function ammConfigPda(index: number): PublicKey {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(index);
  return PublicKey.findProgramAddressSync([Buffer.from('amm_config'), b], CLMM_PROGRAM_ID)[0];
}

/** Ticks one 512-array bitmap spans: the pool's own covers ±this, each extension bitmap the next span out. */
function maxBitmapTick(spacing: number): number {
  return spacing * TICK_ARRAY_SIZE * TICK_ARRAY_BITMAP_SIZE;
}

const EXTENSION_BITMAPS = 14;
const U512_MASK = (1n << 512n) - 1n;

/** The pool's tick-array bitmap extension: 14 bitmaps of 512 arrays each way past the pool's own. */
export interface BitmapExtension {
  positive: bigint[];
  negative: bigint[];
}

export function bitmapExtensionPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('pool_tick_array_bitmap_extension'), pool.toBuffer()], CLMM_PROGRAM_ID)[0];
}

/** TickArrayBitmapExtension: 8 disc, pool (32), positive then negative [[u64; 8]; 14]. */
export function decodeBitmapExtension(info: AccountInfo<Buffer> | null): BitmapExtension | null {
  const d = info?.data;
  if (!d || !info!.owner.equals(CLMM_PROGRAM_ID) || d.length < 40 + 2 * EXTENSION_BITMAPS * 64) return null;
  const read = (base: number) =>
    Array.from({ length: EXTENSION_BITMAPS }, (_, i) => {
      let v = 0n;
      for (let w = 7; w >= 0; w--) v = (v << 64n) | d.readBigUInt64LE(base + i * 64 + w * 8);
      return v;
    });
  return { positive: read(40), negative: read(40 + EXTENSION_BITMAPS * 64) };
}

/** Records whether a search read the extension, so the swap hands the program that account. */
interface Search {
  ext: BitmapExtension | null;
  usedExt: boolean;
}

const lowestBit = (v: bigint): number => {
  const s = v.toString(2);
  return s.length - 1 - s.lastIndexOf('1');
};

/** tick_array_bit_map::next_initialized_tick_array_start_index: [found, start, or where the search stopped]. */
function defaultNext(p: PoolState, last: number, zeroForOne: boolean): [boolean, number] {
  const boundary = maxBitmapTick(p.tickSpacing);
  const n = tickCount(p.tickSpacing);
  const next = zeroForOne ? last - n : last + n;
  if (next < -boundary || next >= boundary) return [false, last];
  let compressed = Math.trunc(next / n) + 512;
  if (next < 0 && next % n !== 0) compressed -= 1;
  const bitPos = Math.abs(compressed);
  if (zeroForOne) {
    const shifted = (p.bitmap << BigInt(1024 - bitPos - 1)) & ((1n << 1024n) - 1n);
    if (shifted === 0n) return [false, -boundary];
    const leadingZeros = 1024 - shifted.toString(2).length;
    return [true, (bitPos - leadingZeros - 512) * n];
  }
  const shifted = p.bitmap >> BigInt(bitPos);
  if (shifted === 0n) return [false, boundary - n];
  return [true, (bitPos + lowestBit(shifted) - 512) * n];
}

/** get_bitmap_offset + get_bitmap: the extension bitmap holding `start`. */
function extensionBitmap(ext: BitmapExtension, start: number, spacing: number): bigint {
  const span = maxBitmapTick(spacing);
  let offset = Math.trunc(Math.abs(start) / span) - 1;
  if (start < 0 && Math.abs(start) % span === 0) offset -= 1;
  if (offset < 0 || offset >= EXTENSION_BITMAPS) throw new ClmmError('CLMM tick array is outside the bitmap extension');
  return (start < 0 ? ext.negative : ext.positive)[offset]!;
}

/** tick_array_offset_in_bitmap */
function extensionOffset(start: number, spacing: number): number {
  const m = Math.abs(start) % maxBitmapTick(spacing);
  let offset = Math.trunc(m / tickCount(spacing));
  if (start < 0 && m !== 0) offset = TICK_ARRAY_BITMAP_SIZE - offset;
  return offset;
}

/** next_initialized_tick_array_from_one_bitmap */
function extensionNext(ext: BitmapExtension, last: number, spacing: number, zeroForOne: boolean): [boolean, number] {
  const n = tickCount(spacing);
  const next = zeroForOne ? last - n : last + n;
  if (next < arrayStart(MIN_TICK, spacing) || next > arrayStart(MAX_TICK, spacing)) return [false, next];
  const bitmap = extensionBitmap(ext, next, spacing);
  // get_bitmap_tick_boundary
  const span = maxBitmapTick(spacing);
  let m = Math.trunc(Math.abs(next) / span);
  if (next < 0 && Math.abs(next) % span !== 0) m += 1;
  const [lo, hi] = next < 0 ? [-span * m, -span * m + span] : [span * m, span * m + span];
  const offset = extensionOffset(next, spacing);
  if (zeroForOne) {
    const shifted = (bitmap << BigInt(TICK_ARRAY_BITMAP_SIZE - 1 - offset)) & U512_MASK;
    if (shifted === 0n) return [false, lo];
    return [true, next - (512 - shifted.toString(2).length) * n];
  }
  const shifted = bitmap >> BigInt(offset);
  if (shifted === 0n) return [false, hi - n];
  return [true, next + lowestBit(shifted) * n];
}

/** PoolState::next_initialized_tick_array_start_index: null when there is none in that direction. */
function nextArrayStart(p: PoolState, search: Search, lastStart: number, zeroForOne: boolean): number | null {
  let last = arrayStart(lastStart, p.tickSpacing);
  for (;;) {
    const [found, start] = defaultNext(p, last, zeroForOne);
    if (found) return start;
    last = start;
    if (!search.ext) {
      // Spacings of 15 and up: the pool's own bitmap covers every tick, so there is no more.
      if (maxBitmapTick(p.tickSpacing) > MAX_TICK) return null;
      throw new ClmmError('This CLMM pool needs its bitmap extension, which was not found');
    }
    search.usedExt = true;
    const [extFound, extStart] = extensionNext(search.ext, last, p.tickSpacing, zeroForOne);
    if (extFound) return extStart;
    last = extStart;
    if (last < MIN_TICK || last > MAX_TICK) return null;
  }
}

/** get_first_initialized_tick_array: [the current tick's array is initialized, the first array to swap in]. */
function firstArray(p: PoolState, search: Search, zeroForOne: boolean): [boolean, number] {
  const span = maxBitmapTick(p.tickSpacing);
  const n = tickCount(p.tickSpacing);
  const start = arrayStart(p.tickCurrent, p.tickSpacing);
  // tick_array_start_index_range
  const max = span > MAX_TICK ? arrayStart(MAX_TICK, p.tickSpacing) + n : span;
  const min = -span < MIN_TICK ? arrayStart(MIN_TICK, p.tickSpacing) : -span;
  let initialized: boolean;
  if (start >= max || start < min) {
    if (!search.ext) throw new ClmmError('This CLMM pool needs its bitmap extension, which was not found');
    search.usedExt = true;
    initialized = ((extensionBitmap(search.ext, start, p.tickSpacing) >> BigInt(extensionOffset(start, p.tickSpacing))) & 1n) === 1n;
  } else {
    let compressed = Math.trunc(p.tickCurrent / n) + 512;
    if (p.tickCurrent < 0 && p.tickCurrent % n !== 0) compressed -= 1;
    initialized = ((p.bitmap >> BigInt(Math.abs(compressed))) & 1n) === 1n;
  }
  if (initialized) return [true, start];
  const next = nextArrayStart(p, search, start, zeroForOne);
  if (next === null) throw new ClmmError('The CLMM pool has no liquidity in this direction');
  return [false, next];
}

// -------------------------------------------------------------------- leg

/**
 * An anchor (SOL, USDC, or a quote token with its own SOL route) <-> token CLMM pool kept fresh by subscriptions,
 * with the tick arrays around its price. "fromSol" means from the anchor.
 */
export class ClmmLeg implements SolLeg {
  private pool: PoolState;
  private fees: Fees;
  /** start index -> ticks (null: the array account doesn't exist). */
  private arrays = new Map<number, Tick[] | null>();
  private readonly arrayKeys = new Map<string, number>();
  /** The pool's bitmap extension (null: it has none, so finer pools can't search past their own bitmap). */
  private ext: BitmapExtension | null = null;
  /** The tick arrays the latest quote each way crossed (keyed by zeroForOne), and whether to pass only those. */
  private readonly lastArrays = new Map<boolean, number[]>();
  private lean = false;
  readonly extensionKey: PublicKey;

  constructor(
    readonly address: PublicKey,
    info: AccountInfo<Buffer>,
    configInfo: AccountInfo<Buffer>,
    /** The token on the other side of the anchor. */
    readonly tokenMint: PublicKey,
    readonly tokenProgram: PublicKey,
    /** SOL, or a token that has its own SOL leg (USDC, an xStock). */
    readonly anchor: PublicKey = NATIVE_MINT,
    /** The token's Token-2022 transfer fee, if it has one. */
    readonly tokenFee: TransferFee | null = null,
    /** The anchor's token program (Token-2022 for an xStock). */
    readonly anchorProgram: PublicKey = TOKEN_PROGRAM_ID,
  ) {
    const p = decodeClmmPool(info);
    if (!p) throw new ClmmError('Raydium CLMM pool not found');
    const pair = [p.mint0.toBase58(), p.mint1.toBase58()].sort().join();
    if (pair !== [anchor.toBase58(), tokenMint.toBase58()].sort().join()) throw new ClmmError('CLMM pool does not pair the quote token as expected');
    this.pool = p;
    this.fees = decodeConfig(configInfo);
    this.extensionKey = bitmapExtensionPda(address);
    this.assertSupported();
  }

  setLean(on: boolean): void {
    this.lean = on;
  }

  setExtension(info: AccountInfo<Buffer> | null): void {
    this.ext = decodeBitmapExtension(info);
  }

  private search(): Search {
    return { ext: this.ext, usedExt: false };
  }

  private assertSupported(): void {
    if (this.pool.status & (1 << 4)) throw new VenueError('Swaps are paused on this Raydium CLMM pool', 'UNSUPPORTED');
  }

  /** Initialized tick arrays from the price outwards, both directions: what a swap of any likely size reads. */
  arraysToLoad(depth = 4): { start: number; key: PublicKey }[] {
    const starts = new Set<number>();
    for (const zeroForOne of [true, false]) {
      try {
        const search = this.search();
        let [, start] = firstArray(this.pool, search, zeroForOne);
        starts.add(start);
        for (let i = 1; i < depth; i++) {
          const next = nextArrayStart(this.pool, search, start, zeroForOne);
          if (next === null) break;
          starts.add(next);
          start = next;
        }
      } catch {
        // No liquidity that way (or beyond the bitmap): quotes that way are refused.
      }
    }
    return [...starts].map((start) => ({ start, key: tickArrayPda(this.address, start) }));
  }

  setArray(start: number, key: PublicKey, info: AccountInfo<Buffer> | null): void {
    const a = info ? decodeTickArray(info) : null;
    this.arrays.set(start, a && a.start === start ? a.ticks : null);
    this.arrayKeys.set(key.toBase58(), start);
  }

  watchAccounts(): PublicKey[] {
    return [this.address, this.pool.ammConfig, this.extensionKey, ...[...this.arrayKeys.keys()].map((k) => new PublicKey(k))];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): boolean {
    if (pubkey.equals(this.address)) {
      this.pool = decodeClmmPool(info) ?? this.pool;
      return true;
    }
    if (pubkey.equals(this.extensionKey)) {
      this.setExtension(info);
      return true;
    }
    if (pubkey.equals(this.pool.ammConfig)) {
      try {
        this.fees = decodeConfig(info);
      } catch {
        // Keep the last good rate; the route's minimum still protects the trade.
      }
      return true;
    }
    const start = this.arrayKeys.get(pubkey.toBase58());
    if (start === undefined) return false;
    this.setArray(start, pubkey, info);
    return true;
  }

  private zeroForOne(fromSol: boolean): boolean {
    return this.pool.mint0.equals(this.anchor) === fromSol;
  }

  /** The pools this leg trades on, to find lookup tables other traders use for them. */
  pools(): PublicKey[] {
    return [this.address];
  }

  hops(): { mint: PublicKey; tokenProgram: PublicKey }[] {
    return [];
  }

  private array(start: number): Tick[] {
    const a = this.arrays.get(start);
    if (a === undefined) throw new VenueError('This trade is bigger than the CLMM liquidity loaded around the price. Try a smaller amount.', 'EMPTY');
    if (a === null) throw new ClmmError('A CLMM tick array the pool marks as initialized was not found');
    return a;
  }

  /**
   * swap_internal for an exact input with no price limit: [amount out, tick arrays the swap reads, in order].
   * A dynamic-fee pool steps one tick-spacing group at a time, its fee rising with the volatility
   * accumulator as the price crosses groups (states/pool_fee.rs, SwapState in instructions/swap.rs).
   * `now` is the chain's clock in seconds: the fee's reference decays with time since its last update.
   */
  swap(amountIn: bigint, zeroForOne: boolean, now = Math.floor(Date.now() / 1000)): { out: bigint; arrays: number[] } {
    this.assertSupported();
    const p = this.pool;
    if (amountIn === 0n) throw new VenueError('Amount too small for the CLMM pool', 'EMPTY');
    const limit = zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;
    const feeOnInput = p.feeOn === 1 ? zeroForOne : p.feeOn === 2 ? !zeroForOne : true;
    const baseFee = this.fees.trade;
    const spacing = p.tickSpacing;
    // A working copy: the swap moves the accumulator, the pool's own state stays as the chain has it.
    const dyn = p.dyn ? { ...p.dyn } : null;
    let groupIndex = 0;
    if (dyn) {
      groupIndex = tickSpacingIndex(p.tickCurrent, spacing);
      updateFeeReference(dyn, groupIndex, now);
    }

    const search = this.search();
    let [containsCurrent, start] = firstArray(p, search, zeroForOne);
    let ticks = this.array(start);
    const used = [start];
    let remaining = amountIn;
    let out = 0n;
    let sqrtPrice = p.sqrtPrice;
    let tick = p.tickCurrent;
    let liquidity = p.liquidity;

    while (remaining !== 0n && sqrtPrice !== limit) {
      let next: Tick | undefined;
      if (arrayStart(tick, spacing) === start) {
        const offset = Math.trunc((tick - start) / spacing);
        if (zeroForOne) {
          for (let i = offset; i >= 0 && !next; i--) if (isInitialized(ticks[i]!)) next = ticks[i];
        } else {
          for (let i = offset + 1; i < TICK_ARRAY_SIZE && !next; i++) if (isInitialized(ticks[i]!)) next = ticks[i];
        }
      }
      if (!next) {
        if (!containsCurrent) {
          containsCurrent = true;
        } else {
          const nextStart = nextArrayStart(p, search, start, zeroForOne);
          if (nextStart === null) throw new VenueError('Not enough liquidity in the CLMM pool for this trade. Try a smaller amount.', 'EMPTY');
          start = nextStart;
          ticks = this.array(start);
          used.push(start);
        }
        next = zeroForOne ? [...ticks].reverse().find(isInitialized) : ticks.find(isInitialized);
        if (!next) throw new ClmmError('CLMM tick array has no initialized tick');
      }

      const tickNext = Math.min(MAX_TICK, Math.max(MIN_TICK, next.tick));
      const sqrtNext = sqrtPriceAtTick(tickNext);
      const target = (zeroForOne && sqrtNext < limit) || (!zeroForOne && sqrtNext > limit) ? limit : sqrtNext;
      let liquidityNext = liquidity;
      // Without a dynamic fee this runs once, straight to the target.
      for (;;) {
        if (dyn) updateVolatility(dyn, groupIndex);
        const feeRate = dyn ? totalFeeRate(baseFee, dyn, spacing) : baseFee;
        // get_spacing_bounded_price: a dynamic-fee step stops at the edge of the current group.
        let skipped = true;
        let bounded = target;
        let boundedTick: number | null = null;
        if (dyn && liquidity !== 0n && dyn.volatility !== dyn.maxVolatility) {
          skipped = false;
          const edge = Math.min(MAX_TICK, Math.max(MIN_TICK, (zeroForOne ? groupIndex : groupIndex + 1) * spacing));
          const edgePrice = sqrtPriceAtTick(edge);
          if (zeroForOne ? target <= edgePrice : target >= edgePrice) {
            bounded = edgePrice;
            boundedTick = edge;
          }
        }
        let stepNext = bounded;
        if (sqrtPrice !== bounded) {
          const r = computeSwap(sqrtPrice, bounded, liquidity, remaining, feeRate, zeroForOne, feeOnInput);
          remaining -= feeOnInput ? r.amountIn + r.fee : r.amountIn;
          out += r.amountOut;
          stepNext = r.sqrtPriceNext;
        }
        if (sqrtNext === stepNext) {
          // Reaching a tick with resting limit orders would fill them at this price: not modelled.
          if (next.limitOrders) throw new ClmmError('This trade would reach Raydium CLMM limit orders (not supported yet). Try a smaller amount.');
          if (next.liquidityGross > 0n) {
            const net = zeroForOne ? -next.liquidityNet : next.liquidityNet;
            liquidityNext = liquidity + net;
            if (net < 0n ? liquidityNext >= liquidity : liquidityNext < liquidity) throw new ClmmError('CLMM liquidity error');
          }
          tick = zeroForOne ? tickNext - 1 : tickNext;
        } else if (sqrtPrice !== stepNext) {
          tick = boundedTick !== null && stepNext === bounded ? boundedTick : tickAtSqrtPrice(stepNext);
        }
        sqrtPrice = stepNext;
        // update_dynamic_fee_index
        if (dyn) {
          if (skipped) {
            const at = sqrtPrice === sqrtNext ? tickNext : tick;
            let index = tickSpacingIndex(at, spacing);
            if (!zeroForOne && at % spacing === 0) index -= 1;
            groupIndex = index;
            if (dyn.volatility !== dyn.maxVolatility) updateVolatility(dyn, groupIndex);
          }
          groupIndex += zeroForOne ? -1 : 1;
        }
        if (remaining === 0n || sqrtPrice === target) break;
      }
      liquidity = liquidityNext;
    }
    // No price limit: the program requires the whole input to be swapped.
    if (remaining !== 0n) throw new VenueError('Not enough liquidity in the CLMM pool for this trade. Try a smaller amount.', 'EMPTY');
    if (out === 0n) throw new VenueError('Amount too small for the CLMM pool', 'EMPTY');
    return { out, arrays: used };
  }

  quote(amount: bigint, fromSol: boolean): bigint {
    // swap_v2 swaps what reaches the vault: the input less its transfer fee.
    const swapped = fromSol ? amount : amount - transferFeeOnRaw(this.tokenFee, amount);
    if (swapped <= 0n) throw new VenueError('Amount too small for the CLMM pool', 'EMPTY');
    const r = this.swap(swapped, this.zeroForOne(fromSol));
    this.lastArrays.set(this.zeroForOne(fromSol), r.arrays);
    // The route hands the program a fixed number of tick arrays.
    if (r.arrays.length > MAX_ARRAYS_PER_SWAP) throw new VenueError('This trade would cross more CLMM liquidity than one transaction can carry. Try a smaller amount.', 'EMPTY');
    // The payout lands less the token's transfer fee.
    return fromSol ? r.out - transferFeeOnRaw(this.tokenFee, r.out) : r.out;
  }

  /** Spot price: raw anchor (lamports, for SOL) per raw token. */
  lamportsPerToken(): number {
    const p = Number(this.pool.sqrtPrice) / Number(Q64);
    const oneIn0 = p * p; // token1 per token0
    return this.pool.mint0.equals(this.anchor) ? 1 / oneIn0 : oneIn0;
  }

  /** The anchor the pool holds (raw): how deep it is. */
  static anchorReserve(vault: AccountInfo<Buffer> | null): bigint {
    return vault && vault.data.length >= 72 ? vault.data.readBigUInt64LE(64) : 0n;
  }

  /**
   * The pool as a Jupiter RaydiumClmmV2 leg, laid out as in Jupiter's own
   * transactions: swap_v2's accounts, then the tick arrays in swap order,
   * and a trailing Jupiter program id. The bitmap extension goes first among
   * them only when finding these arrays reads it (the program checks for it
   * there); otherwise it's left out, as the transaction is close to full. The
   * arrays are the first initialized one in the swap's direction and the next
   * ones after it, as many as a quote may use.
   */
  jupiterLegs(user: PublicKey, fromSol: boolean): RouteLeg[] {
    return [this.jupiterLeg(user, fromSol)];
  }

  jupiterLeg(user: PublicKey, fromSol: boolean): RouteLeg {
    const p = this.pool;
    const zeroForOne = this.zeroForOne(fromSol);
    const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
    const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
    const program = (mint: PublicKey) => (mint.equals(this.anchor) ? this.anchorProgram : this.tokenProgram);
    const [inMint, outMint] = zeroForOne ? [p.mint0, p.mint1] : [p.mint1, p.mint0];
    const [inVault, outVault] = zeroForOne ? [p.vault0, p.vault1] : [p.vault1, p.vault0];
    const search = this.search();
    const starts = [firstArray(p, search, zeroForOne)[1]];
    const used = this.lastArrays.get(zeroForOne);
    // Lean: exactly the arrays the quote crossed (when it started where the swap will).
    const maxArrays = this.lean && used && used[0] === starts[0] ? used.length : MAX_ARRAYS_PER_SWAP;
    while (starts.length < maxArrays) {
      const next = nextArrayStart(p, search, starts[starts.length - 1]!, zeroForOne);
      if (next === null || !this.arrays.get(next)) break;
      starts.push(next);
    }
    return {
      swap: SWAP.raydiumClmmV2(),
      accounts: [
        r(CLMM_PROGRAM_ID),
        w(user),
        r(p.ammConfig),
        w(this.address),
        w(getAssociatedTokenAddressSync(inMint, user, true, program(inMint))),
        w(getAssociatedTokenAddressSync(outMint, user, true, program(outMint))),
        w(inVault),
        w(outVault),
        w(p.observation),
        r(TOKEN_PROGRAM_ID),
        r(TOKEN_2022_PROGRAM_ID),
        r(MEMO_PROGRAM_ID),
        r(inMint),
        r(outMint),
        ...(search.usedExt ? [w(this.extensionKey)] : []),
        ...starts.map((s) => w(tickArrayPda(this.address, s))),
        r(JUPITER_PROGRAM_ID),
      ],
    };
  }

  /**
   * Opens the deepest CLMM pool pairing `token` with `anchor` (SOL by
   * default), or null when there is none we can use. `reserve` is the anchor
   * it holds, to compare it with other routes.
   */
  static async open(conn: Connection, token: PublicKey, anchor: PublicKey = NATIVE_MINT): Promise<{ leg: ClmmLeg; reserve: bigint } | null> {
    const configs = Array.from({ length: AMM_CONFIG_COUNT }, (_, i) => ammConfigPda(i));
    const pools = configs.map((c) => clmmPoolPda(c, anchor, token));
    // Customizable pools (often the dynamic-fee ones) add a seed index to their address, so
    // they're found by their two mints instead. Best effort: some RPCs refuse program scans.
    for (const key of await clmmPoolsByMints(conn, anchor, token)) if (!pools.some((p) => p.equals(key))) pools.push(key);
    // SOL and USDC are classic SPL tokens; any other anchor (an xStock) is read for its program and extensions.
    const plainAnchor = anchor.equals(NATIVE_MINT) || anchor.equals(USDC);
    const [mintInfo, ...poolInfos] = await conn.getMultipleAccountsInfo([token, ...pools], 'confirmed');
    const anchorInfo = plainAnchor ? null : await conn.getAccountInfo(anchor, 'confirmed');
    const found = poolInfos.flatMap((info, i) => {
      const p = info ? decodeClmmPool(info) : null;
      return p && info && p.liquidity > 0n ? [{ key: pools[i]!, info, p }] : [];
    });
    if (!found.length || !mintInfo) return null;
    assertPlainToken(token, mintInfo, { allowFee: true });
    // Only the token's fee is modelled, not one on the anchor.
    if (anchorInfo) assertPlainToken(anchor, anchorInfo);
    // The deepest pool by the anchor it holds that can actually fill a trade:
    // a pool can hold anchor yet have no liquidity in range (DJT's SOL pool held
    // 0.0001 SOL and could fill nothing), and choosing it fails every click.
    const vaultKeys = found.map((f) => (f.p.mint0.equals(anchor) ? f.p.vault0 : f.p.vault1));
    // A vault that can't be read only rules out its own pool.
    const vaults = await conn
      .getMultipleAccountsInfo(vaultKeys, 'confirmed')
      .catch(() => Promise.all(vaultKeys.map((k) => conn.getAccountInfo(k, 'confirmed').catch(() => null))));
    const ranked = found.map((f, i) => ({ ...f, reserve: ClmmLeg.anchorReserve(vaults[i] ?? null) })).sort((a, b) => (b.reserve > a.reserve ? 1 : b.reserve < a.reserve ? -1 : 0));
    const fee = await transferFeeOf(conn, { mint: token, tokenProgram: mintInfo.owner, decimals: 0, supply: new BN(0) }, mintInfo);
    // Each candidate loads on its own: one that fails to load (a missing account, a refused read) is skipped,
    // and with none usable there's simply no route this way.
    for (const pick of ranked) {
      try {
        const configInfo = await conn.getAccountInfo(pick.p.ammConfig, 'confirmed');
        if (!configInfo) throw new ClmmError('CLMM fee config not found');
        const leg = new ClmmLeg(pick.key, pick.info, configInfo, token, mintInfo.owner, anchor, fee, anchorInfo?.owner ?? TOKEN_PROGRAM_ID);
        leg.setExtension(await conn.getAccountInfo(leg.extensionKey, 'confirmed'));
        const arrays = leg.arraysToLoad();
        const arrayInfos = await conn.getMultipleAccountsInfo(arrays.map((a) => a.key), 'confirmed');
        arrays.forEach((a, i) => leg.setArray(a.start, a.key, arrayInfos[i] ?? null));
        if (ClmmLeg.canFill(leg, pick.reserve)) return { leg, reserve: pick.reserve };
      } catch {
        // Next candidate.
      }
    }
    return null;
  }

  /** Whether a small trade (a thousandth of the anchor the pool holds) fills both ways. */
  static canFill(leg: ClmmLeg, reserve: bigint): boolean {
    const probe = reserve / 1000n;
    if (probe <= 0n) return false;
    try {
      const tokens = leg.quote(probe, true);
      return tokens > 0n && leg.quote(tokens, false) > 0n;
    } catch {
      return false;
    }
  }
}

/**
 * Refuses quote tokens whose transfers we can't route as plain transfers: a
 * transfer fee (unless the caller models it), a transfer hook program, paused
 * transfers, or new accounts that start frozen. (The xStocks carry these
 * extensions but leave them off.)
 */
export function assertPlainToken(mint: PublicKey, info: AccountInfo<Buffer>, opts: { allowFee?: boolean } = {}): void {
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) return;
  const m = unpackMint(mint, info, TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(m);
  if (!opts.allowFee && fee && (fee.newerTransferFee.transferFeeBasisPoints > 0 || fee.olderTransferFee.transferFeeBasisPoints > 0)) {
    throw new ClmmError('The quote token has a transfer fee (not supported yet)');
  }
  const hook = getTransferHook(m);
  if (hook && !hook.programId.equals(PublicKey.default)) throw new ClmmError('The quote token runs a transfer hook (not supported yet)');
  if (getPausableConfig(m)?.paused) throw new VenueError('Transfers of the quote token are paused', 'UNSUPPORTED');
  if (getDefaultAccountState(m)?.state === AccountState.Frozen) throw new ClmmError('New accounts for the quote token start frozen (not supported)');
}
