// Offline Meteora tests on mainnet snapshots recorded by
// `LIVE=1 npx vitest run tests/live-meteora.test.ts`. Each fixture holds the
// trades that run simulated on mainnet whose result matched the quote, with
// the market state they were quoted on: replayed here, the quote must still
// give exactly what landed.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Keypair, PACKET_DATA_SIZE, PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { accountOf, fromRaw, loadFixture, replay, type Fixture } from './helpers/fixtures';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket, venueAllowlist } from '../src/venues/registry';
import { DBC_PROGRAM_ID, meteoraDbc, type DbcMarket } from '../src/venues/meteoraDbc';
import { DAMM_V2_PROGRAM_ID, type DammMarket } from '../src/venues/meteoraDammV2';
import { JUPITER_PROGRAM_ID } from '../src/venues/jupiter';
import { feeInPeriod, rateLimitedFee, scheduledFee, variableFee } from '../src/venues/meteoraMath';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { migratesOnComplete, type Market } from '../src/venues/types';
import { buildTrade } from '../src/solana/execute';
import { guardTransaction } from '../src/solana/guard';
import { planTrade } from '../src/solana/trade';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';

const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const SWAP2 = [65, 75, 63, 76, 235, 91, 91, 136];

const CASES: [string, Market['venue'], PublicKey][] = [
  ['meteora-dbc-sol', 'METEORA_DBC', DBC_PROGRAM_ID],
  ['meteora-dbc-usdc', 'METEORA_DBC_ROUTED', DBC_PROGRAM_ID],
  ['meteora-damm-graduated', 'METEORA_DAMM_V2', DAMM_V2_PROGRAM_ID],
  ['meteora-damm-only-b', 'METEORA_DAMM_V2', DAMM_V2_PROGRAM_ID],
  ['meteora-damm-compounding-usdc', 'METEORA_DAMM_V2_ROUTED', DAMM_V2_PROGRAM_ID],
];

async function open(fx: Fixture): Promise<Market> {
  __resetCurveProtocolCache();
  const conn = replay(fx);
  const r = await resolveAddress(conn, new PublicKey(fx.address));
  return openMarket(conn, r.mint, r.hint);
}

function tokenAccount(amount: bigint, mint: PublicKey, owner: PublicKey, programId: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { data, owner: programId, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

async function build(m: Market, side: 'buy' | 'sell', held: bigint) {
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const user = Keypair.generate().publicKey;
  const plan = planTrade(m, { side, amount: side === 'buy' ? 0.05 : 100, presetIndex: null }, settings, profile, new BN(held.toString()));
  const built = await buildTrade({
    market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: held ? tokenAccount(held, m.mint.mint, user, m.mint.tokenProgram) : null,
    tier: 'fast', tipSol: null, profile, settings, blockhash: BLOCKHASH, cuLimit: () => 200_000, cuPrice: 10_000, closeAfterFullSell: m.canCloseTokenAccount?.() ?? true,
  });
  const policy = { payer: user, venuePrograms: venueAllowlist(), selfAccounts: m.selfAccounts(user).map(String), maxTipLamports: 10_000_000n, maxPriorityFeeLamports: 10_000_000n, requireTip: true };
  return { built, policy, plan };
}

/** A copy of the fixture with one account's bytes changed. */
function patched(fx: Fixture, key: string, edit: (d: Buffer) => void): Fixture {
  const raw = fx.accounts[key]!;
  const d = Buffer.from(raw.data, 'base64');
  edit(d);
  return { ...fx, accounts: { ...fx.accounts, [key]: { ...raw, data: d.toString('base64') } } };
}

describe.each(CASES)('%s', (name, venue, program) => {
  const fx = loadFixture(`tests/fixtures/${name}.json`);

  it('resolves the page address to its venue', async () => {
    const r = await resolveAddress(replay(fx), new PublicKey(fx.address));
    expect(r.hint?.venue).toBe(venue.replace('_ROUTED', ''));
    expect((await open(fx)).venue).toBe(venue);
  });

  it('quotes every trade simulated on mainnet exactly as it landed', async () => {
    expect(fx.checks?.length).toBeGreaterThanOrEqual(3);
    const m = await open(fx);
    for (const c of fx.checks!) {
      for (const [k, raw] of Object.entries(c.accounts)) m.apply(new PublicKey(k), fromRaw(raw));
      const q = c.side === 'buy' ? m.quoteBuy(new BN(c.amountIn), 15) : m.quoteSell(new BN(c.amountIn), 15);
      expect(q.out.toString(), `${c.side} ${c.amountIn}`).toBe(c.out);
    }
  });

  it('builds a buy and a full sell the guard accepts, through the program or a Jupiter route', async () => {
    const m = await open(fx);
    const routed = venue.endsWith('_ROUTED');
    for (const side of ['buy', 'sell'] as const) {
      const held = side === 'sell' ? BigInt(fx.checks!.at(-1)!.amountIn) : 0n;
      const { built, policy } = await build(m, side, held);
      expect(built.tx.serialize().length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const keys = built.tx.message.staticAccountKeys;
      const programs = built.tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]!);
      if (routed) {
        expect(programs.some((p) => p.equals(JUPITER_PROGRAM_ID))).toBe(true);
        expect(programs.some((p) => p.equals(program))).toBe(false);
        const tables = { ...policy, lookupTables: m.lookupTables?.() ?? [] };
        if (built.tx.message.addressTableLookups.length) expect(() => guardTransaction(built.tx, policy)).toThrow(/unknown address lookup table/);
        expect(() => guardTransaction(built.tx, tables)).not.toThrow();
      } else {
        const swap = built.tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex]!.equals(program))!;
        expect([...Buffer.from(swap.data).subarray(0, 8)]).toEqual(SWAP2);
        expect(built.tx.message.addressTableLookups).toHaveLength(0);
        expect(() => guardTransaction(built.tx, policy)).not.toThrow();
        // Without the venue's program in the allowlist, the guard refuses to sign.
        const without = { ...policy, venuePrograms: venueAllowlist().filter((p) => p !== program.toBase58()) };
        expect(() => guardTransaction(built.tx, without)).toThrow(/not allowlisted/);
      }
    }
  });
});

describe('Meteora in the guard allowlist', () => {
  it('holds both programs, and Jupiter for routed trades', () => {
    expect(DBC_PROGRAM_ID.toBase58()).toBe('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
    expect(DAMM_V2_PROGRAM_ID.toBase58()).toBe('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
    expect(venueAllowlist()).toEqual(expect.arrayContaining([DBC_PROGRAM_ID.toBase58(), DAMM_V2_PROGRAM_ID.toBase58(), JUPITER_PROGRAM_ID.toBase58()]));
  });
});

describe('Meteora bonding curve lifecycle', () => {
  const fx = loadFixture('tests/fixtures/meteora-dbc-sol.json');

  it('a buy past the end of the curve takes what is left, as a partial fill', async () => {
    const m = (await open(fx)) as DbcMarket;
    const huge = m.quoteBuy(new BN(5_000_000_000_000), 15);
    // Everything up to the migration price, however much more SOL is offered.
    expect(m.quoteBuy(new BN(9_000_000_000_000), 15).out.toString()).toBe(huge.out.toString());
    expect(huge.out.lt(new BN(m.state.baseReserve.toString()))).toBe(true);
    const ixs = await m.buildBuy(Keypair.generate().publicKey, null, huge, 15);
    const swap = ixs.find((ix) => ix.programId.equals(DBC_PROGRAM_ID))!;
    expect(swap.data[24]).toBe(1); // SwapMode::PartialFill
    const normal = await m.buildBuy(Keypair.generate().publicKey, null, m.quoteBuy(new BN(10_000_000), 15), 15);
    expect(normal.find((ix) => ix.programId.equals(DBC_PROGRAM_ID))!.data[24]).toBe(0); // ExactIn
  });

  it('a curve priced in another token refuses a buy past its end (no partial fills through a route)', async () => {
    const m = (await open(loadFixture('tests/fixtures/meteora-dbc-usdc.json'))) as DbcMarket;
    expect(() => m.quoteBuy(new BN(5_000_000_000_000), 15)).toThrow(/bigger than what is left/);
  });

  it('stops trading when the curve completes, and the app follows it to DAMM v2', async () => {
    const m = (await open(fx)) as DbcMarket;
    expect(m.tradable()).toBe(true);
    expect(migratesOnComplete(m.venue)).toBe(true);
    const full = accountOf(fx, m.address);
    full.data.writeBigUInt64LE(m.curveConfig.migrationQuoteThreshold, 240);
    m.apply(m.address, full);
    expect(m.tradable()).toBe(false);
    expect(() => m.quoteBuy(new BN(10_000_000), 15)).toThrow(expect.objectContaining({ code: 'CURVE_COMPLETE' }));
  });

  it('a completed curve says it is migrating; once migrated it hands over to the DAMM v2 venue', async () => {
    const m = (await open(fx)) as DbcMarket;
    const complete = patched(fx, fx.address, (d) => d.writeBigUInt64LE(m.curveConfig.migrationQuoteThreshold, 240));
    await expect(meteoraDbc.open(replay(complete), m.mint, { account: m.address })).rejects.toMatchObject({ code: 'CURVE_COMPLETE' });
    const migrated = patched(complete, fx.address, (d) => {
      d[305] = 1; // is_migrated
      d[308] = 3; // MigrationProgress::CreatedPool
    });
    expect(await meteoraDbc.open(replay(migrated), m.mint, { account: m.address })).toBeNull();
  });
});

describe('Meteora DAMM v2 pool state', () => {
  it('a pool whose liquidity was withdrawn stops trading', async () => {
    const fx = loadFixture('tests/fixtures/meteora-damm-graduated.json');
    const m = (await open(fx)) as DammMarket;
    expect(m.tradable()).toBe(true);
    const empty = accountOf(fx, m.address);
    empty.data.fill(0, 360, 376); // liquidity
    m.apply(m.address, empty);
    expect(m.tradable()).toBe(false);
    expect(() => m.quoteSell(new BN(1_000_000), 15)).toThrow(/no liquidity/);
  });

  it('follows pool updates: a sell after a big buy gets less', async () => {
    const fx = loadFixture('tests/fixtures/meteora-damm-only-b.json');
    const m = (await open(fx)) as DammMarket;
    const before = m.quoteSell(new BN('1000000000000'), 15).out;
    const moved = accountOf(fx, m.address);
    // Halve the price: B per A doubles when the coin is token B, so SOL per coin halves.
    const sqrt = m.state.sqrtPrice;
    const next = (sqrt * 1414n) / 1000n;
    moved.data.writeBigUInt64LE(next & ((1n << 64n) - 1n), 456);
    moved.data.writeBigUInt64LE(next >> 64n, 464);
    m.apply(m.address, moved);
    expect(m.quoteSell(new BN('1000000000000'), 15).out.lt(before)).toBe(true);
  });
});

describe('Meteora fee maths', () => {
  it('fee schedules: linear steps, exponential decay, capped at the last period', () => {
    expect(scheduledFee(false, 500_000_000n, 10, 40_000_000n, 3n)).toBe(380_000_000n);
    expect(scheduledFee(false, 500_000_000n, 10, 40_000_000n, 50n)).toBe(100_000_000n);
    expect(feeInPeriod(990_000_000n, 1_000n, 0)).toBe(990_000_000n);
    // 10% off per period: 990M * 0.9^5 = 584.6M (Q64 truncation leaves it a few units under).
    const five = feeInPeriod(990_000_000n, 1_000n, 5);
    expect(Number(five)).toBeCloseTo(990_000_000 * 0.9 ** 5, -2);
    expect(five).toBeLessThanOrEqual(584_595_100n);
    expect(scheduledFee(true, 990_000_000n, 5, 1_000n, 99n)).toBe(five);
  });

  it('rate limiter: the cliff fee up to the reference amount, rising by the increment per reference amount after', () => {
    const r = { cliff: 10_000_000n, incrementBps: 100n, referenceAmount: 1_000n, maxFeeNumerator: 990_000_000n };
    expect(rateLimitedFee(r, 1_000n)).toBe(10_000_000n);
    // 1000 at 1%, 1000 at 2%, 500 at 3%: 45 in fees on 2500 -> 1.8%.
    expect(rateLimitedFee(r, 2_500n)).toBe(18_000_000n);
  });

  it('volatility fee: ceil((accumulator * bin step)^2 * control / 1e11)', () => {
    expect(variableFee({ initialized: true, binStep: 100n, variableFeeControl: 1_000n, volatilityAccumulator: 10_000n })).toBe(10_000n);
    expect(variableFee({ initialized: false, binStep: 100n, variableFeeControl: 1_000n, volatilityAccumulator: 10_000n })).toBe(0n);
  });
});
