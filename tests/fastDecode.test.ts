// The copytrade fast path against real pump.fun and PumpSwap trades
// (tests/fixtures/copytrade-logs.json: a wallet's buy and sell on each, with
// its token and SOL changes from the same transactions).
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeLeaderLogs } from '../src/automation/fastDecode';

const fx = JSON.parse(readFileSync('tests/fixtures/copytrade-logs.json', 'utf8')) as {
  leader: string;
  cases: { signature: string; logs: string[]; mint: string; tokenDelta: string; walletLamports: number }[];
};

describe('decodeLeaderLogs (real trades)', () => {
  it.each(fx.cases.map((c) => [c.signature.slice(0, 8), c] as const))('%s: the side, coin and amounts the chain recorded', (_, c) => {
    const t = decodeLeaderLogs(c.logs, fx.leader);
    expect(t).not.toBeNull();
    const delta = BigInt(c.tokenDelta);
    expect(t!.side).toBe(delta > 0n ? 'buy' : 'sell');
    expect(t!.tokens).toBe(delta > 0n ? delta : -delta);
    if (t!.venue === 'curve') expect(t!.mint).toBe(c.mint);
    // The trade's own SOL. The wallet's change also carries its bot's fee, tips, rent and any SOL left wrapped, so it
    // spends at least the trade on a buy, and receives at most the trade on a sell, within ~12%.
    const wallet = Math.abs(c.walletLamports);
    const sol = Number(t!.lamports);
    if (t!.side === 'buy') expect(wallet).toBeGreaterThanOrEqual(sol);
    else expect(wallet).toBeLessThanOrEqual(sol);
    expect(Math.abs(wallet - sol) / sol).toBeLessThan(0.12);
  });

  it('reads the exact amounts from the events: the curve buy cost 4.5 SOL with fees, the PumpSwap buy 6 SOL', () => {
    expect(decodeLeaderLogs(fx.cases[0]!.logs, fx.leader)!.lamports).toBe(4_500_000_000n);
    expect(decodeLeaderLogs(fx.cases[2]!.logs, fx.leader)!.lamports).toBe(6_000_000_000n);
  });

  it("ignores another wallet's trade in the same logs", () => {
    expect(decodeLeaderLogs(fx.cases[0]!.logs, 'So11111111111111111111111111111111111111112')).toBeNull();
  });

  it('gives a PumpSwap sell the share of the holding it sold', () => {
    const sell = fx.cases.find((c) => BigInt(c.tokenDelta) < 0n && c.logs.some((l) => l.includes('pAMMBay6')))!;
    const t = decodeLeaderLogs(sell.logs, fx.leader)!;
    expect(t.venue).toBe('pumpswap');
    if (t.venue === 'pumpswap') expect(t.holdingBefore).toBeGreaterThanOrEqual(t.tokens);
  });
});
