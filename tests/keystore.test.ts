import '../src/polyfills';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { decrypt, encrypt, WrongPasswordError } from '../src/keystore/crypto';
import type { DeviceKeyStore } from '../src/keystore/device';
import { parseSecretKey } from '../src/keystore/keys';
import * as ks from '../src/keystore/keystore';

const PW = 'correct horse battery';
const EP = {
  rpcUrl: 'https://rpc.example.com/?api-key=SECRETRPC',
  wsUrl: 'wss://rpc.example.com/?api-key=SECRETRPC',
  senderApiKey: 'SECRETSENDER',
  customSendUrl: null,
};

// IndexedDB isn't in Node; an in-memory store holds the same non-extractable CryptoKey.
let deviceKey: CryptoKey | null = null;
const memoryStore: DeviceKeyStore = {
  get: async () => deviceKey,
  set: async (k) => {
    deviceKey = k;
  },
  clear: async () => {
    deviceKey = null;
  },
};
ks.__setDeviceKeyStore(memoryStore);

beforeEach(() => {
  fakeBrowser.reset();
  deviceKey = null;
  ks.__simulateWorkerRestart();
});

describe('crypto', () => {
  it('round-trips and binds the AAD', async () => {
    const pt = crypto.getRandomValues(new Uint8Array(64));
    const blob = await encrypt(pt.slice(), PW, 'wallet', 'pk1');
    expect(await decrypt(blob, PW)).toEqual(pt);
    await expect(decrypt({ ...blob, pubkey: 'pk2' }, PW)).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(decrypt({ ...blob, purpose: 'endpoints' }, PW)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('rejects a wrong password', async () => {
    const blob = await encrypt(new Uint8Array(64), PW, 'wallet', 'pk');
    await expect(decrypt(blob, 'wrong password!!')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('uses fresh salt and IV each time and >= 600k iterations', async () => {
    const a = await encrypt(new Uint8Array(64), PW, 'wallet', 'pk');
    const b = await encrypt(new Uint8Array(64), PW, 'wallet', 'pk');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.kdf.iterations).toBeGreaterThanOrEqual(600_000);
  });

  it('refuses downgraded KDF params', async () => {
    const blob = await encrypt(new Uint8Array(64), PW, 'wallet', 'pk');
    await expect(decrypt({ ...blob, kdf: { ...blob.kdf, iterations: 1000 } }, PW)).rejects.toThrow(/iteration/);
  });
});

describe('parseSecretKey', () => {
  const kp = Keypair.generate();
  it('accepts base58 and JSON arrays', () => {
    expect(parseSecretKey(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey)).toBe(true);
    expect(parseSecretKey(JSON.stringify([...kp.secretKey])).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it('rejects wrong lengths and mismatched pubkey halves', () => {
    expect(() => parseSecretKey(bs58.encode(kp.secretKey.slice(0, 32)))).toThrow(/64 bytes/);
    const bad = kp.secretKey.slice();
    bad[40] = (bad[40]! + 1) % 256;
    expect(() => parseSecretKey(bs58.encode(bad))).toThrow();
    expect(() => parseSecretKey('not-a-key-0OIl')).toThrow();
  });
});

describe('keystore (no password)', () => {
  it('generates a wallet that signs right away and after a worker restart', async () => {
    const pk = await ks.generateWallet();
    expect(await ks.needsPassword()).toBe(false);
    expect((await ks.getKeypair()).publicKey.toBase58()).toBe(pk);
    ks.__simulateWorkerRestart();
    expect((await ks.getKeypair()).publicKey.toBase58()).toBe(pk);
    expect(await ks.getPubkey()).toBe(pk);
  });

  it('imports a key', async () => {
    const kp = Keypair.generate();
    expect(await ks.importWallet(bs58.encode(kp.secretKey))).toBe(kp.publicKey.toBase58());
    ks.__simulateWorkerRestart();
    expect((await ks.getKeypair()).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('never stores the plaintext key or endpoint secrets', async () => {
    const kp = Keypair.generate();
    await ks.importWallet(bs58.encode(kp.secretKey));
    await ks.setEndpoints(EP);
    const dump = JSON.stringify([await fakeBrowser.storage.local.get(null), await fakeBrowser.storage.session.get(null)]);
    const sk = kp.secretKey;
    for (const needle of [
      bs58.encode(sk),
      Buffer.from(sk).toString('base64'),
      Buffer.from(sk.slice(0, 32)).toString('base64'),
      Buffer.from(sk).toString('hex'),
      JSON.stringify([...sk]).slice(1, 40),
      'SECRETRPC',
      'SECRETSENDER',
    ]) {
      expect(dump).not.toContain(needle);
    }
  });

  it('keeps endpoints sealed and readable after a restart', async () => {
    await ks.generateWallet();
    expect(await ks.hasEndpoints()).toBe(false);
    await ks.setEndpoints(EP);
    ks.__simulateWorkerRestart();
    expect(await ks.hasEndpoints()).toBe(true);
    expect(await ks.getEndpoints()).toEqual(EP);
  });

  it('a sealed blob tampered to another wallet does not open', async () => {
    const pk = await ks.generateWallet();
    const wallets = (await fakeBrowser.storage.local.get('deviceWallets')).deviceWallets as { name: string; sealed: Record<string, unknown> }[];
    const other = Keypair.generate().publicKey.toBase58();
    await fakeBrowser.storage.local.set({ deviceWallets: [{ ...wallets[0], sealed: { ...wallets[0]!.sealed, pubkey: other } }], activeWallets: [other] });
    ks.__simulateWorkerRestart();
    await expect(ks.getKeypair()).rejects.toThrow();
    await expect(ks.getKeypair(pk)).rejects.toThrow(/not found/);
  });

  it('says so if the device key is gone', async () => {
    await ks.generateWallet();
    deviceKey = null;
    ks.__simulateWorkerRestart();
    await expect(ks.getKeypair()).rejects.toThrow(/lost the wallet key/);
  });

  it('holds several named wallets; the first is selected, others are added unselected', async () => {
    const a = await ks.generateWallet();
    const kp = Keypair.generate();
    const b = await ks.importWallet(bs58.encode(kp.secretKey), 'Sniper');
    await expect(ks.importWallet(bs58.encode(kp.secretKey))).rejects.toThrow(/already added/);
    expect(await ks.listWallets()).toEqual([
      { pubkey: a, name: 'Wallet 1' },
      { pubkey: b, name: 'Sniper' },
    ]);
    expect(await ks.getActive()).toEqual([a]);
    expect(await ks.setActive([b, a, 'nope'])).toEqual([b, a]);
    expect(await ks.getPubkey()).toBe(b); // the first selected is the primary
    await expect(ks.setActive([])).rejects.toThrow(/at least one/);
    ks.__simulateWorkerRestart();
    expect((await ks.getKeypair(b)).publicKey.equals(kp.publicKey)).toBe(true);
    expect(await ks.revealSecret(b)).toBe(bs58.encode(kp.secretKey));
  });

  it('renames and removes single wallets; removing the last one clears everything', async () => {
    const a = await ks.generateWallet();
    const b = await ks.generateWallet();
    await ks.setEndpoints(EP);
    await ks.setActive([a, b]);
    await ks.renameWallet(b, '  Main burner  ');
    expect((await ks.listWallets())[1]!.name).toBe('Main burner');
    await ks.removeWallet(a);
    expect((await ks.listWallets()).map((w) => w.pubkey)).toEqual([b]);
    expect(await ks.getActive()).toEqual([b]);
    // Endpoints don't belong to a wallet, so they survive removing one.
    ks.__simulateWorkerRestart();
    expect(await ks.getEndpoints()).toEqual(EP);
    await ks.removeWallet(b);
    expect(await ks.hasWallet()).toBe(false);
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  it('turns a wallet saved before multi-wallet into "Wallet 1"', async () => {
    const pk = await ks.generateWallet();
    const { deviceWallets } = (await fakeBrowser.storage.local.get('deviceWallets')) as { deviceWallets: { sealed: unknown }[] };
    await fakeBrowser.storage.local.remove(['deviceWallets', 'activeWallets']);
    await fakeBrowser.storage.local.set({ deviceVault: deviceWallets[0]!.sealed });
    ks.__simulateWorkerRestart();
    expect(await ks.listWallets()).toEqual([{ pubkey: pk, name: 'Wallet 1' }]);
    expect(await ks.getActive()).toEqual([pk]);
    expect((await fakeBrowser.storage.local.get('deviceVault')).deviceVault).toBeUndefined();
    expect((await ks.getKeypair()).publicKey.toBase58()).toBe(pk);
  });

  it('reveals the secret and writes a password backup file', async () => {
    const kp = Keypair.generate();
    await ks.importWallet(bs58.encode(kp.secretKey));
    expect(await ks.revealSecret()).toBe(bs58.encode(kp.secretKey));
    await expect(ks.exportEncryptedBackup('')).rejects.toThrow(/password/);
    const file = JSON.parse(await ks.exportEncryptedBackup('file pw')) as { kind: string; vault: Parameters<typeof decrypt>[0] };
    expect(file.kind).toBe('instanttrench-vault');
    expect(await decrypt(file.vault, 'file pw')).toEqual(kp.secretKey);
  });

  it('delete wipes the wallet, endpoints and device key', async () => {
    await ks.generateWallet();
    await ks.setEndpoints(EP);
    await ks.deleteWallet();
    expect(await ks.hasWallet()).toBe(false);
    expect(await ks.hasEndpoints()).toBe(false);
    expect(deviceKey).toBeNull();
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
    await expect(ks.getKeypair()).rejects.toBeInstanceOf(ks.NoWalletError);
  });
});

describe('converting an old password wallet', () => {
  async function legacyWallet() {
    const kp = Keypair.generate();
    const pubkey = kp.publicKey.toBase58();
    const vault = await encrypt(kp.secretKey.slice(), PW, 'wallet', pubkey);
    const endpointsVault = await encrypt(new TextEncoder().encode(JSON.stringify(EP)), PW, 'endpoints', pubkey);
    await fakeBrowser.storage.local.set({ vault, endpointsVault });
    return kp;
  }

  async function expectConverted(kp: Keypair) {
    const local = await fakeBrowser.storage.local.get(null);
    expect(local.vault).toBeUndefined();
    expect(local.endpointsVault).toBeUndefined();
    ks.__simulateWorkerRestart();
    expect((await ks.getKeypair()).publicKey.equals(kp.publicKey)).toBe(true);
    expect(await ks.getEndpoints()).toEqual(EP);
    expect(await ks.needsPassword()).toBe(false);
  }

  it('needs the old password once', async () => {
    const kp = await legacyWallet();
    expect(await ks.hasWallet()).toBe(true);
    expect(await ks.getPubkey()).toBe(kp.publicKey.toBase58());
    expect(await ks.needsPassword()).toBe(true);
    await expect(ks.getKeypair()).rejects.toBeInstanceOf(ks.NeedsPasswordError);
    await expect(ks.migrateWithPassword('wrong password!')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(await ks.migrateWithPassword(PW)).toBe(kp.publicKey.toBase58());
    await expectConverted(kp);
  });
});
