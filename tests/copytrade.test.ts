import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Keypair, type VersionedTransactionResponse } from '@solana/web3.js';
import { decideCopy, parseLeaderTrade, withinCaps, type CopyContext, type LeaderTrade } from '../src/automation/copytrade';
import { newCopytrade, parseAutomations, DEFAULT_AUTOMATIONS } from '../src/automation/schema';

const leader = Keypair.generate().publicKey;
const coin = Keypair.generate().publicKey;
const pool = Keypair.generate().publicKey;
const ata = Keypair.generate().publicKey;
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface Tok {
  index: number;
  mint: string;
  owner?: string;
  pre?: bigint;
  post?: bigint;
}

/** A fake getTransaction() result: the leader (and optionally the mint) sign; balances as given. */
function tx(lamports: [number, number], tokens: Tok[], opts: { mintSigns?: boolean; err?: unknown } = {}): VersionedTransactionResponse {
  const keys = opts.mintSigns ? [leader, coin, pool, ata] : [leader, pool, ata];
  const tb = (which: 'pre' | 'post') =>
    tokens
      .filter((t) => t[which] !== undefined)
      .map((t) => ({ accountIndex: t.index, mint: t.mint, owner: t.owner ?? leader.toBase58(), uiTokenAmount: { amount: t[which]!.toString(), decimals: 6, uiAmount: null, uiAmountString: '' } }));
  return {
    slot: 1,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: ['sig-1'],
      message: { header: { numRequiredSignatures: opts.mintSigns ? 2 : 1 }, getAccountKeys: () => ({ length: keys.length, get: (i: number) => keys[i] }) },
    },
    meta: {
      fee: 5_000,
      err: (opts.err ?? null) as never,
      preBalances: [lamports[0], 0, 0, 0],
      postBalances: [lamports[1], 0, 0, 0],
      preTokenBalances: tb('pre'),
      postTokenBalances: tb('post'),
    },
  } as unknown as VersionedTransactionResponse;
}

const L = leader.toBase58();
const C = coin.toBase58();

describe('parseLeaderTrade', () => {
  it('reads a buy: SOL out, the coin in', () => {
    const t = parseLeaderTrade(tx([10e9, 10e9 - 1e9 - 5_000], [{ index: 2, mint: C, pre: 0n, post: 500n }]), L)!;
    expect(t).toMatchObject({ mint: C, side: 'buy', sellPct: null, deploy: false });
    expect(t.sol).toBeCloseTo(1, 9);
  });

  it('reads a sell, and what share of the holding it was', () => {
    const t = parseLeaderTrade(tx([1e9, 1e9 + 2e9 - 5_000], [{ index: 2, mint: C, pre: 1_000n, post: 250n }]), L)!;
    expect(t).toMatchObject({ side: 'sell', sellPct: 75 });
    expect(t.sol).toBeCloseTo(2, 9);
  });

  it('flags a coin the leader created in the same transaction', () => {
    expect(parseLeaderTrade(tx([10e9, 9e9], [{ index: 3, mint: C, pre: 0n, post: 500n }], { mintSigns: true }), L)!.deploy).toBe(true);
  });

  it('ignores quote tokens moving alongside the coin (a USDC-routed buy is still one coin)', () => {
    const t = parseLeaderTrade(tx([10e9, 9e9], [{ index: 2, mint: C, pre: 0n, post: 500n }, { index: 1, mint: USDC, pre: 0n, post: 0n }, { index: 1, mint: WSOL, pre: 0n, post: 0n }]), L);
    expect(t?.mint).toBe(C);
  });

  it('is not a trade: failed, a transfer (tokens without SOL), or two coins at once', () => {
    expect(parseLeaderTrade(tx([10e9, 9e9], [{ index: 2, mint: C, pre: 0n, post: 500n }], { err: { InstructionError: [0, 'x'] } }), L)).toBeNull();
    expect(parseLeaderTrade(tx([10e9, 10e9 - 5_000], [{ index: 2, mint: C, pre: 0n, post: 500n }]), L)).toBeNull();
    const other = Keypair.generate().publicKey.toBase58();
    expect(parseLeaderTrade(tx([10e9, 9e9], [{ index: 2, mint: C, pre: 0n, post: 500n }, { index: 1, mint: other, pre: 10n, post: 0n }]), L)).toBeNull();
  });
});

describe('decideCopy', () => {
  const buy = (sol: number, over: Partial<LeaderTrade> = {}): LeaderTrade => ({ signature: 's', leader: L, mint: C, side: 'buy', sol, sellPct: null, deploy: false, blockTime: null, ...over });
  const ctx = (over: Partial<CopyContext> = {}): CopyContext => ({ fires: 0, leaderBoughtBefore: false, weBought: false, weHold: false, ...over });
  const cfg = newCopytrade('a');

  it('copies a buy at the fixed size, or a capped share of the leader', () => {
    expect(decideCopy(cfg, buy(2), ctx())).toEqual({ kind: 'buy', sol: 0.1 });
    const pct = { ...cfg, size: { mode: 'percent' as const, pct: 10, maxSol: 0.5 } };
    expect(decideCopy(pct, buy(2), ctx())).toEqual({ kind: 'buy', sol: 0.2 });
    expect(decideCopy(pct, buy(20), ctx())).toEqual({ kind: 'buy', sol: 0.5 });
  });

  it('skips what the config rules out, saying why', () => {
    const reason = (d: ReturnType<typeof decideCopy>) => (d.kind === 'skip' ? d.reason : '');
    expect(reason(decideCopy(cfg, buy(0.05), ctx()))).toMatch(/under the 0.1 SOL minimum/);
    expect(reason(decideCopy({ ...cfg, maxTargetSol: 5 }, buy(9), ctx()))).toMatch(/over the 5 SOL maximum/);
    expect(reason(decideCopy(cfg, buy(1, { deploy: true }), ctx()))).toMatch(/created this coin/);
    expect(reason(decideCopy(cfg, buy(1), ctx({ fires: 3 })))).toMatch(/already copied 3 trades/);
    expect(reason(decideCopy(cfg, buy(1), ctx({ leaderBoughtBefore: true })))).toMatch(/first buy/);
    expect(reason(decideCopy(cfg, buy(1), ctx({ weHold: true })))).toMatch(/already hold/);
    expect(reason(decideCopy({ ...cfg, skipIfBought: true, skipIfHolding: false }, buy(1), ctx({ weBought: true })))).toMatch(/bought this coin before/);
  });

  it("copies a sell as the same share of our holding, only when we hold it and sells are on", () => {
    const sell = buy(1, { side: 'sell', sellPct: 40 });
    expect(decideCopy(cfg, sell, ctx({ weHold: true }))).toEqual({ kind: 'sell', pct: 40 });
    expect(decideCopy(cfg, sell, ctx()).kind).toBe('skip');
    expect(decideCopy({ ...cfg, copySells: false }, sell, ctx({ weHold: true })).kind).toBe('skip');
  });
});

describe('caps', () => {
  it('trims a buy to the per-trade cap and refuses one past the daily cap', () => {
    expect(withinCaps({ maxSolPerTrade: 0.5, maxSolPerDay: 2 }, 1, 0)).toEqual({ ok: true, sol: 0.5, trimmed: true });
    expect(withinCaps({ maxSolPerTrade: 0.5, maxSolPerDay: 2 }, 0.3, 1.5)).toEqual({ ok: true, sol: 0.3, trimmed: false });
    const r = withinCaps({ maxSolPerTrade: 0.5, maxSolPerDay: 2 }, 0.5, 1.8);
    expect(r.ok).toBe(false);
  });

  it('falls back to safe defaults for anything malformed in storage', () => {
    expect(parseAutomations({ stopped: 'no' })).toEqual(DEFAULT_AUTOMATIONS);
    expect(parseAutomations(undefined).copytrades).toEqual([]);
  });
});
