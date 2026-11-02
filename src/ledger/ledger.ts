// Position accounting from landed transactions. Pure: no storage, no RPC.
//
// For one transaction, from the wallet's point of view:
//   walletDelta = trade + (-fee) + (-tip) + (-rent locked in our token accounts)
// so the SOL that actually went into (buy, negative) or came out of (sell,
// positive) the trade itself is
//   trade = walletDelta + fee + tip + Δlamports(our token accounts)
// Our WSOL account counts as one of "our token accounts": PumpSwap wraps SOL
// through it, and closing it unwraps any WSOL we already held.
import type { PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import { WSOL_MINT } from '../constants';

export interface Fill {
  signature: string;
  slot: number;
  blockTime: number | null;
  mint: string;
  side: 'buy' | 'sell' | 'none';
  /** Landed without error. Failed transactions still cost the network fee. */
  ok: boolean;
  /** SOL into (−) or out of (+) the trade, excluding fee, tip and token-account rent. */
  tradeLamports: number;
  /** Raw token amount change, signed, as a decimal string. */
  tokenDelta: string;
  decimals: number;
  feeLamports: number;
  tipLamports: number;
  /** Rent locked (+) or refunded (−) in our token accounts for this mint. */
  rentLamports: number;
  /** The wallet's SOL balance change, as an explorer shows it. */
  walletLamports: number;
}

export function parseFill(tx: VersionedTransactionResponse, user: PublicKey, mint: PublicKey, tipAccounts: readonly string[]): Fill {
  const meta = tx.meta;
  if (!meta) throw new Error('Transaction has no metadata');
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? undefined });
  const keyAt = (i: number) => keys.get(i)?.toBase58();
  const userKey = user.toBase58();
  const mintKey = mint.toBase58();
  const delta = (i: number) => (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);

  let userIdx = -1;
  for (let i = 0; i < keys.length; i++) if (keyAt(i) === userKey) userIdx = i;
  if (userIdx < 0) throw new Error('Wallet is not part of this transaction');

  const tipSet = new Set(tipAccounts);
  let tip = 0;
  for (let i = 0; i < keys.length; i++) if (tipSet.has(keyAt(i)!)) tip += Math.max(0, delta(i));

  // Our token accounts, seen before and/or after (a closed account only appears before).
  const ours = new Map<number, string>();
  for (const b of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) {
    if (b.owner === userKey) ours.set(b.accountIndex, b.mint);
  }
  let rent = 0;
  let wsol = 0;
  for (const [i, m] of ours) {
    if (m === WSOL_MINT) wsol += delta(i);
    // Rent in or out of our token accounts: the coin's, or a routed trade's quote-token account.
    else rent += delta(i);
  }

  const amount = (list: typeof meta.preTokenBalances) =>
    (list ?? []).filter((b) => b.mint === mintKey && b.owner === userKey).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  const tokenDelta = amount(meta.postTokenBalances) - amount(meta.preTokenBalances);
  const decimals = [...(meta.postTokenBalances ?? []), ...(meta.preTokenBalances ?? [])].find((b) => b.mint === mintKey)?.uiTokenAmount.decimals ?? 0;

  const fee = userIdx === 0 ? meta.fee : 0;
  const wallet = delta(userIdx);
  return {
    signature: tx.transaction.signatures[0]!,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    mint: mintKey,
    side: tokenDelta > 0n ? 'buy' : tokenDelta < 0n ? 'sell' : 'none',
    ok: meta.err === null,
    tradeLamports: wallet + fee + tip + rent + wsol,
    tokenDelta: tokenDelta.toString(),
    decimals,
    feeLamports: fee,
    tipLamports: tip,
    rentLamports: rent,
    walletLamports: wallet,
  };
}

// ----------------------------------------------------------------- positions

export interface Position {
  mint: string;
  decimals: number;
  /** SOL spent on buys (positive). */
  boughtLamports: number;
  /** SOL received from sells (positive). */
  soldLamports: number;
  /** Tokens bought minus sold through this extension (raw, decimal string). */
  tokensRaw: string;
  feesLamports: number;
  tipsLamports: number;
  /** Net rent currently locked in our token accounts for this mint. */
  rentLamports: number;
  buys: number;
  sells: number;
  firstAt: number;
  lastAt: number;
  /** Most recent fills, newest last. */
  fills: Fill[];
}

const MAX_FILLS = 200;

export function applyFill(p: Position | undefined, f: Fill, at = Date.now()): Position {
  const base: Position = p ?? {
    mint: f.mint,
    decimals: f.decimals,
    boughtLamports: 0,
    soldLamports: 0,
    tokensRaw: '0',
    feesLamports: 0,
    tipsLamports: 0,
    rentLamports: 0,
    buys: 0,
    sells: 0,
    firstAt: at,
    lastAt: at,
    fills: [],
  };
  if (base.fills.some((x) => x.signature === f.signature)) return base; // already recorded
  const next: Position = {
    ...base,
    decimals: f.decimals || base.decimals,
    feesLamports: base.feesLamports + f.feeLamports,
    tipsLamports: base.tipsLamports + f.tipLamports,
    rentLamports: base.rentLamports + f.rentLamports,
    lastAt: at,
    fills: [...base.fills, f].slice(-MAX_FILLS),
  };
  if (!f.ok || f.side === 'none') return next;
  const tokens = BigInt(base.tokensRaw) + BigInt(f.tokenDelta);
  next.tokensRaw = (tokens < 0n ? 0n : tokens).toString();
  if (f.side === 'buy') {
    next.boughtLamports += Math.max(0, -f.tradeLamports);
    next.buys++;
  } else {
    next.soldLamports += Math.max(0, f.tradeLamports);
    next.sells++;
  }
  return next;
}

export interface Pnl {
  /** Value of the tokens counted, at the given price. */
  valueLamports: number;
  /** value + sold - bought (excludes fees and tips, like most terminals). */
  pnlLamports: number;
  /** pnl / bought, in percent; null before any buy. */
  pnlPct: number | null;
  /** pnl minus fees and tips paid. */
  netLamports: number;
}

/**
 * Unrealized + realized PnL. `heldRaw` should be what's actually in the
 * wallet, capped at what this ledger accounts for (tokens bought elsewhere
 * have no cost basis here).
 */
export function pnl(p: Position, heldRaw: bigint, lamportsPerRawToken: number): Pnl {
  const counted = heldRaw < BigInt(p.tokensRaw) ? heldRaw : BigInt(p.tokensRaw);
  const valueLamports = Math.round(Number(counted) * lamportsPerRawToken);
  const pnlLamports = valueLamports + p.soldLamports - p.boughtLamports;
  return {
    valueLamports,
    pnlLamports,
    pnlPct: p.boughtLamports > 0 ? (pnlLamports / p.boughtLamports) * 100 : null,
    netLamports: pnlLamports - p.feesLamports - p.tipsLamports,
  };
}

/** The platform fee these trades would have paid elsewhere, in basis points of volume. */
export const COMPARED_PLATFORM_FEE_BPS = 100;

export function platformFeesAvoided(positions: Iterable<Position>): number {
  let volume = 0;
  for (const p of positions) volume += p.boughtLamports + p.soldLamports;
  return Math.round((volume * COMPARED_PLATFORM_FEE_BPS) / 10_000);
}
