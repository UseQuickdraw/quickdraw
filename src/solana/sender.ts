// Helius Sender helpers. Endpoints/minimums live in constants.ts (SENDER).
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { LAMPORTS_PER_SOL, SENDER } from '../constants';
import type { TierName } from '../settings/schema';
import { sendFetch } from './retryFetch';

export interface SendTarget {
  url: string;
  /** Whether this path needs a Sender tip + CU price (Sender does; plain RPC doesn't). */
  requiresTip: boolean;
}

export function senderUrl(opts: {
  tier: TierName;
  mevProtect: boolean;
  apiKey: string | null;
  base?: string;
}): string {
  const u = new URL(opts.base ?? SENDER.globalUrl);
  if (opts.tier === 'eco') u.searchParams.set('swqos_only', 'true');
  if (opts.mevProtect) u.searchParams.set('mev-protect', 'true');
  if (opts.apiKey) u.searchParams.set('api-key', opts.apiKey);
  return u.toString();
}

export function minTipSol(tier: TierName): number {
  return tier === 'fast' ? SENDER.minTipFastSol : SENDER.minTipEcoSol;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function randomTipAccount(): PublicKey {
  const i = crypto.getRandomValues(new Uint32Array(1))[0]! % SENDER.tipAccounts.length;
  return new PublicKey(SENDER.tipAccounts[i]!);
}

export function tipInstruction(from: PublicKey, tipSol: number, tier: TierName): TransactionInstruction {
  const sol = Math.max(tipSol, minTipSol(tier));
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: randomTipAccount(), lamports: solToLamports(sol) });
}

/**
 * The endpoint answered and refused the transaction (JSON-RPC error or HTTP
 * error status), so it was not forwarded. A network failure throws something
 * else: then the transaction may or may not have gone out.
 */
export class SendRejectedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SendRejectedError';
  }
}

/** POSTs a signed transaction. Returns the signature, throws SendRejectedError on refusal. */
export async function sendRawTransaction(url: string, base64Tx: string, signal?: AbortSignal): Promise<string> {
  // A 429 wasn't forwarded, so it's resent until it is (the signature is the same either way).
  const res = await sendFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'sendTransaction',
      params: [base64Tx, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
    }),
    signal,
  });
  const body = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
  if (!res.ok || !body || body.error || typeof body.result !== 'string') {
    throw new SendRejectedError(body?.error?.message ?? `Send refused (HTTP ${res.status})`, res.status);
  }
  return body.result;
}

/** Keeps the TLS connection warm between trades. Errors are ignored. */
export async function pingSender(): Promise<number | null> {
  const t = performance.now();
  try {
    const r = await fetch(SENDER.pingUrl, { method: 'GET', cache: 'no-store' });
    return r.ok ? performance.now() - t : null;
  } catch {
    return null;
  }
}
