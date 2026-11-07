// Meteora DAMM v2 (cp-amm) pools: where Meteora bonding-curve coins graduate,
// and a common home for other launches. Built from the program's source
// (MeteoraAg/damm-v2: state/pool.rs, state/fee.rs, base_fee/*,
// liquidity_handler/*, instructions/swap/*); no SDK.
//
// A pool is one concentrated-liquidity range over a price band (usually the
// full range), or, in compounding mode, a plain constant-product pool on its
// recorded reserves. The coin may be either token. SOL-paired pools trade
// directly with swap2 (exact in), wrapping into our WSOL ATA and closing it
// in the same tx; pools paired with another token trade through our Jupiter
// route (SOL <-> that token, then this pool).
//
// The base fee is fixed, time-scheduled, market-cap-scheduled or rate
// limited, with an optional volatility fee on top. Fees are taken from the
// output, or from the input when the pool collects only token B and B goes in.
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
import { ChainClock, deltaBaseU64, deltaQuoteU64, excludeFee, mulDiv, nextSqrtPriceFromInput, priceFromSqrt, rateLimitedFee, readU128, readU64, scheduledFee, variableFee, FEE_DENOMINATOR } from './meteoraMath';
import { DBC_POOL_AUTHORITY } from './meteoraDbc';
import { ROUTED_QUOTES, USDC_MINT, assertNoQuoteFee, hopAtas, nonSolQuoteNamed, openRoute, routeCuFloor, transferFeeOf, type Route, type SolLeg, type TransferFee } from './routes';
import { transferFeeOnRaw } from './transferFee';
import { VenueError, impactPct, lessSlippage, type Market, type Quote, type VenueAdapter } from './types';

export const DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], DAMM_V2_PROGRAM_ID)[0];
const POOL_AUTHORITY = pda('pool_authority');
const EVENT_AUTHORITY = pda('__event_authority');

const SWAP2 = Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]);
const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const POOL_LEN = 1112;
const MINT_OFFSETS = [168, 200];
/** Max total fee by the pool's fee version. */
const MAX_FEE_NUMERATOR = [500_000_000n, 990_000_000n];
const COMPOUNDING = 2;
/** Quote tokens a coin can be paired with (the coin is the other side). */
const QUOTE_MINTS = new Set([NATIVE_MINT.toBase58(), USDC_MINT.toBase58(), ...Object.keys(ROUTED_QUOTES)]);

// ----------------------------------------------------------------- layouts
// zero_copy. Offsets include the 8-byte Anchor discriminator.

export interface DammPool {
  /** The base fee's 32 bytes (a time scheduler, rate limiter or market-cap scheduler). */
  baseFee: Buffer;
  dynamicFee: boolean;
  binStep: bigint;
  variableFeeControl: bigint;
  volatilityAccumulator: bigint;
  initSqrtPrice: bigint;
  mintA: PublicKey;
  mintB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  liquidity: bigint;
  sqrtMinPrice: bigint;
  sqrtMaxPrice: bigint;
  sqrtPrice: bigint;
  activationPoint: bigint;
  /** 0: slots, 1: unix seconds. */
  activationType: number;
  /** 0: enabled. */
  status: number;
  /** 0: fees in both tokens, 1: only token B, 2: compounding (token B, constant product). */
  collectFeeMode: number;
  feeVersion: number;
  creator: PublicKey;
  /** Reserves (layout version 1; the compounding curve trades on these). */
  amountA: bigint;
  amountB: bigint;
}

const key = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));

export function decodeDammPool(info: AccountInfo<Buffer>): DammPool | null {
  const d = info.data;
  if (!info.owner.equals(DAMM_V2_PROGRAM_ID) || d.length < POOL_LEN || !d.subarray(0, 8).equals(POOL_DISC)) return null;
  return {
    baseFee: Buffer.from(d.subarray(8, 40)),
    dynamicFee: d[56] !== 0,
    variableFeeControl: BigInt(d.readUInt32LE(68)),
    binStep: BigInt(d.readUInt16LE(72)),
    volatilityAccumulator: readU128(d, 120),
    initSqrtPrice: readU128(d, 152),
    mintA: key(d, 168),
    mintB: key(d, 200),
    vaultA: key(d, 232),
    vaultB: key(d, 264),
    liquidity: readU128(d, 360),
    sqrtMinPrice: readU128(d, 424),
    sqrtMaxPrice: readU128(d, 440),
    sqrtPrice: readU128(d, 456),
    activationPoint: readU64(d, 472),
    activationType: d[480]!,
    status: d[481]!,
    collectFeeMode: d[484]!,
    feeVersion: d[486]!,
    creator: key(d, 648),
    amountA: readU64(d, 680),
    amountB: readU64(d, 688),
  };
}

/** False for a pool whose liquidity was all withdrawn. */
const hasLiquidity = (p: DammPool) => (p.collectFeeMode === COMPOUNDING ? p.amountA > 0n && p.amountB > 0n : p.liquidity > 0n);

/**
 * The DAMM v2 configs whose pools only Meteora's bonding-curve authority may
 * create: the ones a graduating curve migrates into (every config on chain with
 * that pool_creator_authority, 2026-11-08). A pool's address derives from its
 * config and its two mints, so a graduated coin's pool is found by reading a
 * handful of addresses instead of scanning the program.
 */
const DBC_MIGRATION_CONFIGS = [
  '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd',
  '2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k',
  'Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp',
  '2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq',
  'AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD',
  'DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u',
  'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck',
].map((k) => new PublicKey(k));

/** pool = PDA("pool", config, larger mint, smaller mint). */
export function dammPoolAddress(config: PublicKey, mintA: PublicKey, mintB: PublicKey): PublicKey {
  const [hi, lo] = Buffer.compare(mintA.toBuffer(), mintB.toBuffer()) > 0 ? [mintA, mintB] : [mintB, mintA];
  return PublicKey.findProgramAddressSync([Buffer.from('pool'), config.toBuffer(), hi.toBuffer(), lo.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
}

/** A graduated curve coin's pool against SOL or USDC, by address; [] for a coin that didn't graduate from a Meteora curve. */
async function migratedPools(conn: Connection, mint: PublicKey): Promise<{ address: PublicKey; pool: DammPool }[]> {
  const addresses = [NATIVE_MINT, USDC_MINT].flatMap((quote) => DBC_MIGRATION_CONFIGS.map((c) => dammPoolAddress(c, mint, quote)));
  const found: { address: PublicKey; pool: DammPool }[] = [];
  // Seven at a time: some RPCs cap getMultipleAccounts at 10.
  for (let i = 0; i < addresses.length; i += DBC_MIGRATION_CONFIGS.length) {
    const chunk = addresses.slice(i, i + DBC_MIGRATION_CONFIGS.length);
    const infos = await conn.getMultipleAccountsInfo(chunk, 'confirmed').catch(() => []);
    infos.forEach((info, j) => {
      const pool = info ? decodeDammPool(info) : null;
      if (pool && pool.status === 0 && hasLiquidity(pool)) found.push({ address: chunk[j]!, pool });
    });
    if (found.length) break; // a SOL pool wins: no need to read the USDC ones
  }
  return found;
}

/** The coin's DAMM v2 pools (as token A or B), most likely market first: its graduation pool, then SOL pools, then the deepest. */
async function dammPoolsOf(conn: Connection, mint: PublicKey): Promise<{ address: PublicKey; pool: DammPool }[]> {
  // A graduated curve coin (Bags, Believe…): its pool by address, which works on RPCs that refuse program scans.
  const migrated = await migratedPools(conn, mint);
  if (migrated.length) return migrated;
  try {
    const found = await Promise.all(
      MINT_OFFSETS.map((offset) =>
        conn.getProgramAccounts(DAMM_V2_PROGRAM_ID, {
          commitment: 'confirmed',
          filters: [{ dataSize: POOL_LEN }, { memcmp: { offset: 0, bytes: bs58.encode(POOL_DISC) } }, { memcmp: { offset, bytes: mint.toBase58() } }],
        }),
      ),
    );
    const pools = found.flat().flatMap((f) => {
      const pool = decodeDammPool(f.account);
      return pool && pool.status === 0 && hasLiquidity(pool) ? [{ address: f.pubkey, pool }] : [];
    });
    const quoteOf = (p: DammPool) => (p.mintA.equals(mint) ? { mint: p.mintB, amount: p.amountB } : { mint: p.mintA, amount: p.amountA });
    const rank = (p: DammPool): [number, number, bigint] => [p.creator.equals(DBC_POOL_AUTHORITY) ? 1 : 0, quoteOf(p).mint.equals(NATIVE_MINT) ? 1 : 0, quoteOf(p).amount];
    return pools.sort((x, y) => {
      const [a, b] = [rank(x.pool), rank(y.pool)];
      return b[0] - a[0] || b[1] - a[1] || (b[2] > a[2] ? 1 : b[2] < a[2] ? -1 : 0);
    });
  } catch {
    // RPCs that refuse program scans find nothing; the pool address still opens it.
    return [];
  }
}

const toBN = (n: bigint) => new BN(n.toString());
const toBig = (n: BN) => BigInt(n.toString());

// ------------------------------------------------------------------ market

class DammMarket implements Market {
  readonly venue: 'METEORA_DAMM_V2' | 'METEORA_DAMM_V2_ROUTED';
  private pool: DammPool;
  /** Whether the coin is token A (and the quote token B). */
  private readonly coinIsA: boolean;

  constructor(
    readonly mint: MintInfo,
    readonly address: PublicKey,
    pool: DammPool,
    private readonly quoteProgram: PublicKey,
    private readonly clock: ChainClock,
    private readonly route: Route | null,
    private readonly transferFee: TransferFee | null,
  ) {
    this.venue = route ? 'METEORA_DAMM_V2_ROUTED' : 'METEORA_DAMM_V2';
    this.pool = pool;
    this.coinIsA = pool.mintA.equals(mint.mint);
  }

  get state(): DammPool {
    return this.pool;
  }

  get quoteMint(): PublicKey {
    return this.coinIsA ? this.pool.mintB : this.pool.mintA;
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
    return [this.address, ...(this.route?.leg.watchAccounts() ?? [])];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    if (pubkey.equals(this.address)) this.pool = decodeDammPool(info) ?? this.pool;
    else this.route?.leg.apply(pubkey, info);
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

  private point(): bigint {
    return this.clock.point(this.pool.activationType);
  }

  tradable(): boolean {
    return this.pool.status === 0 && hasLiquidity(this.pool) && this.point() >= this.pool.activationPoint;
  }

  private assertTradable(): void {
    if (this.pool.status !== 0) throw new VenueError('Swaps are disabled on this Meteora pool', 'UNSUPPORTED');
    if (!hasLiquidity(this.pool)) throw new VenueError('This Meteora pool has no liquidity left', 'EMPTY');
    if (!this.tradable()) throw new VenueError('This Meteora pool has not opened for trading yet', 'UNSUPPORTED');
  }

  transferFeeOn(amount: BN): BN {
    return toBN(transferFeeOnRaw(this.transferFee, toBig(amount)));
  }

  canCloseTokenAccount(): boolean {
    return !this.transferFee;
  }

  // ------------------------------------------------------------- fees

  /** The rate limiter's fields, when the base fee is one and it's in force for this direction now. */
  private rateLimiter(aToB: boolean): { cliff: bigint; incrementBps: bigint; referenceAmount: bigint; maxFeeNumerator: bigint } | null {
    const f = this.pool.baseFee;
    if (f[8] !== 2 || aToB) return null;
    const incrementBps = BigInt(f.readUInt16LE(14));
    const duration = BigInt(f.readUInt32LE(16));
    const maxFeeBps = BigInt(f.readUInt32LE(20));
    const referenceAmount = readU64(f, 24);
    if (incrementBps === 0n && duration === 0n && maxFeeBps === 0n && referenceAmount === 0n) return null;
    const now = this.point();
    if (now < this.pool.activationPoint || now > this.pool.activationPoint + duration) return null;
    return { cliff: readU64(f, 0), incrementBps, referenceAmount, maxFeeNumerator: (maxFeeBps * FEE_DENOMINATOR) / 10_000n };
  }

  /** get_total_trading_fee_from_included_fee_amount */
  private feeNumerator(aToB: boolean, included: bigint): bigint {
    const p = this.pool;
    const f = p.baseFee;
    const cliff = readU64(f, 0);
    const mode = f[8]!;
    const now = this.point();
    let base: bigint;
    if (mode === 0 || mode === 1) {
      const periods = f.readUInt16LE(14);
      const frequency = readU64(f, 16);
      if (frequency === 0n) base = cliff;
      else {
        const period = now < p.activationPoint ? BigInt(periods) : (now - p.activationPoint) / frequency;
        base = scheduledFee(mode === 1, cliff, periods, readU64(f, 24), period);
      }
    } else if (mode === 2) {
      const r = this.rateLimiter(aToB);
      base = r ? rateLimitedFee(r, included) : cliff;
    } else if (mode === 3 || mode === 4) {
      const periods = f.readUInt16LE(14);
      const step = BigInt(f.readUInt32LE(16));
      const expiration = p.activationPoint + BigInt(f.readUInt32LE(20));
      let period: bigint;
      if (now > expiration || now < p.activationPoint) period = BigInt(periods);
      else if (p.sqrtPrice <= p.initSqrtPrice) period = 0n;
      else period = ((p.sqrtPrice - p.initSqrtPrice) * 10_000n) / p.initSqrtPrice / step;
      base = scheduledFee(mode === 4, cliff, periods, readU64(f, 24), period);
    } else {
      throw new VenueError('This Meteora pool uses a fee mode Quickdraw does not know yet', 'UNSUPPORTED');
    }
    const max = MAX_FEE_NUMERATOR[p.feeVersion];
    if (max === undefined) throw new VenueError('This Meteora pool uses a fee version Quickdraw does not know yet', 'UNSUPPORTED');
    const total = base + variableFee({ initialized: p.dynamicFee, binStep: p.binStep, variableFeeControl: p.variableFeeControl, volatilityAccumulator: p.volatilityAccumulator });
    return total > max ? max : total;
  }

  // ------------------------------------------------------------ swaps

  /** The pool's output for an input it receives (after the input's transfer fee). */
  private curveOut(aToB: boolean, amountIn: bigint): bigint {
    const p = this.pool;
    if (p.collectFeeMode === COMPOUNDING) {
      return aToB ? mulDiv(p.amountB, amountIn, p.amountA + amountIn, false) : mulDiv(p.amountA, amountIn, p.amountB + amountIn, false);
    }
    const range = () => new VenueError('Trade amount too large for this pool', 'EMPTY');
    const next = nextSqrtPriceFromInput(p.sqrtPrice, p.liquidity, amountIn, aToB);
    if (aToB) {
      if (next < p.sqrtMinPrice) throw range();
      return deltaQuoteU64(next, p.sqrtPrice, p.liquidity, false);
    }
    if (next > p.sqrtMaxPrice) throw range();
    return deltaBaseU64(p.sqrtPrice, next, p.liquidity, false);
  }

  /** swap2 exact in: what lands for `amountIn` of one side, before the output's transfer fee. */
  private swapIn(amountIn: bigint, aToB: boolean, inFee: TransferFee | null): bigint {
    const net = amountIn - transferFeeOnRaw(inFee, amountIn);
    if (net <= 0n) throw new VenueError('Trade amount too small for this pool', 'EMPTY');
    const numerator = this.feeNumerator(aToB, net);
    // Fees come off the input only when B goes in and the pool collects only B.
    const feesOnInput = !aToB && this.pool.collectFeeMode !== 0;
    const actualIn = feesOnInput ? excludeFee(numerator, net)[0] : net;
    const out = this.curveOut(aToB, actualIn);
    return feesOnInput ? out : excludeFee(numerator, out)[0];
  }

  /** Tokens for quote units in. */
  private buyOut(quoteIn: bigint): bigint {
    const out = this.swapIn(quoteIn, !this.coinIsA, null);
    return out - transferFeeOnRaw(this.transferFee, out);
  }

  /** Quote units for tokens in. */
  private sellOut(tokensIn: bigint): bigint {
    return this.swapIn(tokensIn, this.coinIsA, this.transferFee);
  }

  private poolSpot(): number {
    const b = priceFromSqrt(this.pool.sqrtPrice);
    return this.coinIsA ? b : b > 0 ? 1 / b : 0;
  }

  private spotPerRaw(): number {
    return this.poolSpot() * (this.route ? this.route.leg.lamportsPerToken() : 1);
  }

  spotLamportsPerToken(): number {
    return this.spotPerRaw() * 10 ** this.mint.decimals;
  }

  quoteBuy(lamportsIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    const leg = this.route?.leg;
    const quoteIn = leg ? leg.quote(toBig(lamportsIn), true) : toBig(lamportsIn);
    if (quoteIn <= 0n) throw new VenueError('Trade amount too small for this pool', 'EMPTY');
    const out = toBN(this.buyOut(quoteIn));
    if (out.lten(0)) throw new VenueError('Trade amount too small for this pool', 'EMPTY');
    const minOut = leg ? BN.max(routeMinOut(out, slippageBps(slippagePct)), new BN(1)) : lessSlippage(out, slippagePct, 1);
    return { side: 'buy', inAmount: lamportsIn, out, minOut, maxIn: lamportsIn, priceImpactPct: impactPct('buy', lamportsIn, out, this.spotPerRaw()) };
  }

  quoteSell(tokensIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    const leg = this.route?.leg;
    const quoteOut = this.sellOut(toBig(tokensIn));
    if (leg && quoteOut <= 0n) throw new VenueError('Trade amount too small for this pool', 'EMPTY');
    const out = toBN(leg ? leg.quote(quoteOut, false) : quoteOut);
    const minOut = leg ? routeMinOut(out, slippageBps(slippagePct)) : lessSlippage(out, slippagePct);
    return { side: 'sell', inAmount: tokensIn, out, minOut, maxIn: tokensIn, priceImpactPct: impactPct('sell', out, tokensIn, this.spotPerRaw()) };
  }

  // ------------------------------------------------------------ build

  private baseAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.mint.mint, user, true, this.mint.tokenProgram);
  }

  private quoteAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.quoteMint, user, true, this.quoteProgram);
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
    const [programA, programB] = this.coinIsA ? [this.mint.tokenProgram, this.quoteProgram] : [this.quoteProgram, this.mint.tokenProgram];
    return [
      r(POOL_AUTHORITY),
      w(this.address),
      w(input),
      w(output),
      w(p.vaultA),
      w(p.vaultB),
      r(p.mintA),
      r(p.mintB),
      payer,
      r(programA),
      r(programB),
      r(DAMM_V2_PROGRAM_ID), // referral_token_account: None
      r(EVENT_AUTHORITY),
      r(DAMM_V2_PROGRAM_ID),
    ];
  }

  /** The direction a trade runs through the pool: A -> B unless B goes in. */
  private aToB(buy: boolean): boolean {
    return buy !== this.coinIsA;
  }

  private swapIx(user: PublicKey, buy: boolean, amountIn: BN, minOut: BN): TransactionInstruction {
    // The rate limiter only lets one swap on the pool per tx, which it checks through the instructions sysvar.
    const sysvar = this.rateLimiter(this.aToB(buy)) ? [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }] : [];
    return new TransactionInstruction({
      programId: DAMM_V2_PROGRAM_ID,
      keys: [...this.swapAccounts(user, { pubkey: user, isSigner: true, isWritable: false }, buy), ...sysvar],
      data: Buffer.concat([SWAP2, amountIn.toArrayLike(Buffer, 'le', 8), minOut.toArrayLike(Buffer, 'le', 8), Buffer.from([0])]),
    });
  }

  /** The pool as a Jupiter MeteoraDammV2 leg: its swap accounts, prefixed by the program id. */
  private poolLeg(user: PublicKey, buy: boolean): RouteLeg {
    if (this.rateLimiter(this.aToB(buy))) throw new VenueError('This pool only takes direct swaps for now (launch rate limit). Try again in a minute.', 'UNSUPPORTED');
    return {
      swap: SWAP.meteoraDammV2(),
      accounts: [{ pubkey: DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: false }, ...this.swapAccounts(user, { pubkey: user, isSigner: false, isWritable: false }, buy)],
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
    if (this.route) ixs.push(...hopAtas(user, this.route.leg), createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.quoteMint, this.quoteProgram));
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
            legs: [...this.solLegs(user, true), this.poolLeg(user, true)],
          })
        : this.swapIx(user, true, q.inAmount, q.minOut),
      // Unwraps anything not spent, plus the account rent.
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    );
    return ixs;
  }

  async buildSell(user: PublicKey, _userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number) {
    this.assertTradable();
    const wsol = this.wsolAta(user);
    const ixs: TransactionInstruction[] = [];
    if (this.route) ixs.push(...hopAtas(user, this.route.leg), createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.quoteMint, this.quoteProgram));
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
            legs: [this.poolLeg(user, false), ...this.solLegs(user, false)],
          })
        : this.swapIx(user, false, q.inAmount, q.minOut),
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

export const meteoraDammV2: VenueAdapter = {
  id: 'METEORA_DAMM_V2',

  async open(conn: Connection, mint: MintInfo, hint) {
    let address: PublicKey;
    let pool: DammPool | null;
    if (hint?.account) {
      address = hint.account;
      const info = await conn.getAccountInfo(address, 'confirmed');
      pool = info ? decodeDammPool(info) : null;
    } else {
      const best = (await dammPoolsOf(conn, mint.mint))[0];
      if (!best) return null;
      ({ address, pool } = best);
    }
    if (!pool || !(pool.mintA.equals(mint.mint) || pool.mintB.equals(mint.mint))) return null;
    const quoteMint = pool.mintA.equals(mint.mint) ? pool.mintB : pool.mintA;
    const routed = !quoteMint.equals(NATIVE_MINT);
    const [mintInfo, quoteInfo, clockInfo] = await conn.getMultipleAccountsInfo([mint.mint, quoteMint, new PublicKey(ChainClock.SYSVAR)], 'confirmed');
    if (!mintInfo) throw new VenueError('Mint not found on chain', 'NOT_FOUND');
    if (!quoteInfo) throw new VenueError('Quote token not found on chain', 'NOT_FOUND');
    const [route, transferFee] = await Promise.all([routed ? openRoute(conn, quoteMint, address) : null, transferFeeOf(conn, mint, mintInfo)]);
    if (routed && !route) throw await nonSolQuoteNamed(conn, quoteMint);
    if (route) assertNoQuoteFee(route);
    return new DammMarket(mint, address, pool, quoteInfo.owner, ChainClock.decode(clockInfo?.data), route, transferFee);
  },

  ownsAccount: (owner) => owner.equals(DAMM_V2_PROGRAM_ID),

  async mintOf(_conn, _account, info) {
    const pool = decodeDammPool(info);
    if (!pool) return null;
    // The coin is the side that isn't a quote token (token A when neither or both are).
    if (QUOTE_MINTS.has(pool.mintA.toBase58()) && !QUOTE_MINTS.has(pool.mintB.toBase58())) return pool.mintB;
    return pool.mintA;
  },

  allowedPrograms: () => [DAMM_V2_PROGRAM_ID.toBase58(), JUPITER_PROGRAM_ID.toBase58()],
};

export type { DammMarket };
