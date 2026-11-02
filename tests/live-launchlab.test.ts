// Raydium LaunchLab on mainnet, skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] [LIVE_LAUNCHLAB_POOL=...] npx vitest run tests/live-launchlab.test.ts
// Opens a live SOL-quoted LaunchLab pool from its pool address (what Axiom
// shows), records fixtures for tests/venues.test.ts, then simulates a buy, a
// 50% sell and a full sell + close exactly as the extension builds them
// (guard included). Each simulation's TradeEvent carries the curve state the
// program priced against; our quote on that same state must match the
// program's amount_out to the unit. Nothing is signed or sent.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import BN from 'bn.js';
import { Connection, PublicKey, SystemProgram, type AccountInfo, type PartiallyDecodedInstruction } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { GLOBAL_PDA, PUMP_SDK } from '@pump-fun/pump-sdk';
import { PUBLIC_MAINNET_RPC } from '../src/constants';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { LAUNCHLAB_PROGRAM_ID, decodePool } from '../src/venues/launchLab';
import { planTrade } from '../src/solana/trade';
import { buildTrade, interpretSimulation } from '../src/solana/execute';
import { tokenAmount } from '../src/solana/tokens';
import { recording, saveFixture, type Fixture } from './helpers/fixtures';
import type { Market } from '../src/venues/types';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
const pace = () => new Promise((r) => setTimeout(r, 150));
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const TRADE_EVENT = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);

/** Pools touched by recent LaunchLab transactions, decoded, newest first. */
async function recentPools(limit = 60): Promise<{ address: PublicKey; info: AccountInfo<Buffer> }[]> {
  const sigs = await conn.getSignaturesForAddress(LAUNCHLAB_PROGRAM_ID, { limit }, 'confirmed');
  const seen = new Map<string, AccountInfo<Buffer>>();
  for (const s of sigs) {
    if (s.err) continue;
    await pace();
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    const keys = tx?.transaction.message.staticAccountKeys ?? [];
    const fresh = keys.filter((k) => !seen.has(k.toBase58())).slice(0, 100);
    if (!fresh.length) continue;
    const infos = await conn.getMultipleAccountsInfo(fresh, 'confirmed');
    fresh.forEach((k, i) => {
      const info = infos[i];
      if (info?.owner.equals(LAUNCHLAB_PROGRAM_ID) && decodePool(info)) seen.set(k.toBase58(), info);
    });
    if (seen.size >= 8) break;
  }
  return [...seen].map(([k, info]) => ({ address: new PublicKey(k), info }));
}

async function liveSolPool(): Promise<PublicKey> {
  if (process.env.LIVE_LAUNCHLAB_POOL) return new PublicKey(process.env.LIVE_LAUNCHLAB_POOL);
  for (const { address, info } of await recentPools()) {
    const p = decodePool(info)!;
    if (p.status === 0 && p.quoteMint.equals(NATIVE_MINT) && p.realB.gtn(5e8)) return address;
  }
  throw new Error('no live SOL-quoted LaunchLab pool with > 0.5 SOL found');
}

async function fundedWallet(): Promise<PublicKey> {
  const g = PUMP_SDK.decodeGlobal((await conn.getAccountInfo(GLOBAL_PDA))!);
  for (const k of [g.feeRecipient, ...g.feeRecipients]) {
    const info = await conn.getAccountInfo(k);
    if (info?.owner.equals(SystemProgram.programId) && info.lamports > 2e9) return k;
  }
  throw new Error('no funded system wallet found');
}

/** The smallest real holder among recent traders of the pool. */
async function holder(m: Market): Promise<PublicKey> {
  const sigs = await conn.getSignaturesForAddress(m.address, { limit: 60 }, 'confirmed');
  const owners = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    await pace();
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint === m.mint.mint.toBase58() && b.owner && Number(b.uiTokenAmount.amount) > 0) owners.add(b.owner);
    }
    if (owners.size >= 12) break;
  }
  let best: { owner: PublicKey; amount: bigint } | null = null;
  for (const o of owners) {
    const owner = new PublicKey(o);
    const ata = getAssociatedTokenAddressSync(m.mint.mint, owner, true, m.mint.tokenProgram);
    const [wallet, ta] = await conn.getMultipleAccountsInfo([owner, ata]);
    const amount = BigInt(tokenAmount(ta).toString());
    if (wallet?.owner.equals(SystemProgram.programId) && wallet.lamports > 5_000_000 && amount > 0n && (!best || amount < best.amount)) best = { owner, amount };
  }
  if (!best) throw new Error('no suitable holder among recent traders');
  return best.owner;
}

interface TradeEvent {
  virtualBase: BN;
  virtualQuote: BN;
  realBaseBefore: BN;
  realQuoteBefore: BN;
  amountIn: BN;
  amountOut: BN;
}

function tradeEvent(ixs: PartiallyDecodedInstruction[]): TradeEvent {
  for (const ix of ixs) {
    if (!ix.programId.equals(LAUNCHLAB_PROGRAM_ID)) continue;
    const d = Buffer.from(bs58.decode(ix.data));
    if (!d.subarray(0, 8).equals(EVENT_IX_TAG) || !d.subarray(8, 16).equals(TRADE_EVENT)) continue;
    const u = (o: number) => new BN(d.subarray(16 + o, 24 + o), 'le');
    // pool_state(32) total_base_sell virtual_base virtual_quote real_base_before real_quote_before real_base_after real_quote_after amount_in amount_out
    return { virtualBase: u(40), virtualQuote: u(48), realBaseBefore: u(56), realQuoteBefore: u(64), amountIn: u(88), amountOut: u(96) };
  }
  throw new Error('no TradeEvent in the simulation');
}

/** Our quote on the exact curve state the program priced against. */
async function quoteOnEventState(market: Market, ev: TradeEvent, side: 'buy' | 'sell', amountIn: BN) {
  const info = (await conn.getAccountInfo(market.address, 'confirmed'))!;
  const data = Buffer.from(info.data);
  data.set(ev.virtualBase.toArrayLike(Buffer, 'le', 8), 37);
  data.set(ev.virtualQuote.toArrayLike(Buffer, 'le', 8), 45);
  data.set(ev.realBaseBefore.toArrayLike(Buffer, 'le', 8), 53);
  data.set(ev.realQuoteBefore.toArrayLike(Buffer, 'le', 8), 61);
  market.apply(market.address, { ...info, data });
  return side === 'buy' ? market.quoteBuy(amountIn, 15) : market.quoteSell(amountIn, 15);
}

async function run(market: Market, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell = false) {
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const userAta = getAssociatedTokenAddressSync(market.mint.mint, user, true, market.mint.tokenProgram);
  const [ataInfo, wallet] = await conn.getMultipleAccountsInfo([userAta, user]);
  const plan = planTrade(market, { side, amount, presetIndex: null }, settings, profile, tokenAmount(ataInfo));
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const built = await buildTrade({
    market,
    plan,
    user,
    userAta,
    userAtaInfo: ataInfo ?? null,
    tier: 'eco',
    tipSol: null,
    profile,
    settings,
    blockhash,
    cuLimit: () => 1_400_000,
    cuPrice: 1_000,
    closeAfterFullSell,
  });
  const res = await conn.simulateTransaction(built.tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'processed',
    innerInstructions: true,
    accounts: { encoding: 'base64', addresses: [user.toBase58(), userAta.toBase58()] },
  });
  const sim = interpretSimulation(res.value, { preLamports: wallet?.lamports ?? null, preTokens: tokenAmount(ataInfo) });
  const row = { side, amount, ok: sim.ok, units: sim.unitsConsumed, tokenDelta: sim.tokenDelta?.toString(), solDelta: sim.solDelta, error: sim.error, logs: sim.ok ? undefined : sim.logs.slice(-10) };
  expect(sim.error, JSON.stringify(row)).toBeNull();

  const inner = (res.value.innerInstructions ?? []).flatMap((g) => g.instructions as PartiallyDecodedInstruction[]);
  const ev = tradeEvent(inner);
  const q = await quoteOnEventState(market, ev, side, plan.quote.inAmount);
  console.log(`[launchlab] ${side} ${amount}: units=${sim.unitsConsumed} in=${ev.amountIn} out=${ev.amountOut} ours=${q.out} live-quote=${plan.quote.out} tokenDelta=${sim.tokenDelta} solDelta=${sim.solDelta}`);
  expect(ev.amountIn.toString()).toBe(plan.quote.inAmount.toString());
  expect(q.out.toString()).toBe(ev.amountOut.toString());
  if (side === 'buy') expect(sim.tokenDelta!.toString()).toBe(ev.amountOut.toString());
  else expect(sim.tokenDelta!.neg().toString()).toBe(ev.amountIn.toString());
  return sim;
}

describe.skipIf(!LIVE)('LaunchLab on mainnet (simulated)', () => {
  it('records fixtures, and quotes match the program to the unit for buy, 50% sell and full sell + close', async () => {
    const poolAddr = await liveSolPool();
    const fx: Fixture = { name: 'launchlab', slot: await conn.getSlot(), address: poolAddr.toBase58(), accounts: {}, tokenAccountsByOwner: {} };
    const rec = recording(conn, fx);
    const viaPool = await resolveAddress(rec, poolAddr);
    await openMarket(rec, viaPool.mint, viaPool.hint);
    await openMarket(rec, (await resolveAddress(rec, viaPool.mint.mint)).mint);
    saveFixture('tests/fixtures/launchlab.json', fx);

    const market = await openMarket(conn, viaPool.mint, viaPool.hint);
    expect(market.venue).toBe('LAUNCHLAB');
    console.log(`[launchlab] pool=${poolAddr.toBase58()} mint=${market.mint.mint.toBase58()} spot=${market.spotLamportsPerToken().toExponential(3)} lamports/token`);
    await run(market, await fundedWallet(), 'buy', 0.01);
    const seller = await holder(market);
    await run(market, seller, 'sell', 50);
    await run(market, seller, 'sell', 100, true);
  }, 300_000);

});
