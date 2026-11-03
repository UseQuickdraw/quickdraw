// Raydium AMM v4 (the "Raydium V4" Axiom shows): where pump.fun coins
// graduated before PumpSwap existed, and many older SOL pairs. Built from the
// program's source (raydium-io/raydium-amm: state.rs AmmInfo, processor.rs
// process_swap_base_in_v2, math.rs); no SDK.
//
// Only SOL-paired pools that are swap-only (status 6) trade here: they no
// longer place orders on OpenBook, so the pool is plain constant product on its
// two vaults less the PnL it still owes, and swap_base_in_v2 needs no OpenBook
// accounts. The coin can be either side: pools put whichever mint first.
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo, type Connection } from '@solana/web3.js';
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
import { VenueError, impactPct, lessSlippage, type Market, type Quote, type VenueAdapter } from './types';

export const AMM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('amm authority')], AMM_V4_PROGRAM_ID)[0];
const POOL_SIZE = 752;
/** AmmStatus::SwapOnly: no OpenBook orders, so the vaults are the whole pool. */
const SWAP_ONLY = 6;
const SWAP_BASE_IN_V2 = 16;

// ----------------------------------------------------------------- layout
// AmmInfo: 16 u64s, Fees (8 u64), StateData, then the keys. Plain repr(C), no discriminator.

export interface AmmPool {
  status: number;
  swapFeeNumerator: BN;
  swapFeeDenominator: BN;
  /** PnL owed out of each vault: in the vault, but not liquidity. */
  needTakePnlCoin: BN;
  needTakePnlPc: BN;
  openTime: number;
  coinVault: PublicKey;
  pcVault: PublicKey;
  coinMint: PublicKey;
  pcMint: PublicKey;
}

const u64 = (d: Buffer, o: number) => new BN(d.subarray(o, o + 8), 'le');
const key = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));

export function decodeAmmPool(info: AccountInfo<Buffer>): AmmPool | null {
  const d = info.data;
  if (!info.owner.equals(AMM_V4_PROGRAM_ID) || d.length !== POOL_SIZE) return null;
  return {
    status: Number(d.readBigUInt64LE(0)),
    swapFeeNumerator: u64(d, 176),
    swapFeeDenominator: u64(d, 184),
    needTakePnlCoin: u64(d, 192),
    needTakePnlPc: u64(d, 200),
    openTime: Number(d.readBigUInt64LE(224)),
    coinVault: key(d, 336),
    pcVault: key(d, 368),
    coinMint: key(d, 400),
    pcMint: key(d, 432),
  };
}

// ------------------------------------------------------------------ market

class AmmMarket implements Market {
  readonly venue = 'RAYDIUM_AMM' as const;
  private pool: AmmPool;
  private coinVault: BN;
  private pcVault: BN;
  /** Whether the coin is the pool's "coin" side (and SOL its "pc"). */
  private readonly baseIsCoin: boolean;

  constructor(
    readonly mint: MintInfo,
    readonly address: PublicKey,
    pool: AmmPool,
    coinVault: AccountInfo<Buffer>,
    pcVault: AccountInfo<Buffer>,
  ) {
    this.pool = pool;
    this.coinVault = tokenAmount(coinVault);
    this.pcVault = tokenAmount(pcVault);
    this.baseIsCoin = pool.coinMint.equals(mint.mint);
  }

  get state(): AmmPool {
    return this.pool;
  }

  watchAccounts(): PublicKey[] {
    return [this.address, this.pool.coinVault, this.pool.pcVault];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    if (pubkey.equals(this.address)) this.pool = decodeAmmPool(info) ?? this.pool;
    else if (pubkey.equals(this.pool.coinVault)) this.coinVault = tokenAmount(info);
    else if (pubkey.equals(this.pool.pcVault)) this.pcVault = tokenAmount(info);
  }

  tradable(): boolean {
    return this.pool.status === SWAP_ONLY && Date.now() / 1000 >= this.pool.openTime;
  }

  private assertTradable(): void {
    if (this.pool.status !== SWAP_ONLY) throw new VenueError('This Raydium AMM v4 pool still trades through OpenBook (not supported yet)', 'UNSUPPORTED');
    if (!this.tradable()) throw new VenueError('Swaps are not open on this Raydium pool yet', 'UNSUPPORTED');
  }

  /** Vault balances less the PnL owed out of them (calc_total_without_take_pnl_no_orderbook). */
  private reserves(): { base: BN; quote: BN } {
    const coin = this.coinVault.sub(this.pool.needTakePnlCoin);
    const pc = this.pcVault.sub(this.pool.needTakePnlPc);
    return this.baseIsCoin ? { base: coin, quote: pc } : { base: pc, quote: coin };
  }

  /** swap_base_in: the fee comes off the input (rounded up), then constant product, rounded down. */
  private swapIn(amountIn: BN, fromBase: boolean): BN {
    const { base, quote } = this.reserves();
    const [reserveIn, reserveOut] = fromBase ? [base, quote] : [quote, base];
    const fee = amountIn.mul(this.pool.swapFeeNumerator).add(this.pool.swapFeeDenominator).subn(1).div(this.pool.swapFeeDenominator);
    const net = amountIn.sub(fee);
    const out = net.mul(reserveOut).div(reserveIn.add(net));
    if (out.lten(0)) throw new VenueError('Trade amount too small for this pool', 'EMPTY');
    return out;
  }

  private spotPerRaw(): number {
    const { base, quote } = this.reserves();
    const b = Number(base.toString());
    return b > 0 ? Number(quote.toString()) / b : 0;
  }

  spotLamportsPerToken(): number {
    return this.spotPerRaw() * 10 ** this.mint.decimals;
  }

  quoteBuy(lamportsIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    const out = this.swapIn(lamportsIn, false);
    return { side: 'buy', inAmount: lamportsIn, out, minOut: lessSlippage(out, slippagePct, 1), maxIn: lamportsIn, priceImpactPct: impactPct('buy', lamportsIn, out, this.spotPerRaw()) };
  }

  quoteSell(tokensIn: BN, slippagePct: number): Quote {
    this.assertTradable();
    const out = this.swapIn(tokensIn, true);
    return { side: 'sell', inAmount: tokensIn, out, minOut: lessSlippage(out, slippagePct), maxIn: tokensIn, priceImpactPct: impactPct('sell', out, tokensIn, this.spotPerRaw()) };
  }

  private baseAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.mint.mint, user, true, this.mint.tokenProgram);
  }

  private wsolAta(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  }

  /** swap_base_in_v2: the direction follows which of the user's accounts is the source. */
  private swapIx(user: PublicKey, fromBase: boolean, amountIn: BN, minOut: BN): TransactionInstruction {
    const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const [source, destination] = fromBase ? [this.baseAta(user), this.wsolAta(user)] : [this.wsolAta(user), this.baseAta(user)];
    return new TransactionInstruction({
      programId: AMM_V4_PROGRAM_ID,
      keys: [
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        w(this.address),
        { pubkey: AUTHORITY, isSigner: false, isWritable: false },
        w(this.pool.coinVault),
        w(this.pool.pcVault),
        w(source),
        w(destination),
        { pubkey: user, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([SWAP_BASE_IN_V2]), amountIn.toArrayLike(Buffer, 'le', 8), minOut.toArrayLike(Buffer, 'le', 8)]),
    });
  }

  async buildBuy(user: PublicKey, userAta: AccountInfo<Buffer> | null, q: Quote) {
    this.assertTradable();
    const wsol = this.wsolAta(user);
    const ixs: TransactionInstruction[] = [];
    if (!userAta) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, this.baseAta(user), user, this.mint.mint, this.mint.tokenProgram));
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports: BigInt(q.inAmount.toString()) }),
      createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID),
      this.swapIx(user, false, q.inAmount, q.minOut),
      // Unwraps anything not spent, plus the account rent.
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    );
    return ixs;
  }

  async buildSell(user: PublicKey, _userAta: AccountInfo<Buffer> | null, q: Quote) {
    this.assertTradable();
    const wsol = this.wsolAta(user);
    return [
      createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID),
      this.swapIx(user, true, q.inAmount, q.minOut),
      createCloseAccountInstruction(wsol, user, user, [], TOKEN_PROGRAM_ID),
    ];
  }

  selfAccounts(user: PublicKey): PublicKey[] {
    return [this.wsolAta(user)];
  }
}

// ----------------------------------------------------------------- adapter

/**
 * A coin's SOL pool on AMM v4, found by a filtered scan (pool addresses derive
 * from an OpenBook market, not the mints). The deepest if there are several.
 */
async function poolByMint(conn: Connection, mint: PublicKey): Promise<PublicKey | null> {
  // An RPC that refuses program scans just means no pool found here.
  const scan = async (coin: PublicKey, pc: PublicKey) => {
    try {
      return await conn.getProgramAccounts(AMM_V4_PROGRAM_ID, {
        commitment: 'confirmed',
        dataSlice: { offset: 0, length: 0 },
        filters: [{ dataSize: POOL_SIZE }, { memcmp: { offset: 400, bytes: coin.toBase58() } }, { memcmp: { offset: 432, bytes: pc.toBase58() } }],
      });
    } catch {
      return [];
    }
  };
  const found = [...(await scan(mint, NATIVE_MINT)), ...(await scan(NATIVE_MINT, mint))].map((a) => a.pubkey);
  if (found.length <= 1) return found[0] ?? null;
  const pools = await conn.getMultipleAccountsInfo(found, 'confirmed');
  const sol = await conn.getMultipleAccountsInfo(
    pools.map((p) => {
      const d = p ? decodeAmmPool(p) : null;
      return d ? (d.coinMint.equals(NATIVE_MINT) ? d.coinVault : d.pcVault) : PublicKey.default;
    }),
    'confirmed',
  );
  let best = 0;
  sol.forEach((v, i) => tokenAmount(v).gt(tokenAmount(sol[best])) && (best = i));
  return found[best]!;
}

export const raydiumAmm: VenueAdapter = {
  id: 'RAYDIUM_AMM',

  async open(conn: Connection, mint: MintInfo, hint) {
    const address = hint?.account ?? (await poolByMint(conn, mint.mint));
    if (!address) return null;
    const poolInfo = await conn.getAccountInfo(address, 'confirmed');
    const pool = poolInfo ? decodeAmmPool(poolInfo) : null;
    if (!pool || !(pool.coinMint.equals(mint.mint) || pool.pcMint.equals(mint.mint))) return null;
    const quoteMint = pool.coinMint.equals(mint.mint) ? pool.pcMint : pool.coinMint;
    if (!quoteMint.equals(NATIVE_MINT)) throw new VenueError('This Raydium AMM v4 pool is paired with a token other than SOL (not supported yet)', 'UNSUPPORTED');
    if (!mint.tokenProgram.equals(TOKEN_PROGRAM_ID)) throw new VenueError('Raydium AMM v4 only trades classic SPL tokens', 'UNSUPPORTED');
    const [coinVault, pcVault] = await conn.getMultipleAccountsInfo([pool.coinVault, pool.pcVault], 'confirmed');
    if (!coinVault || !pcVault) throw new VenueError('Raydium AMM v4 pool vaults not found', 'NOT_FOUND');
    return new AmmMarket(mint, address, pool, coinVault, pcVault);
  },

  ownsAccount: (owner) => owner.equals(AMM_V4_PROGRAM_ID),

  async mintOf(_conn, _account, info) {
    const pool = decodeAmmPool(info);
    if (!pool) return null;
    // The coin is the side that isn't SOL.
    return pool.coinMint.equals(NATIVE_MINT) ? pool.pcMint : pool.coinMint;
  },

  allowedPrograms: () => [AMM_V4_PROGRAM_ID.toBase58()],
};

export type { AmmMarket };
