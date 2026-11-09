// Runs automations in the worker: follows the copytrade leaders over the RPC's
// WebSocket, decodes each of their transactions, and copies them through the
// normal trade engine (same signing guard, fees and confirmation as a click),
// within the global caps. Runs only while the browser does.
import { PublicKey, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import type { Profile, Settings } from '../settings/schema';
import type { TradeEngine } from '../solana/engine';
import { bondingCurvePda } from '@pump-fun/pump-sdk';
import { PUMP_AMM_SDK } from '@pump-fun/pump-sdk/swap';
import { WSOL_MINT } from '../constants';
import { consensusReached, decideCopy, marketBlocks, parseLeaderTrade, withinCaps, type LeaderTrade } from './copytrade';
import { decodeLeaderLogs, type LogTrade } from './fastDecode';
import { PUMP_MINT_AUTHORITY, decodeLaunch, launchMisses, type Launch } from './deploy';
import type { ActivityRow, Automations, Copytrade, Deploy } from './schema';

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
  /** Attaches a config's auto-sell ladder to a copied buy. */
  attachLadder?(wallet: string, mint: string, steps: Copytrade['ladder'], source: string, opts: { dryRun: boolean; slippagePct: number }): Promise<void>;
}

export class AutomationRunner {
  private subs = new Map<string, number>();
  /** The launch feed (pump.fun's mint authority), while any deploy sniper is on. */
  private launchSub: number | null = null;
  private seen = new Set<string>();
  /** `${automation}:${leader}:${mint}` for buys already seen, for "first buy only". */
  private leaderBuys = new Set<string>();
  private config: Automations | null = null;
  /** Consensus memory per copytrade: mint -> leader -> when they bought. */
  private consensus = new Map<string, Map<string, Map<string, number>>>();
  /** Coins a consensus copytrade has already bought, so the 4th and 5th buyer don't trigger it again. */
  private consensusFired = new Set<string>();

  constructor(private readonly deps: RunnerDeps) {}

  /** (Re)reads the automations and follows exactly the leaders that enabled configs name. */
  async sync(): Promise<void> {
    this.config = await this.deps.load();
    this.syncLaunches(this.config);
    const want = new Set(this.config.stopped ? [] : this.config.copytrades.filter((c) => c.enabled).flatMap((c) => c.targets));
    for (const [leader, id] of this.subs) {
      if (want.has(leader)) continue;
      void this.deps.conn.removeOnLogsListener(id).catch(() => {});
      this.subs.delete(leader);
    }
    for (const leader of want) {
      if (this.subs.has(leader)) continue;
      // 'processed': as soon as the leader's transaction is in a block, about a second before it's confirmed.
      const id = this.deps.conn.onLogs(new PublicKey(leader), (l) => !l.err && void this.onSignature(leader, l.signature, l.logs), 'processed');
      this.subs.set(leader, id);
    }
  }

  /** Follows pump.fun launches while any deploy sniper is enabled. */
  private syncLaunches(cfg: Automations): void {
    const want = !cfg.stopped && cfg.deploys.some((d) => d.enabled);
    if (want && this.launchSub === null) {
      this.launchSub = this.deps.conn.onLogs(PUMP_MINT_AUTHORITY, (l) => !l.err && void this.onLaunch(l.signature, l.logs), 'processed');
    } else if (!want && this.launchSub !== null) {
      void this.deps.conn.removeOnLogsListener(this.launchSub).catch(() => {});
      this.launchSub = null;
    }
  }

  /** Every enabled deploy sniper checks a new coin; matches are bought. Exposed for tests. */
  async onLaunch(signature: string, logs: readonly string[]): Promise<void> {
    const cfg = this.config;
    if (!cfg || cfg.stopped || this.seen.has(signature)) return;
    this.seen.add(signature);
    const launch = decodeLaunch(signature, logs);
    if (!launch) return;
    for (const d of cfg.deploys) {
      // Launches that don't match aren't logged: there are hundreds a minute.
      if (!d.enabled || launchMisses(d, launch)) continue;
      await this.snipe(cfg, d, launch).catch((e: Error) => this.recordLaunch(d, launch, 'failed', e.message));
    }
  }

  private async snipe(cfg: Automations, d: Deploy, l: Launch): Promise<void> {
    if (d.maxFires !== null && (await this.deps.fires(d.id)) >= d.maxFires) return this.recordLaunch(d, l, 'skipped', `already sniped ${d.maxFires} (the maximum)`);
    const caps = withinCaps(cfg, d.buySol, await this.deps.spentToday());
    if (!caps.ok) return this.recordLaunch(d, l, 'skipped', caps.reason);
    const eng = await this.deps.engineFor(d.wallet);
    // A coin this new can take a moment to show up at the RPC's 'confirmed' reads.
    let view = null;
    for (let i = 0; i < 6 && !view; i++) {
      view = await eng.markets.watch(l.bondingCurve, AUTOMATION_TAB).catch(() => null);
      if (!view) await new Promise((r) => setTimeout(r, 500));
    }
    if (!view) return this.recordLaunch(d, l, 'failed', "the new coin's curve didn't show up at the RPC in time");
    if (d.skipRisky && view.risks?.length) return this.recordLaunch(d, l, 'skipped', "the coin's creator can freeze or take back tokens");
    const { settings, profile } = await this.deps.settings();
    const s: Settings = { ...settings, safety: { ...settings.safety, dryRun: settings.safety.dryRun || d.dryRun } };
    const p: Profile = { ...profile, slippagePct: d.slippagePct };
    const r = await eng.trade({ side: 'buy', amount: caps.sol, mint: l.mint, tier: d.tier, presetIndex: null, clickedAt: Date.now(), tabId: AUTOMATION_TAB }, s, p);
    const what = `Bought ${caps.sol} SOL of ${l.symbol || l.name}${caps.trimmed ? ` (trimmed to the ${cfg.maxSolPerTrade} SOL per-trade cap)` : ''}`;
    if (r.kind === 'simulated') return this.recordLaunch(d, l, 'simulated', `${what} (dry run${r.ok ? '' : `, would fail: ${r.text}`})`);
    await this.deps.addSpent(caps.sol);
    await this.deps.addFire(d.id);
    if (d.ladder.length) await this.deps.attachLadder?.(eng.wallet, l.mint, d.ladder, d.name, { dryRun: d.dryRun, slippagePct: d.slippagePct }).catch(() => {});
    await this.recordLaunch(d, l, 'copied', what, r.kind === 'sent' ? r.signature : undefined);
  }

  private recordLaunch(d: Deploy, l: Launch, outcome: ActivityRow['outcome'], detail: string, signature?: string): Promise<void> {
    return this.deps.log({ at: Date.now(), automationId: d.id, automationName: d.name, leader: l.creator, mint: l.mint, leaderSide: 'buy', leaderSol: l.devBuySol, outcome, detail, signature });
  }

  /** The leaders being followed now. */
  following(): string[] {
    return [...this.subs.keys()];
  }

  dispose(): void {
    for (const id of this.subs.values()) void this.deps.conn.removeOnLogsListener(id).catch(() => {});
    this.subs.clear();
    if (this.launchSub !== null) void this.deps.conn.removeOnLogsListener(this.launchSub).catch(() => {});
    this.launchSub = null;
  }

  private async onSignature(leader: string, signature: string, logs: readonly string[] = []): Promise<void> {
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > 5_000) this.seen.delete(this.seen.values().next().value!);
    // Fast path: a pump.fun or PumpSwap trade read straight from the logs. Otherwise fetch the transaction.
    const fast = decodeLeaderLogs(logs, leader);
    const trade = fast ? await this.fromLogs(fast, leader, signature).catch(() => null) : null;
    if (trade) return this.onTrade(trade);
    const tx = await this.fetch(signature);
    if (tx) await this.onTransaction(leader, tx);
  }

  /** PumpSwap pools' mints, read once each. */
  private poolMints = new Map<string, { base: string; quote: string }>();

  /** A trade from the logs, completed: a PumpSwap pool's coin, and a curve sell's share of the leader's holding. Null to fall back. */
  async fromLogs(f: LogTrade, leader: string, signature: string): Promise<LeaderTrade | null> {
    const base = { signature, leader, side: f.side, sol: Number(f.lamports) / 1e9, deploy: f.deploy, blockTime: Math.floor(Date.now() / 1000) };
    const pct = (sold: bigint, before: bigint) => (before > 0n ? Math.min(100, Number((sold * 10_000n) / before) / 100) : 100);
    if (f.venue === 'pumpswap') {
      let mints = this.poolMints.get(f.pool);
      if (!mints) {
        const info = await this.deps.conn.getAccountInfo(new PublicKey(f.pool), 'processed');
        if (!info) return null;
        const pool = PUMP_AMM_SDK.decodePool(info);
        mints = { base: pool.baseMint.toBase58(), quote: pool.quoteMint.toBase58() };
        this.poolMints.set(f.pool, mints);
      }
      if (mints.quote !== WSOL_MINT) return null; // priced in another token: the full transaction says more
      return { ...base, mint: mints.base, sellPct: f.side === 'sell' ? pct(f.tokens, f.holdingBefore) : null, venue: f.pool };
    }
    let sellPct: number | null = null;
    if (f.side === 'sell') {
      // The event doesn't carry the leader's holding: what's left after the sell, plus what they sold.
      const left = await this.deps.conn.getTokenAccountsByOwner(new PublicKey(leader), { mint: new PublicKey(f.mint) }, 'processed');
      const after = left.value.reduce((s, a) => s + a.account.data.readBigUInt64LE(64), 0n);
      sellPct = pct(f.tokens, after + f.tokens);
    }
    return { ...base, mint: f.mint, sellPct, venue: bondingCurvePda(f.mint).toBase58() };
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
    if (trade) await this.onTrade(trade);
  }

  /** Every enabled copytrade following this trade's leader decides on it. */
  async onTrade(trade: LeaderTrade): Promise<void> {
    const leader = trade.leader;
    const cfg = this.config;
    if (!cfg || cfg.stopped) return;
    for (const c of cfg.copytrades) {
      if (!c.enabled || !c.targets.includes(leader)) continue;
      await this.copy(cfg, c, trade).catch((e: Error) => this.record(c, trade, 'failed', e.message));
    }
  }

  private async copy(cfg: Automations, c: Copytrade, t: LeaderTrade): Promise<void> {
    const eng = await this.deps.engineFor(c.wallet);
    // Opening the coin gives us its market and our balance in it; straight from its curve or pool when the trade named it.
    const view = await eng.markets.watch(t.venue ?? t.mint, AUTOMATION_TAB);
    if (t.side === 'buy') {
      const live = eng.markets.get(t.mint);
      const supply = live ? Number(live.market.mint.supply.toString()) / 10 ** live.market.mint.decimals : 0;
      const blocked = marketBlocks(c, {
        venue: view.venue,
        mcapUsd: view.solUsd && supply ? view.spotSolPerToken * supply * view.solUsd : null,
        risky: !!view.risks?.length,
      });
      if (blocked) return this.record(c, t, 'skipped', blocked);
      if (c.consensus) {
        const seen = this.consensus.get(c.id) ?? new Map<string, Map<string, number>>();
        this.consensus.set(c.id, seen);
        const { reached, have } = consensusReached(seen, t.mint, t.leader, Date.now(), c.consensus);
        if (this.consensusFired.has(`${c.id}:${t.mint}`)) return this.record(c, t, 'skipped', 'consensus already bought this coin');
        if (!reached) return this.record(c, t, 'skipped', `consensus ${have} of ${c.consensus.count} wallets within ${c.consensus.windowSec}s`);
        this.consensusFired.add(`${c.id}:${t.mint}`);
      }
    }
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
    if (decision.kind === 'buy') {
      await this.deps.addSpent(amount);
      // The config's auto-sell ladder rides on the copied position.
      if (c.ladder.length) await this.deps.attachLadder?.(eng.wallet, t.mint, c.ladder, c.name, { dryRun: c.dryRun, slippagePct: c.slippagePct }).catch(() => {});
    }
    await this.deps.addFire(c.id);
    await this.record(c, t, 'copied', `${what}${note}`, result.kind === 'sent' ? result.signature : undefined);
  }

  private record(c: Copytrade, t: LeaderTrade, outcome: ActivityRow['outcome'], detail: string, signature?: string): Promise<void> {
    return this.deps.log({ at: Date.now(), automationId: c.id, automationName: c.name, leader: t.leader, mint: t.mint, leaderSide: t.side, leaderSol: t.sol, outcome, detail, signature });
  }
}
