// Runs auto-sell ladders in the worker. Once a second it checks every attached
// ladder against the live market state Quickdraw already keeps (no RPC calls):
// price against the position's average entry, the peak since, and time held.
// A step that's due is removed first (so it never fires twice), then sold
// through the normal trade path. Paused while automations are stopped.
import type { Profile, Settings } from '../settings/schema';
import type { TradeEngine } from '../solana/engine';
import { averageEntry, describeStep, dueStep, type ActiveLadder, type LadderStep } from './ladder';
import { AUTOMATION_TAB } from './runner';
import type { ActivityRow } from './schema';

const TICK_MS = 1_000;
/** A ladder whose position never showed up (the buy failed or expired) is dropped after this long. */
const NO_POSITION_MS = 3 * 60_000;

export interface LadderDeps {
  load(): Promise<Record<string, ActiveLadder & { dryRun?: boolean; slippagePct?: number }>>;
  save(all: Record<string, ActiveLadder & { dryRun?: boolean; slippagePct?: number }>): Promise<void>;
  engineFor(wallet: string): Promise<TradeEngine>;
  settings(): Promise<{ settings: Settings; profile: Profile }>;
  stopped(): Promise<boolean>;
  log(row: ActivityRow): Promise<void>;
  now?(): number;
}

type Stored = ActiveLadder & { dryRun?: boolean; slippagePct?: number; sawHolding?: boolean };

export class LadderManager {
  private ladders = new Map<string, Stored>();
  private firing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(private readonly deps: LadderDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Loads the stored ladders, re-opens their coins, and starts checking. */
  async start(): Promise<void> {
    for (const [k, l] of Object.entries(await this.deps.load())) this.ladders.set(k, l);
    for (const l of this.ladders.values()) await this.watch(l).catch(() => {});
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Every ladder, for the Automations page. */
  list(): Stored[] {
    return [...this.ladders.values()];
  }

  /** Attaches `steps` to a wallet's position in `mint` (replacing any ladder already on it). */
  async attach(wallet: string, mint: string, steps: readonly LadderStep[], source: string, opts: { dryRun?: boolean; slippagePct?: number } = {}): Promise<void> {
    if (!steps.length) return;
    const l: Stored = { wallet, mint, steps: steps.map((s, i) => ({ ...s, id: `${s.id}-${i}` })), createdAt: this.now(), peak: 0, source, ...opts };
    this.ladders.set(`${wallet}:${mint}`, l);
    await this.persist();
    await this.watch(l).catch(() => {});
  }

  /** Removes a ladder (from the page). */
  async remove(wallet: string, mint: string): Promise<void> {
    this.ladders.delete(`${wallet}:${mint}`);
    await this.persist();
  }

  private async watch(l: Stored): Promise<void> {
    await (await this.deps.engineFor(l.wallet)).markets.watch(l.mint, AUTOMATION_TAB);
  }

  private async persist(): Promise<void> {
    this.dirty = false;
    await this.deps.save(Object.fromEntries(this.ladders));
  }

  /** One pass over every ladder. Exposed for tests. */
  async tick(): Promise<void> {
    if (!this.ladders.size || (await this.deps.stopped())) return;
    for (const [key, l] of this.ladders) {
      if (this.firing.has(key)) continue;
      await this.check(key, l).catch(() => {});
    }
    if (this.dirty) await this.persist();
  }

  private async check(key: string, l: Stored): Promise<void> {
    const eng = await this.deps.engineFor(l.wallet);
    const live = eng.markets.get(l.mint);
    const holding = eng.markets.tokenBalance(l.mint);
    const age = this.now() - l.createdAt;
    if (holding.isZero()) {
      // Sold out (here or elsewhere), or the buy never landed: nothing left to manage.
      if (l.sawHolding || age > NO_POSITION_MS) {
        this.ladders.delete(key);
        this.dirty = true;
      }
      return;
    }
    if (!l.sawHolding) {
      l.sawHolding = true;
      this.dirty = true;
    }
    if (!live) return;
    const entry = averageEntry(eng.ledger.position(l.mint));
    if (entry === null) return; // the buy isn't booked yet
    const spot = live.market.spotLamportsPerToken() / 1e9 / 10 ** live.market.mint.decimals; // SOL per raw unit, like `entry`
    if (spot <= 0) return;
    if (spot > l.peak) {
      l.peak = spot;
      this.dirty = true;
    }
    const step = dueStep(l.steps, { ratio: spot / entry, fromPeak: spot / l.peak, ageSec: age / 1000 });
    if (step) await this.fire(key, l, eng, step, spot / entry);
  }

  private async fire(key: string, l: Stored, eng: TradeEngine, step: LadderStep, ratio: number): Promise<void> {
    this.firing.add(key);
    // Off the ladder before the sell goes out: a step never fires twice, even if the sell fails.
    l.steps = l.steps.filter((s) => s.id !== step.id);
    if (!l.steps.length) this.ladders.delete(key);
    await this.persist();
    const row = (outcome: ActivityRow['outcome'], detail: string, signature?: string): ActivityRow => ({
      at: this.now(), automationId: 'ladder', automationName: `Auto-sell (${l.source})`, leader: '', mint: l.mint, leaderSide: 'sell', leaderSol: 0, outcome, detail, signature,
    });
    const move = `${describeStep(step)} at ${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)}%`;
    try {
      const { settings, profile } = await this.deps.settings();
      const s: Settings = { ...settings, safety: { ...settings.safety, dryRun: settings.safety.dryRun || !!l.dryRun } };
      const p: Profile = l.slippagePct ? { ...profile, slippagePct: l.slippagePct } : profile;
      const r = await eng.trade({ side: 'sell', amount: step.sellPct, mint: l.mint, tier: 'fast', presetIndex: null, clickedAt: this.now(), tabId: AUTOMATION_TAB }, s, p);
      await this.deps.log(r.kind === 'simulated' ? row('simulated', `${move} (dry run)`) : row('copied', move, r.kind === 'sent' ? r.signature : undefined));
    } catch (e) {
      await this.deps.log(row('failed', `${move}: ${(e as Error).message}`));
    } finally {
      this.firing.delete(key);
    }
  }
}
