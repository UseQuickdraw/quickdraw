// Raydium AMM v4 on mainnet, skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] [LIVE_AMMV4_POOL=...] [LIVE_AMMV4_HOLDER=...] npx vitest run tests/live-ammv4.test.ts
// Pool: FRIC/SOL, a pump.fun coin that graduated to AMM v4 (the coin on the pool's
// "pc" side). Records tests/fixtures/ammv4.json, then simulates a buy, a 50% sell
// and a full sell + close exactly as the extension builds them. From the pool's
// ray_log (the reserves it priced against) our maths must give its exact output,
// and what lands in the wallet must equal the quote. Nothing is signed or sent.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { GLOBAL_PDA, PUMP_SDK } from '@pump-fun/pump-sdk';
import { PUBLIC_MAINNET_RPC } from '../src/constants';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import type { AmmMarket } from '../src/venues/raydiumAmm';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { planTrade } from '../src/solana/trade';
import { buildTrade, interpretSimulation } from '../src/solana/execute';
import { tokenAmount } from '../src/solana/tokens';
import { recording, saveFixture, type Fixture } from './helpers/fixtures';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
const POOL = new PublicKey(process.env.LIVE_AMMV4_POOL ?? '9iL89qfbTMWygtawzGikL2j6ASbRYX7XSM5ePUcoQ5fk');

/**
 * A funded wallet with no WSOL account, like a burner's: the trade then creates
 * (and closes) it, which is the costliest case for the compute limit. The pump.fun
 * fee recipients all keep one, so the AMM's own owner wallet comes first.
 */
async function fundedWallet(): Promise<PublicKey> {
  const g = PUMP_SDK.decodeGlobal((await conn.getAccountInfo(GLOBAL_PDA))!);
  const candidates = [new PublicKey('GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'), g.feeRecipient, ...g.feeRecipients];
  let fallback: PublicKey | null = null;
  for (const k of candidates) {
    const [info, wsol] = await conn.getMultipleAccountsInfo([k, getAssociatedTokenAddressSync(NATIVE_MINT, k, true)]);
    if (!info?.owner.equals(SystemProgram.programId) || info.lamports < 2e9) continue;
    if (!wsol) return k;
    fallback ??= k;
  }
  if (fallback) return fallback;
  throw new Error('no funded system wallet found');
}

async function holder(m: AmmMarket): Promise<PublicKey> {
  if (process.env.LIVE_AMMV4_HOLDER) return new PublicKey(process.env.LIVE_AMMV4_HOLDER);
  const sigs = await conn.getSignaturesForAddress(m.address, { limit: 60 }, 'confirmed');
  const owners = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    let tx = null;
    for (let i = 0; i < 4 && !tx; i++) {
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
      tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    }
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint === m.mint.mint.toBase58() && b.owner && Number(b.uiTokenAmount.amount) > 0) owners.add(b.owner);
    }
    if (owners.size >= 8) break;
  }
  const found: { owner: PublicKey; amount: bigint }[] = [];
  for (const o of owners) {
    const owner = new PublicKey(o);
    const ata = getAssociatedTokenAddressSync(m.mint.mint, owner, true, m.mint.tokenProgram);
    const [wallet, ta] = await conn.getMultipleAccountsInfo([owner, ata]);
    const amount = BigInt(tokenAmount(ta).toString());
    if (wallet?.owner.equals(SystemProgram.programId) && wallet.lamports > 5_000_000 && amount > 0n) found.push({ owner, amount });
  }
  found.sort((a, b) => (a.amount < b.amount ? -1 : 1));
  const pick = found[Math.floor(found.length / 2)];
  if (!pick) throw new Error('no suitable holder among recent traders');
  return pick.owner;
}

interface RaySwap {
  amountIn: bigint;
  direction: bigint;
  poolCoin: bigint;
  poolPc: bigint;
  out: bigint;
}

/** The pool's SwapBaseInLog (log_type 3): amount_in, minimum_out, direction, user_source, pool_coin, pool_pc, out_amount. */
function raySwap(logs: string[]): RaySwap | null {
  for (const line of logs) {
    const at = line.indexOf('ray_log: ');
    if (at < 0) continue;
    const d = Buffer.from(line.slice(at + 9), 'base64');
    if (d[0] !== 3 || d.length < 57) continue;
    return { amountIn: d.readBigUInt64LE(1), direction: d.readBigUInt64LE(17), poolCoin: d.readBigUInt64LE(33), poolPc: d.readBigUInt64LE(41), out: d.readBigUInt64LE(49) };
  }
  return null;
}

/** processor.rs swap_base_in written out independently, on the log's reserves (direction 1 = pc to coin, 2 = coin to pc). */
function poolMaths(m: AmmMarket, e: RaySwap): bigint {
  const num = BigInt(m.state.swapFeeNumerator.toString());
  const den = BigInt(m.state.swapFeeDenominator.toString());
  const net = e.amountIn - (e.amountIn * num + den - 1n) / den;
  const [rin, rout] = e.direction === 2n ? [e.poolCoin, e.poolPc] : [e.poolPc, e.poolCoin];
  return (net * rout) / (rin + net);
}

async function attempt(user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell: boolean) {
  const r = await resolveAddress(conn, POOL);
  const market = (await openMarket(conn, r.mint, r.hint)) as AmmMarket;
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const userAta = getAssociatedTokenAddressSync(market.mint.mint, user, true, market.mint.tokenProgram);
  const [ataInfo, wallet] = await conn.getMultipleAccountsInfo([userAta, user]);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const keys = market.watchAccounts();
  const fresh = await conn.getMultipleAccountsInfo(keys, 'processed');
  keys.forEach((k, i) => fresh[i] && market.apply(k, fresh[i]!));
  const plan = planTrade(market, { side, amount, presetIndex: null }, settings, profile, tokenAmount(ataInfo));
  const built = await buildTrade({
    market, plan, user, userAta, userAtaInfo: ataInfo ?? null, tier: 'eco', tipSol: null, profile, settings, blockhash,
    cuLimit: () => 1_400_000, cuPrice: 1_000, closeAfterFullSell,
  });
  const res = await conn.simulateTransaction(built.tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'processed',
    accounts: { encoding: 'base64', addresses: [user.toBase58(), userAta.toBase58()] },
  });
  const sim = interpretSimulation(res.value, { preLamports: wallet?.lamports ?? null, preTokens: tokenAmount(ataInfo) });
  return { market, plan, built, sim, swap: raySwap(sim.logs) };
}

async function run(user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell = false) {
  for (let i = 1; ; i++) {
    const a = await attempt(user, side, amount, closeAfterFullSell);
    const { plan, sim, swap, market } = a;
    expect(sim.error, JSON.stringify({ side, amount, error: sim.error, logs: sim.logs.slice(-12) })).toBeNull();
    expect(swap).not.toBeNull();
    expect(poolMaths(market, swap!)).toBe(swap!.out);
    const received = side === 'buy' ? BigInt(sim.tokenDelta!.toString()) : swap!.out;
    expect(received >= BigInt(plan.quote.minOut.toString())).toBe(true);
    const exact = received === BigInt(plan.quote.out.toString());
    console.log(
      `[ammv4] ${side} ${amount} try ${i}: ${a.built.tx.serialize().length} bytes, units=${sim.unitsConsumed} ` +
        `pool ${swap!.amountIn}->${swap!.out} quote=${plan.quote.out} min=${plan.quote.minOut} received=${received} exact=${exact} cuKey=${a.built.cuKey}`,
    );
    if (exact || i === 4) {
      expect(exact, 'quote never matched what landed exactly (pool kept moving)').toBe(true);
      return a;
    }
  }
}

describe.skipIf(!LIVE)('Raydium AMM v4 on mainnet (simulated)', () => {
  it('SOL-paired: buy, 50% sell and full sell + close match the chain', async () => {
    const fx: Fixture = { name: 'ammv4', slot: await conn.getSlot(), address: POOL.toBase58(), accounts: {}, tokenAccountsByOwner: {} };
    const rec = recording(conn, fx);
    __resetCurveProtocolCache();
    const viaPool = await resolveAddress(rec, POOL);
    const m = (await openMarket(rec, viaPool.mint, viaPool.hint)) as AmmMarket;
    expect(m.venue).toBe('RAYDIUM_AMM');
    saveFixture('tests/fixtures/ammv4.json', fx);
    // Opened from the mint, the scan finds the same pool.
    const viaMint = await openMarket(conn, (await resolveAddress(conn, viaPool.mint.mint)).mint);
    expect(viaMint.address.toBase58()).toBe(POOL.toBase58());

    await run(await fundedWallet(), 'buy', 0.01);
    const seller = await holder(m);
    await run(seller, 'sell', 50);
    await run(seller, 'sell', 100, true);
  }, 600_000);
});
