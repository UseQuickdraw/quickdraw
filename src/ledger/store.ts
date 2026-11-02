// Persistence for positions. Storage is injected so the worker can use
// chrome.storage.local and tests can use memory.
import { z } from 'zod';
import { applyFill, platformFeesAvoided, type Fill, type Position } from './ledger';

export interface LedgerIO {
  get(): Promise<unknown>;
  set(value: unknown): Promise<void>;
}

const Int = z.number().int();
const FillSchema = z.object({
  signature: z.string(),
  slot: Int,
  blockTime: Int.nullable(),
  mint: z.string(),
  side: z.enum(['buy', 'sell', 'none']),
  ok: z.boolean(),
  tradeLamports: Int,
  tokenDelta: z.string().regex(/^-?\d+$/),
  decimals: Int,
  feeLamports: Int,
  tipLamports: Int,
  rentLamports: Int,
  walletLamports: Int,
});
const PositionSchema = z.object({
  mint: z.string(),
  decimals: Int,
  boughtLamports: Int,
  soldLamports: Int,
  tokensRaw: z.string().regex(/^\d+$/),
  feesLamports: Int,
  tipsLamports: Int,
  rentLamports: Int,
  buys: Int,
  sells: Int,
  firstAt: z.number(),
  lastAt: z.number(),
  fills: z.array(FillSchema),
});

/** Reads a stored ledger, dropping anything malformed instead of failing. */
export function parseLedger(raw: unknown): Map<string, Position> {
  const out = new Map<string, Position>();
  const positions = (raw as { positions?: unknown } | null)?.positions;
  if (!positions || typeof positions !== 'object') return out;
  for (const v of Object.values(positions)) {
    const p = PositionSchema.safeParse(v);
    if (p.success) out.set(p.data.mint, p.data);
  }
  return out;
}

export class LedgerStore {
  private positions = new Map<string, Position>();

  constructor(private readonly io?: LedgerIO) {}

  async load(): Promise<void> {
    if (this.io) this.positions = parseLedger(await this.io.get().catch(() => null));
  }

  position(mint: string): Position | undefined {
    return this.positions.get(mint);
  }

  all(): Position[] {
    return [...this.positions.values()];
  }

  feesAvoidedLamports(): number {
    return platformFeesAvoided(this.positions.values());
  }

  async record(fill: Fill): Promise<Position> {
    const next = applyFill(this.positions.get(fill.mint), fill);
    this.positions.set(fill.mint, next);
    await this.io?.set({ version: 1, positions: Object.fromEntries(this.positions) });
    return next;
  }
}
