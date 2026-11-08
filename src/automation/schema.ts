// Automations: settings for trades Quickdraw makes on its own (copytrade first).
// Stored in chrome.storage.local, apart from the click settings, and validated
// on load like them. Nothing here is a secret.
import { z } from 'zod';
import { HARD_LIMITS } from '../constants';

const Base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'not a Solana address');
const Sol = z.number().finite().nonnegative().max(HARD_LIMITS.maxTradeSol);

export const CopytradeSchema = z.object({
  kind: z.literal('copytrade'),
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(16),
  enabled: z.boolean(),
  /** New automations start simulated; trades are only sent once this is off (and the global dry run is off). */
  dryRun: z.boolean(),
  /** The wallets to copy. */
  targets: z.array(Base58).min(1).max(50),
  /** The burner that trades; null = the primary selected wallet. */
  wallet: Base58.nullable(),
  size: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('fixed'), sol: Sol.positive() }),
    /** A share of what the leader spent, capped by `maxSol`. */
    z.object({ mode: z.literal('percent'), pct: z.number().positive().max(1000), maxSol: Sol.positive() }),
  ]),
  /** Ignore the leader's buys outside this range (dust, or whale buys too big to follow). */
  minTargetSol: Sol,
  maxTargetSol: Sol.nullable(),
  /** Copies so far count toward this; null = unlimited. */
  maxFires: z.number().int().positive().nullable(),
  copySells: z.boolean(),
  skipIfBought: z.boolean(),
  skipIfHolding: z.boolean(),
  firstBuyOnly: z.boolean(),
  /** Don't copy a leader buying a coin they just created. */
  skipDeploys: z.boolean(),
  slippagePct: z.number().min(HARD_LIMITS.minSlippagePct).max(HARD_LIMITS.maxSlippagePct),
  tier: z.enum(['fast', 'eco']),
});
export type Copytrade = z.infer<typeof CopytradeSchema>;

export const AutomationsSchema = z.object({
  /** The big switch: nothing automatic trades while it's on. */
  stopped: z.boolean(),
  /** Hard caps on what automations may spend, whatever each config says. */
  maxSolPerTrade: Sol.positive(),
  maxSolPerDay: Sol.positive(),
  copytrades: z.array(CopytradeSchema).max(50),
});
export type Automations = z.infer<typeof AutomationsSchema>;

export const DEFAULT_AUTOMATIONS: Automations = { stopped: false, maxSolPerTrade: 0.5, maxSolPerDay: 2, copytrades: [] };

export function newCopytrade(id: string): Copytrade {
  return {
    kind: 'copytrade',
    id,
    name: 'copytrade',
    enabled: true,
    dryRun: true,
    targets: [],
    wallet: null,
    size: { mode: 'fixed', sol: 0.1 },
    minTargetSol: 0.1,
    maxTargetSol: null,
    maxFires: 3,
    copySells: true,
    skipIfBought: false,
    skipIfHolding: true,
    firstBuyOnly: true,
    skipDeploys: true,
    slippagePct: 15,
    tier: 'fast',
  };
}

/** Reads stored automations, falling back to the defaults when missing or malformed. */
export function parseAutomations(raw: unknown): Automations {
  const r = AutomationsSchema.safeParse(raw);
  return r.success ? r.data : structuredClone(DEFAULT_AUTOMATIONS);
}

/** One line in the activity log: a signal and what was done about it. */
export interface ActivityRow {
  at: number;
  automationId: string;
  automationName: string;
  leader: string;
  mint: string;
  /** What the leader did. */
  leaderSide: 'buy' | 'sell';
  leaderSol: number;
  outcome: 'copied' | 'simulated' | 'skipped' | 'failed';
  /** Why it was skipped or failed, or what was sent. */
  detail: string;
  signature?: string;
}
