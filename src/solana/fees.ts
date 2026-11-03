// Hot caches the click path reads synchronously: compute-unit limits,
// priority-fee estimates and the latest blockhash. All refreshed in the
// background so a click never waits on the network for them.
import type { Connection, PublicKey } from '@solana/web3.js';
import type { PriorityLevel } from '../settings/schema';
import type { VenueId } from '../venues/types';
import { rpcFetch } from './retryFetch';

// ---------------------------------------------------------------- CU limits

export type CuOp = 'buy' | 'buy+ata' | 'sell' | 'sell+close';
export type CuKey = `${VenueId}:${CuOp}`;

/**
 * Starting limits: the largest consumption seen in mainnet simulations
 * (tests/live-sim.test.ts, 2026-10-28) plus ~35% headroom. Calibration then
 * sizes them from this browser's own simulations.
 *   curve buy+ata 73-81k, sell ~50k, sell+close ~51k
 *   PumpSwap buy+ata 106-132k, sell 91-116k, sell+close 91-116k
 *   LaunchLab buy+ata 76k, sell 65k, sell+close 67k
 *   LaunchLab via STONK (Jupiter route) buy+ata 125-128k, sell 120k
 *   PumpSwap via a pump coin (Jupiter route) buy+ata 166-174k, sell 148-161k;
 *   via an xStock on a Raydium CLMM buy+ata 162k, sell 144-145k
 *   Raydium CPMM via an xStock on a Raydium CLMM buy+ata 133k, sell 108-109k
 *   Raydium CPMM buy+ata 52k, sell 44-46k; via STONK buy+ata 107k, sell 89-90k
 */
export const DEFAULT_CU: Record<CuKey, number> = {
  'PUMP_CURVE:buy': 100_000,
  'PUMP_CURVE:buy+ata': 110_000,
  'PUMP_CURVE:sell': 70_000,
  'PUMP_CURVE:sell+close': 75_000,
  'PUMPSWAP:buy': 160_000,
  'PUMPSWAP:buy+ata': 180_000,
  'PUMPSWAP:sell': 160_000,
  'PUMPSWAP:sell+close': 160_000,
  'LAUNCHLAB:buy': 100_000,
  'LAUNCHLAB:buy+ata': 105_000,
  'LAUNCHLAB:sell': 90_000,
  'LAUNCHLAB:sell+close': 90_000,
  'PUMP_CURVE_ROUTED:buy': 200_000,
  'PUMP_CURVE_ROUTED:buy+ata': 210_000,
  'PUMP_CURVE_ROUTED:sell': 190_000,
  'PUMP_CURVE_ROUTED:sell+close': 195_000,
  'PUMPSWAP_ROUTED:buy': 200_000,
  'PUMPSWAP_ROUTED:buy+ata': 210_000,
  'PUMPSWAP_ROUTED:sell': 190_000,
  'PUMPSWAP_ROUTED:sell+close': 195_000,
  'LAUNCHLAB_ROUTED:buy': 165_000,
  'LAUNCHLAB_ROUTED:buy+ata': 175_000,
  'LAUNCHLAB_ROUTED:sell': 165_000,
  'LAUNCHLAB_ROUTED:sell+close': 170_000,
  'RAYDIUM_CPMM:buy': 65_000,
  'RAYDIUM_CPMM:buy+ata': 72_000,
  'RAYDIUM_CPMM:sell': 62_000,
  'RAYDIUM_CPMM:sell+close': 64_000,
  'RAYDIUM_CPMM_ROUTED:buy': 170_000,
  'RAYDIUM_CPMM_ROUTED:buy+ata': 175_000,
  'RAYDIUM_CPMM_ROUTED:sell': 150_000,
  'RAYDIUM_CPMM_ROUTED:sell+close': 155_000,
  // A coin's own CLMM or Orca pool through a Jupiter route: one swap, but it pays per tick crossed.
  'CLMM_ROUTED:buy': 150_000,
  'CLMM_ROUTED:buy+ata': 160_000,
  'CLMM_ROUTED:sell': 140_000,
  'CLMM_ROUTED:sell+close': 145_000,
};

const HEADROOM = 1.15;
/**
 * Routed trades cross a second pool whose cost varies far more (a CLMM leg
 * pays per tick crossed), so they keep more headroom. No limit goes below the
 * measured default: a cheap trade must not size the limit for a costlier one
 * (PumpSwap sells alone vary 91-116k).
 */
const ROUTED_HEADROOM = 1.3;
const isRouted = (key: CuKey) => key.includes('_ROUTED:');
const MAX_CU = 1_400_000;
const KEEP = 5;

/** Remembers recent `unitsConsumed` per operation and sizes the next limit from them. */
export class CuCalibration {
  private seen: Partial<Record<CuKey, number[]>> = {};

  constructor(saved?: unknown) {
    if (saved && typeof saved === 'object') {
      for (const [k, v] of Object.entries(saved)) {
        if (k in DEFAULT_CU && Array.isArray(v)) this.seen[k as CuKey] = v.filter((n) => Number.isInteger(n) && n > 0).slice(-KEEP);
      }
    }
  }

  limit(key: CuKey): number {
    const s = this.seen[key];
    if (!s?.length) return DEFAULT_CU[key];
    // The largest recent consumption plus headroom, but never under the default.
    const headroom = isRouted(key) ? ROUTED_HEADROOM : HEADROOM;
    return Math.min(MAX_CU, Math.max(DEFAULT_CU[key], Math.ceil(Math.max(...s) * headroom)));
  }

  record(key: CuKey, unitsConsumed: number): void {
    if (!Number.isInteger(unitsConsumed) || unitsConsumed <= 0) return;
    this.seen[key] = [...(this.seen[key] ?? []), unitsConsumed].slice(-KEEP);
  }

  /** After a "computational budget exceeded" failure: make sure the next limit is higher. */
  bump(key: CuKey, failedLimit: number): void {
    this.record(key, Math.min(MAX_CU, Math.ceil(failedLimit * 1.5)));
  }

  snapshot(): Partial<Record<CuKey, number[]>> {
    return structuredClone(this.seen);
  }
}

export function cuKey(venue: VenueId, side: 'buy' | 'sell', extra: boolean): CuKey {
  return `${venue}:${side}${extra ? (side === 'buy' ? '+ata' : '+close') : ''}` as CuKey;
}

/** CU price that keeps price x limit within the priority-fee cap. */
export function capCuPrice(microLamports: number, cuLimit: number, maxPriorityFeeLamports: number): number {
  const cap = Math.floor((maxPriorityFeeLamports * 1_000_000) / cuLimit);
  return Math.max(0, Math.min(Math.floor(microLamports), cap));
}

// ------------------------------------------------------------- priority fee

export type PriorityLevels = Record<PriorityLevel, number>;

/** Used until the first estimate arrives (micro-lamports per CU). */
export const FALLBACK_LEVELS: PriorityLevels = { min: 1_000, low: 10_000, medium: 50_000, high: 200_000, veryHigh: 1_000_000 };

/** Percentiles of recent non-zero fees, for RPCs without Helius' estimator. */
export function levelsFromRecent(fees: number[]): PriorityLevels | null {
  const xs = fees.filter((f) => f > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const at = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  return { min: at(0), low: at(0.25), medium: at(0.5), high: at(0.75), veryHigh: at(0.95) };
}

export class PriorityFees {
  private levels: PriorityLevels | null = null;
  private source: 'helius' | 'recent' | null = null;
  private heliusUnsupported = false;

  constructor(
    private readonly conn: Connection,
    private readonly accounts: PublicKey[],
  ) {}

  get(level: PriorityLevel): number {
    return (this.levels ?? FALLBACK_LEVELS)[level];
  }

  describe(): string {
    return this.source ?? 'fallback';
  }

  async refresh(): Promise<void> {
    if (!this.heliusUnsupported) {
      try {
        const res = await rpcFetch(this.conn.rpcEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getPriorityFeeEstimate',
            params: [{ accountKeys: this.accounts.map((a) => a.toBase58()), options: { includeAllPriorityFeeLevels: true } }],
          }),
        });
        const body = (await res.json()) as { result?: { priorityFeeLevels?: Record<string, number> }; error?: { code?: number } };
        const l = body.result?.priorityFeeLevels;
        if (l) {
          this.levels = { min: l.min ?? 0, low: l.low ?? 0, medium: l.medium ?? 0, high: l.high ?? 0, veryHigh: l.veryHigh ?? 0 };
          this.source = 'helius';
          return;
        }
        if (body.error?.code === -32601) this.heliusUnsupported = true; // method not found: not a Helius RPC
      } catch {
        // fall through to the standard method
      }
    }
    const recent = await this.conn.getRecentPrioritizationFees({ lockedWritableAccounts: this.accounts });
    const levels = levelsFromRecent(recent.map((r) => r.prioritizationFee));
    if (levels) {
      this.levels = levels;
      this.source = 'recent';
    }
  }
}

// ---------------------------------------------------------------- blockhash

export interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAt: number;
}

/** A blockhash older than this is refetched on the click path instead of used. */
const MAX_AGE_MS = 20_000;

export class BlockhashCache {
  private current: CachedBlockhash | null = null;
  private inflight: Promise<CachedBlockhash> | null = null;

  constructor(private readonly conn: Connection) {}

  async refresh(): Promise<CachedBlockhash> {
    this.inflight ??= this.conn
      .getLatestBlockhash('confirmed')
      .then((b) => (this.current = { ...b, fetchedAt: Date.now() }))
      .finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** The cached blockhash if it's fresh, without fetching. */
  peek(now = Date.now()): CachedBlockhash | null {
    return this.current && now - this.current.fetchedAt < MAX_AGE_MS ? this.current : null;
  }

  /** The cached blockhash when fresh, otherwise a fetch (only after idle periods). */
  async get(now = Date.now()): Promise<CachedBlockhash & { cached: boolean }> {
    if (this.current && now - this.current.fetchedAt < MAX_AGE_MS) return { ...this.current, cached: true };
    return { ...(await this.refresh()), cached: false };
  }
}
