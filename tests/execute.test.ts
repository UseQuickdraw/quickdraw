import '../src/polyfills';
import { describe, expect, it, vi } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, type AccountInfo, type Connection, type SimulatedTransactionResponse, type VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { loadFixture, replay, type Fixture } from './helpers/fixtures';
import { CuCalibration, DEFAULT_CU, capCuPrice, levelsFromRecent } from '../src/solana/fees';
import { decodeError } from '../src/solana/errors';
import { buildTrade, interpretSimulation, tipFor } from '../src/solana/execute';
import { TradeEngine } from '../src/solana/engine';
import { planTrade } from '../src/solana/trade';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { SENDER } from '../src/constants';

const pool = loadFixture('tests/fixtures/pumpswap.json');
const curve = loadFixture('tests/fixtures/curve.json');
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

describe('CU calibration', () => {
  it('uses defaults, then the largest recent consumption plus headroom', () => {
    const c = new CuCalibration();
    expect(c.limit('PUMPSWAP:buy')).toBe(DEFAULT_CU['PUMPSWAP:buy']);
    c.record('PUMPSWAP:buy', 150_000);
    c.record('PUMPSWAP:buy', 170_000);
    expect(c.limit('PUMPSWAP:buy')).toBe(195_500);
    c.bump('PUMPSWAP:buy', 195_500);
    expect(c.limit('PUMPSWAP:buy')).toBeGreaterThan(195_500);
  });

  it('never sizes a limit below its default', () => {
    // A run of cheap PumpSwap sells (~91k) must leave room for a costlier one (116k).
    const c = new CuCalibration({ 'PUMPSWAP:sell': [91_000, 92_000, 91_500] });
    expect(c.limit('PUMPSWAP:sell')).toBe(DEFAULT_CU['PUMPSWAP:sell']);
    expect(c.limit('PUMPSWAP:sell')).toBeGreaterThan(116_000);
  });

  it('never sizes a routed trade below its default, and keeps more headroom there', () => {
    // A small CPU sell through the CLMM used ~94k; a bigger one then ran out at 108,056.
    const c = new CuCalibration({ 'RAYDIUM_CPMM_ROUTED:sell': [93_962] });
    expect(c.limit('RAYDIUM_CPMM_ROUTED:sell')).toBe(DEFAULT_CU['RAYDIUM_CPMM_ROUTED:sell']);
    c.record('RAYDIUM_CPMM_ROUTED:sell', 140_000);
    expect(c.limit('RAYDIUM_CPMM_ROUTED:sell')).toBe(182_000);
    c.bump('RAYDIUM_CPMM_ROUTED:sell', 182_000);
    expect(c.limit('RAYDIUM_CPMM_ROUTED:sell')).toBeGreaterThan(182_000);
  });

  it('ignores junk when loading a saved snapshot', () => {
    const c = new CuCalibration({ 'PUMP_CURVE:sell': [80_000, -1, 'x'], 'EVIL:key': [1] });
    expect(c.limit('PUMP_CURVE:sell')).toBe(92_000);
    expect(Object.keys(c.snapshot())).toEqual(['PUMP_CURVE:sell']);
  });

  it('caps the CU price so price x limit stays under the max priority fee', () => {
    expect(capCuPrice(1_000_000, 200_000, 5_000_000)).toBe(1_000_000);
    expect(capCuPrice(100_000_000, 200_000, 5_000_000)).toBe(25_000_000);
    expect(capCuPrice(50, 200_000, 0)).toBe(0);
  });

  it('derives levels from recent fees', () => {
    expect(levelsFromRecent([0, 0])).toBeNull();
    const l = levelsFromRecent([100, 200, 300, 400, 0])!;
    expect(l.min).toBe(100);
    expect(l.veryHigh).toBe(400);
  });
});

describe('error decoding', () => {
  const custom = { InstructionError: [2, { Custom: 6002 }] };
  it('names anchor errors from logs', () => {
    const e = decodeError(custom, ['Program log: AnchorError thrown in programs/pump/src/lib.rs:1. Error Code: TooMuchSolRequired. Error Number: 6002. Error Message: slippage: Too much SOL required.']);
    expect(e.kind).toBe('slippage');
    expect(e.code).toBe('TooMuchSolRequired (6002)');
    expect(decodeError(custom, ['Program log: AnchorError occurred. Error Code: ExceededSlippage. Error Number: 6004. Error Message: Exceeded slippage.']).kind).toBe('slippage');
    expect(decodeError(custom, ['Program log: AnchorError thrown. Error Code: SomethingNew. Error Number: 6099. Error Message: New thing.']).message).toBe('SomethingNew: New thing');
  });
  it('recognizes runtime failures', () => {
    expect(decodeError('AccountNotFound').kind).toBe('insufficient_sol');
    expect(decodeError({ InstructionError: [3, { Custom: 1 }] }, ['Transfer: insufficient lamports 5, need 100']).kind).toBe('insufficient_sol');
    expect(decodeError({ InstructionError: [3, 'ComputationalBudgetExceeded'] }).kind).toBe('compute');
    // The usual "consumed N of M compute units" log line is not a compute failure.
    expect(decodeError({ InstructionError: [4, 'InvalidAccountData'] }, ['Program Tokenkeg consumed 199 of 1277706 compute units', 'Program Tokenkeg failed: invalid account data for instruction']).kind).not.toBe('compute');
    expect(decodeError('BlockhashNotFound').kind).toBe('blockhash');
  });
});

async function openFixture(fx: Fixture) {
  __resetCurveProtocolCache();
  const conn = replay(fx);
  const r = await resolveAddress(conn, new PublicKey(fx.address));
  return openMarket(conn, r.mint, r.hint);
}

/** A fake token account holding `amount` raw tokens. */
function tokenAccount(amount: bigint, mint: PublicKey, owner: PublicKey, programId: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1; // initialized
  return { data, owner: programId, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

describe('buildTrade', () => {
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const user = Keypair.generate().publicKey;

  it('assembles budget + venue + tip that the guard accepts, with calibrated limits', async () => {
    const market = await openFixture(pool);
    const plan = planTrade(market, { side: 'buy', amount: 0.1, presetIndex: null }, settings, profile, new BN(0));
    const built = await buildTrade({
      market, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: null, tier: 'fast', tipSol: null,
      profile, settings, blockhash: BLOCKHASH, cuLimit: () => 123_000, cuPrice: 50_000, closeAfterFullSell: false,
    });
    expect(built.cuKey).toBe('PUMPSWAP:buy+ata');
    expect(built.cuLimit).toBe(123_000);
    expect(built.tipLamports).toBe(1_000_000n); // Fast tier minimum
    expect(built.guard.cuPriceMicroLamports).toBe(50_000n);
    const keys = built.tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys.some((k) => (SENDER.tipAccounts as readonly string[]).includes(k))).toBe(true);
    expect(keys).toContain(ComputeBudgetProgram.programId.toBase58());
  });

  it('closes the token account only on a full sell with the setting on', async () => {
    const market = await openFixture(pool);
    const ata = tokenAccount(5_000_000_000n, market.mint.mint, user, market.mint.tokenProgram);
    const on = { ...settings, safety: { ...settings.safety, autoCloseAta: true } };
    const build = (pct: number) =>
      buildTrade({
        market, plan: planTrade(market, { side: 'sell', amount: pct, presetIndex: null }, on, profile, new BN('5000000000')),
        user, userAta: Keypair.generate().publicKey, userAtaInfo: ata, tier: 'eco', tipSol: null,
        profile, settings: on, blockhash: BLOCKHASH, cuLimit: () => 150_000, cuPrice: 1_000, closeAfterFullSell: true,
      });
    expect((await build(100)).cuKey).toBe('PUMPSWAP:sell+close');
    expect((await build(50)).cuKey).toBe('PUMPSWAP:sell');
  });

  it('refuses a tip above the max tip', () => {
    expect(() => tipFor('fast', profile, 0.05, 0.01)).toThrow(/max tip/);
    expect(tipFor('eco', profile, 0.000001, 0.01)).toBe(0.000005); // raised to the Sender minimum
  });
});

describe('simulation results', () => {
  it('reports token and SOL deltas from the returned accounts', () => {
    const owner = Keypair.generate().publicKey;
    const ata = tokenAccount(700n, owner, owner, owner);
    const v = {
      err: null,
      logs: [],
      unitsConsumed: 80_000,
      accounts: [
        { lamports: 900, owner: owner.toBase58(), data: ['', 'base64'], executable: false },
        { lamports: 1, owner: owner.toBase58(), data: [ata.data.toString('base64'), 'base64'], executable: false },
      ],
    } as unknown as SimulatedTransactionResponse;
    const out = interpretSimulation(v, { preLamports: 1_000, preTokens: new BN(200) });
    expect(out.ok).toBe(true);
    expect(out.tokenDelta!.toString()).toBe('500');
    expect(out.solDelta).toBe(-100);
  });
});

describe('TradeEngine (dry run)', () => {
  function engineFor(fx: Fixture, simulate: (tx: VersionedTransaction) => Partial<SimulatedTransactionResponse>) {
    const base = replay(fx) as unknown as Record<string, (...a: never[]) => unknown>;
    const has = (k: PublicKey) => k.toBase58() in fx.accounts;
    const conn = {
      ...base,
      rpcEndpoint: 'https://example.invalid',
      getAccountInfo: async (k: PublicKey) => (has(k) ? base.getAccountInfo!(k as never) : null),
      getMultipleAccountsInfo: async (ks: PublicKey[]) => Promise.all(ks.map((k) => (has(k) ? base.getAccountInfo!(k as never) : null))),
      getBalance: async () => 1_000_000_000,
      onAccountChange: () => 1,
      removeAccountChangeListener: async () => {},
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
      simulateTransaction: vi.fn(async (tx: VersionedTransaction) => ({ context: { slot: 1 }, value: { err: null, logs: [], accounts: null, unitsConsumed: 0, ...simulate(tx) } })),
    } as unknown as Connection;
    const signer = Keypair.generate();
    const endpoints = { rpcUrl: 'https://rpc.example', wsUrl: 'wss://rpc.example', senderApiKey: null, customSendUrl: null };
    return { engine: new TradeEngine(conn, signer, endpoints, { market: () => {}, toast: () => {} }), conn, signer };
  }

  it('signs with the wallet and simulates with signature checks and our blockhash', async () => {
    const { engine, conn, signer } = engineFor(pool, () => ({ unitsConsumed: 101_234 }));
    const settings = defaultSettings();
    const view = await engine.markets.watch(pool.address, 1);
    const res = await engine.trade({ side: 'buy', amount: 0.1, presetIndex: 1, mint: view.mint, tier: 'eco', clickedAt: Date.now(), tabId: 1 }, settings, activeProfile(settings));
    expect(res.kind).toBe('simulated');
    expect(res.kind === 'simulated' && res.ok).toBe(true);

    const [tx, cfg] = (conn.simulateTransaction as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [VersionedTransaction, { sigVerify: boolean; replaceRecentBlockhash: boolean }];
    expect(cfg.sigVerify).toBe(true);
    expect(cfg.replaceRecentBlockhash).toBe(false);
    expect(tx.message.recentBlockhash).toBe(BLOCKHASH);
    const key = await crypto.subtle.importKey('raw', new Uint8Array(signer.publicKey.toBytes()), { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify('Ed25519', key, new Uint8Array(tx.signatures[0]!), new Uint8Array(tx.message.serialize()))).toBe(true);
    // The measured consumption is remembered for sizing the next limit.
    expect(engine.cu.snapshot()['PUMPSWAP:buy+ata']).toEqual([101_234]);
    engine.dispose();
  });

  it('decodes a failed simulation and bumps the CU limit when compute ran out', async () => {
    const { engine } = engineFor(pool, () => ({ err: { InstructionError: [2, 'ComputationalBudgetExceeded'] } as never }));
    const settings = defaultSettings();
    const view = await engine.markets.watch(pool.address, 1);
    const before = engine.cu.limit('PUMPSWAP:buy+ata');
    const res = await engine.trade({ side: 'buy', amount: 0.1, presetIndex: null, mint: view.mint, tier: 'fast', clickedAt: Date.now(), tabId: 1 }, settings, activeProfile(settings));
    expect(res.kind === 'simulated' && !res.ok && res.text).toMatch(/compute units/);
    expect(engine.cu.limit('PUMPSWAP:buy+ata')).toBeGreaterThan(before);
    engine.dispose();
  });

  it("quotes a sell's proceeds after price impact and the fees it would pay", async () => {
    const { engine } = engineFor(pool, () => ({}));
    const settings = defaultSettings();
    const profile = activeProfile(settings);
    const view = await engine.markets.watch(pool.address, 1);
    expect(engine.quoteSell({ mint: view.mint, pct: 50, tier: 'fast', presetIndex: null }, settings, profile)).toBeNull(); // holds none

    const held = new BN('500000000000000'); // a big holding, so price impact shows
    vi.spyOn(engine.markets, 'tokenBalance').mockReturnValue(held);
    const market = engine.markets.get(view.mint)!.market;
    const half = engine.quoteSell({ mint: view.mint, pct: 50, tier: 'fast', presetIndex: null }, settings, profile)!;
    const all = engine.quoteSell({ mint: view.mint, pct: 100, tier: 'fast', presetIndex: null }, settings, profile)!;
    // Exactly the venue's own quote, which is under the spot value.
    expect(half.outLamports).toBe(Number(market.quoteSell(held.divn(2), profile.slippagePct).out.toString()));
    expect(half.outLamports).toBeLessThan(view.spotSolPerToken * (Number(held.toString()) / 10 ** view.decimals / 2) * 1e9);
    // Selling it all moves the price further than half does.
    expect(all.outLamports).toBeLessThan(2 * half.outLamports);
    // Network fee + priority fee + the fast tip.
    const tip = Math.round(tipFor('fast', profile, null, settings.safety.maxTipSol) * 1e9);
    expect(half.feesLamports).toBeGreaterThanOrEqual(5_000 + tip);
    engine.dispose();
  });

  it("quotes a buy's tokens and their value after price impact and fees", async () => {
    const { engine } = engineFor(pool, () => ({}));
    const settings = defaultSettings();
    const profile = activeProfile(settings);
    const view = await engine.markets.watch(pool.address, 1);
    const market = engine.markets.get(view.mint)!.market;
    const small = engine.quoteBuy({ mint: view.mint, sol: 0.01, tier: 'eco', presetIndex: null }, settings, profile)!;
    const big = engine.quoteBuy({ mint: view.mint, sol: 50, tier: 'eco', presetIndex: null }, settings, profile)!;
    // Exactly the venue's own quote.
    expect(small.tokens).toBe(Number(market.quoteBuy(new BN(10_000_000), profile.slippagePct).out.toString()) / 10 ** view.decimals);
    // Worth less than what went in (pool fee), and a big buy loses more of it to price impact.
    expect(small.valueLamports).toBeLessThan(10_000_000);
    expect(big.valueLamports / 50e9).toBeLessThan(small.valueLamports / 10_000_000);
    // Network fee + priority fee + the eco tip.
    expect(small.feesLamports).toBeGreaterThanOrEqual(5_000 + Math.round(tipFor('eco', profile, null, settings.safety.maxTipSol) * 1e9));
    engine.dispose();
  });
});
