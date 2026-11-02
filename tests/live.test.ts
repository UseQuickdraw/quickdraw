// Live mainnet check + fixture recorder. Skipped unless LIVE=1.
//   LIVE=1 [LIVE_RPC=https://...] npx vitest run tests/live.test.ts
// Finds a live pump.fun curve token and a live PumpSwap token, opens them the
// way the extension does (from the curve/pool address a page would show),
// compares our cached-state quotes with the SDK's own fetch-and-quote path,
// checks the SDK-built instructions pass our guard, and records fixtures for
// tests/venues.test.ts.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Connection, PublicKey, type ParsedTransactionWithMeta, type VersionedTransactionResponse } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda, isLegacyQuoteMint } from '@pump-fun/pump-sdk';
import { PUMP_AMM_SDK, canonicalPumpPoolPda } from '@pump-fun/pump-sdk/swap';
import { PUBLIC_MAINNET_RPC } from '../src/constants';
import { recording, replay, saveFixture, type Fixture } from './helpers/fixtures';
import { compareWithSdk } from './helpers/compare';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';

const LIVE = process.env.LIVE === '1';
const RPC = process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC;

async function recentMints(conn: Connection, program: PublicKey, limit = 25): Promise<PublicKey[]> {
  const sigs = await conn.getSignaturesForAddress(program, { limit }, 'confirmed');
  const mints = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    let tx: VersionedTransactionResponse | ParsedTransactionWithMeta | null = null;
    try {
      tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    } catch {
      continue; // public RPC rate limits; try the next one
    }
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint !== NATIVE_MINT.toBase58()) mints.add(b.mint);
    }
    if (mints.size >= 12) break;
  }
  return [...mints].map((m) => new PublicKey(m));
}

const findCurveToken = (cashback: boolean) => async (conn: Connection): Promise<PublicKey> => {
  // Cashback coins can no longer be created, so recent trades may not include one.
  const pinned = cashback ? process.env.LIVE_CASHBACK_MINT : process.env.LIVE_CURVE_MINT;
  const candidates = pinned ? [new PublicKey(pinned)] : await recentMints(conn, PUMP_PROGRAM_ID, 60);
  for (const mint of candidates) {
    const info = await conn.getAccountInfo(bondingCurvePda(mint));
    if (!info) continue;
    const c = PUMP_SDK.decodeBondingCurveNullable(info);
    if (c && !c.complete && isLegacyQuoteMint(c.quoteMint) && c.isCashbackCoin === cashback) return mint;
  }
  throw new Error(`no live SOL-quoted ${cashback ? 'cashback ' : ''}curve found`);
};

async function findPoolToken(conn: Connection): Promise<PublicKey> {
  for (const mint of await recentMints(conn, PUMP_AMM_PROGRAM_ID)) {
    const pool = canonicalPumpPoolPda(mint);
    const info = await conn.getAccountInfo(pool);
    if (!info) continue;
    const p = PUMP_AMM_SDK.decodePoolNullable(info);
    if (p && p.quoteMint.equals(NATIVE_MINT)) return mint;
  }
  throw new Error('no live canonical WSOL pool found');
}

describe.skipIf(!LIVE)('live mainnet', () => {
  const conn = new Connection(RPC, 'confirmed');

  for (const [name, find, addressOf] of [
    ['curve', findCurveToken(false), (m: PublicKey) => bondingCurvePda(m)],
    ['curve-cashback', findCurveToken(true), (m: PublicKey) => bondingCurvePda(m)],
    ['pumpswap', findPoolToken, (m: PublicKey) => canonicalPumpPoolPda(m)],
  ] as const) {
    it(`${name}: quotes match the SDK and builds pass the guard`, async () => {
      const mint = await find(conn);
      const address = addressOf(mint); // what Axiom-style pair URLs show
      const fx: Fixture = { name, slot: await conn.getSlot(), address: address.toBase58(), accounts: {}, tokenAccountsByOwner: {} };
      const rec = recording(conn, fx);
      __resetCurveProtocolCache(); // so the fixture holds every account a cold start reads

      // Record both our path and the SDK's path, then compare both on the same
      // snapshot (live reserves move between fetches on active tokens).
      await compareWithSdk(rec, fx, { record: true });
      saveFixture(`tests/fixtures/${name}.json`, fx);
      __resetCurveProtocolCache();
      const r = await compareWithSdk(replay(fx), fx);
      console.log(`[live] ${name} mint=${mint.toBase58()} venue=${r.venue} spot=${r.spot.toExponential(3)} lamports/token`);
      expect(r.venue).toBe(name.startsWith('curve') ? 'PUMP_CURVE' : 'PUMPSWAP');
    }, 120_000);
  }
});
