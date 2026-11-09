// The deploy sniper against real pump.fun launches (tests/fixtures/pump-launches.json).
import '../src/polyfills';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import BN from 'bn.js';
import type { Connection } from '@solana/web3.js';
import { decodeLaunch, launchMisses, type Launch } from '../src/automation/deploy';
import { AutomationRunner } from '../src/automation/runner';
import { newDeploy, type ActivityRow, type Automations } from '../src/automation/schema';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import type { TradeEngine } from '../src/solana/engine';

const fx = JSON.parse(readFileSync('tests/fixtures/pump-launches.json', 'utf8')) as { cases: { signature: string; logs: string[]; tradeEvents: number }[] };

// The third recorded launch ("smol moon") is a curve priced in another token (3NZ9…), which isn't sniped.
const solLaunches = fx.cases.slice(0, 2);

describe('decodeLaunch (real launches)', () => {
  it('skips a launch priced in a token other than SOL', () => {
    expect(decodeLaunch(fx.cases[2]!.signature, fx.cases[2]!.logs)).toBeNull();
  });

  it.each(solLaunches.map((c) => [c.signature.slice(0, 8), c] as const))('%s: the coin, its creator and the dev buy', (_, c) => {
    const l = decodeLaunch(c.signature, c.logs)!;
    expect(l).not.toBeNull();
    expect(l.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(l.creator).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(l.name.length + l.symbol.length).toBeGreaterThan(0);
    if (c.tradeEvents === 0) expect(l.devBuySol).toBe(0);
    else expect(l.devBuySol).toBeGreaterThanOrEqual(0);
  });

  it('is null for logs with no launch', () => {
    expect(decodeLaunch('x', ['Program log: Instruction: Buy'])).toBeNull();
  });
});

describe('launchMisses', () => {
  const l: Launch = { signature: 's', mint: 'M1', bondingCurve: 'B', name: 'Pepe Wif Hat', symbol: 'PWH', uri: '', creator: 'DEV', devBuySol: 1.2 };
  const cfg = newDeploy('d');

  it('never matches with no target rules, so it can never buy every launch', () => {
    expect(launchMisses(cfg, l)).toBe('no target rules set');
  });

  it('matches whole words, exact names, mints and deployers, all AND-ed', () => {
    expect(launchMisses({ ...cfg, contains: ['pepe'] }, l)).toBeNull();
    expect(launchMisses({ ...cfg, contains: ['pep'] }, l)).toMatch(/none of pep/);
    expect(launchMisses({ ...cfg, exact: 'pwh' }, l)).toBeNull();
    expect(launchMisses({ ...cfg, contains: ['pepe'], excludes: ['hat'] }, l)).toMatch(/has "hat"/);
    expect(launchMisses({ ...cfg, deployers: ['DEV'] }, l)).toBeNull();
    expect(launchMisses({ ...cfg, deployers: ['DEV'], mints: ['OTHER'] }, l)).toMatch(/whitelisted mint/);
    expect(launchMisses({ ...cfg, deployers: ['DEV'], minDevBuySol: 2 }, l)).toMatch(/under 2/);
    expect(launchMisses({ ...cfg, deployers: ['DEV'], maxDevBuySol: 1 }, l)).toMatch(/over 1/);
  });
});

describe('deploy sniping in the runner', () => {
  it('buys a matching launch from its curve, within the caps, and logs it; ignores the rest silently', async () => {
    const real = decodeLaunch(fx.cases[0]!.signature, fx.cases[0]!.logs)!;
    const trade = vi.fn(async () => ({ kind: 'sent' as const, signature: 'snipe', text: '', detail: '' }));
    const eng = {
      wallet: 'W',
      markets: { watch: vi.fn(async () => ({ venue: 'PUMP_CURVE', spotSolPerToken: 1e-8, solUsd: 100, risks: [] })), get: () => null, tokenBalance: () => new BN(0) },
      ledger: { position: () => undefined },
      trade,
    } as unknown as TradeEngine;
    const rows: ActivityRow[] = [];
    const settings = { ...defaultSettings(), safety: { ...defaultSettings().safety, dryRun: false } };
    const automations: Automations = {
      stopped: false, maxSolPerTrade: 0.5, maxSolPerDay: 2, copytrades: [], manualLadder: { enabled: false, steps: [] },
      deploys: [{ ...newDeploy('d1'), dryRun: false, deployers: [real.creator], buySol: 0.05 }, { ...newDeploy('d2'), dryRun: false, contains: ['zzzznotaword'] }],
    };
    const subs: unknown[] = [];
    const runner = new AutomationRunner({
      conn: { onLogs: (k: unknown) => (subs.push(k), 1), removeOnLogsListener: async () => {} } as unknown as Connection,
      load: async () => automations,
      engineFor: async () => eng,
      settings: async () => ({ settings, profile: activeProfile(settings) }),
      log: async (r) => void rows.push(r),
      spentToday: async () => 0,
      addSpent: async () => {},
      fires: async () => 0,
      addFire: async () => {},
    });
    await runner.sync();
    expect(subs).toHaveLength(1); // the launch feed, nothing else
    await runner.onLaunch(fx.cases[0]!.signature, fx.cases[0]!.logs);
    expect(eng.markets.watch).toHaveBeenCalledWith(real.bondingCurve, -1);
    expect(trade).toHaveBeenCalledTimes(1);
    expect((trade.mock.calls[0] as unknown[])[0]).toMatchObject({ side: 'buy', amount: 0.05, mint: real.mint });
    expect(rows).toHaveLength(1); // the d2 miss isn't logged
    expect(rows[0]).toMatchObject({ outcome: 'copied', automationId: 'd1', leader: real.creator });
  });
});
