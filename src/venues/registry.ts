import type { Connection, PublicKey } from '@solana/web3.js';
import type { MintInfo } from '../solana/tokens';
import { pumpCurve } from './pumpCurve';
import { pumpSwap } from './pumpSwap';
import { launchLab } from './launchLab';
import { raydiumCpmm } from './raydiumCpmm';
import { clmmPool } from './clmmPool';
import { raydiumAmm } from './raydiumAmm';
import { VenueError, type Market, type OpenHint, type VenueAdapter } from './types';

/**
 * Venues in resolution priority order: a live curve wins over a pool, and an
 * older coin's Raydium AMM v4 SOL pool (found by a program scan, and usually
 * its main pool) comes before its own CLMM/Orca pools, which come last.
 */
export const VENUES: VenueAdapter[] = [pumpCurve, pumpSwap, launchLab, raydiumCpmm, raydiumAmm, clmmPool];

export function venueAllowlist(): string[] {
  return [...new Set(VENUES.flatMap((v) => v.allowedPrograms()))];
}

export function venueOwning(owner: PublicKey): VenueAdapter | undefined {
  return VENUES.find((v) => v.ownsAccount(owner));
}

/**
 * Opens the first venue that can trade `mint`. A hint (the curve/pool the page
 * pointed at) is only offered to the venue that owns it, and that venue goes
 * first: a page showing one pool trades on that pool.
 */
export async function openMarket(conn: Connection, mint: MintInfo, hint?: OpenHint & { venue?: VenueAdapter['id'] }): Promise<Market> {
  const hinted = VENUES.find((v) => v.id === hint?.venue);
  for (const v of hinted ? [hinted, ...VENUES.filter((x) => x !== hinted)] : VENUES) {
    const m = await v.open(conn, mint, hint?.venue === v.id ? hint : undefined);
    if (m) return m;
  }
  throw new VenueError('Venue not supported yet (only pump.fun, PumpSwap, Raydium LaunchLab, Raydium CPMM, CLMM and AMM v4, and Orca)', 'UNSUPPORTED');
}
