// The auto-sell ladder: take-profit, stop-loss, trailing-stop and time-based
// sells attached to a position. Pure: which step fires, given the price against
// the position's average entry, the peak since, and how long it's been held.
import { z } from 'zod';
import type { Position } from '../ledger/ledger';

export const LadderStepSchema = z.object({
  id: z.string().min(1).max(64),
  /** tp: price up `value`% · sl: price down `value`% · trail: down `value`% from the peak since buying · time: `value` seconds after buying. */
  kind: z.enum(['tp', 'sl', 'trail', 'time']),
  value: z.number().positive().max(1_000_000),
  /** Share of the holding (at the time it fires) to sell. */
  sellPct: z.number().positive().max(100),
});
export type LadderStep = z.infer<typeof LadderStepSchema>;

/** A ladder attached to one wallet's position in one coin. */
export interface ActiveLadder {
  wallet: string;
  mint: string;
  /** Steps still to fire (a fired step is removed before its sell is sent, so it never fires twice). */
  steps: LadderStep[];
  createdAt: number;
  /** Highest price seen since it was attached, in SOL per token: the trailing stop's reference. */
  peak: number;
  /** Where it came from, for the activity log. */
  source: string;
}

export interface LadderState {
  /** Current price / average entry (1.5 = up 50%). */
  ratio: number;
  /** Current price / the peak since buying (0.8 = 20% under the peak). */
  fromPeak: number;
  ageSec: number;
}

/** The first step whose condition holds now, or null. Stop-losses and trailing stops are checked before take-profits. */
export function dueStep(steps: readonly LadderStep[], s: LadderState): LadderStep | null {
  const order: LadderStep['kind'][] = ['sl', 'trail', 'tp', 'time'];
  for (const kind of order) {
    for (const st of steps) {
      if (st.kind !== kind) continue;
      if (kind === 'tp' && s.ratio >= 1 + st.value / 100) return st;
      if (kind === 'sl' && s.ratio <= 1 - Math.min(st.value, 100) / 100) return st;
      if (kind === 'trail' && s.fromPeak <= 1 - Math.min(st.value, 100) / 100) return st;
      if (kind === 'time' && s.ageSec >= st.value) return st;
    }
  }
  return null;
}

/** Average entry price in SOL per raw token unit, from the position's landed buys; null before any. */
export function averageEntry(p: Position | undefined): number | null {
  if (!p) return null;
  let tokens = 0n;
  let lamports = 0;
  for (const f of p.fills) {
    if (!f.ok || f.side !== 'buy') continue;
    tokens += BigInt(f.tokenDelta);
    lamports += -f.tradeLamports;
  }
  return tokens > 0n && lamports > 0 ? lamports / 1e9 / Number(tokens) : null;
}

/** "TP +100% → sell 50%". */
export function describeStep(st: LadderStep): string {
  const when = st.kind === 'tp' ? `TP +${st.value}%` : st.kind === 'sl' ? `SL −${st.value}%` : st.kind === 'trail' ? `Trailing ${st.value}%` : `After ${st.value}s`;
  return `${when} → sell ${st.sellPct}%`;
}
