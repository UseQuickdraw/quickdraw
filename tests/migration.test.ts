// A coin bonding: its curve completes and empties before the PumpSwap pool it
// migrates to exists. The panel must keep the holding and its value meanwhile,
// and go on looking for the pool, rather than show the position as lost.
import '../src/polyfills';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { loadFixture, replay } from './helpers/fixtures';
import { MarketManager } from '../src/solana/markets';
import type { MarketView } from '../src/messages';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';

const fx = loadFixture('tests/fixtures/curve.json');

/** BondingCurve as it is after a migration: reserves emptied, complete set. */
function completed(info: AccountInfo<Buffer>): AccountInfo<Buffer> {
  const data = Buffer.from(info.data);
  data.fill(0, 8, 40); // virtual/real token and SOL reserves
  data[48] = 1; // complete
  return { ...info, data };
}

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, programId: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { data, owner: programId, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

describe('a coin bonding while it is open', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the holding and its last price while the pool does not exist yet, and keeps looking for it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    __resetCurveProtocolCache();
    const base = replay(fx);
    const user = Keypair.generate().publicKey;
    const subs = new Map<string, (info: AccountInfo<Buffer>) => void>();
    let userAta: PublicKey | null = null;
    let ataInfo: AccountInfo<Buffer> | null = null;
    let lookups = 0;
    /** Accounts as they are now on chain, over the fixture's snapshot. */
    const now = new Map<string, AccountInfo<Buffer> | null>();
    // Accounts the fixture lacks (the pool-to-be, metadata) don't exist yet.
    const known = (k: PublicKey) => k.toBase58() in fx.accounts;
    const conn = {
      ...base,
      getAccountInfo: async (k: PublicKey) => {
        if (userAta && k.equals(userAta)) return ataInfo;
        lookups++;
        if (now.has(k.toBase58())) return now.get(k.toBase58())!;
        return known(k) ? base.getAccountInfo(k) : null;
      },
      getMultipleAccountsInfo: async (ks: PublicKey[]) => Promise.all(ks.map((k) => conn.getAccountInfo(k))),
      onAccountChange: (k: PublicKey, cb: (info: AccountInfo<Buffer>) => void) => {
        subs.set(k.toBase58(), cb);
        return subs.size;
      },
      removeAccountChangeListener: async () => {},
      getBalance: async () => 1_000_000_000,
    } as unknown as Connection;

    const views: MarketView[] = [];
    const markets = new MarketManager(conn, user, (v) => views.push(v));
    const first = await markets.watch(fx.address, 1);
    const mint = new PublicKey(first.mint);
    const live = markets.get(first.mint)!;
    userAta = live.userAta;
    ataInfo = tokenAccount(mint, user, 5_000_000_000n, live.market.mint.tokenProgram);
    expect(userAta.equals(getAssociatedTokenAddressSync(mint, user, true, live.market.mint.tokenProgram))).toBe(true);
    subs.get(userAta.toBase58())!(ataInfo);
    await vi.advanceTimersByTimeAsync(300);
    const before = views.at(-1)!;
    expect(before.tokenBalance).toBeGreaterThan(0);
    expect(before.spotSolPerToken).toBeGreaterThan(0);

    // The curve completes (the migration empties it); no pool yet.
    const curveKey = live.market.address;
    const curveInfo = (await base.getAccountInfo(curveKey))!;
    const lookupsBefore = lookups;
    now.set(curveKey.toBase58(), completed(curveInfo));
    subs.get(curveKey.toBase58())!(completed(curveInfo));
    // Views are pushed at most every 250 ms.
    await vi.advanceTimersByTimeAsync(300);
    const during = views.at(-1)!;
    expect(during.tradable).toBe(false);
    expect(during.tokenBalance).toBe(before.tokenBalance);
    expect(during.spotSolPerToken).toBe(before.spotSolPerToken);

    // It keeps looking for the pool every couple of seconds, and the subscriptions stay live.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(lookups).toBeGreaterThan(lookupsBefore);
    expect(markets.get(first.mint)!.market.address.equals(curveKey)).toBe(true);
    subs.get(userAta.toBase58())!(tokenAccount(mint, user, 7_000_000_000n, live.market.mint.tokenProgram));
    await vi.advanceTimersByTimeAsync(300);
    expect(views.at(-1)!.tokenBalance).toBeGreaterThan(before.tokenBalance);
    markets.dispose();
  });
});
