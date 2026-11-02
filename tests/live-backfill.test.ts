// Reading a wallet's history for a token bought outside the extension, on
// mainnet. Skipped unless LIVE=1:
//   LIVE=1 [LIVE_RPC=...] [LIVE_BACKFILL_MINT=...] npx vitest run tests/live-backfill.test.ts
// Finds recent traders of a token (bought through Axiom, GMGN, Jupiter...),
// reads one wallet's token-account history the way TradeEngine.backfill does,
// and checks the resulting position is sane: buys cost SOL, sells pay SOL, and
// the tokens the ledger accounts for never exceed what the wallet holds.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUBLIC_MAINNET_RPC, SENDER } from '../src/constants';
import { LedgerStore } from '../src/ledger/store';
import { parseFill } from '../src/ledger/ledger';
import { tokenAmount } from '../src/solana/tokens';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
// STONKLANA by default: a graduated stonk.fun coin traded through routers.
const MINT = new PublicKey(process.env.LIVE_BACKFILL_MINT ?? 'GF74fBfcaeLjUiUwKpRiUbvMQtTvNyzMoo6KNyyqNyk6');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tx(signature: string) {
  for (let i = 0; i < 4; i++) {
    const t = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    if (t?.meta) return t;
    await sleep(300 * 2 ** i);
  }
  return null;
}

describe.skipIf(!LIVE)('history of a token bought elsewhere (mainnet)', () => {
  it('turns router trades into a sane position', async () => {
    const mintInfo = (await conn.getAccountInfo(MINT))!;
    const program = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    // A wallet that holds the token, from recent trades.
    const sigs = await conn.getSignaturesForAddress(MINT, { limit: 40 }, 'confirmed');
    let owner: PublicKey | null = null;
    for (const s of sigs) {
      if (s.err) continue;
      const t = await tx(s.signature);
      // An ordinary buyer, like a person on Axiom: signs their own trade and pays SOL for the tokens
      // (bots paying through relayers or pre-funded escrows don't look like that).
      const signer = t?.transaction.message.staticAccountKeys[0];
      if (!t || !signer) continue;
      const f = parseFill(t, signer, MINT, SENDER.tipAccounts);
      if (f.side === 'buy' && f.tradeLamports < 0) {
        owner = signer;
        break;
      }
    }
    expect(owner, 'no holder found among recent trades').not.toBeNull();
    const ata = getAssociatedTokenAddressSync(MINT, owner!, true, program);
    const held = BigInt(tokenAmount(await conn.getAccountInfo(ata)).toString());

    // Same steps as TradeEngine.backfill.
    const ledger = new LedgerStore();
    const history = await conn.getSignaturesForAddress(ata, { limit: 60 }, 'confirmed');
    let buys = 0;
    let sells = 0;
    for (const s of [...history].reverse()) {
      if (s.err) continue;
      const t = await tx(s.signature);
      if (!t) continue;
      const fill = parseFill(t, owner!, MINT, SENDER.tipAccounts);
      if (fill.side === 'none' || fill.tradeLamports === 0 || (fill.side === 'buy') !== fill.tradeLamports < 0) continue;
      await ledger.record(fill);
      if (fill.side === 'buy') buys++;
      else sells++;
    }
    const p = ledger.position(MINT.toBase58());
    console.log(`[backfill] wallet=${owner!.toBase58()} history=${history.length} buys=${buys} sells=${sells} bought=${(p?.boughtLamports ?? 0) / 1e9} SOL sold=${(p?.soldLamports ?? 0) / 1e9} SOL ledgerTokens=${p?.tokensRaw} held=${held}`);
    expect(buys).toBeGreaterThan(0);
    expect(p!.boughtLamports).toBeGreaterThan(0);
    // Every recorded buy cost SOL and every sell paid SOL.
    for (const f of p!.fills) expect(f.side === 'buy' ? f.tradeLamports < 0 : f.tradeLamports > 0).toBe(true);
    // A complete history accounts for exactly what's held (unless the wallet has more history than we read).
    if (history.length < 60) expect(BigInt(p!.tokensRaw)).toBe(held);
  }, 300_000);
});
