// Record real account data from an RPC, then replay it offline in unit tests.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';

interface RawAccount {
  owner: string;
  lamports: number;
  data: string; // base64
  executable: boolean;
}

export interface Fixture {
  name: string;
  slot: number;
  /** The address a page would show (mint, curve or pool). */
  address: string;
  accounts: Record<string, RawAccount | null>;
  /** getTokenAccountsByOwner results, keyed `${owner}:${programId}`. */
  tokenAccountsByOwner: Record<string, string[]>;
}

const toRaw = (i: AccountInfo<Buffer>): RawAccount => ({
  owner: i.owner.toBase58(),
  lamports: i.lamports,
  data: Buffer.from(i.data).toString('base64'),
  executable: i.executable,
});

const fromRaw = (r: RawAccount): AccountInfo<Buffer> => ({
  owner: new PublicKey(r.owner),
  lamports: r.lamports,
  data: Buffer.from(r.data, 'base64'),
  executable: r.executable,
  rentEpoch: 0,
});

/** Wraps a real Connection and remembers every account it returns. */
export function recording(conn: Connection, fx: Fixture): Connection {
  const remember = (k: PublicKey, i: AccountInfo<Buffer> | null) => {
    fx.accounts[k.toBase58()] = i ? toRaw(i) : null;
  };
  return new Proxy(conn, {
    get(target, prop, recv) {
      if (prop === 'getAccountInfo') {
        return async (k: PublicKey, c?: unknown) => {
          const i = await target.getAccountInfo(k, c as never);
          remember(k, i);
          return i;
        };
      }
      if (prop === 'getMultipleAccountsInfo') {
        return async (ks: PublicKey[], c?: unknown) => {
          const is = await target.getMultipleAccountsInfo(ks, c as never);
          ks.forEach((k, n) => remember(k, is[n] ?? null));
          return is;
        };
      }
      if (prop === 'getTokenAccountsByOwner') {
        return async (owner: PublicKey, filter: { programId: PublicKey }, c?: unknown) => {
          const r = await target.getTokenAccountsByOwner(owner, filter, c as never);
          fx.tokenAccountsByOwner[`${owner.toBase58()}:${filter.programId.toBase58()}`] = r.value.map((v) => v.pubkey.toBase58());
          r.value.forEach((v) => remember(v.pubkey, v.account));
          return r;
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

/** A Connection that serves only what a fixture recorded. Unknown accounts throw. */
export function replay(fx: Fixture): Connection {
  const get = (k: PublicKey): AccountInfo<Buffer> | null => {
    const key = k.toBase58();
    if (!(key in fx.accounts)) throw new Error(`fixture ${fx.name} has no account ${key}`);
    const r = fx.accounts[key];
    return r ? fromRaw(r) : null;
  };
  const conn = {
    // Mainnet epochs are a fixed 432,000 slots.
    getEpochInfo: async () => ({ epoch: Math.floor(fx.slot / 432_000), absoluteSlot: fx.slot }),
    getAccountInfo: async (k: PublicKey) => get(k),
    getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(get),
    getTokenAccountsByOwner: async (owner: PublicKey, filter: { programId: PublicKey }) => ({
      context: { slot: fx.slot },
      value: (fx.tokenAccountsByOwner[`${owner.toBase58()}:${filter.programId.toBase58()}`] ?? []).map((p) => ({
        pubkey: new PublicKey(p),
        account: get(new PublicKey(p))!,
      })),
    }),
  };
  return conn as unknown as Connection;
}

export function accountOf(fx: Fixture, key: PublicKey): AccountInfo<Buffer> {
  const r = fx.accounts[key.toBase58()];
  if (!r) throw new Error(`fixture ${fx.name} has no account ${key.toBase58()}`);
  return fromRaw(r);
}

export function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

export function saveFixture(path: string, fx: Fixture): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fx, null, 1));
}
