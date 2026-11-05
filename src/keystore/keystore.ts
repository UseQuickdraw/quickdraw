// Background-only. Key material never leaves the service worker except for the
// explicit WALLET_REVEAL backup flow to an extension page.
//
// No password, no lock: wallets and endpoints are sealed in storage.local with
// a non-extractable device key held in IndexedDB (see device.ts), and opened
// whenever the worker needs them.
//
// Several named wallets can be stored (`deviceWallets`); `activeWallets` lists
// the ones trades go through, in order (the first is the primary). A single
// wallet saved before that (`deviceVault`) becomes "Wallet 1" on first read.
//
// Wallets created before device sealing used a password vault (storage.local
// `vault`, `endpointsVault`). Those convert with the old password, once.
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { browser } from 'wxt/browser';
import { MIN_PASSWORD_LENGTH } from '../constants';
import { EndpointsSchema, NotifySchema, type Endpoints, type Notify } from '../messages';
import { decrypt, encrypt, isEncryptedBlob, type EncryptedBlob } from './crypto';
import { parseSecretKey } from './keys';
import { indexedDbKeyStore, isSealed, newDeviceKey, open, seal, type DeviceKeyStore, type Sealed } from './device';

const WALLETS_KEY = 'deviceWallets';
const ACTIVE_KEY = 'activeWallets';
const ENDPOINTS_KEY = 'deviceEndpoints';
/** The one-wallet layout before multi-wallet, migrated on first read. */
const SINGLE_WALLET_KEY = 'deviceVault';
// Pre-device-key password vaults, read only to migrate.
const LEGACY_VAULT_KEY = 'vault';
const LEGACY_ENDPOINTS_KEY = 'endpointsVault';
/** Sealing label for endpoints, which belong to no particular wallet. */
const ENDPOINTS_LABEL = 'endpoints';
/** Telegram alerts (the bot token): sealed like the endpoints. */
const NOTIFY_KEY = 'deviceNotify';
const NOTIFY_LABEL = 'notify';
export const MAX_WALLETS = 25;

let deviceStore: DeviceKeyStore = indexedDbKeyStore;
/** Test hook: IndexedDB isn't available in Node. */
export function __setDeviceKeyStore(s: DeviceKeyStore): void {
  deviceStore = s;
}

// Hot-path caches; rebuilt from storage after a worker restart.
const keypairs = new Map<string, Keypair>();
let endpointsCache: { value: Endpoints | null } | null = null;

/** The old password wallet still needs its password, once, to convert. */
export class NeedsPasswordError extends Error {
  constructor() {
    super('Enter your old wallet password once to switch it to no-password mode');
    this.name = 'NeedsPasswordError';
  }
}

export class NoWalletError extends Error {
  constructor() {
    super('No wallet yet. Set one up in the extension options.');
    this.name = 'NoWalletError';
  }
}

export interface WalletInfo {
  pubkey: string;
  name: string;
}

interface StoredWallet {
  name: string;
  sealed: Sealed;
}

async function local<T>(key: string): Promise<T | undefined> {
  return (await browser.storage.local.get(key))[key] as T | undefined;
}

async function readWallets(): Promise<StoredWallet[]> {
  const raw = await local<unknown>(WALLETS_KEY);
  if (Array.isArray(raw)) {
    return raw.filter((w): w is StoredWallet => !!w && typeof w.name === 'string' && isSealed(w.sealed, 'wallet'));
  }
  const single = await local<unknown>(SINGLE_WALLET_KEY);
  if (!isSealed(single, 'wallet')) return [];
  const wallets = [{ name: 'Wallet 1', sealed: single }];
  await browser.storage.local.set({ [WALLETS_KEY]: wallets, [ACTIVE_KEY]: [single.pubkey] });
  await browser.storage.local.remove(SINGLE_WALLET_KEY);
  return wallets;
}

async function writeWallets(wallets: StoredWallet[]): Promise<void> {
  await browser.storage.local.set({ [WALLETS_KEY]: wallets });
}

async function readLegacyVault(): Promise<EncryptedBlob | null> {
  const v = await local<unknown>(LEGACY_VAULT_KEY);
  return isEncryptedBlob(v) && v.purpose === 'wallet' ? v : null;
}

async function deviceKey(create: boolean): Promise<CryptoKey | null> {
  const k = await deviceStore.get().catch(() => null);
  if (k || !create) return k;
  const fresh = await newDeviceKey();
  await deviceStore.set(fresh);
  return fresh;
}

async function sealJson(purpose: 'wallet' | 'endpoints', value: unknown, label: string): Promise<Sealed> {
  const key = await deviceKey(true);
  const pt = new TextEncoder().encode(JSON.stringify(value));
  try {
    return await seal(key!, pt, purpose, label);
  } finally {
    pt.fill(0);
  }
}

async function openJson<T>(sealed: Sealed): Promise<T> {
  const key = await deviceKey(false);
  if (!key) throw new Error('This browser lost the wallet key. Re-import your wallet from your backup.');
  const pt = await open(key, sealed);
  try {
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } finally {
    pt.fill(0);
  }
}

async function sealKeypair(kp: Keypair): Promise<Sealed> {
  const sk = Buffer.from(kp.secretKey).toString('base64');
  return sealJson('wallet', { sk }, kp.publicKey.toBase58());
}

async function addKeypair(kp: Keypair, name?: string): Promise<string> {
  const pubkey = kp.publicKey.toBase58();
  const wallets = await readWallets();
  if (wallets.some((w) => w.sealed.pubkey === pubkey)) throw new Error('That wallet is already added.');
  if (wallets.length >= MAX_WALLETS) throw new Error(`At most ${MAX_WALLETS} wallets`);
  const label = cleanName(name) ?? `Wallet ${wallets.length + 1}`;
  await writeWallets([...wallets, { name: label, sealed: await sealKeypair(kp) }]);
  // The first wallet is selected; later ones are added unselected.
  if (wallets.length === 0) await browser.storage.local.set({ [ACTIVE_KEY]: [pubkey] });
  return pubkey;
}

function cleanName(name: string | undefined): string | null {
  const n = name?.trim().slice(0, 32);
  return n ? n : null;
}

// ------------------------------------------------------------------ status

export async function hasWallet(): Promise<boolean> {
  return (await readWallets()).length > 0 || (await readLegacyVault()) !== null;
}

export async function listWallets(): Promise<WalletInfo[]> {
  return (await readWallets()).map((w) => ({ pubkey: w.sealed.pubkey, name: w.name }));
}

/** The wallets trades use, in order; never empty while any wallet exists. */
export async function getActive(): Promise<string[]> {
  const all = (await readWallets()).map((w) => w.sealed.pubkey);
  const raw = await local<unknown>(ACTIVE_KEY);
  const saved: string[] = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  const active = all.filter((k) => saved.includes(k));
  return active.length ? active.sort((a, b) => saved.indexOf(a) - saved.indexOf(b)) : all.slice(0, 1);
}

export async function setActive(pubkeys: string[]): Promise<string[]> {
  const all = new Set((await readWallets()).map((w) => w.sealed.pubkey));
  const valid = [...new Set(pubkeys)].filter((k) => all.has(k));
  if (!valid.length) throw new Error('Select at least one wallet');
  await browser.storage.local.set({ [ACTIVE_KEY]: valid });
  return valid;
}

/** The primary (first selected) wallet's address. */
export async function getPubkey(): Promise<string | null> {
  return (await getActive())[0] ?? (await readLegacyVault())?.pubkey ?? null;
}

export async function hasEndpoints(): Promise<boolean> {
  return isSealed(await local<unknown>(ENDPOINTS_KEY), 'endpoints') || isEncryptedBlob(await local<unknown>(LEGACY_ENDPOINTS_KEY));
}

/** True only for an old password wallet that hasn't converted yet. */
export async function needsPassword(): Promise<boolean> {
  return (await readWallets()).length === 0 && (await readLegacyVault()) !== null;
}

// ---------------------------------------------------------------- create

export async function generateWallet(name?: string): Promise<string> {
  return addKeypair(Keypair.generate(), name);
}

export async function importWallet(secret: string, name?: string): Promise<string> {
  return addKeypair(parseSecretKey(secret), name);
}

export function previewImport(secret: string): string {
  return parseSecretKey(secret).publicKey.toBase58();
}

export async function renameWallet(pubkey: string, name: string): Promise<void> {
  const clean = cleanName(name);
  if (!clean) throw new Error('Give the wallet a name');
  const wallets = await readWallets();
  const w = wallets.find((x) => x.sealed.pubkey === pubkey);
  if (!w) throw new Error('Wallet not found');
  w.name = clean;
  await writeWallets(wallets);
}

/** Removes one wallet (its key is gone from this browser for good). */
export async function removeWallet(pubkey: string): Promise<void> {
  const wallets = await readWallets();
  const left = wallets.filter((w) => w.sealed.pubkey !== pubkey);
  if (left.length === wallets.length) throw new Error('Wallet not found');
  keypairs.delete(pubkey);
  if (!left.length) return deleteWallet();
  await writeWallets(left);
  const active = (await getActive()).filter((k) => k !== pubkey);
  await browser.storage.local.set({ [ACTIVE_KEY]: active.length ? active : [left[0]!.sealed.pubkey] });
}

// ------------------------------------------------------------------- use

/** A wallet's signer for the hot path; the primary one when no address is given. */
export async function getKeypair(pubkey?: string): Promise<Keypair> {
  const want = pubkey ?? (await getActive())[0];
  if (!want) throw (await readLegacyVault()) ? new NeedsPasswordError() : new NoWalletError();
  const hit = keypairs.get(want);
  if (hit) return hit;
  const sealed = (await readWallets()).find((w) => w.sealed.pubkey === want)?.sealed;
  if (!sealed) throw new Error('Wallet not found');
  const { sk } = await openJson<{ sk: string }>(sealed);
  const bytes = Buffer.from(sk, 'base64');
  try {
    const kp = Keypair.fromSecretKey(Uint8Array.from(bytes));
    if (kp.publicKey.toBase58() !== sealed.pubkey) throw new Error('Wallet pubkey mismatch');
    keypairs.set(want, kp);
    return kp;
  } finally {
    bytes.fill(0);
  }
}

export async function getEndpoints(): Promise<Endpoints | null> {
  if (endpointsCache) return endpointsCache.value;
  if (await needsPassword()) throw new NeedsPasswordError();
  const v = await local<unknown>(ENDPOINTS_KEY);
  // A blob opens with the label it was sealed under (older ones carry a wallet address).
  const value = isSealed(v, 'endpoints') ? EndpointsSchema.parse(await openJson<unknown>(v)) : null;
  endpointsCache = { value };
  return value;
}

export async function setEndpoints(endpoints: Endpoints): Promise<void> {
  const valid = EndpointsSchema.parse(endpoints);
  if (!(await hasWallet())) throw new NoWalletError();
  await browser.storage.local.set({ [ENDPOINTS_KEY]: await sealJson('endpoints', valid, ENDPOINTS_LABEL) });
  endpointsCache = { value: valid };
}

let notifyCache: { value: Notify | null } | null = null;

export async function getNotify(): Promise<Notify | null> {
  if (notifyCache) return notifyCache.value;
  const v = await local<unknown>(NOTIFY_KEY);
  let value: Notify | null = null;
  if (isSealed(v, 'endpoints')) {
    const parsed = NotifySchema.safeParse(await openJson<unknown>(v).catch(() => null));
    value = parsed.success ? parsed.data : null;
  }
  notifyCache = { value };
  return value;
}

export async function setNotify(notify: Notify | null): Promise<void> {
  if (!notify) {
    await browser.storage.local.remove(NOTIFY_KEY);
    notifyCache = { value: null };
    return;
  }
  const valid = NotifySchema.parse(notify);
  await browser.storage.local.set({ [NOTIFY_KEY]: await sealJson('endpoints', valid, NOTIFY_LABEL) });
  notifyCache = { value: valid };
}

/** Backup flow (extension pages only): the base58 secret. */
export async function revealSecret(pubkey?: string): Promise<string> {
  return bs58.encode((await getKeypair(pubkey)).secretKey);
}

/** A backup file encrypted with a password chosen just for the file. */
export async function exportEncryptedBackup(password: string, pubkey?: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error('Choose a password for the backup file');
  const kp = await getKeypair(pubkey);
  const sk = new Uint8Array(kp.secretKey);
  try {
    const vault = await encrypt(sk, password, 'wallet', kp.publicKey.toBase58());
    return JSON.stringify({ kind: 'instanttrench-vault', vault }, null, 2);
  } finally {
    sk.fill(0);
  }
}

/** Deletes every wallet, the endpoints and the Telegram bot. */
export async function deleteWallet(): Promise<void> {
  keypairs.clear();
  endpointsCache = null;
  notifyCache = null;
  await browser.storage.local.remove([WALLETS_KEY, ACTIVE_KEY, SINGLE_WALLET_KEY, ENDPOINTS_KEY, NOTIFY_KEY, LEGACY_VAULT_KEY, LEGACY_ENDPOINTS_KEY]);
  await deviceStore.clear().catch(() => {});
}

// -------------------------------------------------------------- migration

/** Converts an old password vault with its password, once. */
export async function migrateWithPassword(password: string): Promise<string> {
  const legacy = await readLegacyVault();
  if (!legacy) throw new Error('Nothing to convert');
  const sk = await decrypt(legacy, password);
  try {
    const kp = Keypair.fromSecretKey(sk.slice());
    const ep = await local<unknown>(LEGACY_ENDPOINTS_KEY);
    let endpoints: Endpoints | null = null;
    if (isEncryptedBlob(ep) && ep.purpose === 'endpoints') {
      const pt = await decrypt(ep, password);
      try {
        endpoints = EndpointsSchema.parse(JSON.parse(new TextDecoder().decode(pt)));
      } finally {
        pt.fill(0);
      }
    }
    await addKeypair(kp);
    if (endpoints) await setEndpoints(endpoints);
    await browser.storage.local.remove([LEGACY_VAULT_KEY, LEGACY_ENDPOINTS_KEY]);
    return kp.publicKey.toBase58();
  } finally {
    sk.fill(0);
  }
}

/** Test hook: drop the in-memory caches to simulate a service worker restart. */
export function __simulateWorkerRestart(): void {
  keypairs.clear();
  endpointsCache = null;
}
