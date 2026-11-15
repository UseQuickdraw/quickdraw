import '../src/polyfills';
import { describe, expect, it, vi } from 'vitest';
import BN from 'bn.js';
import { Keypair, type Connection } from '@solana/web3.js';
import { AutomationRunner } from '../src/automation/runner';
import { isCaller, readSignal, signalLabel, signalMisses, type Signal } from '../src/automation/callout';
import { newCallout, type ActivityRow, type Automations, type Callout } from '../src/automation/schema';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import type { TradeEngine } from '../src/solana/engine';

const coin = Keypair.generate().publicKey.toBase58();
const wallet = Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000_000;

const sig = (over: Partial<Signal> = {}): Signal => ({
  id: `pumpfun:${Math.random()}`,
  source: 'pumpfun',
  kind: 'callout',
  author: wallet,
  authorName: 'Mitch',
  authorWallet: wallet,
  mint: coin,
  symbol: 'MOO',
  text: 'Next moo deng, sending $MOO',
  at: NOW - 5_000,
  receivedAt: NOW - 1_000,
  ...over,
});
const cfg = (over: Partial<Callout> = {}): Callout => ({ ...newCallout('k1'), dryRun: false, ...over });

describe('callout matching', () => {
  it('reads older configs with one callers list as pump.fun callers', async () => {
    const { CalloutSchema } = await import('../src/automation/schema');
    const old = { ...newCallout('x'), callers: ['mitch'] };
    expect(CalloutSchema.parse(old).callers).toEqual({ pumpfun: ['mitch'], fomo: [] });
  });

  it('reads well-formed signals only', () => {
    expect(readSignal({ ...sig(), type: 'signal' })?.mint).toBe(coin);
    expect(readSignal({ ...sig(), mint: 'not-a-mint' })).toBeNull();
    expect(readSignal({ ...sig(), source: 'twitter' })).toBeNull();
  });

  it('names callers by username (with or without @) or wallet', () => {
    expect(isCaller('@mitch', sig())).toBe(true);
    expect(isCaller(wallet, sig())).toBe(true);
    expect(isCaller('someone', sig())).toBe(false);
  });

  it('checks source, callers, age and words', () => {
    expect(signalMisses(cfg(), sig(), NOW)).toBeNull();
    expect(signalMisses(cfg({ sources: ['fomo'] }), sig(), NOW)).toMatch(/sources/);
    expect(signalMisses(cfg({ callers: { pumpfun: ['other'], fomo: [] } }), sig(), NOW)).toMatch(/pump.fun callers/);
    expect(signalMisses(cfg({ callers: { pumpfun: ['mitch'], fomo: [] } }), sig(), NOW)).toBeNull();
    // A name listed for FOMO doesn't match the same name posting on pump.fun.
    expect(signalMisses(cfg({ callers: { pumpfun: ['someone'], fomo: ['mitch'] } }), sig(), NOW)).toMatch(/pump.fun callers/);
    expect(signalMisses(cfg({ callers: { pumpfun: [], fomo: ['someone'] } }), sig({ source: 'fomo', kind: 'thesis' }), NOW)).toMatch(/FOMO callers/);
    // X handles don't count as the site's name.
    expect(isCaller('mitch_x', sig({ authorX: 'mitch_x' }))).toBe(false);
    expect(signalMisses(cfg({ maxAgeSec: 3 }), sig(), NOW)).toMatch(/5s ago/);
    expect(signalMisses(cfg({ contains: ['$moo'] }), sig(), NOW)).toBeNull();
    expect(signalMisses(cfg({ contains: ['pepe'] }), sig(), NOW)).toMatch(/none of pepe/);
    expect(signalMisses(cfg({ excludes: ['deng'] }), sig(), NOW)).toMatch(/"deng"/);
  });

  it('labels the post for the activity log', () => {
    expect(signalLabel(sig())).toBe('pump.fun callout by @Mitch: "Next moo deng, sending $MOO"');
  });
});

function setup(callouts: Callout[], opts: { mcapUsd?: number; holding?: boolean } = {}) {
  const trade = vi.fn(async (req: { amount: number }, s: { safety: { dryRun: boolean } }) =>
    s.safety.dryRun ? { kind: 'simulated' as const, ok: true, text: 'ok', detail: '' } : { kind: 'sent' as const, signature: `sig-${req.amount}`, text: '', detail: '' },
  );
  const eng = {
    wallet,
    markets: {
      watch: vi.fn(async () => ({ venue: 'PUMP_CURVE', spotSolPerToken: (opts.mcapUsd ?? 50_000) / 100 / 1e9, solUsd: 100, risks: [] })),
      get: () => ({ market: { mint: { supply: new BN('1000000000000000'), decimals: 6 } } }),
      tokenBalance: () => new BN(opts.holding ? 1 : 0),
    },
    ledger: { position: () => undefined },
    trade,
  } as unknown as TradeEngine;
  const rows: ActivityRow[] = [];
  let spent = 0;
  const fires: Record<string, number> = {};
  const settings = { ...defaultSettings(), safety: { ...defaultSettings().safety, dryRun: false } };
  const automations: Automations = {
    stopped: false, maxSolPerTrade: 0.5, maxSolPerDay: 2, copytrades: [], deploys: [], manualLadder: { enabled: false, steps: [] },
    callouts, signalServer: { url: 'ws://127.0.0.1:8787', token: 'secret-token' },
  };
  const opened: string[] = [];
  const runner = new AutomationRunner(
    {
      conn: { onLogs: () => 1, removeOnLogsListener: async () => {} } as unknown as Connection,
      load: async () => automations,
      engineFor: async () => eng,
      settings: async () => ({ settings, profile: activeProfile(settings) }),
      log: async (r) => void rows.push(r),
      spentToday: async () => spent,
      addSpent: async (sol) => void (spent += sol),
      fires: async (id) => fires[id] ?? 0,
      addFire: async (id) => void (fires[id] = (fires[id] ?? 0) + 1),
    },
    (srv) => {
      opened.push(srv.url);
      return { status: { state: 'connected', count: 0, lastAt: null }, close() {} } as never;
    },
  );
  return { runner, trade, rows, opened };
}

describe('AutomationRunner callouts', () => {
  it('connects to the signal server only while a callout automation is on', async () => {
    const on = setup([cfg()]);
    await on.runner.sync();
    expect(on.opened).toEqual(['ws://127.0.0.1:8787']);
    const off = setup([cfg({ enabled: false })]);
    await off.runner.sync();
    expect(off.opened).toEqual([]);
  });

  it('buys a fresh callout once, and logs who posted it', async () => {
    const { runner, trade, rows } = setup([cfg({ buySol: 0.1 })]);
    await runner.sync();
    await runner.onSignal(sig(), NOW);
    await runner.onSignal(sig(), NOW); // another post on the same coin
    expect(trade).toHaveBeenCalledTimes(1);
    expect(trade.mock.calls[0]![0]).toMatchObject({ side: 'buy', amount: 0.1, mint: coin });
    expect(rows[0]).toMatchObject({ outcome: 'copied', signal: expect.stringContaining('@Mitch') });
    expect(rows[0]!.detail).toMatch(/sent 5s after the post \(0s here\)/);
    expect(rows[1]).toMatchObject({ outcome: 'skipped', detail: 'already bought this coin' });
  });

  it('says when a recent post is too old, ignores old replays silently, and filters by market cap', async () => {
    const stale = setup([cfg({ maxAgeSec: 2 })]);
    await stale.runner.sync();
    await stale.runner.onSignal(sig(), NOW);
    expect(stale.trade).not.toHaveBeenCalled();
    expect(stale.rows[0]!.detail).toMatch(/posted 5s ago, over the 2s limit/);
    await stale.runner.onSignal(sig({ at: NOW - 3_600_000 }), NOW);
    expect(stale.rows).toHaveLength(1);

    const big = setup([cfg({ maxMcapUsd: 10_000 })], { mcapUsd: 50_000 });
    await big.runner.sync();
    await big.runner.onSignal(sig(), NOW);
    expect(big.trade).not.toHaveBeenCalled();
    expect(big.rows[0]!.detail).toMatch(/over \$10,000/);
  });

  it('waits for consensus from different callers', async () => {
    const { runner, trade, rows } = setup([cfg({ consensus: { count: 2, windowSec: 60 } })]);
    await runner.sync();
    await runner.onSignal(sig(), NOW);
    expect(trade).not.toHaveBeenCalled();
    expect(rows[0]!.detail).toMatch(/1 of 2 callers/);
    const other = Keypair.generate().publicKey.toBase58();
    await runner.onSignal(sig({ author: other, authorWallet: other, authorName: 'Other' }), NOW);
    expect(trade).toHaveBeenCalledTimes(1);
  });

  it("skips coins you already hold", async () => {
    const { runner, trade, rows } = setup([cfg()], { holding: true });
    await runner.sync();
    await runner.onSignal(sig(), NOW);
    expect(trade).not.toHaveBeenCalled();
    expect(rows[0]!.detail).toMatch(/already hold/);
  });
});
