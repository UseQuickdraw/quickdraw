import '../src/polyfills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction, type Connection, type SignatureResult } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadFixture, replay } from './helpers/fixtures';
import { TIMING, sendAndConfirm } from '../src/solana/confirm';
import { TradeEngine, type Toast, type TradeLogEntry } from '../src/solana/engine';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import { SENDER } from '../src/constants';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SystemInstruction, SystemProgram, TransactionMessage } from '@solana/web3.js';
import type { Settings } from '../src/settings/schema';

const pool = loadFixture('tests/fixtures/pumpswap.json');
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const SAVED = { ...TIMING };

type Status = { slot: number; confirmationStatus: 'processed' | 'confirmed'; err: unknown } | null;

/** Scriptable fake of the RPC methods the confirm loop uses. */
function fakeRpc(opts: { statuses?: (call: number) => Status; height?: () => number; logs?: string[] } = {}) {
  let calls = 0;
  const ws: ((r: SignatureResult, ctx: { slot: number }) => void)[] = [];
  const conn = {
    getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [opts.statuses?.(++calls) ?? null] })),
    getBlockHeight: vi.fn(async () => opts.height?.() ?? 100),
    getTransaction: vi.fn(async () => ({ meta: { logMessages: opts.logs ?? [], computeUnitsConsumed: 88_000 } })),
    onSignature: vi.fn((_sig: string, cb: (r: SignatureResult, ctx: { slot: number }) => void) => {
      ws.push(cb);
      return 9;
    }),
    removeSignatureListener: vi.fn(async () => {}),
  };
  return { conn: conn as unknown as Connection, raw: conn, ws };
}

/** fetch stub standing in for Sender / RPC sendTransaction. */
function fakeSend(respond: (n: number) => Response | Promise<Response>) {
  let n = 0;
  const f = vi.fn(async () => respond(++n));
  vi.stubGlobal('fetch', f);
  return f;
}
const ok = (result = 'sig') => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string) as { params: [string, Record<string, unknown>] };

beforeEach(() => Object.assign(TIMING, { pollMs: 5, rebroadcastMs: 15, heightCheckMs: 20, maxWaitMs: 2_000 }));
afterEach(() => {
  Object.assign(TIMING, SAVED);
  vi.unstubAllGlobals();
});

describe('sendAndConfirm', () => {
  it('confirms via polling and rebroadcasts the identical transaction meanwhile', async () => {
    const f = fakeSend(() => ok());
    const { conn } = fakeRpc({ statuses: (n) => (n >= 8 ? { slot: 4242, confirmationStatus: 'confirmed', err: null } : null) });
    const out = await sendAndConfirm({ conn, sendUrl: 'https://send.example', rawTx: 'AAAA', signature: 'S1', lastValidBlockHeight: 1_000 });
    expect(out.status).toBe('confirmed');
    expect(out.slot).toBe(4242);
    expect(out.rebroadcasts).toBeGreaterThan(0);
    expect(f.mock.calls.length).toBe(1 + out.rebroadcasts);
    for (const c of f.mock.calls) {
      expect(bodyOf(c).params[0]).toBe('AAAA'); // never re-signed
      expect(bodyOf(c).params[1]).toMatchObject({ skipPreflight: true, maxRetries: 0, encoding: 'base64' });
    }
  });

  it('confirms from the WebSocket notification', async () => {
    fakeSend(() => ok());
    const rpc = fakeRpc();
    const p = sendAndConfirm({ conn: rpc.conn, sendUrl: 'https://send.example', rawTx: 'AAAA', signature: 'S2', lastValidBlockHeight: 1_000 });
    // Confirmation, then the 'processed' sighting used only for timing.
    await vi.waitFor(() => expect(rpc.ws.length).toBe(2));
    rpc.ws[1]!({ err: null }, { slot: 77 });
    rpc.ws[0]!({ err: null }, { slot: 77 });
    const out = await p;
    expect(out).toMatchObject({ status: 'confirmed', slot: 77 });
    expect(out.inBlockAt).toBeGreaterThanOrEqual(out.sentAt!);
    expect(out.inBlockAt).toBeLessThanOrEqual(out.settledAt);
    expect(rpc.raw.removeSignatureListener).toHaveBeenCalledWith(9);
  });

  it('expires once the blockhash is past its last valid height, without re-signing', async () => {
    fakeSend(() => ok());
    let height = 990;
    const { conn, raw } = fakeRpc({ height: () => (height += 5) });
    const out = await sendAndConfirm({ conn, sendUrl: 'https://send.example', rawTx: 'AAAA', signature: 'S3', lastValidBlockHeight: 1_000 });
    expect(out.status).toBe('expired');
    // The last look searches history in case it landed right at the edge.
    expect(raw.getSignatureStatuses.mock.calls.at(-1)).toEqual([['S3'], { searchTransactionHistory: true }]);
  });

  it('reports an on-chain failure with the decoded reason', async () => {
    fakeSend(() => ok());
    const { conn } = fakeRpc({
      statuses: () => ({ slot: 5, confirmationStatus: 'confirmed', err: { InstructionError: [2, { Custom: 6002 }] } }),
      logs: ['Program log: AnchorError thrown in programs/pump/src/lib.rs:1. Error Code: TooMuchSolRequired. Error Number: 6002. Error Message: slippage.'],
    });
    const out = await sendAndConfirm({ conn, sendUrl: 'https://send.example', rawTx: 'AAAA', signature: 'S4', lastValidBlockHeight: 1_000 });
    expect(out.status).toBe('failed');
    expect(out.error?.kind).toBe('slippage');
  });

  it('stops at once when the endpoint refuses the transaction', async () => {
    fakeSend(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Missing tip' } }), { status: 200 }));
    const { conn, raw } = fakeRpc();
    const out = await sendAndConfirm({ conn, sendUrl: 'https://send.example', rawTx: 'AAAA', signature: 'S5', lastValidBlockHeight: 1_000 });
    expect(out.status).toBe('rejected');
    expect(out.error?.message).toMatch(/Missing tip/);
    expect(raw.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it('keeps watching after a network error, since the send may have gone out', async () => {
    fakeSend((n) => {
      if (n === 1) throw new TypeError('Failed to fetch');
      return ok();
    });
    const { conn } = fakeRpc({ statuses: (n) => (n >= 4 ? { slot: 9, confirmationStatus: 'confirmed', err: null } : null) });
    const out = await sendAndConfirm({ conn, sendUrl: 'https://send.example', rawTx: 'AAAA', signature: 'S6', lastValidBlockHeight: 1_000 });
    expect(out.status).toBe('confirmed');
  });
});

describe('TradeEngine live sending', () => {
  const endpoints = { rpcUrl: 'https://rpc.example/', wsUrl: 'wss://rpc.example/', senderApiKey: null, customSendUrl: null };

  function liveEngine(statuses: (n: number) => Status) {
    const base = replay(pool) as unknown as Record<string, (k: PublicKey) => unknown>;
    const has = (k: PublicKey) => k.toBase58() in pool.accounts;
    const rpc = fakeRpc({ statuses });
    const conn = {
      ...base,
      ...rpc.raw,
      rpcEndpoint: endpoints.rpcUrl,
      getAccountInfo: async (k: PublicKey) => (has(k) ? base.getAccountInfo!(k) : null),
      getMultipleAccountsInfo: async (ks: PublicKey[]) => Promise.all(ks.map((k) => (has(k) ? base.getAccountInfo!(k) : null))),
      getBalance: async () => 1_000_000_000,
      onAccountChange: () => 1,
      removeAccountChangeListener: async () => {},
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
    } as unknown as Connection;
    const toasts: ({ tab: number | undefined } & Toast)[] = [];
    const log: TradeLogEntry[] = [];
    const engine = new TradeEngine(conn, Keypair.generate(), endpoints, { market: () => {}, toast: (tab, t) => toasts.push({ tab, ...t }) }, {
      loadCu: async () => undefined,
      saveCu: async () => {},
      appendTradeLog: async (e) => void log.push(e),
    });
    return { engine, toasts, log, rpc, conn };
  }

  const live = (patch: Partial<Settings> = {}): Settings => {
    const s = defaultSettings();
    return { ...s, ...patch, safety: { ...s.safety, dryRun: false } };
  };

  it('sends the signed transaction to Sender (Eco = swqos_only), then reports it landed', async () => {
    const f = fakeSend(() => ok());
    const { engine, toasts, log } = liveEngine((n) => (n >= 3 ? { slot: 555, confirmationStatus: 'confirmed', err: null } : null));
    const settings = live();
    const view = await engine.markets.watch(pool.address, 3);
    const res = await engine.trade({ side: 'buy', amount: 0.05, presetIndex: null, mint: view.mint, tier: 'eco', clickedAt: Date.now(), tabId: 3 }, settings, activeProfile(settings));
    expect(res.kind).toBe('sent');

    const [url] = f.mock.calls[0]! as unknown as [string];
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(SENDER.globalUrl);
    expect(u.searchParams.get('swqos_only')).toBe('true');
    expect(u.searchParams.get('mev-protect')).toBe('true');
    expect(u.searchParams.has('api-key')).toBe(false);

    const tx = VersionedTransaction.deserialize(Buffer.from(bodyOf(f.mock.calls[0]!).params[0], 'base64'));
    expect(res.kind === 'sent' && res.signature).toBe(bs58.encode(tx.signatures[0]!));
    expect(tx.message.staticAccountKeys.some((k) => (SENDER.tipAccounts as readonly string[]).includes(k.toBase58()))).toBe(true);

    await Promise.all([...engine.pending]);
    await vi.waitFor(() => expect(toasts.at(-1)).toMatchObject({ text: 'Landed', hover: 'Slot 555', sound: 'landed' }));
    expect(toasts.at(-1)?.detail).toMatch(/^in block \d+\.\ds · confirmed \d+\.\ds$/);
    expect(toasts.at(-1)?.tab).toBe(3);
    await vi.waitFor(() => expect(log).toHaveLength(1));
    expect(log[0]).toMatchObject({ status: 'confirmed', slot: 555, side: 'buy', tier: 'eco', venue: 'PUMPSWAP' });
    expect(log[0]!.clickToSentMs).not.toBeNull();
    await vi.waitFor(() => expect(engine.cu.limit('PUMPSWAP:buy+ata')).toBe(Math.ceil(88_000 * 1.15)));
    engine.dispose();
  });

  it('books a landed trade in the ledger and shows it in the panel view', async () => {
    const f = fakeSend(() => ok());
    const { engine, rpc, toasts } = liveEngine((n) => (n >= 2 ? { slot: 900, confirmationStatus: 'confirmed', err: null } : null));
    const views: { pnlSol: number | null; boughtSol: number | null; feesSavedSol: number }[] = [];
    const settings = live();
    const view = await engine.markets.watch(pool.address, 1);
    // Capture market pushes to the tab.
    (engine.markets as unknown as { onUpdate: (v: (typeof views)[number]) => void }).onUpdate = (v) => views.push(v);

    const FEE = 5_000 + 9_000;
    const TIP = 1_000_000;
    const RENT = 2_039_280;
    const SPEND = 50_000_000;
    rpc.raw.getTransaction.mockImplementation(async () => {
      const sent = VersionedTransaction.deserialize(Buffer.from(bodyOf(f.mock.calls[0]!).params[0], 'base64'));
      const keys = sent.message.staticAccountKeys.map((k) => k.toBase58());
      const user = keys[0]!;
      const mint = new PublicKey(view.mint);
      const tokenProgram = new PublicKey(pool.accounts[view.mint]!.owner);
      const ata = getAssociatedTokenAddressSync(mint, new PublicKey(user), true, tokenProgram).toBase58();
      const pre = keys.map(() => 0);
      const post = keys.map(() => 0);
      pre[0] = 1_000_000_000;
      post[0] = 1_000_000_000 - SPEND - FEE - TIP - RENT;
      post[keys.indexOf(ata)] = RENT;
      post[keys.findIndex((k) => (SENDER.tipAccounts as readonly string[]).includes(k))] = TIP;
      return {
        slot: 900,
        blockTime: 1_700_000_000,
        transaction: { signatures: [bs58.encode(sent.signatures[0]!)], message: sent.message },
        meta: {
          fee: FEE,
          err: null,
          preBalances: pre,
          postBalances: post,
          preTokenBalances: [],
          postTokenBalances: [{ accountIndex: keys.indexOf(ata), mint: view.mint, owner: user, uiTokenAmount: { amount: '741371611', decimals: view.decimals, uiAmount: null, uiAmountString: '' } }],
          loadedAddresses: { writable: [], readonly: [] },
          computeUnitsConsumed: 107_000,
        },
      } as never;
    });

    await engine.trade({ side: 'buy', amount: 0.05, presetIndex: null, mint: view.mint, tier: 'fast', clickedAt: Date.now(), tabId: 1 }, settings, activeProfile(settings));
    await Promise.all([...engine.pending]);
    await vi.waitFor(() => expect(engine.ledger.position(view.mint)?.buys).toBe(1));
    const pos = engine.ledger.position(view.mint)!;
    expect(pos).toMatchObject({ boughtLamports: SPEND, feesLamports: FEE, tipsLamports: TIP, rentLamports: RENT, tokensRaw: '741371611' });
    expect(engine.ledger.feesAvoidedLamports()).toBe(SPEND / 100);
    await vi.waitFor(() => expect(toasts.at(-1)?.text).toMatch(/^Bought .* for 0\.05 SOL$/));
    // The panel was pushed a view with the position (the wallet holds 0 here, so PnL = -bought).
    await vi.waitFor(() => expect(views.at(-1)?.boughtSol).toBe(0.05));
    expect(views.at(-1)?.pnlSol).toBe(-0.05);
    expect(views.at(-1)?.feesSavedSol).toBe(0.0005);
    engine.dispose();
  });

  it('sweep sends balance minus the fee to the main wallet via your RPC', async () => {
    const f = fakeSend(() => ok());
    const { engine, conn } = liveEngine(() => ({ slot: 2, confirmationStatus: 'confirmed', err: null }));
    (conn as unknown as { getBalance: () => Promise<number> }).getBalance = async () => 123_456_789;
    const main = Keypair.generate().publicKey;
    const out = await engine.sweep(main);
    expect(out.status).toBe('confirmed');
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(endpoints.rpcUrl);
    const tx = VersionedTransaction.deserialize(Buffer.from(bodyOf(f.mock.calls[0]!).params[0], 'base64'));
    const msg = TransactionMessage.decompile(tx.message);
    const transfers = msg.instructions.filter((ix) => ix.programId.equals(SystemProgram.programId)).map((ix) => SystemInstruction.decodeTransfer(ix));
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.toPubkey.equals(main)).toBe(true);
    expect(Number(transfers[0]!.lamports)).toBe(123_456_789 - 5_000);
    await expect(engine.sweep(tx.message.staticAccountKeys[0]!)).rejects.toThrow(/this burner/);
    (conn as unknown as { getBalance: () => Promise<number> }).getBalance = async () => 4_000;
    await expect(engine.sweep(main)).rejects.toThrow(/Nothing to sweep/);
    engine.dispose();
  });

  it('plain RPC mode sends to your RPC without a Sender tip', async () => {
    const f = fakeSend(() => ok());
    const { engine } = liveEngine(() => ({ slot: 1, confirmationStatus: 'confirmed', err: null }));
    const settings = live({ sendMode: 'rpc' });
    const view = await engine.markets.watch(pool.address, 1);
    await engine.trade({ side: 'buy', amount: 0.05, presetIndex: null, mint: view.mint, tier: 'fast', clickedAt: Date.now(), tabId: 1 }, settings, activeProfile(settings));
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(endpoints.rpcUrl);
    const tx = VersionedTransaction.deserialize(Buffer.from(bodyOf(f.mock.calls[0]!).params[0], 'base64'));
    expect(tx.message.staticAccountKeys.some((k) => (SENDER.tipAccounts as readonly string[]).includes(k.toBase58()))).toBe(false);
    await Promise.all([...engine.pending]);
    engine.dispose();
  });

  it('surfaces a refusal as an error and logs it', async () => {
    fakeSend(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Rate limited' } }), { status: 429 }));
    const { engine, log } = liveEngine(() => null);
    const settings = live();
    const view = await engine.markets.watch(pool.address, 1);
    await expect(
      engine.trade({ side: 'buy', amount: 0.05, presetIndex: null, mint: view.mint, tier: 'fast', clickedAt: Date.now(), tabId: 1 }, settings, activeProfile(settings)),
    ).rejects.toThrow(/Send refused: Rate limited/);
    await vi.waitFor(() => expect(log[0]?.status).toBe('rejected'));
    engine.dispose();
  });
});
