// Password-based encryption for the vault. WebCrypto only.
//   KDF:    PBKDF2-SHA256, >= 600k iterations, random 16-byte salt
//   Cipher: AES-256-GCM, random 12-byte IV, AAD binds version + purpose + pubkey
// The derived CryptoKey is non-extractable and never stored.
import { KDF } from '../constants';

export interface KdfParams {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
}

export interface EncryptedBlob {
  v: 1;
  /** What this blob holds; part of the AAD so blobs can't be swapped. */
  purpose: 'wallet' | 'endpoints';
  kdf: KdfParams;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64 (ciphertext || 16-byte GCM tag)
  /** Public key of the wallet this vault belongs to; also bound into the AAD. */
  pubkey: string;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password');
    this.name = 'WrongPasswordError';
  }
}

const enc = new TextEncoder();

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function aad(purpose: EncryptedBlob['purpose'], pubkey: string): Uint8Array<ArrayBuffer> {
  return enc.encode(`instanttrench:v1:${purpose}:${pubkey}`);
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, kdf: KdfParams): Promise<CryptoKey> {
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') throw new Error('Unsupported KDF');
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < KDF.iterations) {
    // Refuse weakened blobs (e.g. a tampered or downgraded import).
    throw new Error('KDF iteration count below minimum');
  }
  const pw = enc.encode(password.normalize('NFKC'));
  try {
    const base = await crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: kdf.hash, salt, iterations: kdf.iterations },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    pw.fill(0);
  }
}

export async function encrypt(
  plaintext: Uint8Array<ArrayBuffer>,
  password: string,
  purpose: EncryptedBlob['purpose'],
  pubkey: string,
  iterations: number = KDF.iterations,
): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(KDF.saltBytes));
  const iv = crypto.getRandomValues(new Uint8Array(KDF.ivBytes));
  const kdf: KdfParams = { name: KDF.name, hash: KDF.hash, iterations };
  const key = await deriveKey(password, salt, kdf);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(purpose, pubkey) }, key, plaintext),
  );
  return { v: 1, purpose, kdf, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct), pubkey };
}

/** Caller owns the returned buffer and should zero it when done. */
export async function decrypt(blob: EncryptedBlob, password: string): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.v !== 1) throw new Error('Unsupported vault version');
  const key = await deriveKey(password, fromB64(blob.salt), blob.kdf);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(blob.iv), additionalData: aad(blob.purpose, blob.pubkey) },
      key,
      fromB64(blob.ct),
    );
    return new Uint8Array(pt);
  } catch {
    // GCM auth failure: wrong password or tampered blob. Indistinguishable by design.
    throw new WrongPasswordError();
  }
}

export function isEncryptedBlob(x: unknown): x is EncryptedBlob {
  if (!x || typeof x !== 'object') return false;
  const b = x as Record<string, unknown>;
  return (
    b.v === 1 &&
    (b.purpose === 'wallet' || b.purpose === 'endpoints') &&
    typeof b.salt === 'string' &&
    typeof b.iv === 'string' &&
    typeof b.ct === 'string' &&
    typeof b.pubkey === 'string' &&
    !!b.kdf &&
    typeof b.kdf === 'object'
  );
}
