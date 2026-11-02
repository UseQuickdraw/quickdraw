// STONK-paired LaunchLab coins on mainnet, routed SOL <-> STONK <-> coin
// through our own Jupiter route_v2. Skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] [LIVE_STONK_POOL=...] npx vitest run tests/live-stonk.test.ts
// Records tests/fixtures/launchlab-stonk.json, then simulates a buy, a 50%
// sell and a full sell + close exactly as the extension builds them (lookup
// tables and guard included). From the events each simulation emits it checks
// that the route leaves no STONK behind, that the curve leg spent exactly what
// the Orca leg produced, and that each leg matches our maths to the unit.
// Nothing is signed or sent.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import type { WhirlpoolLeg } from '../src/venues/whirlpool';
import bs58 from 'bs58';
import BN from 'bn.js';
import { Connection, PublicKey, SystemProgram, type AccountInfo, type PartiallyDecodedInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { GLOBAL_PDA, PUMP_SDK } from '@pump-fun/pump-sdk';
import { PUBLIC_MAINNET_RPC } from '../src/constants';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { LAUNCHLAB_PROGRAM_ID, decodePool, type LaunchLabMarket } from '../src/venues/launchLab';
import { STONK_MINT, openRoute } from '../src/venues/routes';
import { JUPITER_PROGRAM_ID } from '../src/venues/jupiter';
import { planTrade } from '../src/solana/trade';
import { buildTrade, interpretSimulation } from '../src/solana/execute';
import { tokenAmount } from '../src/solana/tokens';
import { recording, saveFixture, type Fixture } from './helpers/fixtures';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
const pace = () => new Promise((r) => setTimeout(r, 150));
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const LL_TRADE = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const JUP_SWAP = Buffer.from([64, 198, 205, 232, 38, 8, 113, 226]);
const JUP_SWAPS = Buffer.from([152, 47, 78, 235, 192, 96, 110, 106]);
const ORCA_TRADED = Buffer.from('e1ca49af932ba096', 'hex');

async function stonkPool(): Promise<PublicKey> {
  if (process.env.LIVE_STONK_POOL) return new PublicKey(process.env.LIVE_STONK_POOL);
  const sigs = await conn.getSignaturesForAddress(LAUNCHLAB_PROGRAM_ID, { limit: 150 }, 'confirmed');
  const seen = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    await pace();
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    const keys = (tx?.transaction.message.staticAccountKeys ?? []).filter((k) => !seen.has(k.toBase58())).slice(0, 100);
    keys.forEach((k) => seen.add(k.toBase58()));
    if (!keys.length) continue;
    const infos = await conn.getMultipleAccountsInfo(keys, 'confirmed');
    for (const [i, info] of infos.entries()) {
      const p = info?.owner.equals(LAUNCHLAB_PROGRAM_ID) ? decodePool(info) : null;
      if (p && p.status === 0 && p.quoteMint.equals(STONK_MINT) && p.realB.gtn(1e9)) return keys[i]!;
    }
  }
  throw new Error('no live STONK-paired LaunchLab pool found among recent trades');
}

async function fundedWallet(): Promise<PublicKey> {
  const g = PUMP_SDK.decodeGlobal((await conn.getAccountInfo(GLOBAL_PDA))!);
  for (const k of [g.feeRecipient, ...g.feeRecipients]) {
    const info = await conn.getAccountInfo(k);
    if (info?.owner.equals(SystemProgram.programId) && info.lamports > 2e9) return k;
  }
  throw new Error('no funded system wallet found');
}

async function holder(m: LaunchLabMarket): Promise<PublicKey> {
  if (process.env.LIVE_STONK_HOLDER) return new PublicKey(process.env.LIVE_STONK_HOLDER);
  const sigs = await conn.getSignaturesForAddress(m.address, { limit: 60 }, 'confirmed');
  const owners = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    // The public RPC rate-limits getTransaction hard; back off and retry.
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
  // A middling position: enough to be worth something after fees, not a whale.
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

interface Events {
  legs: { amm: string; inAmount: bigint; outAmount: bigint }[];
  curve: { virtualBase: bigint; virtualQuote: bigint; realBase: bigint; realQuote: bigint; amountIn: bigint; amountOut: bigint } | null;
  orcaPreSqrtPrice: bigint | null;
}

function readEvents(inner: PartiallyDecodedInstruction[], logs: string[]): Events {
  const ev: Events = { legs: [], curve: null, orcaPreSqrtPrice: null };
  for (const ix of inner) {
    if (typeof ix.data !== 'string') continue; // parsed system/token instructions
    const d = Buffer.from(bs58.decode(ix.data));
    if (!d.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
    const disc = d.subarray(8, 16);
    const b = d.subarray(16);
    if (ix.programId.equals(LAUNCHLAB_PROGRAM_ID) && disc.equals(LL_TRADE)) {
      const u = (o: number) => b.readBigUInt64LE(o);
      ev.curve = { virtualBase: u(40), virtualQuote: u(48), realBase: u(56), realQuote: u(64), amountIn: u(88), amountOut: u(96) };
    } else if (ix.programId.equals(JUPITER_PROGRAM_ID) && disc.equals(JUP_SWAP)) {
      // amm, input_mint, input_amount, output_mint, output_amount
      ev.legs.push({ amm: new PublicKey(b.subarray(0, 32)).toBase58(), inAmount: b.readBigUInt64LE(64), outAmount: b.readBigUInt64LE(104) });
    } else if (ix.programId.equals(JUPITER_PROGRAM_ID) && disc.equals(JUP_SWAPS)) {
      // vec<{ input_mint, input_amount, output_mint, output_amount, amm }>
      const n = b.readUInt32LE(0);
      for (let i = 0; i < n; i++) {
        const o = 4 + i * 112;
        ev.legs.push({ amm: new PublicKey(b.subarray(o + 80, o + 112)).toBase58(), inAmount: b.readBigUInt64LE(o + 32), outAmount: b.readBigUInt64LE(o + 72) });
      }
    }
  }
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const d = Buffer.from(line.slice(14), 'base64');
    // Traded { whirlpool, a_to_b, pre_sqrt_price u128, ... }
    if (d.subarray(0, 8).equals(ORCA_TRADED)) ev.orcaPreSqrtPrice = (d.readBigUInt64LE(49) << 64n) + d.readBigUInt64LE(41);
  }
  return ev;
}

/** The curve maths written out independently, on the state the program's TradeEvent reports. */
async function curveOnEventState(m: LaunchLabMarket, side: 'buy' | 'sell', c: NonNullable<Events['curve']>): Promise<bigint> {
  const [g, p] = await conn.getMultipleAccountsInfo([m.state.globalConfig, m.state.platformConfig], 'confirmed');
  const rate = g!.data.readBigUInt64LE(27) + p!.data.readBigUInt64LE(104) + p!.data.readBigUInt64LE(720);
  const fee = (x: bigint) => (x * rate + 999_999n) / 1_000_000n;
  const base = c.virtualBase - c.realBase;
  const quote = c.virtualQuote + c.realQuote;
  if (side === 'buy') {
    const net = c.amountIn - fee(c.amountIn);
    return (net * base) / (quote + net);
  }
  const gross = (c.amountIn * quote) / (base + c.amountIn);
  return gross - fee(gross);
}

async function attempt(poolAddr: PublicKey, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell: boolean) {
  const r = await resolveAddress(conn, poolAddr);
  const market = (await openMarket(conn, r.mint, r.hint)) as LaunchLabMarket;
  expect(market.venue).toBe('LAUNCHLAB_ROUTED');
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const userAta = getAssociatedTokenAddressSync(market.mint.mint, user, true, market.mint.tokenProgram);
  const stonkAta = getAssociatedTokenAddressSync(STONK_MINT, user, true, TOKEN_PROGRAM_ID);
  const [ataInfo, wallet, stonkInfo] = await conn.getMultipleAccountsInfo([userAta, user, stonkAta]);
  const plan = planTrade(market, { side, amount, presetIndex: null }, settings, profile, tokenAmount(ataInfo));
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const built = await buildTrade({
    market, plan, user, userAta, userAtaInfo: ataInfo ?? null, tier: 'eco', tipSol: null, profile, settings, blockhash,
    cuLimit: () => 1_400_000, cuPrice: 1_000, closeAfterFullSell,
  });
  const res = await conn.simulateTransaction(built.tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
    innerInstructions: true,
    accounts: { encoding: 'base64', addresses: [user.toBase58(), userAta.toBase58(), stonkAta.toBase58()] },
  });
  const sim = interpretSimulation(res.value, { preLamports: wallet?.lamports ?? null, preTokens: tokenAmount(ataInfo) });
  const stonkAfter = res.value.accounts?.[2] ? tokenAmount({ data: Buffer.from(res.value.accounts[2].data[0]!, 'base64') } as AccountInfo<Buffer>) : new BN(0);
  const inner = (res.value.innerInstructions ?? []).flatMap((g) => g.instructions as PartiallyDecodedInstruction[]);
  return { market, plan, built, sim, events: sim.ok ? readEvents(inner, sim.logs) : null, stonkBefore: tokenAmount(stonkInfo), stonkAfter };
}

async function run(poolAddr: PublicKey, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell = false) {
  for (let i = 1; ; i++) {
    const a = await attempt(poolAddr, user, side, amount, closeAfterFullSell);
    const { plan, sim, events: ev } = a;
    const size = a.built.tx.serialize().length;
    expect(sim.error, JSON.stringify({ side, amount, error: sim.error, logs: sim.logs.slice(-12) })).toBeNull();
    expect(ev!.legs).toHaveLength(2);
    const [first, second] = ev!.legs as [Events['legs'][0], Events['legs'][0]];
    const finalOut = second.outAmount;
    // The route chains exactly and leaves no STONK behind.
    expect(second.inAmount).toBe(first.outAmount);
    expect(a.stonkAfter.toString()).toBe(a.stonkBefore.toString());
    // The curve leg, on the state the program reports, to the unit. A sell's
    // curve input is what the pool received, after any Token-2022 transfer fee.
    const curve = ev!.curve!;
    const tokensIn = plan.quote.inAmount;
    const poolGot = BigInt(tokensIn.sub(a.market.transferFeeOn(tokensIn)).toString());
    expect(curve.amountIn).toBe(side === 'buy' ? first.outAmount : poolGot);
    expect(await curveOnEventState(a.market, side, curve)).toBe(curve.amountOut);
    // The Orca leg, when the pool hadn't moved since we read it.
    const leg = a.market.leg as WhirlpoolLeg;
    const orcaIn = side === 'buy' ? first.inAmount : second.inAmount;
    const orcaOut = side === 'buy' ? first.outAmount : second.outAmount;
    const orcaChecked = ev!.orcaPreSqrtPrice === leg.sqrtPrice;
    if (orcaChecked) expect(leg.swapExactIn(orcaIn, leg.aToB(side === 'buy'))).toBe(orcaOut);
    // What actually landed: the coin in the wallet for a buy (after any
    // transfer fee), SOL out of the route for a sell.
    const received = side === 'buy' ? BigInt(sim.tokenDelta!.toString()) : finalOut;
    expect(received >= BigInt(plan.quote.minOut.toString())).toBe(true);
    const exact = received === BigInt(plan.quote.out.toString());
    console.log(
      `[stonk] ${side} ${amount} try ${i}: ${size} bytes, units=${sim.unitsConsumed} legs=${first.inAmount}->${first.outAmount}->${second.outAmount} ` +
        `quote=${plan.quote.out} min=${plan.quote.minOut} received=${received} transferFee=${a.market.transferFeeOn(new BN(1_000_000_000)).toString()}/1e9 ` +
        `orcaChecked=${orcaChecked} exact=${exact} solDelta=${sim.solDelta} closed=${a.built.cuKey.endsWith('close')}`,
    );
    if (exact || i === 4) {
      expect(exact, 'quote never matched the route output exactly (pools kept moving)').toBe(true);
      return a;
    }
  }
}

describe.skipIf(!LIVE)('STONK-paired LaunchLab on mainnet (simulated)', () => {
  it('records the fixture; routed buy, 50% sell and full sell + close match the chain', async () => {
    const poolAddr = await stonkPool();
    const fx: Fixture = { name: 'launchlab-stonk', slot: await conn.getSlot(), address: poolAddr.toBase58(), accounts: {}, tokenAccountsByOwner: {} };
    const rec = recording(conn, fx);
    const viaPool = await resolveAddress(rec, poolAddr);
    await openMarket(rec, viaPool.mint, viaPool.hint);
    await openMarket(rec, (await resolveAddress(rec, viaPool.mint.mint)).mint);
    // A pool quoted in a token with no SOL pool looks for a route too (the refusal test).
    await openRoute(rec, new PublicKey(Buffer.alloc(32, 7)), poolAddr);
    saveFixture('tests/fixtures/launchlab-stonk.json', fx);
    console.log(`[stonk] pool=${poolAddr.toBase58()} mint=${viaPool.mint.mint.toBase58()}`);

    await run(poolAddr, await fundedWallet(), 'buy', 0.01);
    const m = (await openMarket(conn, viaPool.mint, viaPool.hint)) as LaunchLabMarket;
    const seller = await holder(m);
    await run(poolAddr, seller, 'sell', 50);
    await run(poolAddr, seller, 'sell', 100, true);
  }, 600_000);
});
