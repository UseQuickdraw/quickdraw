// Raydium CPMM on mainnet, skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] npx vitest run tests/live-cpmm.test.ts
// Pools (override with env): STONKLANA/STONK (a graduated stonk.fun coin,
// routed through SOL -> STONK) and a SOL-paired pool (direct swap_base_input).
// Records tests/fixtures/cpmm-*.json, then simulates a buy, a 50% sell and a
// full sell + close exactly as the extension builds them. From each pool's
// SwapEvent (the reserves it priced against) our maths must give its exact
// output, a routed trade must leave no STONK behind, and what lands in the
// wallet must equal the quote. Nothing is signed or sent.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import bs58 from 'bs58';
import { Connection, PublicKey, SystemProgram, type AccountInfo, type PartiallyDecodedInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { GLOBAL_PDA, PUMP_SDK } from '@pump-fun/pump-sdk';
import { PUBLIC_MAINNET_RPC } from '../src/constants';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import type { CpmmMarket } from '../src/venues/raydiumCpmm';
import { JUPITER_PROGRAM_ID } from '../src/venues/jupiter';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { planTrade } from '../src/solana/trade';
import { buildTrade, interpretSimulation } from '../src/solana/execute';
import { tokenAmount } from '../src/solana/tokens';
import { recording, saveFixture, type Fixture } from './helpers/fixtures';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
const STONK_POOL = new PublicKey(process.env.LIVE_CPMM_STONK_POOL ?? 'CY44KJpFgffk5Fu1YZjeVP4BudurkJCFnuovEfeRNuXo');
// CPU / INTCx: a coin paired with an xStock, routed SOL -> INTCx on a Raydium CLMM.
const STOCK_POOL = new PublicKey(process.env.LIVE_CPMM_STOCK_POOL ?? 'APKy43xkxRZ4iJQB7aQAr6u82cRpk8tCg13TKsmUKcAD');
const SOL_POOL = new PublicKey(process.env.LIVE_CPMM_SOL_POOL ?? 'Rwq7WrFAzyBtDzGBxYKEHAtHfhAedW6vYqghPT1xBau');
// CPMM logs its SwapEvent; Jupiter emits its own (same name, same discriminator) through a self-CPI.
const SWAP_EVENT = Buffer.from([64, 198, 205, 232, 38, 8, 113, 226]);
const JUP_SWAPS = Buffer.from([152, 47, 78, 235, 192, 96, 110, 106]);
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** The output of the route's last leg, from Jupiter's events. */
function routeOut(inner: PartiallyDecodedInstruction[]): bigint | null {
  let out: bigint | null = null;
  for (const ix of inner) {
    if (!ix.programId.equals(JUPITER_PROGRAM_ID) || typeof ix.data !== 'string') continue;
    const d = Buffer.from(bs58.decode(ix.data));
    if (!d.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
    const disc = d.subarray(8, 16);
    const b = d.subarray(16);
    if (disc.equals(SWAP_EVENT)) out = b.readBigUInt64LE(104); // amm, input_mint, input_amount, output_mint, output_amount
    else if (disc.equals(JUP_SWAPS)) out = b.readBigUInt64LE(4 + (b.readUInt32LE(0) - 1) * 112 + 72);
  }
  return out;
}

async function fundedWallet(): Promise<PublicKey> {
  const g = PUMP_SDK.decodeGlobal((await conn.getAccountInfo(GLOBAL_PDA))!);
  for (const k of [g.feeRecipient, ...g.feeRecipients]) {
    const info = await conn.getAccountInfo(k);
    if (info?.owner.equals(SystemProgram.programId) && info.lamports > 2e9) return k;
  }
  throw new Error('no funded system wallet found');
}

async function holder(m: CpmmMarket, pinned: string | undefined): Promise<PublicKey> {
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

interface PoolSwap {
  vaultIn: bigint;
  vaultOut: bigint;
  amountIn: bigint;
  amountOut: bigint;
  creatorFeeOnInput: boolean;
}

/** CPMM's SwapEvent for `pool`, emitted to the logs (a CLMM leg logs one of the same name). */
function poolSwap(logs: string[], pool: PublicKey): PoolSwap | null {
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const d = Buffer.from(line.slice(14), 'base64');
    if (d.length < 170 || !d.subarray(0, 8).equals(SWAP_EVENT)) continue;
    const b = d.subarray(8);
    if (!b.subarray(0, 32).equals(pool.toBuffer())) continue;
    return { vaultIn: b.readBigUInt64LE(32), vaultOut: b.readBigUInt64LE(40), amountIn: b.readBigUInt64LE(48), amountOut: b.readBigUInt64LE(56), creatorFeeOnInput: b[161] === 1 };
  }
  return null;
}

/** calculator.rs swap_base_input written out independently, on the event's reserves. */
async function poolMaths(m: CpmmMarket, e: PoolSwap): Promise<bigint> {
  const cfg = (await conn.getAccountInfo(m.state.ammConfig, 'confirmed'))!.data;
  const trade = cfg.readBigUInt64LE(12);
  const creator = m.state.enableCreatorFee ? cfg.readBigUInt64LE(108) : 0n;
  const ceil = (x: bigint, r: bigint) => (x * r + 999_999n) / 1_000_000n;
  if (e.creatorFeeOnInput) {
    const net = e.amountIn - ceil(e.amountIn, trade + creator);
    return (net * e.vaultOut) / (e.vaultIn + net);
  }
  const net = e.amountIn - ceil(e.amountIn, trade);
  const swapped = (net * e.vaultOut) / (e.vaultIn + net);
  return swapped - ceil(swapped, creator);
}

async function attempt(poolAddr: PublicKey, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell: boolean) {
  const r = await resolveAddress(conn, poolAddr);
  const market = (await openMarket(conn, r.mint, r.hint)) as CpmmMarket;
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const userAta = getAssociatedTokenAddressSync(market.mint.mint, user, true, market.mint.tokenProgram);
  const quoteOwner = (await conn.getAccountInfo(market.quoteMint))?.owner ?? TOKEN_PROGRAM_ID;
  const quoteAta = getAssociatedTokenAddressSync(market.quoteMint, user, true, quoteOwner);
  const [ataInfo, wallet, quoteInfo] = await conn.getMultipleAccountsInfo([userAta, user, quoteAta]);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  // Busy pools trade every slot: refresh the market at the newest state right
  // before quoting, and simulate against that same commitment.
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
  return { market, plan, built, sim, swap: poolSwap(sim.logs, market.address), routeOut: sim.ok ? routeOut(inner) : null, quoteBefore: tokenAmount(quoteInfo), quoteAfter };
}

async function run(poolAddr: PublicKey, user: PublicKey, side: 'buy' | 'sell', amount: number, closeAfterFullSell = false) {
  for (let i = 1; ; i++) {
    const a = await attempt(poolAddr, user, side, amount, closeAfterFullSell);
    const { plan, sim, swap, market } = a;
    expect(sim.error, JSON.stringify({ side, amount, error: sim.error, logs: sim.logs.slice(-12) })).toBeNull();
    // The pool's own swap, on the reserves it reports, to the unit.
    expect(swap).not.toBeNull();
    expect(await poolMaths(market, swap!)).toBe(swap!.amountOut);
    const routed = market.venue === 'RAYDIUM_CPMM_ROUTED';
    // A routed trade leaves no quote token behind (a direct one's quote account is WSOL, closed in the tx).
    if (routed) expect(a.quoteAfter.toString()).toBe(a.quoteBefore.toString());
    // What landed: the coin for a buy; for a sell, the pool's output (direct) or the route's SOL.
    let received: bigint;
    if (side === 'buy') received = BigInt(sim.tokenDelta!.toString());
    else if (!routed) received = swap!.amountOut;
    else received = a.routeOut!;
    expect(received >= BigInt(plan.quote.minOut.toString())).toBe(true);
    const exact = received === BigInt(plan.quote.out.toString());
    console.log(
      `[cpmm] ${market.venue} ${side} ${amount} try ${i}: ${a.built.tx.serialize().length} bytes, units=${sim.unitsConsumed} ` +
        `pool ${swap!.amountIn}->${swap!.amountOut} quote=${plan.quote.out} min=${plan.quote.minOut} received=${received} exact=${exact} cuKey=${a.built.cuKey}`,
    );
    if (exact || i === 4) {
      expect(exact, 'quote never matched what landed exactly (pools kept moving)').toBe(true);
      return a;
    }
  }
}

async function record(name: string, poolAddr: PublicKey) {
  const fx: Fixture = { name, slot: await conn.getSlot(), address: poolAddr.toBase58(), accounts: {}, tokenAccountsByOwner: {} };
  const rec = recording(conn, fx);
  __resetCurveProtocolCache(); // so the fixture holds every account a cold start reads
  const viaPool = await resolveAddress(rec, poolAddr);
  const m = (await openMarket(rec, viaPool.mint, viaPool.hint)) as CpmmMarket;
  // Opening from the mint finds the pool too (through the graduated curve, for LaunchLab coins).
  await openMarket(rec, (await resolveAddress(rec, viaPool.mint.mint)).mint).catch(() => null);
  saveFixture(`tests/fixtures/${name}.json`, fx);
  console.log(`[cpmm] ${name}: pool=${poolAddr.toBase58()} mint=${m.mint.mint.toBase58()} venue=${m.venue} quote=${m.quoteMint.toBase58()}`);
  return m;
}

describe.skipIf(!LIVE)('Raydium CPMM on mainnet (simulated)', () => {
  it('STONK-paired (routed): buy, 50% sell and full sell + close match the chain', async () => {
    const m = await record('cpmm-stonk', STONK_POOL);
    expect(m.venue).toBe('RAYDIUM_CPMM_ROUTED');
    await run(STONK_POOL, await fundedWallet(), 'buy', 0.01);
    const seller = await holder(m, process.env.LIVE_CPMM_STONK_HOLDER);
    await run(STONK_POOL, seller, 'sell', 50);
    await run(STONK_POOL, seller, 'sell', 100, true);
  }, 600_000);

  it('xStock-paired (routed through a Raydium CLMM): buy, 50% sell and full sell + close match the chain', async () => {
    const m = await record('cpmm-stock', STOCK_POOL);
    expect(m.venue).toBe('RAYDIUM_CPMM_ROUTED');
    await run(STOCK_POOL, await fundedWallet(), 'buy', 0.01);
    const seller = await holder(m, process.env.LIVE_CPMM_STOCK_HOLDER);
    await run(STOCK_POOL, seller, 'sell', 50);
    await run(STOCK_POOL, seller, 'sell', 100, true);
  }, 600_000);

  it('SOL-paired (direct): buy, 50% sell and full sell + close match the chain', async () => {
    const m = await record('cpmm-sol', SOL_POOL);
    expect(m.venue).toBe('RAYDIUM_CPMM');
    await run(SOL_POOL, await fundedWallet(), 'buy', 0.01);
    const seller = await holder(m, process.env.LIVE_CPMM_SOL_HOLDER);
    await run(SOL_POOL, seller, 'sell', 50);
    await run(SOL_POOL, seller, 'sell', 100, true);
  }, 600_000);
});
