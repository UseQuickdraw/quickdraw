// Runs the ledger parser over real recent pump.fun / PumpSwap trades.
// Skipped unless LIVE=1. Read-only.
import '../src/polyfills';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-sdk/swap';
import { PUBLIC_MAINNET_RPC, SENDER, WSOL_MINT } from '../src/constants';
import { parseFill } from '../src/ledger/ledger';

const LIVE = process.env.LIVE === '1';
const conn = new Connection(process.env.LIVE_RPC ?? PUBLIC_MAINNET_RPC, 'confirmed');
const pace = () => new Promise((r) => setTimeout(r, 150));

describe.skipIf(!LIVE)('ledger on real trades', () => {
  for (const [name, program] of [
    ['pump curve', PUMP_PROGRAM_ID],
    ['PumpSwap', PUMP_AMM_PROGRAM_ID],
  ] as const) {
    it(`${name}: buys are SOL out, sells are SOL in, nothing throws`, async () => {
      const sigs = await conn.getSignaturesForAddress(program, { limit: 40 }, 'confirmed');
      const rows: unknown[] = [];
      for (const s of sigs) {
        if (s.err) continue;
        await pace();
        const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
        if (!tx?.meta) continue;
        const payer = tx.transaction.message.staticAccountKeys[0]!;
        const changed = new Set(
          [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
            .filter((b) => b.owner === payer.toBase58() && b.mint !== WSOL_MINT)
            .map((b) => b.mint),
        );
        if (changed.size !== 1) continue; // single-token trades only
        const f = parseFill(tx, payer, new PublicKey([...changed][0]!), SENDER.tipAccounts);
        if (f.side === 'none') continue;
        const sane = (f.side === 'buy' ? f.tradeLamports < 0 : f.tradeLamports > 0) && Math.abs(f.tradeLamports) < 1_000 * 1e9;
        rows.push({ sig: s.signature, side: f.side, trade: f.tradeLamports, fee: f.feeLamports, tip: f.tipLamports, rent: f.rentLamports, wallet: f.walletLamports, sane });
        if (rows.length >= 8) break;
      }
      writeFileSync(join(tmpdir(), `quickdraw-live-ledger-${name.replace(/\W/g, '')}.json`), JSON.stringify(rows, null, 1));
      expect(rows.length).toBeGreaterThan(0);
      // Arbitrage bots buy and sell across venues in one transaction, which can read as a
      // profitable "buy". The extension never builds those; tolerate the odd one here.
      expect(rows.filter((r) => !(r as { sane: boolean }).sane).length).toBeLessThanOrEqual(Math.floor(rows.length / 4));
    }, 180_000);
  }
});
