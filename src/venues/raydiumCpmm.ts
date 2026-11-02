// Raydium CPMM (CP-Swap) pools: where LaunchLab coins (stonk.fun, letsbonk.fun)
// go when they graduate. Built from the program's source
// (raydium-io/raydium-cp-swap: states/pool.rs, curve/calculator.rs,
// instructions/swap_base_input.rs); no SDK.
//
// SOL-paired pools trade directly with swap_base_input, wrapping SOL in the
// same tx. Pools paired with a token in ROUTED_QUOTES (STONK) trade through our
// Jupiter route: SOL <-> token on Orca, token <-> coin here.
//
// A coin can be opened from the pool address (what Axiom shows) or from its
// mint: a graduated LaunchLab curve records the platform's CPMM config, and
// the pool address derives from that and the two mints.
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo, type AccountMeta, type AddressLookupTableAccount, type Connection } from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { tokenAmount, type MintInfo } from '../solana/tokens';
import { JUPITER_PROGRAM_ID, SWAP, routeMinOut, routeV2Instruction, slippageBps, type RouteLeg } from './jupiter';
import { LAUNCHLAB_PROGRAM_ID, decodePool as decodeLaunchLabPool, launchLabPoolByBase, launchLabPoolPda, migrateType } from './launchLab';
import { ROUTED_QUOTES, assertNoQuoteFee, routeCuFloor, hopAtas, nonSolQuote, openRoute, transferFeeOf, transferFeeOn, type Route, type TransferFee } from './routes';
import { VenueError, impactPct, lessSlippage, type Market, type Quote, type VenueAdapter } from './types';
import type { SolLeg } from './routes';

export const CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('vault_and_lp_mint_auth_seed')], CPMM_PROGRAM_ID)[0];
export const cpmmPoolPda = (config: PublicKey, mint0: PublicKey, mint1: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('pool'), config.toBuffer(), mint0.toBuffer(), mint1.toBuffer()], CPMM_PROGRAM_ID)[0];

const POOL_DISC = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
const CONFIG_DISC = Buffer.from([218, 244, 33, 104, 203, 203, 43, 111]);
const SWAP_BASE_INPUT = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);
const FEE_DENOMINATOR = new BN(1_000_000);
/** Bit 2 of the pool status disables swaps. */
const SWAP_DISABLED = 4;
/** Quote tokens a coin can be paired with (one of them is never the coin itself). */
const QUOTE_MINTS = new Set([NATIVE_MINT.toBase58(), ...Object.keys(ROUTED_QUOTES), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);

// ----------------------------------------------------------------- layouts
// zero_copy, packed. Offsets include the 8-byte Anchor discriminator.

export interface CpmmPool {
  ammConfig: PublicKey;
  vault0: PublicKey;
  vault1: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  program0: PublicKey;
  program1: PublicKey;
  observation: PublicKey;
  status: number;
  /** Fees owed out of each vault (protocol + fund + creator): in the vault, but not liquidity. */
  owed0: BN;
  owed1: BN;
  openTime: number;
  /** 0: on whichever token goes in, 1: only token 0, 2: only token 1. */
  creatorFeeOn: number;
  enableCreatorFee: boolean;
}

const u64 = (d: Buffer, o: number) => new BN(d.subarray(o, o + 8), 'le');
const key = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));

export function decodeCpmmPool(info: AccountInfo<Buffer>): CpmmPool | null {
  const d = info.data;
  if (!info.owner.equals(CPMM_PROGRAM_ID) || d.length < 413 || !d.subarray(0, 8).equals(POOL_DISC)) return null;
  return {
    ammConfig: key(d, 8),
    vault0: key(d, 72),
    vault1: key(d, 104),
    mint0: key(d, 168),
    mint1: key(d, 200),
    program0: key(d, 232),
    program1: key(d, 264),
    observation: key(d, 296),
    status: d[329]!,
    owed0: u64(d, 341).add(u64(d, 357)).add(u64(d, 397)),
    owed1: u64(d, 349).add(u64(d, 365)).add(u64(d, 405)),
    openTime: Number(d.readBigUInt64LE(373)),
    creatorFeeOn: d[389]!,
    enableCreatorFee: d[390] === 1,
  };
}

interface Rates {
  trade: BN;
  creator: BN;
}

function decodeRates(info: AccountInfo<Buffer>): Rates {
  const d = info.data;
  if (d.length < 116 || !d.subarray(0, 8).equals(CONFIG_DISC)) throw new VenueError('Raydium CPMM config not found', 'NOT_FOUND');
  return { trade: u64(d, 12), creator: u64(d, 108) };
}

const ceilDiv = (amount: BN, rate: BN) => amount.mul(rate).add(FEE_DENOMINATOR).subn(1).div(FEE_DENOMINATOR);

// ------------------------------------------------------------------ market

class CpmmMarket implements Market {
  readonly venue: 'RAYDIUM_CPMM' | 'RAYDIUM_CPMM_ROUTED';
  private pool: CpmmPool;
  private rates: Rates;
  private vault0: BN;
  private vault1: BN;
  /** Whether the coin is token 0 (and the quote token 1). */
  private readonly baseIs0: boolean;

  constructor(
    readonly mint: MintInfo,
    readonly address: PublicKey,
    pool: CpmmPool,
    configInfo: AccountInfo<Buffer>,
    vault0: AccountInfo<Buffer>,
    vault1: AccountInfo<Buffer>,
    private readonly route: Route | null,
    private readonly transferFee: TransferFee | null,
  ) {
    this.venue = route ? 'RAYDIUM_CPMM_ROUTED' : 'RAYDIUM_CPMM';
    this.pool = pool;
    this.rates = decodeRates(configInfo);
    this.vault0 = tokenAmount(vault0);
    this.vault1 = tokenAmount(vault1);
    this.baseIs0 = pool.mint0.equals(mint.mint);
  }

  get state(): CpmmPool {
    return this.pool;
  }

  get quoteMint(): PublicKey {
    return this.baseIs0 ? this.pool.mint1 : this.pool.mint0;
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
    const p = this.pool;
    return [this.address, p.ammConfig, p.vault0, p.vault1, ...(this.route?.leg.watchAccounts() ?? [])];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    const p = this.pool;
    if (pubkey.equals(this.address)) this.pool = decodeCpmmPool(info) ?? p;
    else if (pubkey.equals(p.vault0)) this.vault0 = tokenAmount(info);
    else if (pubkey.equals(p.vault1)) this.vault1 = tokenAmount(info);
    else if (this.route?.leg.apply(pubkey, info)) return;
    else if (pubkey.equals(p.ammConfig)) {
      try {
        this.rates = decodeRates(info);
      } catch {
        // Keep the last good rates; the on-chain minimum still protects the trade.
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
    return (this.pool.status & SWAP_DISABLED) === 0 && Date.now() / 1000 >= this.pool.openTime;
  }

  private assertTradable(): void {
    if (!this.tradable()) throw new VenueError('Swaps are not open on this Raydium pool', 'UNSUPPORTED');
  }

  /** Vault balances less fees owed out of them (vault_amount_without_fee). */
  private reserves(): { base: BN; quote: BN } {
    const r0 = this.vault0.sub(this.pool.owed0);
    const r1 = this.vault1.sub(this.pool.owed1);
    return this.baseIs0 ? { base: r0, quote: r1 } : { base: r1, quote: r0 };
  }

  transferFeeOn(amount: BN): BN {
    return transferFeeOn(this.transferFee, amount);
  }

  canCloseTokenAccount(): boolean {
    return !this.transferFee;
  }

  /**
   * swap_base_input for an exact input, from the coin (sell) or to it (buy).
   * Returns what the user receives: after the creator fee if it's taken from
   * the output, and after the coin's transfer fee when the coin is the output.
   */
  private swapIn(amountIn: BN, fromBase: boolean): BN {
    const { base, quote } = this.reserves();
    const [reserveIn, reserveOut] = fromBase ? [base, quote] : [quote, base];
    // The pool only gets what's left after the input's transfer fee.
    const actualIn = fromBase ? amountIn.sub(this.transferFeeOn(amountIn)) : amountIn;
    if (actualIn.lten(0)) throw new VenueError('Trade amount too small for this pool', 'EMPTY');
    const inputIs0 = fromBase === this.baseIs0;
    const on = this.pool.creatorFeeOn;
    const creatorOnInput = on === 0 || (on === 1 && inputIs0) || (on === 2 && !inputIs0);
    const creatorRate = this.pool.enableCreatorFee ? this.rates.creator : new BN(0);

    let output: BN;
    if (creatorOnInput) {
      const net = actualIn.sub(ceilDiv(actualIn, this.rates.trade.add(creatorRate)));
      output = net.mul(reserveOut).div(reserveIn.add(net));
    } else {
      const net = actualIn.sub(ceilDiv(actualIn, this.rates.trade));
      const swapped = net.mul(reserveOut).div(reserveIn.add(net));
      output = swapped.sub(ceilDiv(swapped, creatorRate));
    }
    if (output.lten(0)) throw new VenueError('Trade amount too small for this pool', 'EMPTY');
    return fromBase ? output : output.sub(this.transferFeeOn(output));
  }

  private spotPerRaw(): number {
    const { base, quote } = this.reserves();
    const b = Number(base.toString());
    return b > 0 ? (Number(quote.toString()) / b) * (this.route ? this.route.leg.lamportsPerToken() : 1) : 0;
  }

  spotLamportsPerToken(): number {
    return this.spotPerRaw() * 10 ** this.mint.decimals;
  }

  quoteBuy(lamportsIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    const leg = this.route?.leg;
    const quoteIn = leg ? new BN(leg.quote(BigInt(lamportsIn.toString()), true).toString()) : lamportsIn;
    const out = this.swapIn(quoteIn, false);
    const minOut = leg ? BN.max(routeMinOut(out, slippageBps(slippagePct)), new BN(1)) : lessSlippage(out, slippagePct, 1);
    return { side: 'buy', inAmount: lamportsIn, out, minOut, maxIn: lamportsIn, priceImpactPct: impactPct('buy', lamportsIn, out, this.spotPerRaw()) };
  }

  quoteSell(tokensIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    const leg = this.route?.leg;
    const quoteOut = this.swapIn(tokensIn, true);
    const out = leg ? new BN(leg.quote(BigInt(quoteOut.toString()), false).toString()) : quoteOut;
    const minOut = leg ? routeMinOut(out, slippageBps(slippagePct)) : lessSlippage(out, slippagePct);
    return { side: 'sell', inAmount: tokensIn, out, minOut, maxIn: tokensIn, priceImpactPct: impactPct('sell', out, tokensIn, this.spotPerRaw()) };
  }

  private baseAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.mint.mint, user, true, this.mint.tokenProgram);
  }

  /** The user's account for the pool's quote token (WSOL, or STONK when routed). */
  private quoteAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.quoteMint, user, true, this.baseIs0 ? this.pool.program1 : this.pool.program0);
  }

  private wsolAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  }

  /** swap_base_input's accounts after the payer. */
  private swapAccounts(user: PublicKey, fromBase: boolean): AccountMeta[] {
    const p = this.pool;
    const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    const [baseVault, quoteVault] = this.baseIs0 ? [p.vault0, p.vault1] : [p.vault1, p.vault0];
    const base = { account: this.baseAta(user), vault: baseVault, program: this.mint.tokenProgram, mint: this.mint.mint };
    // The pool records each side's token program (Token-2022 for an xStock quote).
    const quote = { account: this.quoteAta(user), vault: quoteVault, program: this.baseIs0 ? p.program1 : p.program0, mint: this.quoteMint };
    const [input, output] = fromBase ? [base, quote] : [quote, base];
    return [
      r(AUTHORITY),
      r(p.ammConfig),
      w(this.address),
      w(input.account),
      w(output.account),
      w(input.vault),
      w(output.vault),
      r(input.program),
      r(output.program),
      r(input.mint),
      r(output.mint),
      w(p.observation),
    ];
  }

  private swapIx(user: PublicKey, fromBase: boolean, amountIn: BN, minOut: BN): TransactionInstruction {
    return new TransactionInstruction({
      programId: CPMM_PROGRAM_ID,
      keys: [{ pubkey: user, isSigner: true, isWritable: true }, ...this.swapAccounts(user, fromBase)],
      data: Buffer.concat([SWAP_BASE_INPUT, amountIn.toArrayLike(Buffer, 'le', 8), minOut.toArrayLike(Buffer, 'le', 8)]),
    });
  }

  /** The pool as a Jupiter RaydiumCP leg: its swap accounts, prefixed by the program id. */
  private poolLeg(user: PublicKey, fromBase: boolean): RouteLeg {
    return {
      swap: SWAP.raydiumCp(),
      accounts: [{ pubkey: CPMM_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: user, isSigner: false, isWritable: true }, ...this.swapAccounts(user, fromBase)],
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
    if (this.route) ixs.push(...hopAtas(user, this.route.leg), createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.quoteMint, this.route.leg.tokenProgram));
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
            legs: [...this.solLegs(user, true), this.poolLeg(user, false)],
          })
        : this.swapIx(user, false, q.inAmount, q.minOut),
      // Unwraps anything not spent, plus the account rent.
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    );
    return ixs;
  }

  async buildSell(user: PublicKey, _userAta: AccountInfo<Buffer> | null, q: Quote, slippagePct: number) {
    this.assertTradable();
    const wsol = this.wsolAta(user);
    const ixs: TransactionInstruction[] = [];
    if (this.route) ixs.push(...hopAtas(user, this.route.leg), createAssociatedTokenAccountIdempotentInstruction(user, this.quoteAta(user), user, this.quoteMint, this.route.leg.tokenProgram));
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
            legs: [this.poolLeg(user, true), ...this.solLegs(user, false)],
          })
        : this.swapIx(user, true, q.inAmount, q.minOut),
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

/** The CPMM pool a graduated LaunchLab curve migrated to, if it did. */
async function graduatedPool(conn: Connection, mint: PublicKey): Promise<PublicKey | null> {
  const quotes = [NATIVE_MINT, ...Object.keys(ROUTED_QUOTES).map((k) => new PublicKey(k))];
  const infos = await conn.getMultipleAccountsInfo(quotes.map((q) => launchLabPoolPda(mint, q)), 'confirmed');
  // A curve quoted in some other token (an xStock, say): found by its base mint.
  if (!infos.some((i) => i?.owner.equals(LAUNCHLAB_PROGRAM_ID))) infos.push((await launchLabPoolByBase(conn, mint))?.info ?? null);
  for (const info of infos) {
    const ll = info?.owner.equals(LAUNCHLAB_PROGRAM_ID) ? decodeLaunchLabPool(info) : null;
    if (!ll || ll.status !== 2 || !ll.baseMint.equals(mint)) continue;
    if (migrateType(info!) !== 1) throw new VenueError('This coin graduated to a Raydium AMM v4 pool (not supported yet)', 'UNSUPPORTED');
    // The platform config names the CPMM config its coins migrate into.
    const platform = await conn.getAccountInfo(ll.platformConfig, 'confirmed');
    if (!platform || platform.data.length < 720) return null;
    const config = new PublicKey(platform.data.subarray(688, 720));
    const [m0, m1] = Buffer.compare(mint.toBuffer(), ll.quoteMint.toBuffer()) < 0 ? [mint, ll.quoteMint] : [ll.quoteMint, mint];
    return cpmmPoolPda(config, m0, m1);
  }
  return null;
}

export const raydiumCpmm: VenueAdapter = {
  id: 'RAYDIUM_CPMM',

  async open(conn: Connection, mint: MintInfo, hint) {
    const address = hint?.account ?? (await graduatedPool(conn, mint.mint));
    if (!address) return null;
    const [poolInfo, mintInfo] = await conn.getMultipleAccountsInfo([address, mint.mint], 'confirmed');
    const pool = poolInfo ? decodeCpmmPool(poolInfo) : null;
    if (!pool || !(pool.mint0.equals(mint.mint) || pool.mint1.equals(mint.mint))) return null;
    const quoteMint = pool.mint0.equals(mint.mint) ? pool.mint1 : pool.mint0;
    const routed = !quoteMint.equals(NATIVE_MINT);
    if (!mintInfo) throw new VenueError('Mint not found on chain', 'NOT_FOUND');

    const [configInfo, vault0, vault1] = await conn.getMultipleAccountsInfo(
      [pool.ammConfig, pool.vault0, pool.vault1],
      'confirmed',
    );
    if (!configInfo || !vault0 || !vault1) throw new VenueError('Raydium CPMM pool accounts not found', 'NOT_FOUND');
    const [route, transferFee] = await Promise.all([
      routed ? openRoute(conn, quoteMint, address) : null,
      transferFeeOf(conn, mint, mintInfo),
    ]);
    if (routed && !route) throw nonSolQuote(quoteMint);
    if (route) assertNoQuoteFee(route);
    return new CpmmMarket(mint, address, pool, configInfo, vault0, vault1, route, transferFee);
  },

  ownsAccount: (owner) => owner.equals(CPMM_PROGRAM_ID),

  async mintOf(conn, _account, info) {
    const pool = decodeCpmmPool(info);
    if (!pool) return null;
    // The coin is the side that isn't a quote token.
    if (QUOTE_MINTS.has(pool.mint0.toBase58())) return pool.mint1;
    if (QUOTE_MINTS.has(pool.mint1.toBase58())) return pool.mint0;
    // Neither is (a coin paired with an xStock, say): the side that launched on a LaunchLab curve.
    const [as0, as1] = await conn.getMultipleAccountsInfo([launchLabPoolPda(pool.mint0, pool.mint1), launchLabPoolPda(pool.mint1, pool.mint0)], 'confirmed');
    return as1?.owner.equals(LAUNCHLAB_PROGRAM_ID) && !as0 ? pool.mint1 : pool.mint0;
  },

  allowedPrograms: () => [CPMM_PROGRAM_ID.toBase58(), JUPITER_PROGRAM_ID.toBase58()],
};

export type { CpmmMarket };
