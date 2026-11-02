import type { Connection, PublicKey } from '@solana/web3.js';
import type { MintInfo } from '../solana/tokens';
import { pumpCurve } from './pumpCurve';
import { pumpSwap } from './pumpSwap';
import { launchLab } from './launchLab';
import { raydiumCpmm } from './raydiumCpmm';
import { clmmPool } from './clmmPool';
import { VenueError, type Market, type OpenHint, type VenueAdapter } from './types';

/** Venues in resolution priority order: a live curve wins over a pool, and a coin's own CLMM/Orca pool comes last. */
export const VENUES: VenueAdapter[] = [pumpCurve, pumpSwap, launchLab, raydiumCpmm, clmmPool];

export function venueAllowlist(): string[] {
  return [...new Set(VENUES.flatMap((v) => v.allowedPrograms()))];
}

export function venueOwning(owner: PublicKey): VenueAdapter | undefined {
  return VENUES.find((v) => v.ownsAccount(owner));
}

/**
 * Opens the first venue that can trade `mint`. A hint (the curve/pool the page
 * pointed at) is only offered to the venue that owns it.
 */
export async function openMarket(conn: Connection, mint: MintInfo, hint?: OpenHint & { venue?: VenueAdapter['id'] }): Promise<Market> {
  for (const v of VENUES) {
    const m = await v.open(conn, mint, hint?.venue === v.id ? hint : undefined);
    if (m) return m;
  }
  throw new VenueError('Venue not supported yet (only pump.fun, PumpSwap, Raydium LaunchLab, Raydium CPMM and CLMM, and Orca)', 'UNSUPPORTED');
}
