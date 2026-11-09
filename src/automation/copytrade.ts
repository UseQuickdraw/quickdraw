// Copytrade: what a followed wallet just did, and whether (and how much) to copy it.
// Pure: no RPC, no storage. The runner feeds it transactions and state.
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { parseFill } from '../ledger/ledger';
import { WSOL_MINT } from '../constants';
import { platformOf, type Automations, type Copytrade } from './schema';

/** Quote tokens: a leader moving these alongside a coin is the price side of the trade, not the coin. */
const QUOTES = new Set([WSOL_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

export interface LeaderTrade {
  signature: string;
  leader: string;
  mint: string;
  side: 'buy' | 'sell';
  /** SOL the leader put in (buy) or took out (sell), tips included. */
  sol: number;
  /** For a sell: the share of the leader's holding sold, in percent. */
  sellPct: number | null;
  /** The leader created the coin in this transaction (its mint signed it). */
  deploy: boolean;
  blockTime: number | null;
  /** The coin's curve or pool when the trade named it, so the copy can open that market without searching. */
  venue?: string;
}

/**
 * The leader's trade in `tx`: one coin in, SOL out (a buy) or the reverse (a
 * sell). Null for anything else: transfers, failed transactions, swaps between
 * two coins, or several coins at once.
 */
export function parseLeaderTrade(tx: VersionedTransactionResponse, leader: string): LeaderTrade | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const owned = (list: typeof meta.preTokenBalances) => (list ?? []).filter((b) => b.owner === leader && !QUOTES.has(b.mint));
  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();
  for (const b of owned(meta.preTokenBalances)) pre.set(b.mint, (pre.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  for (const b of owned(meta.postTokenBalances)) post.set(b.mint, (post.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  const moved = [...new Set([...pre.keys(), ...post.keys()])].filter((m) => (post.get(m) ?? 0n) !== (pre.get(m) ?? 0n));
  if (moved.length !== 1) return null;
  const mint = moved[0]!;

  let fill;
  try {
    fill = parseFill(tx, new PublicKey(leader), new PublicKey(mint), []);
  } catch {
    return null; // the leader isn't part of it
  }
  // A real trade moves SOL against the coin: a buy spends, a sell receives.
  if (fill.side === 'none' || fill.tradeLamports === 0 || (fill.side === 'buy') !== fill.tradeLamports < 0) return null;

  const before = pre.get(mint) ?? 0n;
  const sold = -BigInt(fill.tokenDelta);
  const sellPct = fill.side === 'sell' && before > 0n ? Math.min(100, Number((sold * 10_000n) / before) / 100) : null;

  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? undefined });
  const signers = tx.transaction.message.header.numRequiredSignatures;
  let deploy = false;
  for (let i = 0; i < signers; i++) if (keys.get(i)?.toBase58() === mint) deploy = true;

  return {
    signature: tx.transaction.signatures[0]!,
    leader,
    mint,
    side: fill.side,
    sol: Math.abs(fill.tradeLamports) / 1e9,
    sellPct,
    deploy,
    blockTime: tx.blockTime ?? null,
  };
}

/** What the runner knows when deciding. */
export interface CopyContext {
  /** Copies this automation has made so far. */
  fires: number;
  /** The leader bought this coin before (seen by this automation). */
  leaderBoughtBefore: boolean;
  /** Our wallet has bought this coin before (the ledger has buys). */
  weBought: boolean;
  /** Our wallet holds the coin now. */
  weHold: boolean;
}

export type CopyDecision = { kind: 'buy'; sol: number } | { kind: 'sell'; pct: number } | { kind: 'skip'; reason: string };

const sol = (n: number) => `${+n.toFixed(4)} SOL`;

/** The copy a config makes of one leader trade, or why it doesn't. */
export function decideCopy(cfg: Copytrade, t: LeaderTrade, ctx: CopyContext): CopyDecision {
  if (t.side === 'sell') {
    if (!cfg.copySells) return { kind: 'skip', reason: 'copying sells is off' };
    if (!ctx.weHold) return { kind: 'skip', reason: "we don't hold this coin" };
    const pct = Math.max(1, Math.min(100, t.sellPct ?? 100));
    return { kind: 'sell', pct };
  }
  if (cfg.skipDeploys && t.deploy) return { kind: 'skip', reason: 'the leader created this coin' };
  if (t.sol < cfg.minTargetSol) return { kind: 'skip', reason: `the leader spent ${sol(t.sol)}, under the ${sol(cfg.minTargetSol)} minimum` };
  if (cfg.maxTargetSol !== null && t.sol > cfg.maxTargetSol) return { kind: 'skip', reason: `the leader spent ${sol(t.sol)}, over the ${sol(cfg.maxTargetSol)} maximum` };
  if (cfg.maxFires !== null && ctx.fires >= cfg.maxFires) return { kind: 'skip', reason: `already copied ${cfg.maxFires} trade${cfg.maxFires === 1 ? '' : 's'} (the maximum)` };
  if (cfg.firstBuyOnly && ctx.leaderBoughtBefore) return { kind: 'skip', reason: "not the leader's first buy of this coin" };
  if (cfg.skipIfBought && ctx.weBought) return { kind: 'skip', reason: 'we bought this coin before' };
  if (cfg.skipIfHolding && ctx.weHold) return { kind: 'skip', reason: 'we already hold this coin' };
  const size = cfg.size.mode === 'fixed' ? cfg.size.sol : Math.min(cfg.size.maxSol, (t.sol * cfg.size.pct) / 100);
  if (size < 0.0001) return { kind: 'skip', reason: `the copy would be ${sol(size)}, too small to trade` };
  return { kind: 'buy', sol: +size.toFixed(9) };
}

/** What's known about the coin once its market is open. */
export interface MarketFacts {
  venue: string;
  /** Market cap in USD, null when the SOL price isn't known yet. */
  mcapUsd: number | null;
  risky: boolean;
}

/** Why the coin's market rules a buy out, or null. Sells always go through: they get us out. */
export function marketBlocks(cfg: Copytrade, m: MarketFacts): string | null {
  if (cfg.platforms.length && !cfg.platforms.includes(platformOf(m.venue))) return `${platformOf(m.venue)} isn't one of this copytrade's platforms`;
  if (cfg.skipRisky && m.risky) return "the coin's creator can freeze or take back tokens";
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  if (m.mcapUsd !== null && cfg.minMcapUsd !== null && m.mcapUsd < cfg.minMcapUsd) return `market cap ${usd(m.mcapUsd)} is under ${usd(cfg.minMcapUsd)}`;
  if (m.mcapUsd !== null && cfg.maxMcapUsd !== null && m.mcapUsd > cfg.maxMcapUsd) return `market cap ${usd(m.mcapUsd)} is over ${usd(cfg.maxMcapUsd)}`;
  if (m.mcapUsd === null && (cfg.minMcapUsd !== null || cfg.maxMcapUsd !== null)) return "the SOL price isn't known yet, so the market cap can't be checked";
  return null;
}

/**
 * Consensus: records `leader` buying `mint` at `at` and says whether enough
 * distinct followed wallets have bought it inside the window. `seen` is the
 * config's memory (mint -> leader -> last buy time), pruned as it goes.
 */
export function consensusReached(seen: Map<string, Map<string, number>>, mint: string, leader: string, at: number, rule: { count: number; windowSec: number }): { reached: boolean; have: number } {
  const buyers = seen.get(mint) ?? new Map<string, number>();
  buyers.set(leader, at);
  for (const [l, t] of buyers) if (at - t > rule.windowSec * 1000) buyers.delete(l);
  seen.set(mint, buyers);
  return { reached: buyers.size >= rule.count, have: buyers.size };
}

/**
 * The global caps, on top of each config: a buy is trimmed to the per-trade cap,
 * and refused if it would take today's automatic spending past the daily cap.
 */
export function withinCaps(caps: Pick<Automations, 'maxSolPerTrade' | 'maxSolPerDay'>, buySol: number, spentTodaySol: number): { ok: true; sol: number; trimmed: boolean } | { ok: false; reason: string } {
  const capped = Math.min(buySol, caps.maxSolPerTrade);
  if (spentTodaySol + capped > caps.maxSolPerDay + 1e-9) {
    return { ok: false, reason: `today's automatic buys would pass the ${sol(caps.maxSolPerDay)} daily cap (${sol(spentTodaySol)} spent)` };
  }
  return { ok: true, sol: capped, trimmed: capped < buySol };
}
