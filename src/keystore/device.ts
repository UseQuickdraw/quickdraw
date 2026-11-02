// The device key: a non-extractable AES-GCM key generated in the browser and
// kept in this extension's IndexedDB. It seals the wallet and endpoints so the
// extension works without a password. JS can use the key but never read its
// bytes, and only code running as this extension can reach it. It does not
// protect against malware with access to the browser profile, which is the
// accepted trade-off for a burner wallet with no password.
import { fromB64, toB64 } from './crypto';

export interface DeviceKeyStore {
  get(): Promise<CryptoKey | null>;
  set(key: CryptoKey): Promise<void>;
  clear(): Promise<void>;
}

export type SealPurpose = 'wallet' | 'endpoints';

export interface Sealed {
  v: 1;
  purpose: SealPurpose;
  iv: string;
  ct: string;
  pubkey: string;
}

const DB = 'instanttrench';
const STORE = 'keys';
const ID = 'device';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** IndexedDB stores CryptoKey objects natively (structured clone), still non-extractable. */
export const indexedDbKeyStore: DeviceKeyStore = {
  get: () => tx<CryptoKey | undefined>('readonly', (s) => s.get(ID) as IDBRequest<CryptoKey | undefined>).then((k) => k ?? null),
  set: (key) => tx('readwrite', (s) => s.put(key, ID)).then(() => undefined),
  clear: () => tx('readwrite', (s) => s.delete(ID)).then(() => undefined),
};

export function newDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** AAD binds purpose + wallet so sealed blobs can't be swapped between slots or wallets. */
const aad = (purpose: SealPurpose, pubkey: string) => new TextEncoder().encode(`instanttrench:v1:device:${purpose}:${pubkey}`);

export async function seal(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, purpose: SealPurpose, pubkey: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(purpose, pubkey) }, key, plaintext));
  return { v: 1, purpose, iv: toB64(iv), ct: toB64(ct), pubkey };
}

/** Caller owns the returned buffer. Throws if the key or blob doesn't match. */
export async function open(key: CryptoKey, sealed: Sealed): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: aad(sealed.purpose, sealed.pubkey) }, key, fromB64(sealed.ct)),
  );
}

export function isSealed(x: unknown, purpose: SealPurpose): x is Sealed {
  const s = x as Sealed | null;
  return !!s && s.v === 1 && s.purpose === purpose && typeof s.iv === 'string' && typeof s.ct === 'string' && typeof s.pubkey === 'string';
}
