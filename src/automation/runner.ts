// Runs automations in the worker: follows the copytrade leaders over the RPC's
// WebSocket, decodes each of their transactions, and copies them through the
// normal trade engine (same signing guard, fees and confirmation as a click),
// within the global caps. Runs only while the browser does.
import { PublicKey, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import type { Profile, Settings } from '../settings/schema';
import type { TradeEngine } from '../solana/engine';
import { decideCopy, parseLeaderTrade, withinCaps, type LeaderTrade } from './copytrade';
import type { ActivityRow, Automations, Copytrade } from './schema';

/** The pseudo-tab automations watch markets under (no page shows it). */
export const AUTOMATION_TAB = -1;

export interface RunnerDeps {
  conn: Connection;
  load(): Promise<Automations>;
  /** The engine for a config's wallet (null = the primary selected wallet). */
  engineFor(wallet: string | null): Promise<TradeEngine>;
  settings(): Promise<{ settings: Settings; profile: Profile }>;
  log(row: ActivityRow): Promise<void>;
  /** SOL spent by automatic buys today (UTC), and adding to it. */
  spentToday(): Promise<number>;
  addSpent(sol: number): Promise<void>;
  /** Copies made per automation. */
  fires(id: string): Promise<number>;
  addFire(id: string): Promise<void>;
}

export class AutomationRunner {
  private subs = new Map<string, number>();
  private seen = new Set<string>();
  /** `${automation}:${leader}:${mint}` for buys already seen, for "first buy only". */
  private leaderBuys = new Set<string>();
  private config: Automations | null = null;

  constructor(private readonly deps: RunnerDeps) {}

  /** (Re)reads the automations and follows exactly the leaders that enabled configs name. */
  async sync(): Promise<void> {
    this.config = await this.deps.load();
    const want = new Set(this.config.stopped ? [] : this.config.copytrades.filter((c) => c.enabled).flatMap((c) => c.targets));
    for (const [leader, id] of this.subs) {
      if (want.has(leader)) continue;
      void this.deps.conn.removeOnLogsListener(id).catch(() => {});
      this.subs.delete(leader);
    }
    for (const leader of want) {
      if (this.subs.has(leader)) continue;
      const id = this.deps.conn.onLogs(new PublicKey(leader), (l) => !l.err && void this.onSignature(leader, l.signature), 'confirmed');
      this.subs.set(leader, id);
    }
  }

  /** The leaders being followed now. */
  following(): string[] {
    return [...this.subs.keys()];
  }

  dispose(): void {
    for (const id of this.subs.values()) void this.deps.conn.removeOnLogsListener(id).catch(() => {});
    this.subs.clear();
  }

  private async onSignature(leader: string, signature: string): Promise<void> {
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > 5_000) this.seen.delete(this.seen.values().next().value!);
    const tx = await this.fetch(signature);
    if (tx) await this.onTransaction(leader, tx);
  }

  /** The transaction, once the RPC has it (it can lag the log notification a moment). */
  private async fetch(signature: string): Promise<VersionedTransactionResponse | null> {
    for (let i = 0; i < 6; i++) {
      const tx = await this.deps.conn.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
      if (tx?.meta) return tx;
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  }

  /** Every enabled copytrade following `leader` decides on this transaction. Exposed for tests. */
  async onTransaction(leader: string, tx: VersionedTransactionResponse): Promise<void> {
    const trade = parseLeaderTrade(tx, leader);
    const cfg = this.config;
    if (!trade || !cfg || cfg.stopped) return;
    for (const c of cfg.copytrades) {
      if (!c.enabled || !c.targets.includes(leader)) continue;
      await this.copy(cfg, c, trade).catch((e: Error) => this.record(c, trade, 'failed', e.message));
    }
  }

  private async copy(cfg: Automations, c: Copytrade, t: LeaderTrade): Promise<void> {
    const eng = await this.deps.engineFor(c.wallet);
    // Opening the coin gives us its market and our balance in it.
    await eng.markets.watch(t.mint, AUTOMATION_TAB);
    const key = `${c.id}:${t.leader}:${t.mint}`;
    const leaderBoughtBefore = this.leaderBuys.has(key);
    if (t.side === 'buy') this.leaderBuys.add(key);
    const decision = decideCopy(c, t, {
      fires: await this.deps.fires(c.id),
      leaderBoughtBefore,
      weBought: (eng.ledger.position(t.mint)?.buys ?? 0) > 0,
      weHold: !eng.markets.tokenBalance(t.mint).isZero(),
    });
    if (decision.kind === 'skip') return this.record(c, t, 'skipped', decision.reason);

    let amount = decision.kind === 'buy' ? decision.sol : decision.pct;
    let note = '';
    if (decision.kind === 'buy') {
      const caps = withinCaps(cfg, decision.sol, await this.deps.spentToday());
      if (!caps.ok) return this.record(c, t, 'skipped', caps.reason);
      amount = caps.sol;
      if (caps.trimmed) note = ` (trimmed to the ${cfg.maxSolPerTrade} SOL per-trade cap)`;
    }

    const { settings, profile } = await this.deps.settings();
    // The config's own dry run and slippage; everything else (tips, fees, caps, guard) is the profile's.
    const s: Settings = { ...settings, safety: { ...settings.safety, dryRun: settings.safety.dryRun || c.dryRun } };
    const p: Profile = { ...profile, slippagePct: c.slippagePct };
    const result = await eng.trade({ side: decision.kind, amount, mint: t.mint, tier: c.tier, presetIndex: null, clickedAt: Date.now(), tabId: AUTOMATION_TAB }, s, p);
    const what = decision.kind === 'buy' ? `Bought ${amount} SOL` : `Sold ${amount}%`;
    if (result.kind === 'simulated') return this.record(c, t, 'simulated', `${what} (dry run${result.ok ? '' : `, would fail: ${result.text}`})${note}`);
    if (decision.kind === 'buy') await this.deps.addSpent(amount);
    await this.deps.addFire(c.id);
    await this.record(c, t, 'copied', `${what}${note}`, result.kind === 'sent' ? result.signature : undefined);
  }

  private record(c: Copytrade, t: LeaderTrade, outcome: ActivityRow['outcome'], detail: string, signature?: string): Promise<void> {
    return this.deps.log({ at: Date.now(), automationId: c.id, automationName: c.name, leader: t.leader, mint: t.mint, leaderSide: t.side, leaderSol: t.sol, outcome, detail, signature });
  }
}
