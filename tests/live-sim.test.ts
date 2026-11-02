// Phase 4 acceptance on mainnet, skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] [LIVE_CASHBACK_MINT=...] npx vitest run tests/live-sim.test.ts
// Builds the exact transactions the extension would send (compute budget,
// venue instructions, optional account close, Sender tip), runs them through
// the guard, and simulates them against live state. No key is needed:
// simulation runs with sigVerify off, as a funded wallet (buys) or a real
// holder of the token (sells). Nothing is signed or sent.
import '../src/polyfills';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { GLOBAL_PDA, PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda, isLegacyQuoteMint } from '@pump-fun/pump-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { PUBLIC_MAINNET_RPC } from '../src/constants';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { planTrade } from '../src/solana/trade';
import { buildTrade, simulate } from '../src/solana/execute';
import { tokenAmount } from '../src/solana/tokens';
import { loadFixture } from './helpers/fixtures';
import type { Market } from '../src/venues/types';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
const results: Record<string, unknown>[] = [];
const OUT = join(tmpdir(), 'quickdraw-live-sim.json');
/** The public RPC rate-limits bursts of getTransaction; pace them. */
const pace = () => new Promise((r) => setTimeout(r, 150));

async function mintOf(fixture: string): Promise<PublicKey> {
  const fx = loadFixture(`tests/fixtures/${fixture}.json`);
  return (await resolveAddress(conn, new PublicKey(fx.address))).mint.mint;
}

/** A live, ordinary (not mayhem, not cashback) SOL curve from recent pump.fun trades. */
async function liveCurveMint(): Promise<PublicKey> {
  if (process.env.LIVE_CURVE_MINT) return new PublicKey(process.env.LIVE_CURVE_MINT);
  const sigs = await conn.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit: 80 }, 'confirmed');
  for (const s of sigs) {
    if (s.err) continue;
    await pace();
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint === NATIVE_MINT.toBase58()) continue;
      const mint = new PublicKey(b.mint);
      const info = await conn.getAccountInfo(bondingCurvePda(mint));
      const c = info && PUMP_SDK.decodeBondingCurveNullable(info);
      if (c && !c.complete && !c.isMayhemMode && !c.isCashbackCoin && isLegacyQuoteMint(c.quoteMint) && c.realQuoteReserves.gtn(3e8)) return mint;
    }
  }
  throw new Error('no live ordinary curve with > 0.3 SOL found');
}

/** A wallet with plenty of SOL to act as the buyer: pump's fee recipient. */
async function fundedWallet(): Promise<PublicKey> {
  const g = PUMP_SDK.decodeGlobal((await conn.getAccountInfo(GLOBAL_PDA))!);
  for (const k of [g.feeRecipient, ...g.feeRecipients]) {
    const info = await conn.getAccountInfo(k);
    if (info?.owner.equals(SystemProgram.programId) && info.lamports > 2e9) return k;
  }
  throw new Error('no funded system wallet found');
}

/**
 * A real holder of `m` (tokens in their ATA, SOL for fees), found among recent
 * traders of the token. The public RPC rate-limits getTokenLargestAccounts.
 */
async function holder(m: Market): Promise<PublicKey> {
  const sigs = await conn.getSignaturesForAddress(m.address, { limit: 80 }, 'confirmed');
  const owners = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    await pace();
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint === m.mint.mint.toBase58() && b.owner && Number(b.uiTokenAmount.amount) > 0) owners.add(b.owner);
    }
    if (owners.size >= 15) break;
  }
  // Prefer the smallest position: a whale's sell can exceed what a curve holds.
  let best: { owner: PublicKey; amount: bigint } | null = null;
  for (const o of owners) {
    const owner = new PublicKey(o);
    const ata = getAssociatedTokenAddressSync(m.mint.mint, owner, true, m.mint.tokenProgram);
    const [wallet, ta] = await conn.getMultipleAccountsInfo([owner, ata]);
    const amount = BigInt(tokenAmount(ta).toString());
    if (wallet?.owner.equals(SystemProgram.programId) && wallet.lamports > 5_000_000 && amount > 0n && (!best || amount < best.amount)) {
      best = { owner, amount };
    }
  }
  if (!best) throw new Error('no suitable holder found among recent traders');
  return best.owner;
}

async function run(name: string, market: Market, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell = false) {
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
    cuLimit: () => 1_400_000, // measure real consumption
    cuPrice: 1_000,
    closeAfterFullSell,
  });
  const sim = await simulate(conn, built.tx, { user, userAta, preLamports: wallet?.lamports ?? null, preTokens: tokenAmount(ataInfo) }, { sigVerify: false, replaceRecentBlockhash: true });
  const row = {
    name,
    venue: market.venue,
    mint: market.mint.mint.toBase58(),
    side,
    amount,
    cuKey: built.cuKey,
    ok: sim.ok,
    unitsConsumed: sim.unitsConsumed,
    tokenDelta: sim.tokenDelta?.toString() ?? null,
    expectedOut: plan.quote.out.toString(),
    solDelta: sim.solDelta,
    error: sim.error,
    logsTail: sim.ok ? undefined : sim.logs.slice(-8),
  };
  results.push(row);
  writeFileSync(OUT, JSON.stringify(results, null, 1));
  expect(sim.error, JSON.stringify(row)).toBeNull();
  expect(sim.ok).toBe(true);
  if (side === 'buy') expect(sim.tokenDelta!.gtn(0)).toBe(true);
  else expect(sim.solDelta!).toBeGreaterThan(0);
  return sim;
}

describe.skipIf(!LIVE)('live mainnet simulation (dry run)', () => {
  const cases: [string, () => Promise<PublicKey>][] = [
    ['curve-v3', liveCurveMint],
    ['curve-cashback', async () => (process.env.LIVE_CASHBACK_MINT ? new PublicKey(process.env.LIVE_CASHBACK_MINT) : mintOf('curve-cashback'))],
    ['pumpswap', () => mintOf('pumpswap')],
  ];
  for (const [name, mint] of cases) {
    it(`${name}: buy, partial sell and full sell + close simulate cleanly`, async () => {
      const m = await mint();
      const market = await openMarket(conn, (await resolveAddress(conn, m)).mint);
      await run(name, market, await fundedWallet(), 'buy', 0.01);
      const seller = await holder(market);
      await run(name, market, seller, 'sell', 50);
      await run(name, market, seller, 'sell', 100, true);
    }, 180_000);
  }
});
