import '../src/polyfills';
import { describe, expect, it, vi } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import { AutomationRunner, AUTOMATION_TAB } from '../src/automation/runner';
import { newCopytrade, type ActivityRow, type Automations } from '../src/automation/schema';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import type { TradeEngine } from '../src/solana/engine';

const leader = Keypair.generate().publicKey.toBase58();
const coin = Keypair.generate().publicKey.toBase58();
const pool = Keypair.generate().publicKey;
const ata = Keypair.generate().publicKey;

/** The leader spends `sol` on 500 of the coin (or sells all 500 for it). */
function leaderTx(side: 'buy' | 'sell', sol: number): VersionedTransactionResponse {
  const keys = [new PublicKey(leader), pool, ata];
  const lamports = sol * 1e9;
  const [pre, post] = side === 'buy' ? [0n, 500n] : [500n, 0n];
  const bal = (amount: bigint) => [{ accountIndex: 2, mint: coin, owner: leader, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' } }];
  return {
    slot: 1,
    blockTime: 1,
    transaction: { signatures: [`${side}-${sol}`], message: { header: { numRequiredSignatures: 1 }, getAccountKeys: () => ({ length: 3, get: (i: number) => keys[i] }) } },
    meta: { fee: 5_000, err: null, preBalances: [100e9, 0, 0], postBalances: [100e9 + (side === 'buy' ? -lamports : lamports) - 5_000, 0, 0], preTokenBalances: bal(pre), postTokenBalances: bal(post) },
  } as unknown as VersionedTransactionResponse;
}

function setup(automations: Automations, opts: { holding?: boolean; spent?: number; venue?: string; risks?: string[]; mcapUsd?: number } = {}) {
  const trade = vi.fn(async (req: { side: string; amount: number }, s: { safety: { dryRun: boolean } }) =>
    s.safety.dryRun ? { kind: 'simulated' as const, ok: true, text: 'ok', detail: '' } : { kind: 'sent' as const, signature: `sig-${req.side}-${req.amount}`, text: '', detail: '' },
  );
  const eng = {
    // A pump.fun coin worth `mcapUsd` (1B supply at SOL = $100), unless the test says otherwise.
    markets: {
      watch: vi.fn(async () => ({ venue: opts.venue ?? 'PUMP_CURVE', spotSolPerToken: (opts.mcapUsd ?? 50_000) / 100 / 1e9, solUsd: 100, risks: opts.risks ?? [] })),
      get: () => ({ market: { mint: { supply: new BN('1000000000000000'), decimals: 6 } } }),
      tokenBalance: () => new BN(opts.holding ? 500 : 0),
    },
    ledger: { position: () => undefined },
    trade,
  } as unknown as TradeEngine;
  const rows: ActivityRow[] = [];
  let spent = opts.spent ?? 0;
  const fires: Record<string, number> = {};
  const settings = { ...defaultSettings(), safety: { ...defaultSettings().safety, dryRun: false } };
  const runner = new AutomationRunner({
    conn: { onLogs: () => 1, removeOnLogsListener: async () => {} } as unknown as Connection,
    load: async () => automations,
    engineFor: async () => eng,
    settings: async () => ({ settings, profile: activeProfile(settings) }),
    log: async (r) => void rows.push(r),
    spentToday: async () => spent,
    addSpent: async (sol) => void (spent += sol),
    fires: async (id) => fires[id] ?? 0,
    addFire: async (id) => void (fires[id] = (fires[id] ?? 0) + 1),
  });
  return { runner, trade, eng, rows, spentNow: () => spent };
}

const auto = (over: Partial<ReturnType<typeof newCopytrade>> = {}, caps: Partial<Automations> = {}): Automations => ({
  stopped: false, maxSolPerTrade: 0.5, maxSolPerDay: 2, manualLadder: { enabled: false, steps: [] }, deploys: [], copytrades: [{ ...newCopytrade('c1'), targets: [leader], dryRun: false, ...over }], ...caps,
});

describe('AutomationRunner', () => {
  it("copies a followed wallet's buy through the engine, on the coin it opened, and logs it", async () => {
    const { runner, trade, eng, rows, spentNow } = setup(auto());
    await runner.sync();
    expect(runner.following()).toEqual([leader]);
    await runner.onTransaction(leader, leaderTx('buy', 1));
    expect(eng.markets.watch).toHaveBeenCalledWith(coin, AUTOMATION_TAB);
    expect(trade).toHaveBeenCalledTimes(1);
    const [req, , profile] = trade.mock.calls[0]! as unknown as [{ side: string; amount: number; mint: string; tabId: number }, unknown, { slippagePct: number }];
    expect(req).toMatchObject({ side: 'buy', amount: 0.1, mint: coin, tabId: AUTOMATION_TAB });
    expect(profile.slippagePct).toBe(15); // the config's slippage, not the profile's
    expect(rows[0]).toMatchObject({ outcome: 'copied', leaderSide: 'buy', signature: 'sig-buy-0.1' });
    expect(spentNow()).toBeCloseTo(0.1, 9);
  });

  it('simulates instead while the automation is in dry run', async () => {
    const { runner, rows, spentNow } = setup(auto({ dryRun: true }));
    await runner.sync();
    await runner.onTransaction(leader, leaderTx('buy', 1));
    expect(rows[0]).toMatchObject({ outcome: 'simulated' });
    expect(spentNow()).toBe(0);
  });

  it('trims to the per-trade cap and stops at the daily cap', async () => {
    const big = setup(auto({ size: { mode: 'fixed', sol: 2 } }));
    await big.runner.sync();
    await big.runner.onTransaction(leader, leaderTx('buy', 1));
    expect((big.trade.mock.calls[0]![0] as { amount: number }).amount).toBe(0.5);
    expect(big.rows[0]!.detail).toMatch(/trimmed to the 0.5 SOL per-trade cap/);

    const spent = setup(auto(), { spent: 1.95 });
    await spent.runner.sync();
    await spent.runner.onTransaction(leader, leaderTx('buy', 1));
    expect(spent.trade).not.toHaveBeenCalled();
    expect(spent.rows[0]).toMatchObject({ outcome: 'skipped', detail: expect.stringMatching(/daily cap/) });
  });

  it("copies a sell as the same share when we hold the coin, and logs a skip when we don't", async () => {
    const held = setup(auto(), { holding: true });
    await held.runner.sync();
    await held.runner.onTransaction(leader, leaderTx('sell', 1));
    expect(held.trade.mock.calls[0]![0]).toMatchObject({ side: 'sell', amount: 100 });

    const none = setup(auto());
    await none.runner.sync();
    await none.runner.onTransaction(leader, leaderTx('sell', 1));
    expect(none.rows[0]).toMatchObject({ outcome: 'skipped', detail: "we don't hold this coin" });
  });

  it("skips coins outside the copytrade's market cap, platforms or risk rule, saying why", async () => {
    const mcap = setup(auto({ maxMcapUsd: 40_000 }), { mcapUsd: 50_000 });
    await mcap.runner.sync();
    await mcap.runner.onTransaction(leader, leaderTx('buy', 1));
    expect(mcap.rows[0]).toMatchObject({ outcome: 'skipped', detail: 'market cap $50,000 is over $40,000' });

    const plat = setup(auto({ platforms: ['raydium'] }));
    await plat.runner.sync();
    await plat.runner.onTransaction(leader, leaderTx('buy', 1));
    expect(plat.rows[0]!.detail).toMatch(/pump isn't one of this copytrade's platforms/);

    const risky = setup(auto(), { risks: ['freeze'] });
    await risky.runner.sync();
    await risky.runner.onTransaction(leader, leaderTx('buy', 1));
    expect(risky.rows[0]!.detail).toMatch(/freeze/);
    expect(mcap.trade).not.toHaveBeenCalled();
  });

  it('consensus: buys once the second followed wallet buys the same coin, and only once', async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const both = setup(auto({ targets: [leader, other], consensus: { count: 2, windowSec: 600 }, firstBuyOnly: false, skipIfHolding: false, maxFires: null }));
    await both.runner.sync();
    await both.runner.onTransaction(leader, leaderTx('buy', 1));
    expect(both.trade).not.toHaveBeenCalled();
    expect(both.rows[0]!.detail).toBe('consensus 1 of 2 wallets within 600s');
    const theirs = leaderTx('buy', 2);
    // The same trade shape, but from the second wallet.
    (theirs.transaction.message as unknown as { getAccountKeys: () => unknown }).getAccountKeys = () => ({ length: 3, get: (i: number) => [new PublicKey(other), pool, ata][i] });
    (theirs.meta!.preTokenBalances as { owner: string }[])[0]!.owner = other;
    (theirs.meta!.postTokenBalances as { owner: string }[])[0]!.owner = other;
    await both.runner.onTransaction(other, theirs);
    expect(both.trade).toHaveBeenCalledTimes(1);
    await both.runner.onTransaction(leader, leaderTx('buy', 3));
    expect(both.trade).toHaveBeenCalledTimes(1);
  });

  it('does nothing while stopped, follows nobody, and ignores wallets it does not follow', async () => {
    const stopped = setup({ ...auto(), stopped: true });
    await stopped.runner.sync();
    expect(stopped.runner.following()).toEqual([]);
    await stopped.runner.onTransaction(leader, leaderTx('buy', 1));
    expect(stopped.trade).not.toHaveBeenCalled();

    const other = setup(auto({ targets: [Keypair.generate().publicKey.toBase58()] }));
    await other.runner.sync();
    await other.runner.onTransaction(leader, leaderTx('buy', 1));
    expect(other.trade).not.toHaveBeenCalled();
  });
});
