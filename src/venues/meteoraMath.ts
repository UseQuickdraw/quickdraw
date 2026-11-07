// Swap maths shared by Meteora's Dynamic Bonding Curve and DAMM v2, ported
// from the programs' source (MeteoraAg/dynamic-bonding-curve: curve.rs,
// math/*, base_fee/*; MeteoraAg/damm-v2: liquidity_handler/*, base_fee/*,
// state/fee.rs). Both price in Q64.64 square roots, take fees in billionths
// and round the same way, so one port serves both. BigInt throughout; the
// programs' overflow checks become thrown errors.
import { VenueError } from './types';

export const Q64 = 1n << 64n;
export const FEE_DENOMINATOR = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const BASIS_POINT_MAX = 10_000n;

const overflow = () => new VenueError('Trade amount too large for this pool', 'EMPTY');

export function mulDiv(x: bigint, y: bigint, d: bigint, up: boolean): bigint {
  if (d === 0n) throw overflow();
  const p = x * y;
  return up ? (p + d - 1n) / d : p / d;
}

const u64 = (n: bigint): bigint => {
  if (n < 0n || n > U64_MAX) throw overflow();
  return n;
};

/** checked u128 multiply */
const mul128 = (a: bigint, b: bigint): bigint => {
  const p = a * b;
  if (p > U128_MAX) throw overflow();
  return p;
};

// ------------------------------------------------------- concentrated curve

/** Δ base (token a) between two sqrt prices: L * (upper - lower) / (lower * upper). */
export function deltaBase(lower: bigint, upper: bigint, liquidity: bigint, up: boolean): bigint {
  return mulDiv(liquidity, upper - lower, lower * upper, up);
}

/** Δ quote (token b) between two sqrt prices: L * (upper - lower) / 2^128. */
export function deltaQuote(lower: bigint, upper: bigint, liquidity: bigint, up: boolean): bigint {
  const p = liquidity * (upper - lower);
  return up ? (p + (1n << 128n) - 1n) >> 128n : p >> 128n;
}

/** As the `_unsigned` variants: the result must fit a u64. */
export const deltaBaseU64 = (lower: bigint, upper: bigint, liquidity: bigint, up: boolean) => u64(deltaBase(lower, upper, liquidity, up));
export const deltaQuoteU64 = (lower: bigint, upper: bigint, liquidity: bigint, up: boolean) => u64(deltaQuote(lower, upper, liquidity, up));

/** The sqrt price after `amount` goes in: base in lowers it (rounding up), quote in raises it (rounding down). */
export function nextSqrtPriceFromInput(sqrtPrice: bigint, liquidity: bigint, amount: bigint, baseIn: boolean): bigint {
  if (amount === 0n) return sqrtPrice;
  if (baseIn) {
    const next = mulDiv(liquidity, sqrtPrice, liquidity + amount * sqrtPrice, true);
    if (next > U128_MAX) throw overflow();
    return next;
  }
  const next = sqrtPrice + (amount << 128n) / liquidity;
  if (next > U128_MAX) throw overflow();
  return next;
}

// -------------------------------------------------------------------- fees

/** The fee comes off an amount that includes it: [amount less fee, fee], the fee rounded up. */
export function excludeFee(numerator: bigint, included: bigint): [bigint, bigint] {
  const fee = mulDiv(included, numerator, FEE_DENOMINATOR, true);
  return [included - fee, fee];
}

/** The amount that, less its fee, leaves `excluded`. */
export function includeFee(numerator: bigint, excluded: bigint): bigint {
  return u64(mulDiv(excluded, FEE_DENOMINATOR, FEE_DENOMINATOR - numerator, true));
}

/** Q64 power as fee_math.rs `pow` (binary exponentiation with its exact truncations). */
function powQ64(base: bigint, exp: number): bigint {
  if (exp === 0) return Q64;
  if (exp >= 0x80000) throw overflow();
  let invert = false;
  let squared = base;
  let result = Q64;
  if (squared >= result) {
    squared = U128_MAX / squared;
    invert = !invert;
  }
  for (let bit = 0; bit < 19; bit++) {
    if (bit > 0) squared = mul128(squared, squared) >> 64n;
    if (exp & (1 << bit)) result = mul128(result, squared) >> 64n;
  }
  if (result === 0n) throw overflow();
  return invert ? U128_MAX / result : result;
}

/** cliff * (1 - reduction / 10_000) ^ period, as get_fee_in_period. */
export function feeInPeriod(cliff: bigint, reduction: bigint, period: number): bigint {
  const bps = (reduction << 64n) / BASIS_POINT_MAX;
  return u64(mul128(powQ64(Q64 - bps, period), cliff) >> 64n);
}

/** A linear or exponential schedule's fee after `period` periods (capped at the last). */
export function scheduledFee(exponential: boolean, cliff: bigint, periods: number, reduction: bigint, period: bigint): bigint {
  const p = period < BigInt(periods) ? period : BigInt(periods);
  if (!exponential) {
    const fee = cliff - reduction * p;
    if (fee < 0n) throw overflow();
    return fee;
  }
  return feeInPeriod(cliff, reduction, Number(p));
}

const toNumerator = (bps: bigint) => (bps * FEE_DENOMINATOR) / BASIS_POINT_MAX;

export interface RateLimiter {
  cliff: bigint;
  incrementBps: bigint;
  referenceAmount: bigint;
  maxFeeNumerator: bigint;
}

/** The rate limiter's fee for an input that includes it: each `referenceAmount` past the first pays `incrementBps` more, up to the max. */
export function rateLimitedFee(r: RateLimiter, input: bigint): bigint {
  if (input <= r.referenceAmount) return r.cliff;
  const c = r.cliff;
  const a = (input - r.referenceAmount) / r.referenceAmount;
  const b = (input - r.referenceAmount) % r.referenceAmount;
  const i = toNumerator(r.incrementBps);
  const maxIndex = (r.maxFeeNumerator - c) / i;
  const x0 = r.referenceAmount;
  let total: bigint;
  if (a < maxIndex) {
    total = x0 * (c + c * a + (i * a * (a + 1n)) / 2n) + b * (c + i * (a + 1n));
  } else {
    total = x0 * (c + c * maxIndex + (i * maxIndex * (maxIndex + 1n)) / 2n) + ((a - maxIndex) * x0 + b) * r.maxFeeNumerator;
  }
  const fee = u64((total + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR);
  return u64(mulDiv(fee, FEE_DENOMINATOR, input, true));
}

export interface DynamicFee {
  initialized: boolean;
  binStep: bigint;
  variableFeeControl: bigint;
  volatilityAccumulator: bigint;
}

/** The volatility fee on top of the base fee: ceil((accumulator * bin_step)^2 * control / 1e11). */
export function variableFee(d: DynamicFee): bigint {
  if (!d.initialized) return 0n;
  const sq = mul128(d.volatilityAccumulator * d.binStep, d.volatilityAccumulator * d.binStep);
  return (mul128(sq, d.variableFeeControl) + 99_999_999_999n) / 100_000_000_000n;
}

/** Spot price, raw quote (token b) per raw base (token a), from a Q64 sqrt price. */
export function priceFromSqrt(sqrtPrice: bigint): number {
  const s = Number(sqrtPrice) / 2 ** 64;
  return s * s;
}

// ------------------------------------------------------------------ layout

export const readU64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
export const readU128 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

// ------------------------------------------------------------------- clock

/**
 * The chain's clock, read once with the market's accounts and carried
 * forward locally (a slot is ~400 ms), for fees that change with time.
 * Quoting a step early or late at a schedule's period boundary only moves
 * the quote by one step; the on-chain minimum still protects the trade.
 */
export class ChainClock {
  static readonly SYSVAR = 'SysvarC1ock11111111111111111111111111111111';

  private constructor(
    private readonly slot: bigint,
    private readonly unix: bigint,
    private readonly at: number,
  ) {}

  static decode(data: Buffer | null | undefined, now = Date.now()): ChainClock {
    if (!data || data.length < 40) return new ChainClock(0n, BigInt(Math.floor(now / 1000)), now);
    return new ChainClock(data.readBigUInt64LE(0), data.readBigInt64LE(32), now);
  }

  /** The current slot (activation type 0) or unix time (type 1). */
  point(activationType: number, now = Date.now()): bigint {
    const ms = Math.max(0, now - this.at);
    return activationType === 0 ? this.slot + BigInt(Math.floor(ms / 400)) : this.unix + BigInt(Math.floor(ms / 1000));
  }
}
