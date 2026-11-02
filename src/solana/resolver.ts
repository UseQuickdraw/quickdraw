// Address -> mint -> venue. Pages may show a mint, a bonding-curve account, a
// pool, or even a token account; we branch on the account owner.
import { PublicKey, type Connection } from '@solana/web3.js';
import { decodeMint, tokenAccountKind, tokenAccountMint, type MintInfo } from './tokens';
import { venueOwning } from '../venues/registry';
import { VenueError, type OpenHint, type VenueId } from '../venues/types';

export interface ResolvedAddress {
  mint: MintInfo;
  /** Set when the page's address was a venue account rather than the mint. */
  hint?: OpenHint & { venue: VenueId };
}

export async function resolveAddress(conn: Connection, address: PublicKey): Promise<ResolvedAddress> {
  const info = await conn.getAccountInfo(address, 'confirmed');
  if (!info) throw new VenueError('Address not found on chain', 'NOT_FOUND');

  let mint: PublicKey;
  let hint: ResolvedAddress['hint'];
  const kind = tokenAccountKind(info);
  if (kind === 'mint') {
    return { mint: decodeMint(address, info) };
  } else if (kind === 'account') {
    mint = tokenAccountMint(info);
  } else {
    const venue = venueOwning(info.owner);
    const found = venue ? await venue.mintOf(conn, address, info) : null;
    if (!venue || !found) throw new VenueError('Not a token, curve or pool address', 'UNSUPPORTED');
    mint = found;
    hint = { venue: venue.id, account: address };
  }

  const mintInfo = await conn.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) throw new VenueError('Mint not found on chain', 'NOT_FOUND');
  return { mint: decodeMint(mint, mintInfo), hint };
}
