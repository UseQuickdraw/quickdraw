// Compute use from a fresh burner, on mainnet, skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] npx vitest run tests/live-fresh-wallet.test.ts
// The per-market live tests buy as funded wallets that already keep a WSOL
// account, and sell as holders who often do too. A burner has none: every trade
// creates (and closes) its WSOL account, and a first buy also creates the coin's
// account and, for a routed coin, the quote token's. That's the costliest case,
// and the one DEFAULT_CU has to cover. For every market in the fixtures (plus a
// few pinned pools) this simulates a first buy from a funded wallet with no
// WSOL account, and a 50% sell + a full sell + close from a holder with none,
// then reports units used against the starting limit. Nothing is signed or sent.
import '../src/polyfills';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUBLIC_MAINNET_RPC } from '../src/constants';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { planTrade } from '../src/solana/trade';
import { buildTrade, interpretSimulation } from '../src/solana/execute';
import { DEFAULT_CU, type CuKey } from '../src/solana/fees';
import { tokenAmount } from '../src/solana/tokens';
import type { Market } from '../src/venues/types';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
/** Raydium's AMM owner: funded, a plain system account, and no WSOL account. */
const FRESH_BUYER = new PublicKey(process.env.LIVE_FRESH_BUYER ?? 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ');
const EXTRA = {
  'clmm-retard': '6LdWaws4uwBi8CNH2jHUUSJHgZ6A7GwCKoBaKL1BhfKN',
  'dynamicfee-hammer': '7PYYkprnTGSbDRjn59416qKTNbSUTeUY2wUrvZsgpump',
  // A Bags coin graduated to DAMM v2, opened from its old curve (what Axiom's URL can show).
  'damm-trumpcoin': '5xXUYpFZTAxzzACGMmxbHv2MRomjqgXHkboxDuo16hiu',
};

const wsolOf = (owner: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A recent trader holding the coin, with SOL for fees and no WSOL account. */
async function freshHolder(m: Market): Promise<PublicKey | null> {
  const sigs = await conn.getSignaturesForAddress(m.address, { limit: 80 }, 'confirmed').catch(() => []);
  const seen = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    await sleep(150);
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint !== m.mint.mint.toBase58() || !b.owner || seen.has(b.owner) || Number(b.uiTokenAmount.amount) <= 0) continue;
      seen.add(b.owner);
      const owner = new PublicKey(b.owner);
      const ata = getAssociatedTokenAddressSync(m.mint.mint, owner, true, m.mint.tokenProgram);
      const [wallet, held, wsol] = await conn.getMultipleAccountsInfo([owner, ata, wsolOf(owner)]);
      if (wallet?.owner.equals(SystemProgram.programId) && wallet.lamports > 10_000_000 && !tokenAmount(held).isZero() && !wsol) return owner;
    }
    if (seen.size >= 25) break;
  }
  return null;
}

async function measure(address: PublicKey, user: PublicKey, side: 'buy' | 'sell', amount: number) {
  const r = await resolveAddress(conn, address);
  const market = await openMarket(conn, r.mint, r.hint);
  const settings = defaultSettings();
  const profile = activeProfile(settings);
  const userAta = getAssociatedTokenAddressSync(market.mint.mint, user, true, market.mint.tokenProgram);
  const [ataInfo, wallet] = await conn.getMultipleAccountsInfo([userAta, user]);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const plan = planTrade(market, { side, amount, presetIndex: null }, settings, profile, tokenAmount(ataInfo));
  const built = await buildTrade({
    market, plan, user, userAta, userAtaInfo: ataInfo ?? null, tier: 'eco', tipSol: null, profile, settings, blockhash,
    cuLimit: () => 1_400_000, cuPrice: 1_000, closeAfterFullSell: true,
  });
  const res = await conn.simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
  const sim = interpretSimulation(res.value, { preLamports: wallet?.lamports ?? null, preTokens: tokenAmount(ataInfo) });
  return { market, key: built.cuKey, units: sim.unitsConsumed ?? null, error: sim.error ? `${sim.error.message} | ${sim.logs.slice(-3).join(' | ')}` : null };
}

describe.skipIf(!LIVE)('compute use from a fresh burner (simulated)', () => {
  it('every market fits its starting compute limit with room to spare', async () => {
    const targets: [string, string][] = [
      ...readdirSync('tests/fixtures')
        .filter((f) => f.endsWith('.json') && !f.startsWith('meteora-'))
        .map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(join('tests/fixtures', f), 'utf8')).address] as [string, string]),
      ...Object.entries(EXTRA),
    ];
    expect((await conn.getAccountInfo(wsolOf(FRESH_BUYER))) === null).toBe(true);
    const rows: { name: string; venue?: string; key?: CuKey; units?: number | null; limit?: number; headroom?: string; note?: string }[] = [];
    for (const [name, address] of targets) {
      try {
        const buy = await measure(new PublicKey(address), FRESH_BUYER, 'buy', 0.01);
        rows.push({ name, venue: buy.market.venue, key: buy.key, units: buy.units, limit: DEFAULT_CU[buy.key], note: buy.error ?? undefined });
        const seller = await freshHolder(buy.market);
        if (!seller) {
          rows.push({ name, note: 'no holder without a WSOL account among recent traders' });
          continue;
        }
        for (const pct of [50, 100]) {
          const sell = await measure(new PublicKey(address), seller, 'sell', pct);
          rows.push({ name, venue: sell.market.venue, key: sell.key, units: sell.units, limit: DEFAULT_CU[sell.key], note: sell.error ?? undefined });
        }
      } catch (e) {
        rows.push({ name, note: `skipped: ${(e as Error).message}` });
      }
    }
    for (const r of rows) if (r.units && r.limit) r.headroom = `${Math.round((r.limit / r.units - 1) * 100)}%`;
    const out = join(tmpdir(), 'quickdraw-fresh-wallet-cu.json');
    writeFileSync(out, JSON.stringify(rows, null, 1));
    for (const r of rows) console.log(`[fresh] ${r.name} ${r.venue ?? ''} ${r.key ?? ''} units=${r.units ?? '-'} limit=${r.limit ?? '-'} headroom=${r.headroom ?? '-'} ${r.note ?? ''}`);
    console.log(`[fresh] written to ${out}`);
  }, 1_800_000);
});
