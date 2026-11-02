// Offline tests for routes whose SOL leg is a Raydium CLMM pool (coins paired
// with an xStock, pump.fun curves priced in PUMP, and Mars, priced in
// NEURALINK: a 1% transfer-fee token reached through USDC), on snapshots recorded by
// `LIVE=1 npx vitest run tests/live-pumproute.test.ts tests/live-cpmm.test.ts`,
// which also check each routed trade against the chain to the unit.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Keypair, PACKET_DATA_SIZE, PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { loadFixture, replay, type Fixture } from './helpers/fixtures';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket, venueAllowlist } from '../src/venues/registry';
import type { Market } from '../src/venues/types';
import { ClmmLeg, decodeDynamicFee, sqrtPriceAtTick, tickAtSqrtPrice, tickSpacingIndex, totalFeeRate, updateFeeReference, type DynamicFee } from '../src/venues/raydiumClmm';
import { ChainLeg, USDC_MINT } from '../src/venues/routes';
import { WhirlpoolLeg } from '../src/venues/whirlpool';
import { PumpSwapSolLeg } from '../src/venues/pumpPool';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { buildTrade } from '../src/solana/execute';
import { guardTransaction } from '../src/solana/guard';
import { planTrade } from '../src/solana/trade';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';

const model3 = loadFixture('tests/fixtures/pumpswap-clmm.json');
const cpu = loadFixture('tests/fixtures/cpmm-stock.json');
const thesis = loadFixture('tests/fixtures/curve-routed.json');
const mars = loadFixture('tests/fixtures/pumpswap-fee.json');
const chad = loadFixture('tests/fixtures/launchlab-chain.json');
const sling = loadFixture('tests/fixtures/curve-chain.json');
const acc = loadFixture('tests/fixtures/curve-fee.json');
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

type Routed = Market & { venue: string; routedVia: string | null; leg: unknown };

async function open(fx: Fixture, address = fx.address): Promise<Routed> {
  __resetCurveProtocolCache();
  const conn = replay(fx);
  const r = await resolveAddress(conn, new PublicKey(address));
  return (await openMarket(conn, r.mint, r.hint)) as unknown as Routed;
}

function tokenAccount(amount: bigint, mint: PublicKey, owner: PublicKey, programId: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { data, owner: programId, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

describe('CLMM dynamic fees (states/pool_fee.rs)', () => {
  const fee = (over: Partial<DynamicFee> = {}): DynamicFee => ({
    filterPeriod: 10, decayPeriod: 60, reductionFactor: 5_000, control: 1_000, maxVolatility: 350_000,
    indexReference: 0, volatilityReference: 0, volatility: 0, lastUpdate: 1_000, ...over,
  });

  it("groups ticks by spacing, rounding down below zero (the program's own cases)", () => {
    for (const [tick, spacing, index] of [[0, 10, 0], [10, 10, 1], [5, 10, 0], [19, 10, 1], [-1, 10, -1], [-5, 10, -1], [-10, 10, -1], [-11, 10, -2], [-21, 10, -3], [121, 60, 2], [-30, 60, -1], [-121, 60, -3], [-5, 1, -5]] as const) {
      expect(tickSpacingIndex(tick, spacing), `${tick}/${spacing}`).toBe(index);
    }
  });

  it('holds the reference while trading is fast, decays it after, and resets it once quiet', () => {
    const held = fee({ volatility: 40_000, volatilityReference: 20_000 });
    updateFeeReference(held, 7, 1_005);
    expect(held).toMatchObject({ volatilityReference: 20_000, indexReference: 0, lastUpdate: 1_000 });
    const decayed = fee({ volatility: 40_000 });
    updateFeeReference(decayed, 7, 1_030);
    expect(decayed).toMatchObject({ volatilityReference: 20_000, indexReference: 7, lastUpdate: 1_030 });
    const reset = fee({ volatility: 40_000, volatilityReference: 20_000 });
    updateFeeReference(reset, 7, 1_100);
    expect(reset).toMatchObject({ volatilityReference: 0, indexReference: 7, lastUpdate: 1_100 });
  });

  it('adds ceil(control * (volatility * spacing)^2 / 1e13) to the base rate, capped at 10%', () => {
    expect(totalFeeRate(2_500n, fee(), 60)).toBe(2_500n);
    // 10,000 * 60 = 600,000; 1,000 * 600,000^2 / 1e13 = 36.
    expect(totalFeeRate(2_500n, fee({ volatility: 10_000 }), 60)).toBe(2_536n);
    expect(totalFeeRate(2_500n, fee({ volatility: 10_001 }), 1)).toBe(2_501n);
    expect(totalFeeRate(90_000n, fee({ volatility: 350_000 }), 60)).toBe(100_000n);
  });

  it('reads the fee state from its 80 packed bytes, and none when they are all zero', () => {
    expect(decodeDynamicFee(Buffer.alloc(80))).toBeNull();
    const b = Buffer.alloc(80);
    b.writeUInt16LE(10, 0);
    b.writeUInt16LE(60, 2);
    b.writeUInt16LE(5_000, 4);
    b.writeUInt32LE(1_000, 6);
    b.writeUInt32LE(350_000, 10);
    b.writeInt32LE(-42, 14);
    b.writeUInt32LE(7, 18);
    b.writeUInt32LE(9, 22);
    b.writeBigUInt64LE(1_700_000_000n, 26);
    expect(decodeDynamicFee(b)).toEqual({ filterPeriod: 10, decayPeriod: 60, reductionFactor: 5_000, control: 1_000, maxVolatility: 350_000, indexReference: -42, volatilityReference: 7, volatility: 9, lastUpdate: 1_700_000_000 });
  });
});

describe('CLMM tick maths', () => {
  it('matches the program at known points and round-trips', () => {
    expect(sqrtPriceAtTick(0)).toBe(1n << 64n);
    expect(sqrtPriceAtTick(-443636)).toBe(4295048016n);
    expect(sqrtPriceAtTick(443636)).toBe(79226673521066979257578248091n);
    for (const t of [-443635, -200000, -36904, -1, 0, 1, 22279, 300000, 443635]) {
      expect(tickAtSqrtPrice(sqrtPriceAtTick(t))).toBe(t);
      expect(tickAtSqrtPrice(sqrtPriceAtTick(t) + 1n)).toBe(t);
      expect(tickAtSqrtPrice(sqrtPriceAtTick(t) - 1n)).toBe(t - 1);
    }
  });
});

describe.each([
  ['MODEL3 / TSLAx (PumpSwap)', model3, 'PUMPSWAP_ROUTED', 'TSLAx'],
  ['CPU / INTCx (Raydium CPMM)', cpu, 'RAYDIUM_CPMM_ROUTED', 'INTCx'],
  ['Thesis Cat / PUMP (pump.fun curve)', thesis, 'PUMP_CURVE_ROUTED', 'PUMP'],
])('%s, routed through a Raydium CLMM', (_name, fx, venue, via) => {
  it('opens from the pool as a routed market with a CLMM SOL leg', async () => {
    const m = await open(fx);
    expect(m.venue).toBe(venue);
    expect(m.routedVia).toBe(via);
    expect(m.leg).toBeInstanceOf(ClmmLeg);
    expect(m.spotLamportsPerToken()).toBeGreaterThan(0);
  });

  it('quotes both ways, and a round trip costs only fees', async () => {
    const m = await open(fx);
    const buy = m.quoteBuy(new BN(10_000_000), 15);
    expect(buy.out.gtn(0)).toBe(true);
    expect(buy.minOut.lt(buy.out)).toBe(true);
    expect(m.quoteBuy(new BN(20_000_000), 15).out.gt(buy.out)).toBe(true);
    const back = m.quoteSell(buy.out, 15).out;
    expect(back.ltn(10_000_000)).toBe(true);
    expect(back.gtn(9_000_000)).toBe(true);
  });

  it('builds a route that fits at the fastest tier and passes the guard', async () => {
    const m = await open(fx);
    const settings = defaultSettings();
    const profile = activeProfile(settings);
    const user = Keypair.generate().publicKey;
    for (const side of ['buy', 'sell'] as const) {
      const held = side === 'sell' ? m.quoteBuy(new BN(50_000_000), 15).out : new BN(0);
      const plan = planTrade(m, { side, amount: side === 'buy' ? 0.05 : 100, presetIndex: null }, settings, profile, held);
      const built = await buildTrade({
        market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: side === 'sell' ? tokenAccount(BigInt(held.toString()), m.mint.mint, user, m.mint.tokenProgram) : null,
        tier: 'fast', tipSol: null, profile, settings, blockhash: BLOCKHASH, cuLimit: () => 200_000, cuPrice: 10_000, closeAfterFullSell: true,
      });
      expect(built.tx.serialize().length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const policy = { payer: user, venuePrograms: venueAllowlist(), selfAccounts: m.selfAccounts(user).map(String), maxTipLamports: 10_000_000n, maxPriorityFeeLamports: 10_000_000n, requireTip: true };
      expect(() => guardTransaction(built.tx, { ...policy, lookupTables: m.lookupTables?.() ?? [] })).not.toThrow();
    }
  });

  it('refuses a trade bigger than the liquidity it loaded, instead of guessing', async () => {
    const m = await open(fx);
    expect(() => m.quoteBuy(new BN('1000000000000000'), 15)).toThrow(/smaller amount|liquidity/i);
  });

  it('only counts a pool as usable when it can fill a small trade both ways', async () => {
    const leg = (await open(fx)).leg as ClmmLeg;
    expect(ClmmLeg.canFill(leg, 10_000_000_000n)).toBe(true);
    // Holding next to nothing (DJT's SOL pool held 0.0001 SOL), or a probe past what's in range, fails.
    expect(ClmmLeg.canFill(leg, 0n)).toBe(false);
    expect(ClmmLeg.canFill(leg, 10n ** 21n)).toBe(false);
  });
});

describe('Mars / NEURALINK (PumpSwap; 1% transfer fee, routed SOL -> USDC -> NEURALINK)', () => {
  const settings = defaultSettings();
  const profile = activeProfile(settings);

  it('opens as a routed market whose SOL leg chains Orca SOL/USDC into a USDC CLMM pool', async () => {
    const m = await open(mars);
    expect(m.venue).toBe('PUMPSWAP_ROUTED');
    expect(m.routedVia).toBe('NEURALINK');
    const leg = m.leg as ChainLeg;
    expect(leg).toBeInstanceOf(ChainLeg);
    expect(leg.first).toBeInstanceOf(WhirlpoolLeg);
    expect(leg.second.anchor.equals(USDC_MINT)).toBe(true);
    expect(leg.second.tokenFee).not.toBeNull();
    expect(leg.hops().map((h) => h.mint.toBase58())).toEqual([USDC_MINT.toBase58()]);
    expect(m.cuFloor?.()).toBe(300_000);
  });

  it('charges the transfer fee each time NEURALINK moves', async () => {
    const m = await open(mars);
    const clmm = (m.leg as ChainLeg).second as ClmmLeg;
    // The same pool without the fee (a shallow copy sharing its state).
    const noFee: ClmmLeg = Object.assign(Object.create(ClmmLeg.prototype), clmm, { tokenFee: null });
    const fee = (x: bigint) => (x + 99n) / 100n; // 1%, rounded up as Token-2022 does
    // Landing NEURALINK loses 1%...
    const gross = noFee.quote(1_000_000n, true);
    const landed = clmm.quote(1_000_000n, true);
    expect(landed).toBe(gross - fee(gross));
    // ...and so does sending it into the pool.
    expect(clmm.quote(landed, false)).toBe(noFee.quote(landed - fee(landed), false));
  });

  it('quotes both ways, and a round trip costs only fees', async () => {
    const m = await open(mars);
    const buy = m.quoteBuy(new BN(10_000_000), 15);
    expect(buy.out.gtn(0)).toBe(true);
    const back = m.quoteSell(buy.out, 15).out;
    expect(back.ltn(10_000_000)).toBe(true);
    expect(back.gtn(8_500_000)).toBe(true);
  });

  it('builds three-leg routes that fit at the fastest tier and pass the guard', async () => {
    const m = await open(mars);
    const user = Keypair.generate().publicKey;
    for (const side of ['buy', 'sell'] as const) {
      const held = side === 'sell' ? m.quoteBuy(new BN(50_000_000), 15).out : new BN(0);
      const plan = planTrade(m, { side, amount: side === 'buy' ? 0.05 : 100, presetIndex: null }, settings, profile, held);
      const built = await buildTrade({
        market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: side === 'sell' ? tokenAccount(BigInt(held.toString()), m.mint.mint, user, m.mint.tokenProgram) : null,
        tier: 'fast', tipSol: null, profile, settings, blockhash: BLOCKHASH, cuLimit: () => 200_000, cuPrice: 10_000, closeAfterFullSell: true,
      });
      expect(built.cuLimit).toBe(300_000);
      expect(built.tx.serialize().length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const policy = { payer: user, venuePrograms: venueAllowlist(), selfAccounts: m.selfAccounts(user).map(String), maxTipLamports: 10_000_000n, maxPriorityFeeLamports: 10_000_000n, requireTip: true };
      expect(() => guardTransaction(built.tx, { ...policy, lookupTables: m.lookupTables?.() ?? [] })).not.toThrow();
    }
  });
});

describe('CHAD / HIMS (LaunchLab curve; SOL -> USDC -> HIMS on a fine CLMM pool that needs its bitmap extension)', () => {
  it('opens as a LaunchLab route chaining SOL/USDC into the HIMS USDC pool', async () => {
    const m = await open(chad);
    expect(m.venue).toBe('LAUNCHLAB_ROUTED');
    expect(m.routedVia).toBe('HIMS');
    expect(m.leg).toBeInstanceOf(ChainLeg);
    expect((m.leg as ChainLeg).second.anchor.equals(USDC_MINT)).toBe(true);
  });

  it("quotes both ways, reading the bitmap extension where the pool's own bitmap ends", async () => {
    const m = await open(chad);
    const buy = m.quoteBuy(new BN(10_000_000), 15);
    expect(buy.out.gtn(0)).toBe(true);
    const back = m.quoteSell(buy.out, 15).out;
    expect(back.ltn(10_000_000)).toBe(true);
    expect(back.gtn(8_500_000)).toBe(true);
    // Selling HIMS for USDC searches past the pool's own bitmap, so the leg hands the program the extension.
    const clmm = (m.leg as ChainLeg).second as ClmmLeg;
    const accounts = clmm.jupiterLeg(Keypair.generate().publicKey, false).accounts.map((a) => a.pubkey.toBase58());
    expect(accounts).toContain(clmm.extensionKey.toBase58());
  });

  it('says plainly when the route does not fit (no borrowed tables offline), instead of failing to encode', async () => {
    const m = await open(chad);
    const settings = defaultSettings();
    const profile = activeProfile(settings);
    const user = Keypair.generate().publicKey;
    const plan = planTrade(m, { side: 'buy', amount: 0.05, presetIndex: null }, settings, profile, new BN(0));
    await expect(
      buildTrade({ market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: null, tier: 'fast', tipSol: null, profile, settings, blockhash: BLOCKHASH, cuLimit: () => 200_000, cuPrice: 10_000, closeAfterFullSell: true }),
    ).rejects.toThrow(/doesn't fit in one transaction \(\d+ of 1232 bytes\)/);
  });
});

describe('Sling1M / BTC (pump.fun curve priced in BTC, a pump coin whose own pool is priced in WBTC)', () => {
  const WBTC = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';

  it("chains SOL -> WBTC on Orca into BTC's own PumpSwap pool", async () => {
    const m = await open(sling);
    expect(m.venue).toBe('PUMP_CURVE_ROUTED');
    expect(m.routedVia).toBe('BTC');
    const leg = m.leg as ChainLeg;
    expect(leg).toBeInstanceOf(ChainLeg);
    expect(leg.first).toBeInstanceOf(WhirlpoolLeg);
    expect(leg.second).toBeInstanceOf(PumpSwapSolLeg);
    expect(leg.second.anchor.toBase58()).toBe(WBTC);
    // The user's WBTC account is passed through, so it's created with the trade.
    expect(leg.hops().map((h) => h.mint.toBase58())).toEqual([WBTC]);
    expect(m.cuFloor?.()).toBe(300_000);
  });

  it('quotes both ways, and a round trip costs only fees', async () => {
    const m = await open(sling);
    const buy = m.quoteBuy(new BN(10_000_000), 15);
    expect(buy.out.gtn(0)).toBe(true);
    const back = m.quoteSell(buy.out, 15).out;
    expect(back.ltn(10_000_000)).toBe(true);
    expect(back.gtn(8_500_000)).toBe(true);
  });
});

describe('ACC / OPENAI (pump.fun curve priced in a PreStock with a Token-2022 transfer fee)', () => {
  it("opens as a routed curve that prices the quote's transfer fee", async () => {
    const m = await open(acc);
    expect(m.venue).toBe('PUMP_CURVE_ROUTED');
    expect(m.routedVia).toBe('OPENAI');
    expect((m as unknown as { route: { quoteFee: unknown } }).route.quoteFee).not.toBeNull();
  });

  it('marks the quote mint writable in the curve leg, so the program can harvest withheld fees', async () => {
    const m = await open(acc);
    const quoteMint = (m as unknown as { bondingCurve: { quoteMint: PublicKey } }).bondingCurve.quoteMint;
    const leg = await (m as unknown as { curveLeg(u: PublicKey, s: 'buy' | 'sell'): Promise<{ accounts: { pubkey: PublicKey; isWritable: boolean }[] }> }).curveLeg(Keypair.generate().publicKey, 'buy');
    expect(leg.accounts.find((a) => a.pubkey.equals(quoteMint))?.isWritable).toBe(true);
  });

  it('quotes both ways, and a round trip costs only fees (the 1% transfer fee four times over included)', async () => {
    const m = await open(acc);
    const buy = m.quoteBuy(new BN(10_000_000), 15);
    expect(buy.out.gtn(0)).toBe(true);
    const back = m.quoteSell(buy.out, 15).out;
    expect(back.ltn(10_000_000)).toBe(true);
    expect(back.gtn(8_500_000)).toBe(true);
  });
});
