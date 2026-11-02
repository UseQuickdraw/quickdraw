// Offline venue tests on real mainnet snapshots (tests/fixtures, recorded by
// `LIVE=1 npx vitest run tests/live.test.ts`).
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { PUMP_AMM_SDK } from '@pump-fun/pump-sdk/swap';
import { accountOf, loadFixture, replay, type Fixture } from './helpers/fixtures';
import { compareWithSdk } from './helpers/compare';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { VenueError } from '../src/venues/types';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';

const curve = loadFixture('tests/fixtures/curve.json');
const cashback = loadFixture('tests/fixtures/curve-cashback.json');
const pool = loadFixture('tests/fixtures/pumpswap.json');

/** Copy of a fixture with one account's bytes patched. */
function patched(fx: Fixture, key: PublicKey, patch: (d: Buffer) => void): Fixture {
  const copy: Fixture = structuredClone(fx);
  const raw = copy.accounts[key.toBase58()]!;
  const data = Buffer.from(raw.data, 'base64');
  patch(data);
  raw.data = data.toString('base64');
  return copy;
}

describe.each([
  ['curve (v3)', curve],
  ['curve (cashback, v2)', cashback],
  ['pumpswap', pool],
] as const)('%s fixture', (_n, fx) => {
  it('resolves the page address and quotes exactly like the SDK', async () => {
    __resetCurveProtocolCache();
    const r = await compareWithSdk(replay(fx), fx);
    expect(r.spot).toBeGreaterThan(0);
  });

  it('resolves the mint address directly to the same venue', async () => {
    __resetCurveProtocolCache();
    const conn = replay(fx);
    const viaPage = await resolveAddress(conn, new PublicKey(fx.address));
    const viaMint = await resolveAddress(conn, viaPage.mint.mint);
    expect(viaMint.hint).toBeUndefined();
    const m = await openMarket(conn, viaMint.mint);
    expect(m.address.toBase58()).toBe(fx.address);
  });
});

it('fixtures cover both curve instruction paths', () => {
  const kind = (fx: Fixture) => PUMP_SDK.decodeBondingCurve(accountOf(fx, new PublicKey(fx.address))).isCashbackCoin;
  expect(kind(curve)).toBe(false); // buy_exact_quote_in_v3 / sell_v3
  expect(kind(cashback)).toBe(true); // buy_v2 / sell_v2
});

describe('subscription updates', () => {
  it('pool: a vault update changes quotes and matches the SDK on the new state', async () => {
    const conn = replay(pool);
    const r = await resolveAddress(conn, new PublicKey(pool.address));
    const market = await openMarket(conn, r.mint, r.hint);
    const quoteVault = PUMP_AMM_SDK.decodePool(accountOf(pool, new PublicKey(pool.address))).poolQuoteTokenAccount;

    const before = market.quoteBuy(new BN(100_000_000), 15).out;
    // SPL token account: amount is the u64 at offset 64. Double the SOL side.
    const bumped = patched(pool, quoteVault, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(64) * 2n, 64));
    market.apply(quoteVault, accountOf(bumped, quoteVault));
    const after = market.quoteBuy(new BN(100_000_000), 15).out;
    expect(after.lt(before)).toBe(true); // SOL got cheaper relative to the token

    // The SDK, fetching the patched snapshot from scratch, agrees.
    await compareWithSdk(replay(bumped), bumped);
  });

  it('curve: a reserve update changes quotes; completion stops trading', async () => {
    __resetCurveProtocolCache();
    const conn = replay(curve);
    const r = await resolveAddress(conn, new PublicKey(curve.address));
    const market = await openMarket(conn, r.mint, r.hint);
    const key = market.address;
    const original = accountOf(curve, key);
    const decoded = PUMP_SDK.decodeBondingCurve(original);
    // Layout check: discriminator(8) | virtual_token u64 | virtual_quote u64 | ... | complete bool @48
    expect(original.data.readBigUInt64LE(16).toString()).toBe(decoded.virtualQuoteReserves.toString());

    const before = market.quoteBuy(new BN(100_000_000), 15).out;
    const pricier = patched(curve, key, (d) => d.writeBigUInt64LE((d.readBigUInt64LE(16) * 12n) / 10n, 16));
    market.apply(key, accountOf(pricier, key));
    expect(market.quoteBuy(new BN(100_000_000), 15).out.lt(before)).toBe(true);
    __resetCurveProtocolCache();
    await compareWithSdk(replay(pricier), pricier);

    const done = patched(curve, key, (d) => d.writeUInt8(1, 48));
    expect(PUMP_SDK.decodeBondingCurve(accountOf(done, key)).complete).toBe(true);
    market.apply(key, accountOf(done, key));
    expect(market.tradable()).toBe(false);
    expect(() => market.quoteBuy(new BN(1_000_000), 15)).toThrow(VenueError);
  });
});

describe('resolver errors', () => {
  it('unknown addresses are reported, not guessed', async () => {
    const missing = new PublicKey('11111111111111111111111111111112');
    const fx: Fixture = { name: 'empty', slot: 0, address: missing.toBase58(), accounts: { [missing.toBase58()]: null }, tokenAccountsByOwner: {} };
    await expect(resolveAddress(replay(fx), missing)).rejects.toThrow(/not found/);
  });
});
