// Meteora on mainnet, skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] npx vitest run tests/live-meteora.test.ts
// Markets (override with env):
//   - a Dynamic Bonding Curve priced in SOL (direct swap2) and one priced in
//     USDC (routed SOL -> USDC -> curve through Jupiter);
//   - DAMM v2 pools: a graduated bonding-curve coin (coin is token A, fees
//     on both tokens), a coin that is token B in a pool collecting only B
//     (a buy pays its fee from the SOL going in), and a compounding pool
//     priced in USDC with a fee schedule and a volatility fee (routed).
// Records tests/fixtures/meteora-*.json, then simulates a buy, a 50% sell
// and a full sell + close exactly as the extension builds them. The pool's
// own swap event must report the output we quote, and what lands in the
// wallet must equal the quote. Nothing is signed or sent.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { Connection, PublicKey, SystemProgram, type PartiallyDecodedInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { GLOBAL_PDA, PUMP_SDK } from '@pump-fun/pump-sdk';
import { PUBLIC_MAINNET_RPC } from '../src/constants';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { JUPITER_PROGRAM_ID } from '../src/venues/jupiter';
import { DBC_PROGRAM_ID } from '../src/venues/meteoraDbc';
import { DAMM_V2_PROGRAM_ID } from '../src/venues/meteoraDammV2';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import type { Market } from '../src/venues/types';
import { planTrade } from '../src/solana/trade';
import { buildTrade, interpretSimulation } from '../src/solana/execute';
import { tokenAmount } from '../src/solana/tokens';
import { recording, saveFixture, toRaw, type Fixture } from './helpers/fixtures';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
const env = (k: string, d: string) => new PublicKey(process.env[k] ?? d);
const DBC_SOL = env('LIVE_DBC_SOL_POOL', '5qt41MaZqHVvWf1wGRQwLCXmwLLhUWNUPJHc5xniwFtN');
// A large system wallet, as the payer of a simulated buy that takes a whole curve (nothing is signed).
const WHALE = env('LIVE_WHALE', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const DBC_USDC = env('LIVE_DBC_USDC_POOL', '9NsniwE5p8V1TL85jVqkKR3D4Lb9shdTbnqqTvyj7PmC');
const DAMM_GRADUATED = env('LIVE_DAMM_GRADUATED_POOL', 'ECMkEE8nmP8C88BxpNYnMJPxcUkGqRsuoudM2pX587BB');
// The bonding curve that coin graduated from.
const DAMM_GRADUATED_CURVE = env('LIVE_DAMM_GRADUATED_CURVE', 'CyUwSGW7z5hTJY9VWppkSGgFYwNyQ19nQKRTh4UG7XbY');
// SOL is token A and the pool collects fees only in B. (The first pick, Dd1oUepp…, was emptied by 2026-11-08.)
const DAMM_ONLY_B = env('LIVE_DAMM_ONLY_B_POOL', '4Ef2C5DHeHX9ncm1A5Mz9FJpA5U9o9AmFSrXQbzm8JDe');
const DAMM_COMPOUNDING_USDC = env('LIVE_DAMM_COMPOUNDING_USDC_POOL', 'DMGDrxyKEq93gcwJHRaGRnN9rJa8ykAz9j13i1KSmajN');

const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const EVT_SWAP2 = Buffer.from([189, 66, 51, 168, 38, 80, 117, 153]);
const JUP_SWAP_EVENT = Buffer.from([64, 198, 205, 232, 38, 8, 113, 226]);
const JUP_SWAPS = Buffer.from([152, 47, 78, 235, 192, 96, 110, 106]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries public-RPC rate limits (429) with back-off. */
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 6 || !/429|Too Many|fetch failed|ECONNRESET/i.test(String(e))) throw e;
      await sleep(500 * 2 ** i);
    }
  }
}

const innerOf = (v: { innerInstructions?: { instructions: unknown[] }[] | null }) =>
  (v.innerInstructions ?? []).flatMap((g) => g.instructions as PartiallyDecodedInstruction[]);

const eventsOf = (inner: PartiallyDecodedInstruction[], program: PublicKey) =>
  inner.flatMap((ix) => {
    if (!ix.programId.equals(program) || typeof ix.data !== 'string') return [];
    const d = Buffer.from(bs58.decode(ix.data));
    return d.subarray(0, 8).equals(EVENT_IX_TAG) ? [{ disc: d.subarray(8, 16), body: d.subarray(16) }] : [];
  });

/** The pool's own EvtSwap2: swap_result.output_amount (what leaves the pool, before any transfer fee). */
function poolOut(inner: PartiallyDecodedInstruction[], program: PublicKey, pool: PublicKey): bigint | null {
  for (const e of eventsOf(inner, program)) {
    if (!e.disc.equals(EVT_SWAP2) || !e.body.subarray(0, 32).equals(pool.toBuffer())) continue;
    // DBC: pool, config, direction, referral, params (17) -> result at 83. DAMM v2: pool, direction, fee mode, referral, params -> 52.
    return e.body.readBigUInt64LE(program.equals(DBC_PROGRAM_ID) ? 83 + 24 : 52 + 24);
  }
  return null;
}

/** The output of a Jupiter route's last leg, from Jupiter's events. */
function routeOut(inner: PartiallyDecodedInstruction[]): bigint | null {
  let out: bigint | null = null;
  for (const e of eventsOf(inner, JUPITER_PROGRAM_ID)) {
    if (e.disc.equals(JUP_SWAP_EVENT)) out = e.body.readBigUInt64LE(104);
    else if (e.disc.equals(JUP_SWAPS)) out = e.body.readBigUInt64LE(4 + (e.body.readUInt32LE(0) - 1) * 112 + 72);
  }
  return out;
}

async function fundedWallet(): Promise<PublicKey> {
  const g = PUMP_SDK.decodeGlobal((await retry(() => conn.getAccountInfo(GLOBAL_PDA)))!);
  for (const k of [g.feeRecipient, ...g.feeRecipients]) {
    const info = await retry(() => conn.getAccountInfo(k));
    if (info?.owner.equals(SystemProgram.programId) && info.lamports > 2e9) return k;
  }
  throw new Error('no funded system wallet found');
}

/** An ordinary wallet still holding the coin, among the pool's recent traders (median holding). */
async function holder(m: Market, pinned: string | undefined): Promise<PublicKey> {
  if (pinned) return new PublicKey(pinned);
  const sigs = await retry(() => conn.getSignaturesForAddress(m.address, { limit: 100 }, 'confirmed'));
  const owners = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    await sleep(250);
    const tx = await retry(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' })).catch(() => null);
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint === m.mint.mint.toBase58() && b.owner && Number(b.uiTokenAmount.amount) > 0) owners.add(b.owner);
    }
    if (owners.size >= 12) break;
  }
  const found: { owner: PublicKey; amount: bigint }[] = [];
  for (const o of owners) {
    const owner = new PublicKey(o);
    const ata = getAssociatedTokenAddressSync(m.mint.mint, owner, true, m.mint.tokenProgram);
    const [wallet, ta] = await retry(() => conn.getMultipleAccountsInfo([owner, ata]));
    const amount = BigInt(tokenAmount(ta).toString());
    if (wallet?.owner.equals(SystemProgram.programId) && wallet.lamports > 5_000_000 && amount > 0n) found.push({ owner, amount });
  }
  found.sort((a, b) => (a.amount < b.amount ? -1 : 1));
  const pick = found[Math.floor(found.length / 2)];
  if (!pick) throw new Error(`no suitable holder among ${owners.size} recent traders`);
  return pick.owner;
}

async function attempt(pool: PublicKey, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell: boolean) {
  const r = await retry(() => resolveAddress(conn, pool));
  const market = await retry(() => openMarket(conn, r.mint, r.hint));
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const userAta = getAssociatedTokenAddressSync(market.mint.mint, user, true, market.mint.tokenProgram);
  const [ataInfo, wallet] = await retry(() => conn.getMultipleAccountsInfo([userAta, user]));
  const { blockhash } = await retry(() => conn.getLatestBlockhash('confirmed'));
  // Busy pools trade every slot: refresh at the newest state right before quoting, and simulate at that commitment.
  const keys = market.watchAccounts();
  const fresh = await retry(() => conn.getMultipleAccountsInfo(keys, 'processed'));
  keys.forEach((k, i) => fresh[i] && market.apply(k, fresh[i]!));
  const plan = planTrade(market, { side, amount, presetIndex: null }, settings, profile, tokenAmount(ataInfo));
  const built = await buildTrade({
    market, plan, user, userAta, userAtaInfo: ataInfo ?? null, tier: 'eco', tipSol: null, profile, settings, blockhash,
    cuLimit: () => 1_400_000, cuPrice: 1_000, closeAfterFullSell: closeAfterFullSell && (market.canCloseTokenAccount?.() ?? true),
  });
  const res = await retry(() =>
    conn.simulateTransaction(built.tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
      innerInstructions: true,
      accounts: { encoding: 'base64', addresses: [user.toBase58(), userAta.toBase58()] },
    }),
  );
  const sim = interpretSimulation(res.value, { preLamports: wallet?.lamports ?? null, preTokens: tokenAmount(ataInfo) });
  const inner = innerOf(res.value);
  const program = market.venue.startsWith('METEORA_DBC') ? DBC_PROGRAM_ID : DAMM_V2_PROGRAM_ID;
  const quotedState = Object.fromEntries(keys.flatMap((k, i) => (fresh[i] ? [[k.toBase58(), toRaw(fresh[i]!)]] : [])));
  return { market, plan, built, sim, quotedState, poolOut: sim.ok ? poolOut(inner, program, market.address) : null, routeOut: sim.ok ? routeOut(inner) : null };
}

async function run(fx: Fixture, pool: PublicKey, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell = false) {
  for (let i = 1; ; i++) {
    const a = await attempt(pool, user, side, amount, closeAfterFullSell);
    const { plan, sim, market } = a;
    expect(sim.error, JSON.stringify({ side, amount, error: sim.error, logs: sim.logs.slice(-14) })).toBeNull();
    const routed = market.venue.endsWith('_ROUTED');
    expect(a.poolOut, 'the pool emitted no swap event').not.toBeNull();
    // What landed: the coin for a buy; for a sell, the pool's SOL (direct) or the route's (routed).
    const received = side === 'buy' ? BigInt(sim.tokenDelta!.toString()) : routed ? a.routeOut! : a.poolOut!;
    expect(received >= BigInt(plan.quote.minOut.toString())).toBe(true);
    const exact = received === BigInt(plan.quote.out.toString());
    console.log(
      `[meteora] ${market.venue} ${market.address.toBase58().slice(0, 6)} ${side} ${amount} try ${i}: ${a.built.tx.serialize().length} bytes, units=${sim.unitsConsumed} ` +
        `pool out=${a.poolOut} quote=${plan.quote.out} min=${plan.quote.minOut} received=${received} exact=${exact} cuKey=${a.built.cuKey}`,
    );
    if (exact || i === 4) {
      expect(exact, 'quote never matched what landed exactly (the pool kept moving)').toBe(true);
      // The state it was quoted on and what landed, for the offline tests.
      (fx.checks ??= []).push({ side, amountIn: plan.quote.inAmount.toString(), out: received.toString(), accounts: a.quotedState });
      saveFixture(`tests/fixtures/${fx.name}.json`, fx);
      return a;
    }
    await sleep(1_000);
  }
}

/** Opens the market the way a page showing the pool does, recording every account read for the offline tests. */
async function record(name: string, pool: PublicKey): Promise<{ m: Market; fx: Fixture }> {
  const fx: Fixture = { name, slot: await retry(() => conn.getSlot()), address: pool.toBase58(), accounts: {}, tokenAccountsByOwner: {} };
  const rec = recording(conn, fx);
  __resetCurveProtocolCache(); // so the fixture holds every account a cold start reads
  const r = await retry(() => resolveAddress(rec, pool));
  const m = await retry(() => openMarket(rec, r.mint, r.hint));
  saveFixture(`tests/fixtures/${name}.json`, fx);
  console.log(`[meteora] ${name}: pool=${pool.toBase58()} mint=${m.mint.mint.toBase58()} venue=${m.venue}`);
  return { m, fx };
}

async function buySell(name: string, pool: PublicKey, venue: Market['venue'], holderEnv: string) {
  const { m, fx } = await record(name, pool);
  expect(m.venue).toBe(venue);
  await run(fx, pool, await fundedWallet(), 'buy', 0.01);
  const seller = await holder(m, process.env[holderEnv]);
  await run(fx, pool, seller, 'sell', 50);
  await run(fx, pool, seller, 'sell', 100, true);
  return { m, fx };
}

describe.skipIf(!LIVE)('Meteora Dynamic Bonding Curve on mainnet (simulated)', () => {
  it('SOL-paired (direct): opens from the mint too, and buys and sells as quoted', async () => {
    const { m, fx } = await buySell('meteora-dbc-sol', DBC_SOL, 'METEORA_DBC', 'LIVE_DBC_SOL_HOLDER');
    const fromMint = await retry(async () => openMarket(conn, (await resolveAddress(conn, m.mint.mint)).mint));
    expect(fromMint.address.equals(m.address)).toBe(true);
    // The last buy: more SOL than the curve has left fills it to the end (a partial fill) and completes it.
    const last = await run(fx, DBC_SOL, WHALE, 'buy', 500);
    const keys = last.built.tx.message.staticAccountKeys;
    const swap = last.built.tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex]!.equals(DBC_PROGRAM_ID))!;
    expect(swap.data[24]).toBe(1); // SwapMode::PartialFill
  }, 900_000);

  it('USDC-paired (routed through Jupiter): buys and sells as quoted', async () => {
    await buySell('meteora-dbc-usdc', DBC_USDC, 'METEORA_DBC_ROUTED', 'LIVE_DBC_USDC_HOLDER');
  }, 900_000);
});

describe.skipIf(!LIVE)('Meteora DAMM v2 on mainnet (simulated)', () => {
  it('a graduated curve coin: its mint and its old curve open the DAMM v2 pool, which buys and sells as quoted', async () => {
    const { m } = await buySell('meteora-damm-graduated', DAMM_GRADUATED, 'METEORA_DAMM_V2', 'LIVE_DAMM_GRADUATED_HOLDER');
    const fromMint = await retry(async () => openMarket(conn, (await resolveAddress(conn, m.mint.mint)).mint));
    expect(fromMint.venue).toBe('METEORA_DAMM_V2');
    expect(fromMint.address.equals(m.address)).toBe(true);
    // A page still showing the old curve opens the pool it graduated to.
    const viaCurve = await retry(() => resolveAddress(conn, DAMM_GRADUATED_CURVE));
    expect(viaCurve.hint?.venue).toBe('METEORA_DBC');
    const fromCurve = await retry(() => openMarket(conn, viaCurve.mint, viaCurve.hint));
    expect(fromCurve.address.equals(m.address)).toBe(true);
  }, 900_000);

  it('coin as token B, fees only in B (taken from the SOL going in on a buy)', async () => {
    await buySell('meteora-damm-only-b', DAMM_ONLY_B, 'METEORA_DAMM_V2', 'LIVE_DAMM_ONLY_B_HOLDER');
  }, 900_000);

  it('compounding pool priced in USDC, with a fee schedule and a volatility fee (routed)', async () => {
    await buySell('meteora-damm-compounding-usdc', DAMM_COMPOUNDING_USDC, 'METEORA_DAMM_V2_ROUTED', 'LIVE_DAMM_COMPOUNDING_USDC_HOLDER');
  }, 900_000);
});
