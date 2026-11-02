// What venues share for coins that aren't priced in SOL, and for Token-2022
// coins with a transfer fee.
//
// A pool quoted in another token trades through a Jupiter route we build
// ourselves: SOL <-> that token on its SOL pool (the "SOL leg"), plus the
// venue's own leg. The route hands each leg exactly what the previous one
// produced, so nothing is left in between. The SOL leg is, in order of
// preference: a configured Orca Whirlpool (ROUTED_QUOTES, e.g. STONK), the
// token's own canonical PumpSwap pool against SOL (pump.fun coins), its
// deepest Raydium CLMM or Orca pool against SOL when that holds enough, or
// else the deepest (valued in SOL) of that, a Raydium CLMM or Orca pool
// against USDC behind SOL -> USDC on Orca's SOL/USDC pool (the PreStocks), and
// a pump coin's own pool priced in another token behind that token's route
// (BTC priced in WBTC: SOL -> WBTC -> BTC). These transactions need address
// lookup tables to fit; the guard expands them before signing.
import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey, TransactionInstruction, type AccountInfo, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { fetchTokenMeta } from '../solana/metadata';
import type { RouteLeg } from './jupiter';
import { PumpSwapSolLeg } from './pumpPool';
import { VenueError } from './types';
import { ClmmLeg } from './raydiumClmm';
import { WhirlpoolLeg } from './whirlpool';
import type { TransferFee } from './transferFee';

export { transferFeeOf, transferFeeOn, type TransferFee } from './transferFee';

export const STONK_MINT = new PublicKey('6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx');
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
/** Orca's SOL/USDC Whirlpool (static fee): the SOL -> USDC hop of USDC-anchored routes. */
const SOL_USDC_WHIRLPOOL = new PublicKey('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE');

/** Quote tokens with a configured Orca SOL pool, and lookup tables that hold that route's fixed accounts. */
export const ROUTED_QUOTES: Record<string, { symbol: string; whirlpool: PublicKey; lookupTables: PublicKey[] }> = {
  [STONK_MINT.toBase58()]: {
    symbol: 'STONK',
    // STONK/SOL, 0.65% static fee, the deepest Orca pool for it.
    whirlpool: new PublicKey('AfrddTGYwCVEQB1gxCAhR8i48o6qtxYqksdVkeLudEhg'),
    // Public tables other routers use for these trades (append-only, so an
    // index can never point at a different account). Execute picks the ones
    // that help; the guard expands and checks them before signing.
    lookupTables: [
      new PublicKey('ErngdC797SmMquTKJEQNkK3XdEk8uWNJi4apbHXGQXsq'),
      new PublicKey('5Nz39d12NjTdcCf5SePRJCcy3kQEJRtL2wA1XYqtcH4E'),
      new PublicKey('BctkHSmQXA1SiTNmxUtnJyeH9dC3tS2KzcEZSmLMc9ZT'),
      new PublicKey('6Et7TDMJFqv7biFJReyFGqddCjbARzMa3squijmQwgim'),
    ],
  },
};

/**
 * Public tables holding the fixed accounts every route uses, whatever the
 * token: token programs, WSOL, Jupiter's event authority, and the PumpSwap,
 * Raydium CPMM and LaunchLab program accounts.
 */
const GENERIC_LOOKUP_TABLES = [
  new PublicKey('8yaum345f4TErAhc3i12KD4mSk2THggKNbqQRigwCree'),
  new PublicKey('GP57a1T8vJjeAnF2zfKT1bnZysNwVprLaw6Mjw2d1gPy'),
  new PublicKey('FSGBpXZGjw21kq3jDtonUccrvYRyGtJFZNX3sUtHFEq3'),
  new PublicKey('3oy9ojnsDzqmMNi87Gs7Hn5v3MPVqnWjG9k8BmzKR7yW'),
];

/**
 * Public tables Jupiter's own USDC-routed trades use, holding the SOL/USDC
 * and USDC-side CLMM accounts that a chained route adds (append-only, and
 * the guard expands and checks them before signing).
 */
const USDC_ROUTE_LOOKUP_TABLES = [
  new PublicKey('DBmHWCVEGCzZ3zDNr9WzRaMmSqCjcixMh78imXfno9qJ'),
  new PublicKey('DHU5eQ48AgxHkeAhtjAqYfbPxhGnB6yXHu5GuAyfpvoW'),
];

/** Other quote tokens, named in the refusal. */
const KNOWN_QUOTES: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  '6UpQcMAb5xMzxc7ZfPaVMgx3KqsvKZdT5U718BzD5We2': 'wXRP',
};

export function quoteSymbol(quote: PublicKey): string {
  const k = quote.toBase58();
  return ROUTED_QUOTES[k]?.symbol ?? KNOWN_QUOTES[k] ?? `another token (${k.slice(0, 4)}…)`;
}

export function nonSolQuote(quote: PublicKey): VenueError {
  return new VenueError(
    `This coin trades against ${quoteSymbol(quote)}, not SOL, and that token has no SOL pool Quickdraw can route through yet.`,
    'NON_SOL_QUOTE',
  );
}

/** The SOL side of a route: swaps SOL and the quote token both ways, on one pool or a chain of them. */
export interface SolLeg {
  /** The quote token's program (its account in the user's wallet uses it). */
  readonly tokenProgram: PublicKey;
  watchAccounts(): PublicKey[];
  /** True when `pubkey` was one of this leg's accounts. */
  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): boolean;
  /** Raw out for an exact input, as it lands: tokens for lamports (fromSol), or lamports for tokens. */
  quote(amount: bigint, fromSol: boolean): bigint;
  /** Spot price: raw lamports per raw token. */
  lamportsPerToken(): number;
  /** Tokens passed through between SOL and the quote token, whose accounts the user needs. */
  hops(): { mint: PublicKey; tokenProgram: PublicKey }[];
  /** The pools it trades on, SOL side first. */
  pools(): PublicKey[];
  /** See Market.setLean. */
  setLean?(on: boolean): void;
  /** The Jupiter legs, in swap order. */
  jupiterLegs(user: PublicKey, fromSol: boolean): RouteLeg[];
}

/** A routed pool's SOL side: the leg and the lookup tables that make the tx fit. */
export interface Route {
  symbol: string;
  leg: SolLeg;
  lookupTables: AddressLookupTableAccount[];
  /** Settles once tables borrowed from recent trades on the route's pools have joined `lookupTables`. */
  tablesReady: Promise<void>;
  /** The quote token's transfer fee, if it has one: only venues that model it may use the route. */
  quoteFee: TransferFee | null;
}

/**
 * The least compute limit a route needs. Routes through a chain of pools
 * share their venue's calibration with two-leg routes but cost more:
 * SOL -> USDC -> NEURALINK -> Mars took 202-223k units in mainnet simulations
 * (tests/live-pumproute.test.ts, 2026-10-30), so they get ~35% over that.
 */
export function routeCuFloor(route: Route | null): number {
  // A further hop (e.g. SOL -> WBTC -> BTC behind a curve) adds roughly one more swap's worth.
  return route?.leg instanceof ChainLeg ? 300_000 + 80_000 * (route.leg.depth - 2) : 0;
}

/** Creates the user's accounts for the tokens a route passes through (kept afterwards, like the quote token's). */
export function hopAtas(user: PublicKey, leg: SolLeg): TransactionInstruction[] {
  return leg.hops().map((h) =>
    createAssociatedTokenAccountIdempotentInstruction(user, getAssociatedTokenAddressSync(h.mint, user, true, h.tokenProgram), user, h.mint, h.tokenProgram),
  );
}

/** Refuses a route whose quote token has a transfer fee, for venues that don't model it. */
export function assertNoQuoteFee(route: Route): void {
  if (route.quoteFee) throw new VenueError(`${route.symbol} charges a transfer fee, which this venue doesn't handle yet`, 'UNSUPPORTED');
}

/** A leg between an anchor token (SOL, USDC, WBTC...) and the quote token: the second half of a ChainLeg. */
export interface AnchoredLeg extends SolLeg {
  readonly anchor: PublicKey;
  readonly anchorProgram: PublicKey;
  /** The quote token's transfer fee, for legs that model one. */
  readonly tokenFee?: TransferFee | null;
}

/** SOL -> anchor on one leg (itself possibly a chain), then anchor -> token; the reverse for sells. */
export class ChainLeg implements SolLeg {
  constructor(
    readonly first: SolLeg,
    readonly second: AnchoredLeg,
  ) {}

  get tokenProgram(): PublicKey {
    return this.second.tokenProgram;
  }

  watchAccounts(): PublicKey[] {
    return [...this.first.watchAccounts(), ...this.second.watchAccounts()];
  }

  apply(pubkey: PublicKey, info: AccountInfo<Buffer>): boolean {
    return this.first.apply(pubkey, info) || this.second.apply(pubkey, info);
  }

  quote(amount: bigint, fromSol: boolean): bigint {
    return fromSol ? this.second.quote(this.first.quote(amount, true), true) : this.first.quote(this.second.quote(amount, false), false);
  }

  lamportsPerToken(): number {
    return this.second.lamportsPerToken() * this.first.lamportsPerToken();
  }

  hops(): { mint: PublicKey; tokenProgram: PublicKey }[] {
    return [...this.first.hops(), { mint: this.second.anchor, tokenProgram: this.second.anchorProgram }];
  }

  /** Swaps a trade makes through this leg. */
  get depth(): number {
    return (this.first instanceof ChainLeg ? this.first.depth : 1) + 1;
  }

  pools(): PublicKey[] {
    return [...this.first.pools(), ...this.second.pools()];
  }

  setLean(on: boolean): void {
    this.first.setLean?.(on);
    this.second.setLean?.(on);
  }

  jupiterLegs(user: PublicKey, fromSol: boolean): RouteLeg[] {
    if (fromSol) return [...this.first.jupiterLegs(user, true), ...this.second.jupiterLegs(user, true)];
    return [...this.second.jupiterLegs(user, false), ...this.first.jupiterLegs(user, false)];
  }
}

async function loadTables(conn: Connection, keys: PublicKey[]): Promise<AddressLookupTableAccount[]> {
  const infos = await conn.getMultipleAccountsInfo(keys, 'confirmed');
  return infos.flatMap((info, i) => {
    if (!info || !info.owner.equals(AddressLookupTableProgram.programId)) return [];
    const t = new AddressLookupTableAccount({ key: keys[i]!, state: AddressLookupTableAccount.deserialize(info.data) });
    return t.isActive() ? [t] : [];
  });
}

/** A configured Whirlpool against SOL (STONK's, and SOL/USDC for USDC-anchored routes). */
async function whirlpoolLeg(conn: Connection, quoteMint: PublicKey, whirlpool: PublicKey): Promise<WhirlpoolLeg> {
  const info = await conn.getAccountInfo(whirlpool, 'confirmed');
  if (!info) throw new VenueError(`The ${quoteSymbol(quoteMint)}/SOL pool was not found`, 'NOT_FOUND');
  const leg = new WhirlpoolLeg(whirlpool, info, quoteMint);
  const arrays = leg.arraysToLoad();
  const arrayInfos = await conn.getMultipleAccountsInfo(arrays.map((a) => a.key), 'confirmed');
  arrays.forEach((a, i) => leg.setArray(a.start, a.key, arrayInfos[i] ?? null));
  return leg;
}

/** A SOL pool holding this much handles trench-size trades in one hop, which costs less and fits more easily than two. */
const DIRECT_ENOUGH_LAMPORTS = 20_000_000_000n;

type Found = { leg: AnchoredLeg & SolLeg; reserve: bigint } | null;
const deeper = (xs: Found[]): Found => xs.reduce<Found>((a, b) => (b && (!a || b.reserve > a.reserve) ? b : a), null);
/** Orca refusals (a hooked token, say) just mean no Orca route; Raydium's own refusals still explain themselves. */
const orNull = (p: Promise<Found>): Promise<Found> => p.catch(() => null);

/**
 * The best leg between SOL and `token`: its own PumpSwap pool against SOL;
 * its deepest Raydium CLMM or Orca pool against SOL when that holds enough;
 * otherwise the deepest, valued in SOL, of that pool, one against USDC
 * behind SOL -> USDC, and (once, not recursively) a pump coin's own pool
 * priced in another token behind that token's own route.
 */
export async function solRoute(conn: Connection, token: PublicKey, followPumpQuote = true): Promise<SolLeg | null> {
  const pump = await PumpSwapSolLeg.open(conn, token);
  if (pump) return pump;
  const direct = deeper(await Promise.all([ClmmLeg.open(conn, token), orNull(WhirlpoolLeg.open(conn, token))]));
  if (direct && direct.reserve >= DIRECT_ENOUGH_LAMPORTS) return direct.leg;
  const options: { leg: SolLeg; lamports: number }[] = direct ? [{ leg: direct.leg, lamports: Number(direct.reserve) }] : [];

  if (!token.equals(USDC_MINT)) {
    const viaUsdc = deeper(await Promise.all([ClmmLeg.open(conn, token, USDC_MINT), orNull(WhirlpoolLeg.open(conn, token, USDC_MINT))]));
    if (viaUsdc) {
      const solUsdc = await whirlpoolLeg(conn, USDC_MINT, SOL_USDC_WHIRLPOOL);
      options.push({ leg: new ChainLeg(solUsdc, viaUsdc.leg), lamports: Number(viaUsdc.reserve) * solUsdc.lamportsPerToken() });
    }
  }
  if (followPumpQuote) {
    const other = await PumpSwapSolLeg.openOtherQuote(conn, token);
    const first = other ? await solRoute(conn, other.leg.anchor, false) : null;
    if (other && first) options.push({ leg: new ChainLeg(first, other.leg), lamports: Number(other.reserve) * first.lamportsPerToken() });
  }
  return options.reduce<{ leg: SolLeg; lamports: number } | null>((a, b) => (!a || b.lamports > a.lamports ? b : a), null)?.leg ?? null;
}

/** Recent transactions read per pool, and the most borrowed tables kept. */
const TABLE_SCAN_TXS = 12;
const TABLE_KEEP = 20;
/** Transactions fetched at once: more trips public RPCs' rate limits and finds less. */
const TABLE_FETCH_CONCURRENCY = 2;

/** Runs `fn` over `items`, `limit` at a time. */
async function inBatches<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

/**
 * Lookup tables other traders' recent transactions on these pools used.
 * Routers keep public tables holding a market's accounts, and a route through
 * pools nobody configured (a coin priced in HIMS, say) only fits in one
 * transaction with them. Tables are append-only and the guard expands and
 * checks every address before signing, so a borrowed table can only shorten
 * a transaction, never change it. Best effort: RPCs without history calls
 * (or a quiet pool) just add nothing.
 */
async function borrowTables(conn: Connection, pools: PublicKey[]): Promise<AddressLookupTableAccount[]> {
  const seen = new Map<string, number>();
  const scan = async (pool: PublicKey) => {
    try {
      const sigs = await conn.getSignaturesForAddress(pool, { limit: 3 * TABLE_SCAN_TXS }, 'confirmed');
      const fetchTx = (sig: string) => conn.getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
      const txs = await inBatches(
        sigs.filter((x) => !x.err).slice(0, TABLE_SCAN_TXS).map((x) => x.signature),
        TABLE_FETCH_CONCURRENCY,
        // One retry: a busy RPC drops the odd request.
        (sig) => fetchTx(sig).catch(() => new Promise((r) => setTimeout(r, 400)).then(() => fetchTx(sig)).catch(() => null)),
      );
      for (const tx of txs) {
        for (const l of tx?.transaction.message.addressTableLookups ?? []) {
          const k = l.accountKey.toBase58();
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
      }
    } catch {
      // No history on this RPC: nothing to borrow.
    }
  };
  for (const pool of pools) await scan(pool);
  const top = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, TABLE_KEEP).map(([k]) => new PublicKey(k));
  return top.length ? loadTables(conn, top) : [];
}

/**
 * Starts borrowing tables for a route (the venue's own pool first, then the
 * leg's, nearest the quote token first). Only chained routes need them, and
 * the reads are paced, so a free RPC plan isn't pushed into rate limits.
 */
function startBorrowing(conn: Connection, route: Omit<Route, 'tablesReady'>, venuePool?: PublicKey): Route {
  if (!(route.leg instanceof ChainLeg)) return { ...route, tablesReady: Promise.resolve() } as Route;
  const pools = [...(venuePool ? [venuePool] : []), ...route.leg.pools().reverse()];
  const tablesReady = borrowTables(conn, pools)
    .then((tables) => {
      for (const t of tables) if (!route.lookupTables.some((x) => x.key.equals(t.key))) route.lookupTables.push(t);
    })
    .catch(() => {});
  return { ...route, tablesReady } as Route;
}

/**
 * A route between SOL and `quoteMint`, or null when the token has no SOL pool
 * we can use. `venuePool` is the coin's own pool or curve, when that isn't
 * already one of the route's (a coin traded on its own SOL pool): tables borrowed
 * from its recent trades join the route's in the background.
 */
export async function openRoute(conn: Connection, quoteMint: PublicKey, venuePool?: PublicKey): Promise<Route | null> {
  const cfg = ROUTED_QUOTES[quoteMint.toBase58()];
  if (cfg) {
    const [leg, lookupTables] = await Promise.all([whirlpoolLeg(conn, quoteMint, cfg.whirlpool), loadTables(conn, [...cfg.lookupTables, ...GENERIC_LOOKUP_TABLES])]);
    return startBorrowing(conn, { symbol: cfg.symbol, leg, lookupTables, quoteFee: null }, venuePool);
  }
  const leg = await solRoute(conn, quoteMint);
  if (!leg) return null;
  const lookupTables = await loadTables(conn, leg instanceof ChainLeg ? [...GENERIC_LOOKUP_TABLES, ...USDC_ROUTE_LOOKUP_TABLES] : GENERIC_LOOKUP_TABLES);
  // Only the CLMM legs model a transfer fee on the quote token (Orca refuses such tokens, PumpSwap pools such coins).
  const last = leg instanceof ChainLeg ? leg.second : (leg as Partial<AnchoredLeg>);
  const meta = await fetchTokenMeta(conn, { mint: quoteMint, tokenProgram: leg.tokenProgram, decimals: 0, supply: new BN(0) });
  return startBorrowing(conn, { symbol: meta?.symbol || `${quoteMint.toBase58().slice(0, 4)}…`, leg, lookupTables, quoteFee: last.tokenFee ?? null }, venuePool);
}
