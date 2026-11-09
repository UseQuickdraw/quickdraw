import '../src/polyfills';
import { describe, expect, it, vi } from 'vitest';
import BN from 'bn.js';
import { averageEntry, dueStep, type LadderStep } from '../src/automation/ladder';
import { LadderManager } from '../src/automation/ladderManager';
import { AUTOMATION_TAB } from '../src/automation/runner';
import type { ActivityRow } from '../src/automation/schema';
import type { Position } from '../src/ledger/ledger';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import type { TradeEngine } from '../src/solana/engine';

const step = (kind: LadderStep['kind'], value: number, sellPct = 50): LadderStep => ({ id: `${kind}${value}`, kind, value, sellPct });

describe('dueStep', () => {
  const steps = [step('tp', 100), step('sl', 30, 100), step('trail', 20), step('time', 600)];

  it('fires a take-profit at +value%, a stop-loss at −value%, trailing off the peak, and time after value seconds', () => {
    expect(dueStep(steps, { ratio: 1.5, fromPeak: 1, ageSec: 10 })).toBeNull();
    expect(dueStep(steps, { ratio: 2, fromPeak: 1, ageSec: 10 })?.kind).toBe('tp');
    expect(dueStep(steps, { ratio: 0.7, fromPeak: 0.9, ageSec: 10 })?.kind).toBe('sl');
    expect(dueStep(steps, { ratio: 1.6, fromPeak: 0.79, ageSec: 10 })?.kind).toBe('trail');
    expect(dueStep(steps, { ratio: 1.1, fromPeak: 1, ageSec: 600 })?.kind).toBe('time');
  });

  it('checks stops before profits when both hold', () => {
    expect(dueStep([step('tp', 10), step('trail', 5)], { ratio: 1.3, fromPeak: 0.9, ageSec: 0 })?.kind).toBe('trail');
  });

  it('averages the entry over landed buys only', () => {
    const fill = (side: 'buy' | 'sell', lamports: number, tokens: string, ok = true) => ({ side, ok, tradeLamports: side === 'buy' ? -lamports : lamports, tokenDelta: tokens }) as Position['fills'][number];
    const p = { fills: [fill('buy', 1e9, '1000'), fill('buy', 3e9, '1000'), fill('buy', 5e9, '1000', false), fill('sell', 2e9, '-500')] } as Position;
    expect(averageEntry(p)).toBeCloseTo(4 / 2000, 12); // 4 SOL over 2000 raw units
    expect(averageEntry(undefined)).toBeNull();
  });
});

describe('LadderManager', () => {
  function setup(price: { v: number }, holding: { v: number }) {
    const trade = vi.fn(async () => ({ kind: 'sent' as const, signature: 'sig', text: '', detail: '' }));
    // Bought 1000 raw units for 1 SOL: the entry is 0.001 SOL per raw unit (decimals 0 keeps the maths plain).
    const position = { fills: [{ side: 'buy', ok: true, tradeLamports: -1e9, tokenDelta: '1000' }] } as unknown as Position;
    const eng = {
      wallet: 'W',
      markets: {
        watch: vi.fn(async () => ({})),
        get: () => ({ market: { spotLamportsPerToken: () => price.v * 1e9, mint: { decimals: 0 } } }),
        tokenBalance: () => new BN(holding.v),
      },
      ledger: { position: () => position },
      trade,
    } as unknown as TradeEngine;
    const rows: ActivityRow[] = [];
    let stored: Record<string, unknown> = {};
    const settings = { ...defaultSettings(), safety: { ...defaultSettings().safety, dryRun: false } };
    const mgr = new LadderManager({
      load: async () => ({}),
      save: async (all) => void (stored = all),
      engineFor: async () => eng,
      settings: async () => ({ settings, profile: activeProfile(settings) }),
      stopped: async () => false,
      log: async (r) => void rows.push(r),
    });
    return { mgr, trade, eng, rows, stored: () => stored };
  }

  it('sells the step once when it is due, then keeps the rest of the ladder', async () => {
    const price = { v: 0.001 };
    const { mgr, trade, eng, rows } = setup(price, { v: 1000 });
    await mgr.attach('W', 'MINT', [step('tp', 100, 50), step('sl', 50, 100)], 'test');
    expect(eng.markets.watch).toHaveBeenCalledWith('MINT', AUTOMATION_TAB);
    await mgr.tick();
    expect(trade).not.toHaveBeenCalled();
    price.v = 0.0021; // +110%
    await mgr.tick();
    await mgr.tick();
    expect(trade).toHaveBeenCalledTimes(1);
    expect((trade.mock.calls[0] as unknown[])[0]).toMatchObject({ side: 'sell', amount: 50, mint: 'MINT', tabId: AUTOMATION_TAB });
    expect(rows[0]).toMatchObject({ outcome: 'copied', detail: expect.stringMatching(/TP \+100% → sell 50% at \+110/) });
    expect(mgr.list()[0]!.steps.map((s) => s.kind)).toEqual(['sl']);
  });

  it('drops a ladder once its position is sold out', async () => {
    const holding = { v: 1000 };
    const { mgr } = setup({ v: 0.001 }, holding);
    await mgr.attach('W', 'MINT', [step('tp', 100)], 'test');
    await mgr.tick();
    holding.v = 0;
    await mgr.tick();
    expect(mgr.list()).toEqual([]);
  });
});
