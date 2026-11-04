// Venue plugin contract. Implementations wrap the pinned pump SDK; the guard's
// program allowlist is the union of every registered venue's allowedPrograms().
//
// A VenueAdapter `open`s a Market for a mint (detect + prefetch in one batched
// RPC call). The Market holds the state accounts the hot path needs, is kept
// fresh by account subscriptions (`watchAccounts` / `apply`), and quotes and
// builds locally with no RPC round-trip.
import type { AccountInfo, AddressLookupTableAccount, Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import type { Venue } from '../messages';
import type { MintInfo } from '../solana/tokens';

export type VenueId = Exclude<Venue, 'UNSUPPORTED'>;

export interface Quote {
  side: 'buy' | 'sell';
  /** Buy: lamports in. Sell: raw tokens in. */
  inAmount: BN;
  /** Expected out. Buy: raw tokens. Sell: lamports. */
  out: BN;
  /** Floor enforced on chain. */
  minOut: BN;
  /** Worst-case spend enforced on chain (buys can exceed `inAmount` by slippage on exact-out venues). */
  maxIn: BN;
  /** Effective price vs spot, in percent (positive = worse). */
  priceImpactPct: number;
}

export interface Market {
  venue: VenueId;
  mint: MintInfo;
  /** The curve or pool account. */
  address: PublicKey;
  /** Accounts whose updates change quotes. */
  watchAccounts(): PublicKey[];
  /** Feed a fresh account state (from a subscription or refetch). */
  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): void;
  /** False once this venue can no longer trade the mint (e.g. the curve completed). */
  tradable(): boolean;
  /** Spot price in lamports per whole token. */
  spotLamportsPerToken(): number;
  quoteBuy(lamportsIn: BN, slippagePct: number): Quote;
  quoteSell(tokensIn: BN, slippagePct: number): Quote;
  /** `userTokenAccount` is the user's ATA for this mint (null if it doesn't exist yet). */
  buildBuy(user: PublicKey, userTokenAccount: AccountInfo<Buffer> | null, quote: Quote, slippagePct: number): Promise<TransactionInstruction[]>;
  buildSell(user: PublicKey, userTokenAccount: AccountInfo<Buffer> | null, quote: Quote, slippagePct: number): Promise<TransactionInstruction[]>;
  /** Accounts we own that this venue's transactions may move SOL into (e.g. our WSOL ATA). */
  selfAccounts(user: PublicKey): PublicKey[];
  /** Lookup tables a transaction may draw from when it would otherwise be too large. */
  lookupTables?(): AddressLookupTableAccount[];
  /** Settles when tables still being found in the background have joined `lookupTables`. */
  whenTablesReady?(): Promise<void>;
  /** While on, routed legs pass only the tick arrays their latest quote crosses, to fit a transaction that's too big. */
  setLean?(on: boolean): void;
  /** False when the user's token account can't be closed after a full sell (e.g. withheld transfer fees). */
  canCloseTokenAccount?(): boolean;
  /** The least compute limit this market's trades need, over what calibration says for its venue (0: none). */
  cuFloor?(): number;
}

export interface OpenHint {
  /** A specific curve/pool the page pointed at, when the address wasn't the mint. */
  account?: PublicKey;
}

export interface VenueAdapter {
  id: VenueId;
  /** Detect + prefetch. Returns null when this venue can't trade the mint. */
  open(conn: Connection, mint: MintInfo, hint?: OpenHint): Promise<Market | null>;
  /** True if `owner` is this venue's program (used to resolve non-mint addresses). */
  ownsAccount(owner: PublicKey): boolean;
  /** Mint behind one of this venue's accounts (curve/pool), or null. */
  mintOf(conn: Connection, account: PublicKey, info: AccountInfo<Buffer>): Promise<PublicKey | null>;
  allowedPrograms(): string[];
}

/** Curve venues whose coins move to a pool when the curve completes: the app re-resolves them to follow. */
export function migratesOnComplete(venue: string): boolean {
  return venue.startsWith('PUMP_CURVE') || venue.startsWith('LAUNCHLAB');
}

/** The pool a completed curve's coin moves to, for messages. */
export function migrationTarget(venue: string): string {
  return venue.startsWith('LAUNCHLAB') ? 'Raydium' : 'PumpSwap';
}

export class VenueError extends Error {
  constructor(
    message: string,
    readonly code: 'UNSUPPORTED' | 'CURVE_COMPLETE' | 'NON_SOL_QUOTE' | 'NOT_FOUND' | 'EMPTY',
  ) {
    super(message);
    this.name = 'VenueError';
  }
}

/** The SDK's slippage rounding (0.1% steps), mirrored for display. */
export function lessSlippage(amount: BN, slippagePct: number, floor = 0): BN {
  const v = amount.sub(amount.muln(Math.floor(slippagePct * 10)).divn(1000));
  return BN.max(v, new BN(floor));
}

export function plusSlippage(amount: BN, slippagePct: number): BN {
  return amount.add(amount.muln(Math.floor(slippagePct * 10)).divn(1000));
}

/** Positive = paying more (buy) / receiving less (sell) than spot. */
export function impactPct(side: 'buy' | 'sell', lamports: BN, tokens: BN, spotLamportsPerRaw: number): number {
  if (tokens.isZero() || spotLamportsPerRaw <= 0) return 0;
  const eff = Number(lamports.toString()) / Number(tokens.toString());
  const r = eff / spotLamportsPerRaw - 1;
  return (side === 'buy' ? r : -r) * 100;
}
