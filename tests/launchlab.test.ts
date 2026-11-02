// Offline Raydium LaunchLab tests on mainnet snapshots recorded by
// `LIVE=1 npx vitest run tests/live-launchlab.test.ts` (SOL pair) and
// tests/live-stonk.test.ts (a STONK pair with a 1% transfer fee). Those live
// tests also check our quotes against the programs' own events to the unit.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Keypair, PACKET_DATA_SIZE, PublicKey, SystemProgram, type AccountInfo } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { accountOf, loadFixture, replay, type Fixture } from './helpers/fixtures';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { LAUNCHLAB_PROGRAM_ID, launchLab, launchLabPoolPda, type LaunchLabMarket } from '../src/venues/launchLab';
import { STONK_MINT } from '../src/venues/routes';
import { JUPITER_PROGRAM_ID, routeMinOut } from '../src/venues/jupiter';
import { guardTransaction } from '../src/solana/guard';
import { venueAllowlist } from '../src/venues/registry';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { VenueError } from '../src/venues/types';
import { buildTrade } from '../src/solana/execute';
import { planTrade } from '../src/solana/trade';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';

const sol = loadFixture('tests/fixtures/launchlab.json');
const stonk = loadFixture('tests/fixtures/launchlab-stonk.json');
const POOL = new PublicKey(sol.address);
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

async function open(fx: Fixture = sol): Promise<LaunchLabMarket> {
  __resetCurveProtocolCache();
  const conn = replay(fx);
  const r = await resolveAddress(conn, new PublicKey(fx.address));
  return (await openMarket(conn, r.mint, r.hint)) as LaunchLabMarket;
}

function patchedPool(fx: Fixture, patch: (d: Buffer) => void): AccountInfo<Buffer> {
  const info = accountOf(fx, POOL);
  const data = Buffer.from(info.data);
  patch(data);
  return { ...info, data };
}

/**
 * The curve maths written out independently from the IDL layout (offsets
 * include the 8-byte discriminator): fee off the input, then x*y=k on
 * (virtual_base - real_base, virtual_quote + real_quote).
 */
function reference(fx: Fixture) {
  const p = accountOf(fx, POOL).data;
  const pool = { virtualA: p.readBigUInt64LE(37), virtualB: p.readBigUInt64LE(45), realA: p.readBigUInt64LE(53), realB: p.readBigUInt64LE(61), totalSellA: p.readBigUInt64LE(29) };
  const g = accountOf(fx, new PublicKey(p.subarray(141, 173))).data;
  const pl = accountOf(fx, new PublicKey(p.subarray(173, 205))).data;
  const rate = g.readBigUInt64LE(27) + pl.readBigUInt64LE(104) + pl.readBigUInt64LE(720);
  const fee = (x: bigint) => (x * rate + 999_999n) / 1_000_000n;
  const base = pool.virtualA - pool.realA;
  const quote = pool.virtualB + pool.realB;
  return {
    rate,
    buy: (lamports: bigint) => {
      const net = lamports - fee(lamports);
      const out = (net * base) / (quote + net);
      const left = pool.totalSellA - pool.realA;
      return out > left ? left : out;
    },
    sell: (tokens: bigint) => {
      const gross = (tokens * quote) / (base + tokens);
      return gross - fee(gross);
    },
  };
}

describe('LaunchLab fixture', () => {
  it('resolves the pool address (what Axiom shows) to LaunchLab', async () => {
    const r = await resolveAddress(replay(sol), POOL);
    expect(r.hint?.venue).toBe('LAUNCHLAB');
    const m = await open();
    expect(m.venue).toBe('LAUNCHLAB');
    expect(m.address.equals(POOL)).toBe(true);
    expect(m.state.quoteMint.equals(NATIVE_MINT)).toBe(true);
    expect(m.spotLamportsPerToken()).toBeGreaterThan(0);
  });

  it('resolves the mint to the same pool', async () => {
    __resetCurveProtocolCache();
    const conn = replay(sol);
    const viaMint = await resolveAddress(conn, (await resolveAddress(conn, POOL)).mint.mint);
    expect(viaMint.hint).toBeUndefined();
    const m = await openMarket(conn, viaMint.mint);
    expect(m.address.equals(POOL)).toBe(true);
    expect(launchLabPoolPda(viaMint.mint.mint, NATIVE_MINT).equals(POOL)).toBe(true);
  });

  it('quotes follow the constant-product curve with the protocol, platform and creator fees', async () => {
    const m = await open();
    const ref = reference(sol);
    expect(ref.rate).toBe(12_500n); // 0.25% Raydium + 1% stonk.fun; this platform sets no creator fee
    for (const lamports of [1_000_000n, 100_000_000n, 2_000_000_000n]) {
      expect(m.quoteBuy(new BN(lamports.toString()), 15).out.toString()).toBe(ref.buy(lamports).toString());
    }
    for (const tokens of [1_000_000n, 5_000_000_000_000n]) {
      expect(m.quoteSell(new BN(tokens.toString()), 15).out.toString()).toBe(ref.sell(tokens).toString());
    }
    const q = m.quoteBuy(new BN(100_000_000), 15);
    expect(q.minOut.lt(q.out)).toBe(true);
    expect(q.maxIn.toString()).toBe('100000000');
    expect(q.priceImpactPct).toBeGreaterThan(0);
  });

  it('a buy past the end of the curve gets only the tokens left', async () => {
    const m = await open();
    const total = m.state.totalSellA;
    m.apply(POOL, patchedPool(sol, (d) => d.set(total.subn(1_000).toArrayLike(Buffer, 'le', 8), 53)));
    expect(m.quoteBuy(new BN(50_000_000_000), 15).out.toString()).toBe('1000');
  });

  it('refuses a sell bigger than the SOL the curve holds', async () => {
    const m = await open();
    expect(() => m.quoteSell(m.state.virtualA, 15)).toThrow(/does not hold enough SOL/);
  });

  it('pool updates move the price; a full or graduated curve stops trading', async () => {
    const m = await open();
    const before = m.quoteBuy(new BN(100_000_000), 15).out;
    m.apply(POOL, patchedPool(sol, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(61) + 10_000_000_000n, 61)));
    expect(m.quoteBuy(new BN(100_000_000), 15).out.lt(before)).toBe(true);

    m.apply(POOL, patchedPool(sol, (d) => d.writeUInt8(1, 17)));
    expect(m.tradable()).toBe(false);
    expect(() => m.quoteBuy(new BN(1_000_000), 15)).toThrow(VenueError);
    m.apply(POOL, patchedPool(sol, (d) => d.writeUInt8(2, 17)));
    expect(() => m.quoteSell(new BN(1_000_000), 15)).toThrow(/graduated/);
  });

  it('platform fee changes reach the quote', async () => {
    const m = await open();
    const before = m.quoteBuy(new BN(100_000_000), 15).out;
    const platform = m.state.platformConfig;
    const info = accountOf(sol, platform);
    const data = Buffer.from(info.data);
    data.writeBigUInt64LE(50_000n, 104); // 1% -> 5%
    m.apply(platform, { ...info, data });
    expect(m.quoteBuy(new BN(100_000_000), 15).out.lt(before)).toBe(true);
  });
});

describe('LaunchLab transactions', () => {
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const user = Keypair.generate().publicKey;

  async function build(side: 'buy' | 'sell', amount: number, held: bigint, close = false) {
    const market = await open();
    const userAta = getAssociatedTokenAddressSync(market.mint.mint, user, true, market.mint.tokenProgram);
    const ataInfo = held > 0n ? tokenAccount(held, market.mint.mint, user, market.mint.tokenProgram) : null;
    const plan = planTrade(market, { side, amount, presetIndex: null }, settings, profile, new BN(held.toString()));
    const built = await buildTrade({
      market, plan, user, userAta, userAtaInfo: ataInfo, tier: 'eco', tipSol: null,
      profile, settings, blockhash: BLOCKHASH, cuLimit: () => 120_000, cuPrice: 1_000, closeAfterFullSell: close,
    });
    return { built, market, plan };
  }

  it('a buy wraps SOL, swaps, unwraps, and passes the guard', async () => {
    const { built, market, plan } = await build('buy', 0.1, 0n);
    expect(built.cuKey).toBe('LAUNCHLAB:buy+ata');
    const msg = built.tx.message;
    const keys = msg.staticAccountKeys;
    const programs = msg.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58());
    expect(programs.filter((p) => p === LAUNCHLAB_PROGRAM_ID.toBase58())).toHaveLength(1);
    expect(programs).toContain(SystemProgram.programId.toBase58()); // the wrap transfer (and the tip)
    const swap = msg.compiledInstructions.find((ix) => keys[ix.programIdIndex]!.equals(LAUNCHLAB_PROGRAM_ID))!;
    expect(swap.accountKeyIndexes).toHaveLength(18);
    const data = Buffer.from(swap.data);
    expect([...data.subarray(0, 8)]).toEqual([250, 234, 13, 123, 213, 156, 19, 236]);
    expect(new BN(data.subarray(8, 16), 'le').toString()).toBe(plan.quote.inAmount.toString());
    expect(new BN(data.subarray(16, 24), 'le').toString()).toBe(plan.quote.minOut.toString());
    expect(new BN(data.subarray(24, 32), 'le').isZero()).toBe(true); // no referral share
    // The pool, vaults and fee vaults are writable; configs aren't.
    const writable = (k: PublicKey) => msg.isAccountWritable(keys.findIndex((x) => x.equals(k)));
    expect(writable(POOL)).toBe(true);
    expect(writable(market.state.quoteVault)).toBe(true);
    expect(writable(market.state.globalConfig)).toBe(false);
  });

  it('a full sell can close the token account', async () => {
    const { built } = await build('sell', 100, 5_000_000_000n, true);
    expect(built.cuKey).toBe('LAUNCHLAB:sell+close');
    const { built: half } = await build('sell', 50, 5_000_000_000n, true);
    expect(half.cuKey).toBe('LAUNCHLAB:sell');
  });
});

describe('STONK-paired LaunchLab coins (routed through SOL)', () => {
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const user = Keypair.generate().publicKey;
  const STONK_POOL = new PublicKey(stonk.address);

  it('open from the pool or the mint as a routed market with lookup tables', async () => {
    const conn = replay(stonk);
    const r = await resolveAddress(conn, STONK_POOL);
    expect(r.hint?.venue).toBe('LAUNCHLAB');
    const m = (await launchLab.open(conn, r.mint, r.hint)) as LaunchLabMarket;
    expect(m.venue).toBe('LAUNCHLAB_ROUTED');
    expect(m.routedVia).toBe('STONK');
    expect(m.state.quoteMint.equals(STONK_MINT)).toBe(true);
    expect(m.lookupTables().length).toBeGreaterThan(0);
    expect(m.spotLamportsPerToken()).toBeGreaterThan(0);
    const viaMint = (await launchLab.open(conn, r.mint)) as LaunchLabMarket;
    expect(viaMint.address.equals(STONK_POOL)).toBe(true);
  });

  it('quotes through both legs, with the transfer fee off what the buyer gets', async () => {
    const conn = replay(stonk);
    const r = await resolveAddress(conn, STONK_POOL);
    const m = (await launchLab.open(conn, r.mint, r.hint)) as LaunchLabMarket;
    // This coin charges a 1% Token-2022 transfer fee.
    expect(m.transferFeeOn(new BN(1_000_000_000)).toString()).toBe('10000000');
    expect(m.canCloseTokenAccount()).toBe(false);
    // Small: this recorded curve holds only ~58 STONK to pay sells with.
    const buy = m.quoteBuy(new BN(10_000_000), 15);
    expect(buy.out.gtn(0)).toBe(true);
    expect(buy.minOut.toString()).toBe(routeMinOut(buy.out, 1500).toString());
    const sell = m.quoteSell(buy.out, 15);
    // Round trip loses curve, pool and transfer fees but stays in the right ballpark.
    expect(sell.out.ltn(10_000_000)).toBe(true);
    expect(sell.out.gtn(9_000_000)).toBe(true);
    // A sell needing more STONK than the curve holds is refused before signing.
    expect(() => m.quoteSell(m.state.realA.muln(2), 15)).toThrow(/does not hold enough STONK/);
  });

  it('builds one route_v2 per trade that fits, uses lookup tables, and passes the guard', async () => {
    const conn = replay(stonk);
    const r = await resolveAddress(conn, STONK_POOL);
    const m = (await launchLab.open(conn, r.mint, r.hint)) as LaunchLabMarket;
    for (const side of ['buy', 'sell'] as const) {
      const held = side === 'sell' ? 10_000_000_000n : 0n;
      const ataInfo = held ? tokenAccount(held, m.mint.mint, user, m.mint.tokenProgram) : null;
      const plan = planTrade(m, { side, amount: side === 'buy' ? 0.05 : 100, presetIndex: null }, settings, profile, new BN(held.toString()));
      const built = await buildTrade({
        market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: ataInfo, tier: 'fast', tipSol: null,
        profile, settings, blockhash: BLOCKHASH, cuLimit: () => 170_000, cuPrice: 10_000, closeAfterFullSell: true,
      });
      // Full sell, but this coin's account keeps withheld fees, so no close.
      expect(built.cuKey).toBe(side === 'buy' ? 'LAUNCHLAB_ROUTED:buy+ata' : 'LAUNCHLAB_ROUTED:sell');
      expect(built.tx.serialize().length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const msg = built.tx.message;
      expect(msg.addressTableLookups.length).toBeGreaterThan(0);
      const keys = msg.staticAccountKeys;
      const programs = msg.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58());
      expect(programs.filter((p) => p === JUPITER_PROGRAM_ID.toBase58())).toHaveLength(1);
      expect(programs).not.toContain(LAUNCHLAB_PROGRAM_ID.toBase58()); // the curve is reached through the route
      // Without the tables the guard can't see the real accounts, so it refuses.
      const policy = { payer: user, venuePrograms: venueAllowlist(), selfAccounts: m.selfAccounts(user).map(String), maxTipLamports: 10_000_000n, maxPriorityFeeLamports: 10_000_000n, requireTip: true };
      expect(() => guardTransaction(built.tx, policy)).toThrow(/unknown address lookup table/);
      expect(() => guardTransaction(built.tx, { ...policy, lookupTables: m.lookupTables() })).not.toThrow();
    }
  });

  it('a quote token with no route is named in the refusal', async () => {
    // A made-up quote token: no SOL pool anywhere (the recording looked).
    const nowhere = new PublicKey(Buffer.alloc(32, 7));
    const other = structuredClone(stonk);
    const raw = other.accounts[stonk.address]!;
    const data = Buffer.from(raw.data, 'base64');
    nowhere.toBuffer().copy(data, 237);
    raw.data = data.toString('base64');
    const conn = replay(other);
    const r = await resolveAddress(conn, STONK_POOL);
    await expect(launchLab.open(conn, r.mint, r.hint)).rejects.toThrow(`trades against another token (${nowhere.toBase58().slice(0, 4)}…), not SOL`);
  });
});

/** A fake token account holding `amount` raw tokens. */
function tokenAccount(amount: bigint, mint: PublicKey, owner: PublicKey, programId: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { data, owner: programId, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}
