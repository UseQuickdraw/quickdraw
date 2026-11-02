// Send once, then watch for confirmation while rebroadcasting the SAME signed
// transaction until it lands or its blockhash expires. Never re-signs:
// rebroadcasting one signature is idempotent, re-signing could double-buy.
import type { Connection, SignatureStatus, TransactionError } from '@solana/web3.js';
import { decodeError, type DecodedError } from './errors';
import { SendRejectedError, sendRawTransaction } from './sender';

export interface SendRequest {
  conn: Connection;
  sendUrl: string;
  /** Base64 of the signed, serialized transaction. */
  rawTx: string;
  signature: string;
  /** From the blockhash the transaction was built with. */
  lastValidBlockHeight: number;
  /** Called once the first send was accepted (or may have been). */
  onSent?(at: number): void;
}

export interface SendOutcome {
  status: 'confirmed' | 'failed' | 'expired' | 'rejected';
  signature: string;
  slot?: number;
  error?: DecodedError;
  sentAt?: number;
  /** When it was first seen in a block ('processed'), before the cluster confirmed it. */
  inBlockAt?: number;
  settledAt: number;
  rebroadcasts: number;
}

export const TIMING = {
  pollMs: 400,
  rebroadcastMs: 1_500,
  /** How often to check whether the blockhash has expired. */
  heightCheckMs: 2_000,
  /** Hard stop even if block height can't be read. */
  maxWaitMs: 90_000,
};

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function failureReason(conn: Connection, signature: string, err: TransactionError): Promise<DecodedError> {
  // The status carries only the error code; the logs name it.
  const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
  return decodeError(err, tx?.meta?.logMessages ?? []);
}

export async function sendAndConfirm(req: SendRequest): Promise<SendOutcome> {
  const { conn, sendUrl, rawTx, signature } = req;
  let rebroadcasts = 0;
  let sentAt: number | undefined;

  try {
    await sendRawTransaction(sendUrl, rawTx);
  } catch (e) {
    if (e instanceof SendRejectedError) {
      return {
        status: 'rejected',
        signature,
        settledAt: now(),
        rebroadcasts,
        error: { kind: 'unknown', message: `Send refused: ${e.message}` },
      };
    }
    // Network error: it may have gone out. Keep watching (and rebroadcasting).
  }
  sentAt = now();
  req.onSent?.(sentAt);

  // Boxed: the WebSocket callbacks set it, which TS narrowing can't follow.
  const box: { settled: { slot?: number; err?: TransactionError | null } | null; inBlockAt?: number } = { settled: null };

  // WebSocket confirmation, with polling as the fallback (and race).
  let subId: number | null = null;
  try {
    subId = conn.onSignature(
      signature,
      (result, ctx) => {
        box.settled ??= { slot: ctx.slot, err: result.err };
      },
      'confirmed',
    );
  } catch {
    subId = null;
  }
  // Only for timing: when it first landed in a block, ahead of the votes that confirm it.
  let processedSubId: number | null = null;
  try {
    processedSubId = conn.onSignature(
      signature,
      () => {
        box.inBlockAt ??= now();
      },
      'processed',
    );
  } catch {
    processedSubId = null;
  }

  const start = now();
  let lastRebroadcast = start;
  let lastHeightCheck = start;
  let expired = false;
  try {
    while (!box.settled) {
      await sleep(TIMING.pollMs);
      if (box.settled) break;

      const { value } = await conn.getSignatureStatuses([signature]).catch(() => ({ value: [null] as (SignatureStatus | null)[] }));
      const s = value[0];
      if (s) box.inBlockAt ??= now();
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' || s.err)) {
        box.settled = { slot: s.slot, err: s.err };
        break;
      }

      const t = now();
      if (t - lastHeightCheck >= TIMING.heightCheckMs) {
        lastHeightCheck = t;
        const height = await conn.getBlockHeight('confirmed').catch(() => null);
        if (height !== null && height > req.lastValidBlockHeight) {
          expired = true;
          break;
        }
      }
      if (t - start > TIMING.maxWaitMs) {
        expired = true;
        break;
      }
      if (t - lastRebroadcast >= TIMING.rebroadcastMs) {
        lastRebroadcast = t;
        rebroadcasts++;
        // Same bytes, same signature. Refusals here are expected ("already processed").
        void sendRawTransaction(sendUrl, rawTx).catch(() => {});
      }
    }
  } finally {
    if (subId !== null) void conn.removeSignatureListener(subId).catch(() => {});
    if (processedSubId !== null) void conn.removeSignatureListener(processedSubId).catch(() => {});
  }

  if (expired && !box.settled) {
    // One last look: it may have landed right at the edge.
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => ({ value: [null] }));
    const s = value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' || s.err)) {
      box.settled = { slot: s.slot, err: s.err };
    } else {
      return { status: 'expired', signature, sentAt, settledAt: now(), rebroadcasts };
    }
  }

  const done = box.settled!;
  const settledAt = now();
  // Seen confirmed with no earlier sighting: it was in a block by then at the latest.
  const inBlockAt = box.inBlockAt ?? settledAt;
  if (done.err) {
    return { status: 'failed', signature, slot: done.slot, sentAt, inBlockAt, settledAt, rebroadcasts, error: await failureReason(conn, signature, done.err) };
  }
  return { status: 'confirmed', signature, slot: done.slot, sentAt, inBlockAt, settledAt, rebroadcasts };
}
