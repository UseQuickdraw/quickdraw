// PumpSwap coins quoted in another token, on mainnet, skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] npx vitest run tests/live-pumproute.test.ts
// Pools (override with env):
// - MEIMEI / MeiMei, routed SOL -> MeiMei (its own SOL PumpSwap pool) -> MEIMEI;
// - MODEL3 / TSLAx, routed SOL -> TSLAx (Raydium CLMM) -> MODEL3;
// - Thesis Cat, a pump.fun curve priced in PUMP: SOL -> PUMP (Raydium CLMM) -> curve;
// - Mars / NEURALINK, a quote with a 1% transfer fee whose liquidity is against
//   USDC: SOL -> USDC (Orca) -> NEURALINK (Raydium CLMM) -> Mars.
// Records tests/fixtures/pumpswap-routed*.json, then simulates a buy, a 50%
// sell and a full sell exactly as the extension builds them. What lands must
// equal the quote, and none of the quote token may be left behind. Nothing is
// signed or sent.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import bs58 from 'bs58';
import { Connection, PublicKey, SystemProgram, type AccountInfo, type PartiallyDecodedInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { GLOBAL_PDA, PUMP_SDK } from '@pump-fun/pump-sdk';
import { GLOBAL_CONFIG_PDA, PUMP_AMM_SDK } from '@pump-fun/pump-sdk/swap';
import { PUBLIC_MAINNET_RPC } from '../src/constants';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import type { PoolMarket } from '../src/venues/pumpSwap';
import { JUPITER_PROGRAM_ID } from '../src/venues/jupiter';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { planTrade } from '../src/solana/trade';
import { buildTrade, interpretSimulation } from '../src/solana/execute';
import { tokenAmount } from '../src/solana/tokens';
import { recording, saveFixture, type Fixture } from './helpers/fixtures';

const LIVE = process.env.LIVE === '1';
/** Public RPCs drop connections now and then: retry those (not RPC errors). */
const retryingFetch: typeof fetch = async (input, init) => {
  for (let i = 0; ; i++) {
    try {
      return await fetch(input, init);
    } catch (e) {
      if (i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
};
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, { commitment: 'confirmed', fetch: retryingFetch });
interface Case {
  pool: PublicKey;
  quote: PublicKey;
  holder?: string;
  venue: 'PUMPSWAP_ROUTED' | 'PUMP_CURVE_ROUTED';
  /** Jupiter legs per trade (2 unless the SOL leg is a chain). */
  legs?: number;
  /**
   * Quote-token units a buy may leave behind: with a transfer fee, pump's
   * buy_exact_quote_in_v2 rounds its gross-up and spends a few units less
   * than it was handed.
   */
  dust?: bigint;
}
const MEIMEI: Case = {
  pool: new PublicKey(process.env.LIVE_PUMP_ROUTED_POOL ?? '47uDzMnqVP5ErxTBGSP4hqCnp1ZLSb1WCM3or6HDxSED'),
  quote: new PublicKey(process.env.LIVE_PUMP_ROUTED_QUOTE ?? 'MsGDybWRSNdNXkdDZhEksgzugT5CbVWUG2wkhwgpump'),
  holder: process.env.LIVE_PUMP_ROUTED_HOLDER,
  venue: 'PUMPSWAP_ROUTED',
};
const MODEL3: Case = {
  pool: new PublicKey(process.env.LIVE_PUMP_CLMM_POOL ?? '6aHrpqe1pmdnAACWHH4Gp34LXU5Pb4NZvLELRKb4reki'),
  quote: new PublicKey(process.env.LIVE_PUMP_CLMM_QUOTE ?? 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'),
  holder: process.env.LIVE_PUMP_CLMM_HOLDER,
  venue: 'PUMPSWAP_ROUTED',
};
// A curve is opened from its mint (resolving the curve address needs an indexed RPC call).
const THESIS: Case = {
  pool: new PublicKey(process.env.LIVE_CURVE_ROUTED_MINT ?? 'GwC93ekZXWPvoR51LjCuCM9EGeFvbk7Vab7idS9Xpump'),
  quote: new PublicKey(process.env.LIVE_CURVE_ROUTED_QUOTE ?? 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn'),
  holder: process.env.LIVE_CURVE_ROUTED_HOLDER,
  venue: 'PUMP_CURVE_ROUTED',
};
const MARS: Case = {
  pool: new PublicKey(process.env.LIVE_PUMP_FEE_POOL ?? 'DVKwm9Qrk2xdrRfoE7h56kTn7w9utJ2DC1EcP2w8tY5f'),
  quote: new PublicKey(process.env.LIVE_PUMP_FEE_QUOTE ?? 'PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S'),
  holder: process.env.LIVE_PUMP_FEE_HOLDER,
  venue: 'PUMPSWAP_ROUTED',
  legs: 3,
  dust: 10n,
};
const JUP_SWAPS = Buffer.from([152, 47, 78, 235, 192, 96, 110, 106]);
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** Each leg's (in, out), from Jupiter's SwapsEvent. */
function routeLegs(inner: PartiallyDecodedInstruction[]): { in: bigint; out: bigint }[] {
  for (const ix of inner) {
    if (!ix.programId.equals(JUPITER_PROGRAM_ID) || typeof ix.data !== 'string') continue;
    const d = Buffer.from(bs58.decode(ix.data));
    if (!d.subarray(0, 8).equals(EVENT_IX_TAG) || !d.subarray(8, 16).equals(JUP_SWAPS)) continue;
    const b = d.subarray(16);
    // Vec<{ input_mint, input_amount, output_mint, output_amount, (32 more) }>
    return Array.from({ length: b.readUInt32LE(0) }, (_, i) => {
      const o = 4 + i * 112;
      return { in: b.readBigUInt64LE(o + 32), out: b.readBigUInt64LE(o + 72) };
    });
  }
  return [];
}

/**
 * A funded system wallet to simulate buys from. pump.fun's fee recipients are,
 * but a curve trade pays its fee to one of them: for curves, use PumpSwap's.
 */
async function fundedWallet(c: Case): Promise<PublicKey> {
  const g = PUMP_SDK.decodeGlobal((await conn.getAccountInfo(GLOBAL_PDA))!);
  const curveRecipients = [g.feeRecipient, ...g.feeRecipients];
  const amm = PUMP_AMM_SDK.decodeGlobalConfig((await conn.getAccountInfo(GLOBAL_CONFIG_PDA))!);
  // An exchange hot wallet (a plain system account with lots of SOL) when pump's own won't do.
  const exchange = new PublicKey(process.env.LIVE_FUNDER ?? '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  // pump.fun's fee recipients also collect fees in quote tokens like NEURALINK, which would move the balance we check.
  const candidates = c.venue === 'PUMP_CURVE_ROUTED' || c.dust ? [...amm.protocolFeeRecipients.filter((k) => !curveRecipients.some((r) => r.equals(k))), exchange] : curveRecipients;
  for (const k of candidates) {
    const info = await conn.getAccountInfo(k);
    if (info?.owner.equals(SystemProgram.programId) && info.lamports > 2e9) return k;
  }
  throw new Error('no funded system wallet found');
}

async function holder(m: PoolMarket, pinned: string | undefined): Promise<PublicKey> {
  if (pinned) return new PublicKey(pinned);
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

async function attempt(c: Case, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell: boolean) {
  const r = await resolveAddress(conn, c.pool);
  const market = (await openMarket(conn, r.mint, r.hint)) as PoolMarket;
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const quoteInfo0 = await conn.getAccountInfo(c.quote);
  const userAta = getAssociatedTokenAddressSync(market.mint.mint, user, true, market.mint.tokenProgram);
  const quoteAta = getAssociatedTokenAddressSync(c.quote, user, true, quoteInfo0!.owner);
  const [ataInfo, wallet, quoteInfo] = await conn.getMultipleAccountsInfo([userAta, user, quoteAta]);
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
    innerInstructions: true,
    accounts: { encoding: 'base64', addresses: [user.toBase58(), userAta.toBase58(), quoteAta.toBase58()] },
  });
  const sim = interpretSimulation(res.value, { preLamports: wallet?.lamports ?? null, preTokens: tokenAmount(ataInfo) });
  const quoteAfter = res.value.accounts?.[2] ? tokenAmount({ data: Buffer.from(res.value.accounts[2].data[0]!, 'base64') } as AccountInfo<Buffer>) : new BN(0);
  const inner = (res.value.innerInstructions ?? []).flatMap((g) => g.instructions as PartiallyDecodedInstruction[]);
  return { market, plan, built, sim, legs: sim.ok ? routeLegs(inner) : [], quoteBefore: tokenAmount(quoteInfo), quoteAfter };
}

async function run(c: Case, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell = false) {
  for (let i = 1; ; i++) {
    const a = await attempt(c, user, side, amount, closeAfterFullSell);
    const { plan, sim, legs, market } = a;
    expect(sim.error, JSON.stringify({ side, amount, error: sim.error, logs: sim.logs.slice(-14) })).toBeNull();
    expect(legs.length).toBe(c.legs ?? 2);
    if (process.env.LIVE_DEBUG) console.log('[debug]', side, legs.map((l) => `${l.in}->${l.out}`).join(' | '), a.quoteBefore.toString(), a.quoteAfter.toString(), user.toBase58(), sim.logs.filter((l) => /Instruction|invoke \[2\]/.test(l)).join(' / '));
    // The route passes all of the quote token straight through.
    const left = BigInt(a.quoteAfter.sub(a.quoteBefore).toString());
    expect(left >= 0n && left <= (side === 'buy' ? (c.dust ?? 0n) : 0n), `quote token left behind: ${left}`).toBe(true);
    const received = side === 'buy' ? BigInt(sim.tokenDelta!.toString()) : legs[legs.length - 1]!.out;
    expect(received >= BigInt(plan.quote.minOut.toString())).toBe(true);
    // Leg by leg, on the state we read: the SOL leg, then the coin's pool (reverse for sells).
    const firstOut = side === 'buy' ? market.leg!.quote(BigInt(plan.quote.inAmount.toString()), true) : null;
    const exact = received === BigInt(plan.quote.out.toString());
    console.log(
      `[pumproute] ${market.venue} ${side} ${amount} try ${i}: ${a.built.tx.serialize().length} bytes, units=${sim.unitsConsumed} ` +
        `legs=${legs.map((l) => `${l.in}->${l.out}`).join(' | ')} solLeg=${firstOut ?? '-'} quote=${plan.quote.out} min=${plan.quote.minOut} received=${received} exact=${exact} cuKey=${a.built.cuKey}`,
    );
    if (exact || i === Number(process.env.LIVE_TRIES ?? 4)) {
      expect(exact, 'quote never matched what landed exactly (pools kept moving)').toBe(true);
      return a;
    }
  }
}

async function record(name: string, c: Case) {
  const fx: Fixture = { name, slot: await conn.getSlot(), address: c.pool.toBase58(), accounts: {}, tokenAccountsByOwner: {} };
  const rec = recording(conn, fx);
  __resetCurveProtocolCache();
  const viaPool = await resolveAddress(rec, c.pool);
  const m = (await openMarket(rec, viaPool.mint, viaPool.hint)) as PoolMarket;
  await openMarket(rec, (await resolveAddress(rec, viaPool.mint.mint)).mint).catch(() => null);
  saveFixture(`tests/fixtures/${name}.json`, fx);
  console.log(`[pumproute] ${name}: pool=${c.pool.toBase58()} mint=${m.mint.mint.toBase58()} venue=${m.venue} via=${m.routedVia}`);
  return m;
}

async function roundTrip(name: string, c: Case) {
  const m = await record(name, c);
  expect(m.venue).toBe(c.venue);
  await run(c, await fundedWallet(c), 'buy', 0.01);
  const seller = await holder(m, c.holder);
  await run(c, seller, 'sell', 50);
  await run(c, seller, 'sell', 100, true);
}

describe.skipIf(!LIVE)('PumpSwap pools quoted in another token (simulated)', () => {
  it('MEIMEI via MeiMei (PumpSwap SOL leg): buy, 50% sell and full sell + close match the chain', () => roundTrip('pumpswap-routed', MEIMEI), 600_000);
  it('MODEL3 via TSLAx (Raydium CLMM SOL leg): buy, 50% sell and full sell + close match the chain', () => roundTrip('pumpswap-clmm', MODEL3), 600_000);
  it('Thesis Cat curve via PUMP (Raydium CLMM SOL leg): buy, 50% sell and full sell + close match the chain', () => roundTrip('curve-routed', THESIS), 600_000);
  it('Mars via NEURALINK (1% transfer fee; SOL -> USDC -> NEURALINK): buy, 50% sell and full sell + close match the chain', () => roundTrip('pumpswap-fee', MARS), 600_000);
});
