// SOL/USD for display, read from chain: the current price of Orca's main
// SOL/USDC whirlpool (verified 2026-10-28: token A = WSOL, token B = USDC).
// Display only; never used for trading.
import { PublicKey, type Connection } from '@solana/web3.js';
import { WSOL_MINT } from '../constants';

export const SOL_USDC_WHIRLPOOL = new PublicKey('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Whirlpool layout: sqrt_price u128 @65, token_mint_a @101, token_mint_b @181. */
export function solUsdFromWhirlpool(data: Buffer): number | null {
  if (data.length < 213) return null;
  if (new PublicKey(data.subarray(101, 133)).toBase58() !== WSOL_MINT) return null;
  if (new PublicKey(data.subarray(181, 213)).toBase58() !== USDC_MINT) return null;
  const sqrt = data.readBigUInt64LE(65) + (data.readBigUInt64LE(73) << 64n);
  const p = Number(sqrt) / 2 ** 64;
  const price = p * p * 1_000; // 10^(9 - 6) for SOL vs USDC decimals
  return Number.isFinite(price) && price > 0 ? price : null;
}

export async function fetchSolUsd(conn: Connection): Promise<number | null> {
  const info = await conn.getAccountInfo(SOL_USDC_WHIRLPOOL, 'confirmed').catch(() => null);
  return info ? solUsdFromWhirlpool(info.data) : null;
}
