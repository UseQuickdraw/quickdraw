// Turns a validated trade intent into amounts + a quote. Pure: no RPC, no key.
import BN from 'bn.js';
import { LAMPORTS_PER_SOL } from '../constants';
import type { Profile, Settings } from '../settings/schema';
import type { Market, Quote } from '../venues/types';
import { fmtCompact, fmtPct, fmtSol } from '../ui/format';

export interface TradeIntent {
  side: 'buy' | 'sell';
  /** Buy: SOL. Sell: percent of holdings. */
  amount: number;
  presetIndex: number | null;
}

export interface TradePlan {
  quote: Quote;
  slippagePct: number;
}

export function slippageFor(profile: Profile, intent: TradeIntent): number {
  const preset = intent.presetIndex === null ? null : (intent.side === 'buy' ? profile.buyPresets : profile.sellPresets)[intent.presetIndex];
  return preset?.slippagePct ?? profile.slippagePct;
}

/**
 * One wallet's share of a click that trades from `wallets` wallets. A buy's
 * amount is the total, split evenly (rounded down to the lamport, so the
 * wallets never spend more than it); a sell's percent applies to each
 * wallet's own holding, so it stays as it is.
 */
export function perWalletIntent<T extends TradeIntent>(intent: T, wallets: number): T {
  if (intent.side !== 'buy' || wallets <= 1) return intent;
  const lamports = Math.floor(Math.round(intent.amount * LAMPORTS_PER_SOL) / wallets);
  return { ...intent, amount: lamports / LAMPORTS_PER_SOL };
}

export function sellTokens(balance: BN, pct: number): BN {
  if (pct >= 100) return balance.clone();
  // Basis-point precision is plenty for preset percentages.
  return balance.muln(Math.round(pct * 100)).divn(10_000);
}

export function planTrade(market: Market, intent: TradeIntent, settings: Settings, profile: Profile, tokenBalance: BN): TradePlan {
  const slippagePct = slippageFor(profile, intent);
  if (intent.side === 'buy') {
    const lamports = new BN(Math.round(intent.amount * LAMPORTS_PER_SOL));
    return { quote: market.quoteBuy(lamports, slippagePct), slippagePct };
  }
  if (intent.amount > 100) throw new Error('Sell percent must be <= 100');
  const tokens = sellTokens(tokenBalance, intent.amount);
  if (tokens.isZero()) throw new Error('No tokens to sell');
  return { quote: market.quoteSell(tokens, slippagePct), slippagePct };
}

const sol = (lamports: BN) => fmtSol(Number(lamports.toString()) / LAMPORTS_PER_SOL);
const tok = (raw: BN, decimals: number) => fmtCompact(Number(raw.toString()) / 10 ** decimals);

export function describePlan(market: Market, { quote: q, slippagePct }: TradePlan): string {
  const d = market.mint.decimals;
  const impact = `impact incl. fees ${fmtPct(Math.max(0, q.priceImpactPct))}, slip ${fmtPct(slippagePct)}`;
  return q.side === 'buy'
    ? `Buy ${sol(q.inAmount)} SOL → ~${tok(q.out, d)} tokens (min ${tok(q.minOut, d)}, max spend ${sol(q.maxIn)} SOL, ${impact})`
    : `Sell ${tok(q.inAmount, d)} tokens → ~${sol(q.out)} SOL (min ${sol(q.minOut)}, ${impact})`;
}
