import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Accepts a base58-encoded 64-byte secret key or a JSON byte array (Solana CLI
 * format). Returns a Keypair whose public half has been checked against the
 * secret, so a corrupted paste can't produce a wallet nobody controls.
 */
export function parseSecretKey(input: string): Keypair {
  const text = input.trim();
  let bytes: Uint8Array;
  if (text.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new Error('Invalid JSON byte array');
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('JSON key must be an array of bytes');
    }
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = bs58.decode(text);
    } catch {
      throw new Error('Not valid base58');
    }
  }
  try {
    if (bytes.length !== 64) throw new Error(`Secret key must be 64 bytes, got ${bytes.length}`);
    // fromSecretKey verifies the embedded public key matches the seed.
    return Keypair.fromSecretKey(bytes.slice());
  } catch (e) {
    throw new Error(e instanceof Error && e.message.startsWith('Secret key') ? e.message : 'Invalid secret key');
  } finally {
    bytes.fill(0);
  }
}
