// Orca Whirlpool (concentrated liquidity), as a leg of a route: SOL (or
// another anchor, such as USDC) <-> the quote token. Pools are found from
// their addresses (Orca's main config, every static fee tier), so any token
// with an Orca pool can route; classic SPL and plain Token-2022 tokens. The maths is a line-by-line port of the program
// (orca-so/whirlpools: math/tick_math.rs, swap_math.rs, token_math.rs and
// manager/swap_manager.rs), in BigInt, so quotes match the chain to the unit.
// Only static-fee pools; adaptive-fee pools are refused.
import { PublicKey, type AccountInfo, type AccountMeta, type Connection } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SWAP, type RouteLeg } from './jupiter';
import type { SolLeg } from './routes';
import { assertPlainToken } from './raydiumClmm';
import { VenueError } from './types';

export const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
/** Orca's main WhirlpoolsConfig, which nearly every public pool belongs to. */
const WHIRLPOOLS_CONFIG = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');
/** Static fee tiers' tick spacings (a static pool's fee tier index is its spacing; adaptive ones differ and are refused). */
const FEE_TIER_SPACINGS = [1, 2, 4, 8, 16, 32, 64, 96, 128, 256, 32896];

export function whirlpoolPda(mintA: PublicKey, mintB: PublicKey, feeTierIndex: number): PublicKey {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(feeTierIndex);
  return PublicKey.findProgramAddressSync([Buffer.from('whirlpool'), WHIRLPOOLS_CONFIG.toBuffer(), mintA.toBuffer(), mintB.toBuffer(), b], WHIRLPOOL_PROGRAM_ID)[0];
}
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const Q64 = 1n << 64n;
const U64_MAX = Q64 - 1n;
const U128 = 1n << 128n;
const FEE_RATE_MUL = 1_000_000n;
const MIN_SQRT_PRICE = 4295048016n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;
const MIN_TICK = -443636;
const MAX_TICK = 443636;
const TICK_ARRAY_SIZE = 88;
const LOG_B_2_X32 = 59543866431248n;
const LOG_B_P_ERR_MARGIN_LOWER_X64 = 184467440737095516n;
const LOG_B_P_ERR_MARGIN_UPPER_X64 = 15793534762490258745n;

const WHIRLPOOL_DISC = Buffer.from('3f95d10ce1806309', 'hex');
const FIXED_TICK_ARRAY_DISC = Buffer.from('4561bdbe6e0742bb', 'hex');
const DYNAMIC_TICK_ARRAY_DISC = Buffer.from('11d8f68ee1c7da38', 'hex');

// ------------------------------------------------------------- tick maths

const POSITIVE: [number, bigint][] = [
  [2, 79236085330515764027303304731n],
  [4, 79244008939048815603706035061n],
  [8, 79259858533276714757314932305n],
  [16, 79291567232598584799939703904n],
  [32, 79355022692464371645785046466n],
  [64, 79482085999252804386437311141n],
  [128, 79736823300114093921829183326n],
  [256, 80248749790819932309965073892n],
  [512, 81282483887344747381513967011n],
  [1024, 83390072131320151908154831281n],
  [2048, 87770609709833776024991924138n],
  [4096, 97234110755111693312479820773n],
  [8192, 119332217159966728226237229890n],
  [16384, 179736315981702064433883588727n],
  [32768, 407748233172238350107850275304n],
  [65536, 2098478828474011932436660412517n],
  [131072, 55581415166113811149459800483533n],
  [262144, 38992368544603139932233054999993551n],
];

const NEGATIVE: [number, bigint][] = [
  [2, 18444899583751176498n],
  [4, 18443055278223354162n],
  [8, 18439367220385604838n],
  [16, 18431993317065449817n],
  [32, 18417254355718160513n],
  [64, 18387811781193591352n],
  [128, 18329067761203520168n],
  [256, 18212142134806087854n],
  [512, 17980523815641551639n],
  [1024, 17526086738831147013n],
  [2048, 16651378430235024244n],
  [4096, 15030750278693429944n],
  [8192, 12247334978882834399n],
  [16384, 8131365268884726200n],
  [32768, 3584323654723342297n],
  [65536, 696457651847595233n],
  [131072, 26294789957452057n],
  [262144, 37481735321082n],
];

export function sqrtPriceFromTick(tick: number): bigint {
  if (tick >= 0) {
    let ratio = tick & 1 ? 79232123823359799118286999567n : 79228162514264337593543950336n;
    for (const [bit, c] of POSITIVE) if (tick & bit) ratio = (ratio * c) >> 96n;
    return ratio >> 32n;
  }
  const abs = -tick;
  let ratio = abs & 1 ? 18445821805675392311n : 18446744073709551616n;
  for (const [bit, c] of NEGATIVE) if (abs & bit) ratio = (ratio * c) >> 64n;
  return ratio;
}

export function tickFromSqrtPrice(sqrtPrice: bigint): number {
  const msb = sqrtPrice.toString(2).length - 1;
  const log2pIntegerX32 = BigInt(msb - 64) << 32n;
  let bit = 0x8000_0000_0000_0000n;
  let r = msb >= 64 ? sqrtPrice >> BigInt(msb - 63) : sqrtPrice << BigInt(63 - msb);
  let log2pFractionX64 = 0n;
  for (let precision = 0; bit > 0n && precision < 14; precision++) {
    r *= r;
    const isMoreThanTwo = r >> 127n;
    r >>= 63n + isMoreThanTwo;
    log2pFractionX64 += bit * isMoreThanTwo;
    bit >>= 1n;
  }
  const logbpX64 = (log2pIntegerX32 + (log2pFractionX64 >> 32n)) * LOG_B_2_X32;
  const low = Number((logbpX64 - LOG_B_P_ERR_MARGIN_LOWER_X64) >> 64n);
  const high = Number((logbpX64 + LOG_B_P_ERR_MARGIN_UPPER_X64) >> 64n);
  if (low === high) return low;
  return sqrtPriceFromTick(high) <= sqrtPrice ? high : low;
}

// ------------------------------------------------------------ token maths

/** An amount that may not fit a u64 (the program's AmountDeltaU64). */
type Delta = { value: bigint; exceeds: boolean };
const ceilDiv = (n: bigint, d: bigint) => (n % d === 0n ? n / d : n / d + 1n);

function deltaA(p0: bigint, p1: bigint, liquidity: bigint, roundUp: boolean): Delta {
  const [lo, hi] = p0 < p1 ? [p0, p1] : [p1, p0];
  const numerator = (liquidity * (hi - lo)) << 64n;
  const denominator = hi * lo;
  const value = roundUp ? ceilDiv(numerator, denominator) : numerator / denominator;
  return { value, exceeds: value > U64_MAX };
}

function deltaB(p0: bigint, p1: bigint, liquidity: bigint, roundUp: boolean): Delta {
  const [lo, hi] = p0 < p1 ? [p0, p1] : [p1, p0];
  const diff = hi - lo;
  if (liquidity === 0n || diff === 0n) return { value: 0n, exceeds: false };
  const p = liquidity * diff;
  if (p >= U128) return { value: 0n, exceeds: true };
  const result = p >> 64n;
  const round = roundUp && (p & U64_MAX) > 0n;
  if (round && result === U64_MAX) return { value: 0n, exceeds: true };
  return { value: round ? result + 1n : result, exceeds: false };
}

function valid(d: Delta): bigint {
  if (d.exceeds) throw new VenueError('Swap amount is out of range for the pool', 'EMPTY');
  return d.value;
}

function nextSqrtPrice(sqrtPrice: bigint, liquidity: bigint, amount: bigint, isInput: boolean, aToB: boolean): bigint {
  if (isInput === aToB) {
    // From A, rounded up.
    if (amount === 0n) return sqrtPrice;
    const product = sqrtPrice * amount;
    const numerator = (liquidity * sqrtPrice) << 64n;
    const liquidityShifted = liquidity << 64n;
    if (!isInput && liquidityShifted <= product) throw new VenueError('Swap is larger than the pool', 'EMPTY');
    const price = ceilDiv(numerator, isInput ? liquidityShifted + product : liquidityShifted - product);
    if (price < MIN_SQRT_PRICE || price > MAX_SQRT_PRICE) throw new VenueError('Swap is larger than the pool', 'EMPTY');
    return price;
  }
  // From B, rounded down.
  const amountX64 = amount << 64n;
  const delta = isInput ? amountX64 / liquidity : ceilDiv(amountX64, liquidity);
  return isInput ? sqrtPrice + delta : sqrtPrice - delta;
}

interface Step {
  amountIn: bigint;
  amountOut: bigint;
  nextPrice: bigint;
  fee: bigint;
}

/** compute_swap from swap_math.rs. */
function computeSwap(remaining: bigint, feeRate: bigint, liquidity: bigint, current: bigint, target: bigint, isInput: boolean, aToB: boolean): Step {
  const fixedIsA = aToB === isInput;
  const fixed = (to: bigint) => (fixedIsA ? deltaA(current, to, liquidity, isInput) : deltaB(current, to, liquidity, isInput));
  const unfixed = (to: bigint) => (fixedIsA ? deltaB(current, to, liquidity, !isInput) : deltaA(current, to, liquidity, !isInput));

  const initial = fixed(target);
  const amountCalc = isInput ? (remaining * (FEE_RATE_MUL - feeRate)) / FEE_RATE_MUL : remaining;
  const next = !initial.exceeds && initial.value <= amountCalc ? target : nextSqrtPrice(current, liquidity, amountCalc, isInput, aToB);
  const isMax = next === target;
  const unfixedDelta = valid(unfixed(next));
  const fixedDelta = !isMax || initial.exceeds ? valid(fixed(next)) : initial.value;
  let [amountIn, amountOut] = isInput ? [fixedDelta, unfixedDelta] : [unfixedDelta, fixedDelta];
  if (!isInput && amountOut > remaining) amountOut = remaining;
  const fee = isInput && !isMax ? remaining - amountIn : ceilDiv(amountIn * feeRate, FEE_RATE_MUL - feeRate);
  return { amountIn, amountOut, nextPrice: next, fee };
}

// ------------------------------------------------------------- tick arrays

/** The initialized ticks of one tick array: offset -> liquidity_net. */
export interface TickArrayData {
  start: number;
  ticks: Map<number, bigint>;
}

const i128 = (d: Buffer, o: number) => (d.readBigInt64LE(o + 8) << 64n) + d.readBigUInt64LE(o);

export function decodeTickArray(info: AccountInfo<Buffer>): TickArrayData | null {
  const d = info.data;
  if (!info.owner.equals(WHIRLPOOL_PROGRAM_ID) || d.length < 60) return null;
  const disc = d.subarray(0, 8);
  const start = d.readInt32LE(8);
  const ticks = new Map<number, bigint>();
  if (disc.equals(FIXED_TICK_ARRAY_DISC)) {
    // start(4) then 88 x Tick { initialized u8, liquidity_net i128, ... } of 113 bytes
    for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
      const o = 12 + i * 113;
      if (d[o]) ticks.set(i, i128(d, o + 1));
    }
  } else if (disc.equals(DYNAMIC_TICK_ARRAY_DISC)) {
    // start(4) whirlpool(32) tick_bitmap(16), then per tick: tag 0 (1 byte) or tag 1 + 112 bytes
    let o = 60;
    for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
      if (d[o] === 1) {
        ticks.set(i, i128(d, o + 1));
        o += 113;
      } else {
        o += 1;
      }
    }
  } else {
    return null;
  }
  return { start, ticks };
}

export function tickArrayPda(whirlpool: PublicKey, start: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('tick_array'), whirlpool.toBuffer(), Buffer.from(String(start))], WHIRLPOOL_PROGRAM_ID)[0];
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);

// ------------------------------------------------------------------- pool

export interface WhirlpoolState {
  tickSpacing: number;
  feeRate: bigint;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrent: number;
  mintA: PublicKey;
  vaultA: PublicKey;
  mintB: PublicKey;
  vaultB: PublicKey;
  adaptiveFee: boolean;
}

const u128 = (d: Buffer, o: number) => (d.readBigUInt64LE(o + 8) << 64n) + d.readBigUInt64LE(o);

export function decodeWhirlpool(info: AccountInfo<Buffer>): WhirlpoolState | null {
  const d = info.data;
  if (!info.owner.equals(WHIRLPOOL_PROGRAM_ID) || d.length < 245 || !d.subarray(0, 8).equals(WHIRLPOOL_DISC)) return null;
  const tickSpacing = d.readUInt16LE(41);
  return {
    tickSpacing,
    // fee_tier_index differs from tick_spacing only on adaptive-fee pools
    adaptiveFee: d.readUInt16LE(43) !== tickSpacing,
    feeRate: BigInt(d.readUInt16LE(45)),
    liquidity: u128(d, 49),
    sqrtPrice: u128(d, 65),
    tickCurrent: d.readInt32LE(81),
    mintA: new PublicKey(d.subarray(101, 133)),
    vaultA: new PublicKey(d.subarray(133, 165)),
    mintB: new PublicKey(d.subarray(181, 213)),
    vaultB: new PublicKey(d.subarray(213, 245)),
  };
}

/**
 * An anchor (SOL, or USDC) <-> token Whirlpool kept fresh by subscriptions.
 * It loads the tick arrays around the price once; a swap that needs one it
 * didn't load is refused rather than guessed. "fromSol" means from the anchor.
 */
export class WhirlpoolLeg implements SolLeg {
  private state: WhirlpoolState;
  /** start index -> data (null: the array doesn't exist, so it holds no liquidity). */
  private arrays = new Map<number, TickArrayData | null>();
  private readonly arrayKeys = new Map<string, number>();

  constructor(
    readonly address: PublicKey,
    info: AccountInfo<Buffer>,
    /** The token on the other side of the anchor (the mint a venue's pool is quoted in). */
    readonly tokenMint: PublicKey,
    /** SOL, or a classic SPL token (USDC) that has its own SOL leg. */
    readonly anchor: PublicKey = NATIVE_MINT,
    /** The token's program (classic SPL or Token-2022). */
    readonly tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
    readonly anchorProgram: PublicKey = TOKEN_PROGRAM_ID,
  ) {
    const s = decodeWhirlpool(info);
    if (!s) throw new VenueError('Whirlpool not found', 'NOT_FOUND');
    if (s.adaptiveFee) throw new VenueError('This Whirlpool uses adaptive fees (not supported)', 'UNSUPPORTED');
    const pair = [s.mintA.toBase58(), s.mintB.toBase58()].sort().join();
    if (pair !== [anchor.toBase58(), tokenMint.toBase58()].sort().join()) throw new VenueError('Whirlpool does not pair the quote token as expected', 'UNSUPPORTED');
    this.state = s;
  }

  /** The anchor the pool holds (raw), from its vault: how deep it is. */
  get anchorVault(): PublicKey {
    return this.state.mintA.equals(this.anchor) ? this.state.vaultA : this.state.vaultB;
  }

  /**
   * Opens the deepest static-fee Orca pool pairing `token` with `anchor` (SOL
   * by default), or null when there is none we can use. `reserve` is the
   * anchor it holds, to compare it with other routes.
   */
  static async open(conn: Connection, token: PublicKey, anchor: PublicKey = NATIVE_MINT): Promise<{ leg: WhirlpoolLeg; reserve: bigint } | null> {
    if (token.equals(anchor)) return null;
    const [mintA, mintB] = Buffer.compare(token.toBuffer(), anchor.toBuffer()) < 0 ? [token, anchor] : [anchor, token];
    const pools = FEE_TIER_SPACINGS.map((t) => whirlpoolPda(mintA, mintB, t));
    const [mintInfo, anchorInfo, ...infos] = await conn.getMultipleAccountsInfo([token, anchor, ...pools], 'confirmed');
    if (!mintInfo || !anchorInfo) return null;
    const found = infos.flatMap((info, i) => {
      const st = info ? decodeWhirlpool(info) : null;
      return st && info && !st.adaptiveFee && st.liquidity > 0n ? [{ key: pools[i]!, info, st }] : [];
    });
    if (!found.length) return null;
    assertPlainToken(token, mintInfo);
    const vaults = await conn.getMultipleAccountsInfo(found.map((f) => (f.st.mintA.equals(anchor) ? f.st.vaultA : f.st.vaultB)), 'confirmed');
    const reserve = (i: number) => (vaults[i] && vaults[i]!.data.length >= 72 ? vaults[i]!.data.readBigUInt64LE(64) : 0n);
    let best = 0;
    found.forEach((_, i) => {
      if (reserve(i) > reserve(best)) best = i;
    });
    const pick = found[best]!;
    const leg = new WhirlpoolLeg(pick.key, pick.info, token, anchor, mintInfo.owner, anchorInfo.owner);
    const arrays = leg.arraysToLoad();
    const arrayInfos = await conn.getMultipleAccountsInfo(arrays.map((a) => a.key), 'confirmed');
    arrays.forEach((a, i) => leg.setArray(a.start, a.key, arrayInfos[i] ?? null));
    return { leg, reserve: reserve(best) };
  }

  /** The tick arrays a swap might touch from the current price, in both directions, plus margin. */
  arraysToLoad(): { start: number; key: PublicKey }[] {
    const span = TICK_ARRAY_SIZE * this.state.tickSpacing;
    const base = floorDiv(this.state.tickCurrent, span) * span;
    return [-3, -2, -1, 0, 1, 2, 3, 4].map((k) => base + k * span).map((start) => ({ start, key: tickArrayPda(this.address, start) }));
  }

  setArray(start: number, key: PublicKey, info: AccountInfo<Buffer> | null): void {
    this.arrays.set(start, info && info.data.length ? decodeTickArray(info) : null);
    this.arrayKeys.set(key.toBase58(), start);
  }

  watchAccounts(): PublicKey[] {
    return [this.address, ...[...this.arrayKeys.keys()].map((k) => new PublicKey(k))];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): boolean {
    if (pubkey.equals(this.address)) {
      const s = decodeWhirlpool(info);
      if (s) this.state = s;
      return true;
    }
    const start = this.arrayKeys.get(pubkey.toBase58());
    if (start === undefined) return false;
    this.arrays.set(start, info.data.length ? decodeTickArray(info) : null);
    return true;
  }

  get sqrtPrice(): bigint {
    return this.state.sqrtPrice;
  }

  /** a_to_b for a swap out of the anchor (or into it). */
  aToB(fromSol: boolean): boolean {
    return this.state.mintA.equals(this.anchor) === fromSol;
  }

  /** Start indexes of the three tick arrays the program walks (sparse_swap.rs get_start_tick_indexes). */
  private sequence(aToB: boolean): number[] {
    const span = TICK_ARRAY_SIZE * this.state.tickSpacing;
    const tick = this.state.tickCurrent;
    const base = floorDiv(tick, span) * span;
    const offsets = aToB ? [0, -1, -2] : tick + this.state.tickSpacing >= base + span ? [1, 2, 3] : [0, 1, 2];
    return offsets.map((k) => base + k * span);
  }

  /** Raw tokens out for an exact input (manager/swap_manager.rs `swap`, static fee). */
  swapExactIn(amount: bigint, aToB: boolean): bigint {
    if (amount <= 0n) throw new VenueError('Swap amount is zero', 'EMPTY');
    const s = this.state;
    const spacing = s.tickSpacing;
    const span = TICK_ARRAY_SIZE * spacing;
    const starts = this.sequence(aToB);
    const seq = starts.map((start) => {
      if (!this.arrays.has(start)) throw new VenueError('The quote-token price moved out of the loaded range. Reload the page.', 'NOT_FOUND');
      return { start, ticks: this.arrays.get(start)?.ticks ?? new Map<number, bigint>() };
    });
    const limit = aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
    const tooBig = () => new VenueError('This trade is too large for the quote-token pool', 'EMPTY');

    // swap_tick_sequence.rs get_next_initialized_tick_index
    const nextInitialized = (tickIndex: number, from: number): [number, number] => {
      let search = tickIndex;
      for (let i = from; ; i++) {
        const arr = seq[i];
        if (!arr) throw tooBig();
        const shift = aToB ? 0 : spacing;
        if (search < arr.start - shift || search >= arr.start + span - shift) throw tooBig();
        let off = floorDiv(search - arr.start, spacing) + (aToB ? 0 : 1);
        for (; off >= 0 && off < TICK_ARRAY_SIZE; off += aToB ? -1 : 1) {
          if (arr.ticks.has(off)) return [i, arr.start + off * spacing];
        }
        if (aToB && arr.start <= MIN_TICK) return [i, MIN_TICK];
        if (!aToB && arr.start + span > MAX_TICK) return [i, MAX_TICK];
        if (i + 1 === seq.length) return [i, aToB ? arr.start : arr.start + span - 1];
        search = aToB ? arr.start - 1 : arr.start + span - 1;
      }
    };

    let remaining = amount;
    let out = 0n;
    let price = s.sqrtPrice;
    let tick = s.tickCurrent;
    let liquidity = s.liquidity;
    let arrayIndex = 0;
    while (remaining > 0n && price !== limit) {
      const [nextArray, nextTick] = nextInitialized(tick, arrayIndex);
      const nextTickPrice = sqrtPriceFromTick(nextTick);
      const target = aToB ? (nextTickPrice > limit ? nextTickPrice : limit) : nextTickPrice < limit ? nextTickPrice : limit;
      const step = computeSwap(remaining, s.feeRate, liquidity, price, target, true, aToB);
      remaining -= step.amountIn + step.fee;
      out += step.amountOut;
      if (step.nextPrice === nextTickPrice) {
        const arr = seq[nextArray]!;
        const off = floorDiv(nextTick - arr.start, spacing);
        // get_tick: only a usable tick (a multiple of the spacing) inside this array can be initialized
        const usable = nextTick % spacing === 0 && off >= 0 && off < TICK_ARRAY_SIZE;
        const net = usable ? arr.ticks.get(off) : undefined;
        if (net !== undefined) liquidity = aToB ? liquidity - net : liquidity + net;
        arrayIndex = (aToB && off === 0) || (!aToB && off === TICK_ARRAY_SIZE - 1) ? nextArray + 1 : nextArray;
        tick = aToB ? nextTick - 1 : nextTick;
      } else if (step.nextPrice !== price) {
        tick = tickFromSqrtPrice(step.nextPrice);
      }
      price = step.nextPrice;
    }
    if (out > U64_MAX) throw tooBig();
    return out;
  }

  quote(amount: bigint, fromSol: boolean): bigint {
    return this.swapExactIn(amount, this.aToB(fromSol));
  }

  /** The pools this leg trades on, to find lookup tables other traders use for them. */
  pools(): PublicKey[] {
    return [this.address];
  }

  hops(): { mint: PublicKey; tokenProgram: PublicKey }[] {
    return [];
  }

  jupiterLegs(user: PublicKey, fromSol: boolean): RouteLeg[] {
    return [this.jupiterLeg(user, fromSol)];
  }

  jupiterLeg(user: PublicKey, fromSol: boolean): RouteLeg {
    const aToB = this.aToB(fromSol);
    return { swap: SWAP.whirlpoolV2(aToB), accounts: this.legAccounts(user, aToB) };
  }

  /** Spot price: raw anchor (lamports, for SOL) per raw token. */
  lamportsPerToken(): number {
    const p = Number(this.state.sqrtPrice) / Number(Q64);
    const bPerA = p * p;
    return this.state.mintA.equals(this.anchor) ? 1 / bPerA : bPerA;
  }

  /** Accounts for a swap_v2 leg inside a Jupiter route (Orca's own swap_v2 order). */
  legAccounts(user: PublicKey, aToB: boolean): AccountMeta[] {
    const s = this.state;
    const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    const program = (mint: PublicKey) => (mint.equals(this.anchor) ? this.anchorProgram : this.tokenProgram);
    const ata = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, user, true, program(mint));
    const oracle = PublicKey.findProgramAddressSync([Buffer.from('oracle'), this.address.toBuffer()], WHIRLPOOL_PROGRAM_ID)[0];
    return [
      r(WHIRLPOOL_PROGRAM_ID),
      r(program(s.mintA)),
      r(program(s.mintB)),
      r(MEMO_PROGRAM_ID),
      w(user),
      w(this.address),
      r(s.mintA),
      r(s.mintB),
      w(ata(s.mintA)),
      w(s.vaultA),
      w(ata(s.mintB)),
      w(s.vaultB),
      ...this.sequence(aToB).map((start) => w(tickArrayPda(this.address, start))),
      w(oracle),
    ];
  }
}
