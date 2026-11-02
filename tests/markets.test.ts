import '../src/polyfills';
import { describe, expect, it, vi } from 'vitest';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import BN from 'bn.js';
import { PUMP_AMM_SDK } from '@pump-fun/pump-sdk/swap';
import { accountOf, loadFixture, replay, type Fixture } from './helpers/fixtures';
import { TEST_USER } from './helpers/compare';
import { MarketManager } from '../src/solana/markets';
import { describePlan, planTrade, sellTokens, slippageFor } from '../src/solana/trade';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';

const pool = loadFixture('tests/fixtures/pumpswap.json');
const curve = loadFixture('tests/fixtures/curve.json');

/** Fixture replay plus a fake WebSocket layer we can drive by hand. */
function liveReplay(fx: Fixture) {
  const base = replay(fx) as unknown as Record<string, unknown>;
  const subs = new Map<number, { key: string; cb: (i: AccountInfo<Buffer>) => void }>();
  let next = 1;
  const conn = {
    ...base,
    // The user's own accounts aren't in the fixture: a fresh wallet with no ATA.
    getAccountInfo: async (k: PublicKey) => (k.toBase58() in fx.accounts ? (base.getAccountInfo as (k: PublicKey) => unknown)(k) : null),
    getMultipleAccountsInfo: async (ks: PublicKey[]) =>
      Promise.all(ks.map((k) => (k.toBase58() in fx.accounts ? (base.getAccountInfo as (k: PublicKey) => unknown)(k) : null))),
    getBalance: async () => 2_500_000_000,
    onAccountChange: (k: PublicKey, cb: (i: AccountInfo<Buffer>) => void) => {
      subs.set(next, { key: k.toBase58(), cb });
      return next++;
    },
    removeAccountChangeListener: async (id: number) => {
      subs.delete(id);
    },
  };
  const emit = (k: PublicKey, info: AccountInfo<Buffer>) => {
    for (const s of subs.values()) if (s.key === k.toBase58()) s.cb(info);
  };
  return { conn: conn as unknown as Connection, subs, emit };
}

describe('MarketManager', () => {
  it('watches, pushes subscription updates to the right tabs, and cleans up', async () => {
    vi.useFakeTimers();
    const { conn, subs, emit } = liveReplay(pool);
    const pushed: { spot: number; tabs: number[] }[] = [];
    const mgr = new MarketManager(conn, TEST_USER, (v, tabs) => pushed.push({ spot: v.spotSolPerToken, tabs: [...tabs] }));

    const view = await mgr.watch(pool.address, 7);
    expect(view.venue).toBe('PUMPSWAP');
    expect(view.solBalance).toBe(2.5);
    expect(view.tokenBalance).toBe(0);
    // pool + 2 vaults + user ATA + user wallet
    expect(subs.size).toBe(5);

    const quoteVault = PUMP_AMM_SDK.decodePool(accountOf(pool, new PublicKey(pool.address))).poolQuoteTokenAccount;
    const info = accountOf(pool, quoteVault);
    const data = Buffer.from(info.data);
    data.writeBigUInt64LE(data.readBigUInt64LE(64) * 2n, 64);
    emit(quoteVault, { ...info, data });
    await vi.advanceTimersByTimeAsync(300);
    expect(pushed.at(-1)!.tabs).toEqual([7]);
    expect(pushed.at(-1)!.spot).toBeGreaterThan(view.spotSolPerToken);

    // The same mint from another tab shares the subscriptions.
    await mgr.watch(view.mint, 8);
    expect(subs.size).toBe(5);
    mgr.release(7);
    expect(subs.size).toBe(5);
    mgr.release(8);
    expect(subs.size).toBe(1); // only the wallet balance watch remains
    mgr.dispose();
    expect(subs.size).toBe(0);
    vi.useRealTimers();
  });

  it('keeps a completed curve live until the pool it migrates to opens', async () => {
    __resetCurveProtocolCache();
    const chain: Fixture = structuredClone(curve); // mutable "chain state"
    const { conn, subs } = liveReplay(chain);
    const mgr = new MarketManager(conn, TEST_USER, () => {});
    const view = await mgr.watch(curve.address, 1);
    const live = mgr.get(view.mint)!;
    const key = live.market.address;

    // The curve completes on chain and the subscription delivers it.
    const raw = chain.accounts[key.toBase58()]!;
    const data = Buffer.from(raw.data, 'base64');
    data.writeUInt8(1, 48); // complete = true
    raw.data = data.toString('base64');
    live.market.apply(key, accountOf(chain, key));
    expect(live.market.tradable()).toBe(false);

    // Re-resolving skips the completed curve; this fixture has no pool, so it says so...
    const before = subs.size;
    await expect(mgr.reopen(view.mint)).rejects.toThrow(/not supported/);
    // ...and nothing is dropped meanwhile: the holding and the curve stay live (they were lost here before).
    expect(subs.size).toBe(before);
    expect(mgr.get(view.mint)!.market).toBe(live.market);
    mgr.dispose();
  });
});

describe('trade planning', () => {
  const settings = defaultSettings();
  const profile = activeProfile(settings);

  it('sell percentages are exact at 100% and floor otherwise', () => {
    const bal = new BN('123456789');
    expect(sellTokens(bal, 100).toString()).toBe('123456789');
    expect(sellTokens(bal, 50).toString()).toBe('61728394');
    expect(sellTokens(bal, 12.5).toString()).toBe('15432098');
  });

  it('preset slippage overrides the profile', () => {
    const p = structuredClone(profile);
    p.buyPresets[2]!.slippagePct = 3;
    expect(slippageFor(p, { side: 'buy', amount: 0.2, presetIndex: 2 })).toBe(3);
    expect(slippageFor(p, { side: 'buy', amount: 0.2, presetIndex: 1 })).toBe(profile.slippagePct);
    expect(slippageFor(p, { side: 'buy', amount: 0.2, presetIndex: null })).toBe(profile.slippagePct);
  });

  it('refuses empty sells and quotes buys of any size', async () => {
    const conn = replay(pool);
    const r = await resolveAddress(conn, new PublicKey(pool.address));
    const market = await openMarket(conn, r.mint, r.hint);
    expect(planTrade(market, { side: 'buy', amount: 5, presetIndex: null }, settings, profile, new BN(0)).quote.inAmount.toString()).toBe('5000000000');
    expect(() => planTrade(market, { side: 'sell', amount: 50, presetIndex: null }, settings, profile, new BN(0))).toThrow(/No tokens/);
    const plan = planTrade(market, { side: 'buy', amount: 0.1, presetIndex: 1 }, settings, profile, new BN(0));
    expect(plan.quote.inAmount.toString()).toBe('100000000');
    expect(describePlan(market, plan)).toMatch(/^Buy 0\.1 SOL → ~[\d.]+[KMBT]? tokens/);
  });
});
