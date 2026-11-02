// Raydium LaunchLab bonding curves (stonk.fun, letsbonk.fun and other
// platforms), built by hand from the program's on-chain IDL (raydium_launchpad
// 0.2.0) and the curve maths in Raydium's SDK v2, so there's no SDK dependency.
//
// SOL-paired pools trade directly:
//   buy  -> buy_exact_in  (exact SOL in, min tokens out)
//   sell -> sell_exact_in (exact tokens in, min SOL out)
// wrapping into our WSOL ATA and closing it in the same tx.
//
// Pools paired with a token in ROUTED_QUOTES (STONK) trade through a Jupiter
// route_v2 we build ourselves: SOL -> token on an Orca Whirlpool, then token ->
// coin on the curve (and the reverse for sells). The route hands each leg
// exactly what the previous one produced, so no token is left over. These
// transactions need address lookup tables to fit.
//
// Token-2022 coins with a transfer fee are supported: the fee comes off what
// the buyer receives (the on-chain minimum applies to that), and off what the
// pool receives on a sell. Their token accounts are left open after a full
// sell, because withheld fees stop Token-2022 from closing them.
//
// Supported: the constant-product curve (curve type 0). Anything else is
// refused with a reason.
import {
  type AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
  type AccountMeta,
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
import { ROUTED_QUOTES, assertNoQuoteFee, routeCuFloor, hopAtas, nonSolQuoteNamed, openRoute, transferFeeOf, transferFeeOn, type Route, type TransferFee } from './routes';
import { VenueError, impactPct, lessSlippage, type Market, type Quote, type VenueAdapter } from './types';
import type { SolLeg } from './routes';

export const LAUNCHLAB_PROGRAM_ID = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, LAUNCHLAB_PROGRAM_ID)[0];
const AUTHORITY = pda([Buffer.from('vault_auth_seed')]);
const EVENT_AUTHORITY = pda([Buffer.from('__event_authority')]);
export const launchLabPoolPda = (base: PublicKey, quote: PublicKey) => pda([Buffer.from('pool'), base.toBuffer(), quote.toBuffer()]);

/**
 * A coin's LaunchLab pool when its quote token isn't one we can guess (a coin
 * paired with an xStock, say): one filtered program-account query on the base
 * mint. Null when there is none, or when the RPC refuses the query.
 */
export async function launchLabPoolByBase(conn: Connection, base: PublicKey): Promise<{ address: PublicKey; info: AccountInfo<Buffer> } | null> {
  try {
    const found = await conn.getProgramAccounts(LAUNCHLAB_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(POOL_DISC) } }, { memcmp: { offset: 205, bytes: base.toBase58() } }],
    });
    const hit = found.find((f) => decodePool(f.account)?.baseMint.equals(base));
    return hit ? { address: hit.pubkey, info: hit.account } : null;
  } catch {
    return null;
  }
}
const platformFeeVault = (platform: PublicKey, quote: PublicKey) => pda([platform.toBuffer(), quote.toBuffer()]);
const creatorFeeVault = (creator: PublicKey, quote: PublicKey) => pda([creator.toBuffer(), quote.toBuffer()]);

const BUY_EXACT_IN = Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]);
const SELL_EXACT_IN = Buffer.from([149, 39, 222, 155, 211, 124, 152, 26]);
const POOL_DISC = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
const GLOBAL_DISC = Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]);
const PLATFORM_DISC = Buffer.from([160, 78, 128, 0, 248, 83, 230, 160]);
/** Fee rates are in millionths. */
const FEE_DENOMINATOR = new BN(1_000_000);


// ----------------------------------------------------------------- layouts
// Borsh, packed. Offsets include the 8-byte Anchor discriminator.

export interface PoolState {
  /** 0 = trading on the curve, 1 = curve full (waiting to migrate), 2 = migrated to Raydium. */
  status: number;
  totalSellA: BN;
  virtualA: BN;
  virtualB: BN;
  realA: BN;
  realB: BN;
  globalConfig: PublicKey;
  platformConfig: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  creator: PublicKey;
}

const u64 = (d: Buffer, o: number) => new BN(d.subarray(o, o + 8), 'le');
const key = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));

export function decodePool(info: AccountInfo<Buffer>): PoolState | null {
  const d = info.data;
  if (d.length < 367 || !d.subarray(0, 8).equals(POOL_DISC)) return null;
  return {
    status: d[17]!,
    totalSellA: u64(d, 29),
    virtualA: u64(d, 37),
    virtualB: u64(d, 45),
    realA: u64(d, 53),
    realB: u64(d, 61),
    globalConfig: key(d, 141),
    platformConfig: key(d, 173),
    baseMint: key(d, 205),
    quoteMint: key(d, 237),
    baseVault: key(d, 269),
    quoteVault: key(d, 301),
    creator: key(d, 333),
  };
}

interface Fees {
  curveType: number;
  /** protocol + platform + creator, in millionths. Share fee is always 0 for us. */
  totalRate: BN;
}

function decodeFees(global: AccountInfo<Buffer>, platform: AccountInfo<Buffer>): Fees {
  const g = global.data;
  const p = platform.data;
  if (g.length < 35 || !g.subarray(0, 8).equals(GLOBAL_DISC)) throw new VenueError('LaunchLab global config not found', 'NOT_FOUND');
  if (p.length < 728 || !p.subarray(0, 8).equals(PLATFORM_DISC)) throw new VenueError('LaunchLab platform config not found', 'NOT_FOUND');
  const totalRate = u64(g, 27).add(u64(p, 104)).add(u64(p, 720));
  if (totalRate.gte(FEE_DENOMINATOR)) throw new VenueError('LaunchLab fee rates are invalid', 'UNSUPPORTED');
  return { curveType: g[16]!, totalRate };
}

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** A graduated pool's migration: 0 = Raydium AMM v4, 1 = CPMM. */
export function migrateType(info: AccountInfo<Buffer>): number {
  return info.data[20]!;
}

const ceilFee = (amount: BN, rate: BN) => amount.mul(rate).add(FEE_DENOMINATOR).subn(1).div(FEE_DENOMINATOR);
const toBig = (n: BN) => BigInt(n.toString());
const toBN = (n: bigint) => new BN(n.toString());

// ------------------------------------------------------------------ market

class LaunchLabMarket implements Market {
  readonly venue: 'LAUNCHLAB' | 'LAUNCHLAB_ROUTED';
  private pool: PoolState;
  private fees: Fees;
  private globalInfo: AccountInfo<Buffer>;
  private platformInfo: AccountInfo<Buffer>;

  constructor(
    readonly mint: MintInfo,
    readonly address: PublicKey,
    pool: PoolState,
    globalInfo: AccountInfo<Buffer>,
    platformInfo: AccountInfo<Buffer>,
    private readonly route: Route | null = null,
    private readonly transferFee: TransferFee | null = null,
  ) {
    this.venue = route ? 'LAUNCHLAB_ROUTED' : 'LAUNCHLAB';
    this.pool = pool;
    this.globalInfo = globalInfo;
    this.platformInfo = platformInfo;
    this.fees = decodeFees(globalInfo, platformInfo);
  }

  get state(): PoolState {
    return this.pool;
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
    return [this.address, this.pool.globalConfig, this.pool.platformConfig, ...(this.route?.leg.watchAccounts() ?? [])];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    if (pubkey.equals(this.address)) {
      this.pool = decodePool(info) ?? this.pool;
      return;
    }
    if (this.route?.leg.apply(pubkey, info)) return;
    if (pubkey.equals(this.pool.globalConfig)) this.globalInfo = info;
    else if (pubkey.equals(this.pool.platformConfig)) this.platformInfo = info;
    else return;
    try {
      this.fees = decodeFees(this.globalInfo, this.platformInfo);
    } catch {
      // Keep the last good rates; the on-chain minimum still protects the trade.
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
    return this.pool.status === 0 && this.pool.realA.lt(this.pool.totalSellA);
  }

  private assertTradable(): void {
    if (this.pool.status === 2) throw new VenueError('This coin graduated from LaunchLab to a Raydium pool (not supported yet)', 'UNSUPPORTED');
    if (!this.tradable()) throw new VenueError('The LaunchLab curve is full and migrating to Raydium', 'CURVE_COMPLETE');
  }

  /** Tokens still on the curve, and the reserves the constant-product maths runs on. */
  private reserves() {
    const p = this.pool;
    return { base: p.virtualA.sub(p.realA), quote: p.virtualB.add(p.realB), remaining: p.totalSellA.sub(p.realA) };
  }

  /** Curve price in raw quote units per raw token. */
  private curveSpot(): number {
    const r = this.reserves();
    const base = Number(r.base.toString());
    return base > 0 ? Number(r.quote.toString()) / base : 0;
  }

  private spotPerRaw(): number {
    return this.curveSpot() * (this.route ? this.route.leg.lamportsPerToken() : 1);
  }

  spotLamportsPerToken(): number {
    return this.spotPerRaw() * 10 ** this.mint.decimals;
  }

  /** The Token-2022 fee withheld from a transfer of `amount` tokens (0 for most coins). */
  transferFeeOn(amount: BN): BN {
    return transferFeeOn(this.transferFee, amount);
  }

  canCloseTokenAccount(): boolean {
    return !this.transferFee;
  }

  /** Tokens out of the curve for an exact quote input; the fee comes off the input first. */
  private curveBuy(quoteIn: BN): { out: BN; capped: boolean } {
    const r = this.reserves();
    const net = quoteIn.sub(ceilFee(quoteIn, this.fees.totalRate));
    const out = net.mul(r.base).div(r.quote.add(net));
    // A buy past the end of the curve gets only what's left (and pays less).
    return out.gt(r.remaining) ? { out: r.remaining, capped: true } : { out, capped: false };
  }

  /** Quote units out of the curve for an exact token input, after fees. */
  private curveSell(tokensIn: BN): BN {
    const r = this.reserves();
    const gross = tokensIn.mul(r.quote).div(r.base.add(tokensIn));
    if (gross.gt(this.pool.realB)) throw new VenueError(`The curve does not hold enough ${this.route?.symbol ?? 'SOL'} for this sell. Try a smaller %.`, 'EMPTY');
    return gross.sub(ceilFee(gross, this.fees.totalRate));
  }

  quoteBuy(lamportsIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    let out: BN;
    let minOut: BN;
    if (this.route) {
      const leg = this.route.leg;
      const tokenIn = toBN(leg.quote(toBig(lamportsIn), true));
      const r = this.curveBuy(tokenIn);
      // A capped buy would leave the unspent quote token in the wallet.
      if (r.capped) throw new VenueError('This buy is bigger than what is left on the curve. Try a smaller amount.', 'EMPTY');
      out = r.out.sub(this.transferFeeOn(r.out));
      minOut = routeMinOut(out, slippageBps(slippagePct));
    } else {
      const sent = this.curveBuy(lamportsIn).out;
      out = sent.sub(this.transferFeeOn(sent));
      minOut = lessSlippage(out, slippagePct, 1);
    }
    if (out.isZero()) throw new VenueError('Buy amount too small for this curve', 'EMPTY');
    return { side: 'buy', inAmount: lamportsIn, out, minOut: BN.max(minOut, new BN(1)), maxIn: lamportsIn, priceImpactPct: impactPct('buy', lamportsIn, out, this.spotPerRaw()) };
  }

  quoteSell(tokensIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    // The pool receives what's left after the transfer fee.
    const quoteOut = this.curveSell(tokensIn.sub(this.transferFeeOn(tokensIn)));
    let out: BN;
    let minOut: BN;
    if (this.route) {
      const leg = this.route.leg;
      if (quoteOut.isZero()) throw new VenueError('Sell amount too small for this curve', 'EMPTY');
      out = toBN(leg.quote(toBig(quoteOut), false));
      minOut = routeMinOut(out, slippageBps(slippagePct));
    } else {
      out = quoteOut;
      minOut = lessSlippage(out, slippagePct);
    }
    return { side: 'sell', inAmount: tokensIn, out, minOut, maxIn: tokensIn, priceImpactPct: impactPct('sell', out, tokensIn, this.spotPerRaw()) };
  }

  private baseAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.mint.mint, user, true, this.mint.tokenProgram);
  }

  /** The user's account for the pool's quote token (WSOL, or STONK when routed). */
  /** The quote token's program: SPL Token for SOL, or whatever owns the routed token (Token-2022 for the xStocks). */
  private get quoteProgram(): PublicKey {
    return this.route?.leg.tokenProgram ?? TOKEN_PROGRAM_ID;
  }

  private quoteAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.pool.quoteMint, user, true, this.quoteProgram);
  }

  private wsolAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  }

  /** buy_exact_in / sell_exact_in accounts after the payer, through the program id. */
  private poolAccounts(user: PublicKey): AccountMeta[] {
    const p = this.pool;
    const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    return [
      r(AUTHORITY),
      r(p.globalConfig),
      r(p.platformConfig),
      w(this.address),
      w(this.baseAta(user)),
      w(this.quoteAta(user)),
      w(p.baseVault),
      w(p.quoteVault),
      r(p.baseMint),
      r(p.quoteMint),
      r(this.mint.tokenProgram),
      r(this.quoteProgram),
      r(EVENT_AUTHORITY),
      r(LAUNCHLAB_PROGRAM_ID),
    ];
  }

  /** Remaining accounts the program reads since the fee-vault upgrade. */
  private feeVaults(): AccountMeta[] {
    const p = this.pool;
    return [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: platformFeeVault(p.platformConfig, p.quoteMint), isSigner: false, isWritable: true },
      { pubkey: creatorFeeVault(p.creator, p.quoteMint), isSigner: false, isWritable: true },
    ];
  }

  private swapIx(disc: Buffer, amountIn: BN, minOut: BN, user: PublicKey): TransactionInstruction {
    // amount_in, minimum_amount_out, share_fee_rate (0: no referral share)
    const data = Buffer.concat([disc, amountIn.toArrayLike(Buffer, 'le', 8), minOut.toArrayLike(Buffer, 'le', 8), Buffer.alloc(8)]);
    return new TransactionInstruction({
      programId: LAUNCHLAB_PROGRAM_ID,
      keys: [{ pubkey: user, isSigner: true, isWritable: true }, ...this.poolAccounts(user), ...this.feeVaults()],
      data,
    });
  }

  /**
   * The curve as a Jupiter leg, laid out as in Jupiter's own transactions: the
   * user doubles as the (zero-rate) share-fee receiver, and a sell leg ends with
   * one optional account, passed as Jupiter's program id for "none".
   */
  private curveLeg(user: PublicKey, side: 'buy' | 'sell'): RouteLeg {
    const me = { pubkey: user, isSigner: false, isWritable: true };
    const none = { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false };
    return {
      swap: side === 'buy' ? SWAP.launchLabBuy() : SWAP.launchLabSell(),
      accounts: [
        { pubkey: LAUNCHLAB_PROGRAM_ID, isSigner: false, isWritable: false },
        me,
        ...this.poolAccounts(user),
        me,
        ...this.feeVaults(),
        ...(side === 'sell' ? [none] : []),
      ],
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
    if (this.route) ixs.push(...hopAtas(user, this.route.leg), createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.pool.quoteMint, this.route.leg.tokenProgram));
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
            legs: [...this.solLegs(user, true), this.curveLeg(user, 'buy')],
          })
        : this.swapIx(BUY_EXACT_IN, q.inAmount, q.minOut, user),
      // Unwraps anything not spent, plus the account rent.
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    );
    return ixs;
  }

  async buildSell(user: PublicKey, _userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number) {
    this.assertTradable();
    const wsol = this.wsolAta(user);
    const ixs: TransactionInstruction[] = [];
    if (this.route) ixs.push(...hopAtas(user, this.route.leg), createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.pool.quoteMint, this.route.leg.tokenProgram));
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
            legs: [this.curveLeg(user, 'sell'), ...this.solLegs(user, false)],
          })
        : this.swapIx(SELL_EXACT_IN, q.inAmount, q.minOut, user),
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

export const launchLab: VenueAdapter = {
  id: 'LAUNCHLAB',

  async open(conn: Connection, mint: MintInfo, hint) {
    // The page may point at the pool; otherwise try the SOL pool, then the
    // other quote tokens (routed ones to trade, known ones to explain a refusal).
    const quotes = [NATIVE_MINT, ...Object.keys(ROUTED_QUOTES), USDC_MINT].map((k) => new PublicKey(k));
    const candidates = hint?.account ? [hint.account] : quotes.map((q) => launchLabPoolPda(mint.mint, q));
    const infos = await conn.getMultipleAccountsInfo([...candidates, mint.mint], 'confirmed');
    const mintInfo = infos.pop() ?? null;
    let address: PublicKey | null = null;
    let pool: PoolState | null = null;
    for (const [i, info] of infos.entries()) {
      const p = info && info.owner.equals(LAUNCHLAB_PROGRAM_ID) ? decodePool(info) : null;
      if (p && p.baseMint.equals(mint.mint)) {
        address = candidates[i]!;
        pool = p;
        break;
      }
    }
    // Quoted in some other token: look the pool up by its base mint.
    if (!pool && !hint?.account) {
      const byBase = await launchLabPoolByBase(conn, mint.mint);
      if (byBase) {
        address = byBase.address;
        pool = decodePool(byBase.info);
      }
    }
    if (!pool || !address) return null;
    const routed = !pool.quoteMint.equals(NATIVE_MINT);
    // Graduated: the Raydium CPMM venue picks it up from here.
    if (pool.status === 2) return null;
    if (!mintInfo) throw new VenueError('Mint not found on chain', 'NOT_FOUND');

    const [globalInfo, platformInfo] = await conn.getMultipleAccountsInfo([pool.globalConfig, pool.platformConfig], 'confirmed');
    if (!globalInfo || !platformInfo) throw new VenueError('LaunchLab config not found', 'NOT_FOUND');
    if (decodeFees(globalInfo, platformInfo).curveType !== 0) {
      throw new VenueError('This LaunchLab coin uses a fixed-price or linear curve (not supported yet)', 'UNSUPPORTED');
    }
    const [route, transferFee] = await Promise.all([
      routed ? openRoute(conn, pool.quoteMint, address) : null,
      transferFeeOf(conn, mint, mintInfo),
    ]);
    if (routed && !route) throw await nonSolQuoteNamed(conn, pool.quoteMint);
    if (route) assertNoQuoteFee(route);
    return new LaunchLabMarket(mint, address, pool, globalInfo, platformInfo, route, transferFee);
  },

  ownsAccount: (owner) => owner.equals(LAUNCHLAB_PROGRAM_ID),

  async mintOf(_conn, _account, info) {
    return decodePool(info)?.baseMint ?? null;
  },

  allowedPrograms: () => [LAUNCHLAB_PROGRAM_ID.toBase58(), JUPITER_PROGRAM_ID.toBase58()],
};

export type { LaunchLabMarket };
