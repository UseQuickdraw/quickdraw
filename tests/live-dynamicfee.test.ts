// A coin routed through a dynamic-fee Raydium CLMM pool, skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] npx vitest run tests/live-dynamicfee.test.ts
// HAMMER by default: a pump.fun curve priced in DJT (Backpack's Trump Media
// stock token), whose SOL liquidity sits in a dynamic-fee CLMM pool, so a
// trade runs SOL -> DJT (dynamic fee) -> HAMMER. Simulates a buy, a 50% sell
// and a full sell exactly as the extension builds them: what lands must equal
// the quote. Nothing is signed or sent.
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
import { planTrade } from '../src/solana/trade';
import { buildTrade, interpretSimulation } from '../src/solana/execute';
import { tokenAmount } from '../src/solana/tokens';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
const MINT = new PublicKey(process.env.LIVE_ROUTED_MINT ?? '7PYYkprnTGSbDRjn59416qKTNbSUTeUY2wUrvZsgpump');
let POOL = MINT;
const JUP_SWAPS = Buffer.from([152, 47, 78, 235, 192, 96, 110, 106]);
const SWAP_EVENT = Buffer.from([64, 198, 205, 232, 38, 8, 113, 226]);
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
    if (disc.equals(SWAP_EVENT)) out = b.readBigUInt64LE(104);
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

/** An ordinary wallet still holding the coin, among the pool's recent traders. */
async function holder(tokenProgram: PublicKey): Promise<PublicKey> {
  if (process.env.LIVE_ROUTED_HOLDER) return new PublicKey(process.env.LIVE_ROUTED_HOLDER);
  const sigs = await conn.getSignaturesForAddress(POOL, { limit: 200 }, 'confirmed');
  const owners = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    let tx = null;
    for (let i = 0; i < 4 && !tx; i++) {
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
      tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    }
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint === MINT.toBase58() && b.owner && Number(b.uiTokenAmount.amount) > 0) owners.add(b.owner);
    }
    if (owners.size >= 30) break;
  }
  for (const o of owners) {
    const owner = new PublicKey(o);
    const [wallet, ta] = await conn.getMultipleAccountsInfo([owner, getAssociatedTokenAddressSync(MINT, owner, true, tokenProgram)]);
    if (wallet?.owner.equals(SystemProgram.programId) && wallet.lamports > 1_000_000 && tokenAmount(ta).gtn(0)) return owner;
  }
  throw new Error(`no suitable holder among ${owners.size} recent traders (${sigs.length} transactions)`);
}

async function attempt(user: PublicKey, side: 'buy' | 'sell', amount: number) {
  const r = await resolveAddress(conn, MINT);
  const market = await openMarket(conn, r.mint, r.hint);
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
    cuLimit: () => 1_400_000, cuPrice: 1_000, closeAfterFullSell: market.canCloseTokenAccount?.() ?? true,
  });
  const res = await conn.simulateTransaction(built.tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'processed',
    innerInstructions: true,
    accounts: { encoding: 'base64', addresses: [user.toBase58(), userAta.toBase58()] },
  });
  const sim = interpretSimulation(res.value, { preLamports: wallet?.lamports ?? null, preTokens: tokenAmount(ataInfo) });
  const inner = (res.value.innerInstructions ?? []).flatMap((g) => g.instructions as PartiallyDecodedInstruction[]);
  return { market, plan, built, sim, routeOut: sim.ok ? routeOut(inner) : null };
}

async function run(user: PublicKey, side: 'buy' | 'sell', amount: number) {
  for (let i = 1; ; i++) {
    const a = await attempt(user, side, amount);
    expect(a.sim.error, JSON.stringify({ side, amount, error: a.sim.error, logs: a.sim.logs.slice(-12) })).toBeNull();
    const received = side === 'buy' ? BigInt(a.sim.tokenDelta!.toString()) : a.routeOut!;
    expect(received >= BigInt(a.plan.quote.minOut.toString())).toBe(true);
    const exact = received === BigInt(a.plan.quote.out.toString());
    console.log(
      `[dynamic-fee] ${a.market.venue} ${side} ${amount} try ${i}: ${a.built.tx.serialize().length} bytes, units=${a.sim.unitsConsumed} ` +
        `quote=${a.plan.quote.out} min=${a.plan.quote.minOut} received=${received} exact=${exact}`,
    );
    if (exact || i === 4) {
      expect(exact, 'quote never matched what landed exactly (the pool kept moving)').toBe(true);
      return a;
    }
  }
}

describe.skipIf(!LIVE)('A coin routed through a dynamic-fee CLMM pool (simulated)', () => {
  it('opens, and buys and sells as quoted', async () => {
    const fromMint = await openMarket(conn, (await resolveAddress(conn, MINT)).mint);
    console.log(`[dynamic-fee] ${MINT.toBase58()} opened as ${fromMint.venue} at ${fromMint.address.toBase58()}`);
    POOL = fromMint.address;
    await run(await fundedWallet(), 'buy', 0.01);
    const seller = await holder(fromMint.mint.tokenProgram);
    await run(seller, 'sell', 50);
    await run(seller, 'sell', 100);
  }, 600_000);
});
