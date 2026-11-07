// Background-only. Owns the per-session trading state: live markets, the
// hot caches (blockhash, priority fees, CU limits) and the click -> signed
// transaction -> simulate (dry run) or send + confirm (live) path.
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
  type Keypair,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { guardTransaction } from './guard';
import type BN from 'bn.js';
import bs58 from 'bs58';
import { PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-sdk/swap';
import { LAMPORTS_PER_SOL, SENDER } from '../constants';
import type { Endpoints, TradeResult } from '../messages';
import type { Profile, Settings, TierName } from '../settings/schema';
import { fmtCompact, fmtPct, fmtSol, shortAddr } from '../ui/format';
import type { TradeNotice } from '../notify/telegram';
import { BlockhashCache, CuCalibration, PriorityFees, capCuPrice, cuKey } from './fees';
import { activeProfile } from '../settings/profiles';
import { TooBigError, buildTrade, simulate, tipFor, type BuildInput, type BuiltTrade } from './execute';
import { PersonalTables, type PersonalTableStore } from './personalTable';
import { migratesOnComplete, migrationTarget, type Market } from '../venues/types';
import type { CuKey } from './fees';
import { MarketManager, type MarketListener } from './markets';
import { describePlan, planTrade, type TradeIntent, type TradePlan } from './trade';
import { sendAndConfirm, type SendOutcome } from './confirm';
import { pingSender, senderUrl } from './sender';
import { fetchSolUsd } from './price';
import { LedgerStore, type LedgerIO } from '../ledger/store';
import { parseFill, type Fill } from '../ledger/ledger';

const BLOCKHASH_EVERY_MS = 2_000;
const FEES_EVERY_MS = 10_000;
const PRICE_EVERY_MS = 30_000;
/** Sender recommends a ping when there's been no traffic for > 5 s. */
const PING_IDLE_MS = 5_000;

export interface TradeRequest extends TradeIntent {
  mint: string;
  tier: TierName;
  /** Epoch ms (performance.timeOrigin + performance.now()) when the user clicked. */
  clickedAt: number;
  tabId: number | undefined;
}

/** One live trade, for the latency harness and the trade log. */
export interface TradeLogEntry {
  at: number;
  /** The wallet that traded (added by the worker; older entries have none). */
  wallet?: string;
  mint: string;
  venue: string;
  side: 'buy' | 'sell';
  amount: number;
  tier: TierName;
  sendMode: Settings['sendMode'];
  status: SendOutcome['status'];
  signature: string;
  slot: number | null;
  clickToSentMs: number | null;
  sentToSettledMs: number | null;
  rebroadcasts: number;
  error: string | null;
}

export interface EngineStorage {
  loadCu(): Promise<unknown>;
  saveCu(snapshot: unknown): Promise<void>;
  appendTradeLog?(entry: TradeLogEntry): Promise<void>;
  ledger?: LedgerIO;
  /** This wallet's own lookup tables (their addresses). */
  ownTables?: PersonalTableStore;
}

/** Rent for a wallet lookup table: the table itself, then each address (rent-exempt minimums, refundable on close). */
const TABLE_RENT_SOL = 0.00128;
const TABLE_RENT_PER_ADDRESS_SOL = 0.000223;

export interface Toast {
  id: string;
  level: 'info' | 'success' | 'error';
  text: string;
  /** A second, smaller line. */
  detail?: string;
  /** Shown only on hover. */
  hover?: string;
  link?: string;
  /** A trade's on-chain result, for the panel's sound. */
  sound?: 'landed' | 'failed';
}

export interface EngineEvents {
  market: MarketListener;
  /** A status update for the tab that made the trade (sent -> landed / failed / expired). */
  toast(tabId: number | undefined, toast: Toast): void;
  /** A trade settled, or one made elsewhere was found: for Telegram alerts. */
  notice?(n: TradeNotice): void;
}

const now = () => performance.timeOrigin + performance.now();
/** How often a hovered trade is checked against the market and rebuilt if it moved, and for how long. */
const PREBUILD_EVERY_MS = 100;
const PREBUILD_FOR_MS = 15_000;

/** What a trade button would do: enough to build its transaction. */
export type PrebuildRequest = { mint: string; side: 'buy' | 'sell'; amount: number; tier: TierName; presetIndex: number | null };

/** A quoted and built (unsigned) trade, and what it was built against. */
interface Prepared {
  plan: TradePlan;
  built: BuiltTrade;
  bh: { blockhash: string; lastValidBlockHeight: number; cached: boolean };
  market: Market;
  version: number;
  cuPrice: number;
  ownTables: unknown;
  key: string;
}

/** The request plus every setting the build reads, so a settings change between hover and click forces a rebuild. */
function prebuildKey(req: PrebuildRequest, settings: Settings, profile: Profile): string {
  return JSON.stringify([req.mint, req.side, req.amount, req.tier, req.presetIndex, settings.safety, settings.sendMode, profile]);
}

function presetFor(req: PrebuildRequest, profile: Profile): { tipSol: number | null; cuPriceMicroLamports: number | null } | null {
  if (req.presetIndex === null) return null;
  return (req.side === 'buy' ? profile.buyPresets : profile.sellPresets)[req.presetIndex] ?? null;
}
/** How far back a token's history is read when it was bought outside the extension. */
const BACKFILL_LIMIT = 60;
/**
 * How far back to look after the token balance changes, and the waits before
 * each look: an RPC can take a while to list a new transaction for an address.
 */
const RESYNC_LIMIT = 10;
const RESYNC_DELAY_MS = [1500, 4000, 10_000, 25_000];
/** The base fee for a transaction with one signature. */
const NETWORK_FEE_LAMPORTS = 5_000;

/** "Sold 1.16K → 0.002 SOL", or null when the trade moved neither (a fee-only transaction). */
function describeFill(f: Fill): string | null {
  const sol = fmtSol(Math.abs(f.tradeLamports) / LAMPORTS_PER_SOL);
  const tokens = fmtCompact(Math.abs(Number(f.tokenDelta)) / 10 ** f.decimals);
  return f.side === 'buy' ? `Bought ${tokens} for ${sol} SOL` : f.side === 'sell' ? `Sold ${tokens} → ${sol} SOL` : null;
}
/** "Bought 9.7K FRIC for 0.05 SOL" / "Sold 1.2M FRIC for 0.41 SOL", or null for a fee-only transaction. */
function fillLine(f: Fill, ticker: string): string | null {
  const sol = fmtSol(Math.abs(f.tradeLamports) / LAMPORTS_PER_SOL);
  const tokens = `${fmtCompact(Math.abs(Number(f.tokenDelta)) / 10 ** f.decimals)} ${ticker}`;
  return f.side === 'buy' ? `Bought ${tokens} for ${sol} SOL` : f.side === 'sell' ? `Sold ${tokens} for ${sol} SOL` : null;
}
/** A trade found on chain this long after it happened is history, not news: no alert. */
const OUTSIDE_NOTICE_MAX_AGE_S = 30 * 60;
const fillCosts = (f: Fill) => `fee ${fmtSol(f.feeLamports / LAMPORTS_PER_SOL)} SOL · tip ${fmtSol(f.tipLamports / LAMPORTS_PER_SOL)} SOL`;
const secs = (from: number | undefined, to: number | undefined) => (from !== undefined && to !== undefined ? `${((to - from) / 1000).toFixed(1)}s` : '?');
const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;

export function sendUrlFor(settings: Settings, profile: Profile, tier: TierName, endpoints: Endpoints): string {
  switch (settings.sendMode) {
    case 'sender':
      return senderUrl({ tier, mevProtect: profile.tiers[tier].mevProtect, apiKey: endpoints.senderApiKey });
    case 'rpc':
      return endpoints.rpcUrl;
    case 'custom':
      if (!endpoints.customSendUrl) throw new Error('Send mode is "custom" but no custom send URL is set');
      return endpoints.customSendUrl;
  }
}

export class TradeEngine {
  readonly markets: MarketManager;
  private readonly backfilled = new Set<string>();
  private readonly resyncs = new Map<string, ReturnType<typeof setTimeout>>();
  private hover: { key: string; timer: ReturnType<typeof setInterval> } | null = null;
  /** Signatures this engine sent, so a resync doesn't report them as trades made elsewhere. */
  private readonly sent = new Set<string>();
  private prebuilt: Prepared | null = null;
  readonly blockhash: BlockhashCache;
  readonly fees: PriorityFees;
  cu = new CuCalibration();
  readonly ledger: LedgerStore;
  private timers: ReturnType<typeof setInterval>[] = [];
  private settings: Settings | null = null;
  private solUsd: number | null = null;
  private lastSendAt = 0;
  /** Confirmation loops still running (tests await these). */
  readonly pending = new Set<Promise<SendOutcome>>();
  private readonly own: PersonalTables;

  constructor(
    private readonly conn: Connection,
    private readonly signer: Keypair,
    private readonly endpoints: Endpoints,
    private readonly events: EngineEvents,
    private readonly storage?: EngineStorage,
  ) {
    this.ledger = new LedgerStore(storage?.ledger);
    this.markets = new MarketManager(
      conn,
      signer.publicKey,
      events.market,
      this.ledger,
      (m) => this.priorityEstimate(m),
      (mint) => this.resync(mint),
    );
    this.blockhash = new BlockhashCache(conn);
    this.fees = new PriorityFees(conn, [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]);
    this.own = new PersonalTables(conn, signer, endpoints.rpcUrl, storage?.ownTables);
  }

  setSettings(s: Settings): void {
    this.settings = s;
    this.markets.refreshAll();
  }

  /** What a buy's priority fee would cost right now, per tier, for the panel's fee row. */
  private priorityEstimate(m: Market): { priorityFeeSol?: { fast: number; eco: number }; solUsd?: number | null } {
    const s = this.settings;
    if (!s) return { solUsd: this.solUsd };
    const p = activeProfile(s);
    const limit = this.cu.limit(cuKey(m.venue, 'buy', false));
    const maxLamports = Math.floor(s.safety.maxPriorityFeeSol * LAMPORTS_PER_SOL);
    const est = (t: TierName) => {
      const c = p.tiers[t];
      const price = capCuPrice(c.cuPriceMicroLamports ?? this.fees.get(c.priorityLevel), limit, maxLamports);
      return (price * limit) / 1e6 / LAMPORTS_PER_SOL;
    };
    return { priorityFeeSol: { fast: est('fast'), eco: est('eco') }, solUsd: this.solUsd };
  }

  /**
   * What selling `pct` of the holding would bring in right now: the venue's own
   * quote (pool fee, price impact, transfer tax) less the network fee, priority
   * fee and tip the trade would pay. Null when there's nothing to sell.
   */
  quoteSell(req: { mint: string; pct: number; tier: TierName; presetIndex: number | null }, settings: Settings, profile: Profile): { outLamports: number; feesLamports: number } | null {
    const live = this.markets.get(req.mint);
    const balance = this.markets.tokenBalance(req.mint);
    if (!live || balance.isZero() || !live.market.tradable()) return null;
    const plan = planTrade(live.market, { side: 'sell', amount: req.pct, presetIndex: req.presetIndex }, settings, profile, balance);
    const preset = req.presetIndex === null ? null : profile.sellPresets[req.presetIndex];
    const close = plan.quote.inAmount.eq(balance) && settings.safety.autoCloseAta && live.market.canCloseTokenAccount?.() !== false;
    const feesLamports = this.feesFor(live.market, cuKey(live.market.venue, 'sell', close), req.tier, preset ?? null, settings, profile);
    return { outLamports: Number(plan.quote.out.toString()), feesLamports };
  }

  /**
   * What buying for `sol` would get right now: the tokens the venue's own quote
   * gives (after its fee and price impact), their value at the current price,
   * and the network fee, priority fee and tip the trade would pay on top.
   */
  quoteBuy(
    req: { mint: string; sol: number; tier: TierName; presetIndex: number | null },
    settings: Settings,
    profile: Profile,
  ): { tokens: number; valueLamports: number; feesLamports: number } | null {
    const live = this.markets.get(req.mint);
    if (!live || !live.market.tradable()) return null;
    const plan = planTrade(live.market, { side: 'buy', amount: req.sol, presetIndex: req.presetIndex }, settings, profile, this.markets.tokenBalance(req.mint));
    const preset = req.presetIndex === null ? null : profile.buyPresets[req.presetIndex];
    const feesLamports = this.feesFor(live.market, cuKey(live.market.venue, 'buy', live.userAtaInfo === null), req.tier, preset ?? null, settings, profile);
    const tokensRaw = Number(plan.quote.out.toString());
    const valueLamports = Math.round((tokensRaw * live.market.spotLamportsPerToken()) / 10 ** live.market.mint.decimals);
    return { tokens: tokensRaw / 10 ** live.market.mint.decimals, valueLamports, feesLamports };
  }

  /** Network fee, priority fee and tip for one trade, as it would be built now. */
  private feesFor(
    market: Market,
    key: CuKey,
    tier: TierName,
    preset: { tipSol: number | null; cuPriceMicroLamports: number | null } | null,
    settings: Settings,
    profile: Profile,
  ): number {
    const tierCfg = profile.tiers[tier];
    const cuLimit = Math.max(this.cu.limit(key), market.cuFloor?.() ?? 0);
    const cuPrice = capCuPrice(
      preset?.cuPriceMicroLamports ?? tierCfg.cuPriceMicroLamports ?? this.fees.get(tierCfg.priorityLevel),
      cuLimit,
      Math.floor(settings.safety.maxPriorityFeeSol * LAMPORTS_PER_SOL),
    );
    const tipSol = settings.sendMode === 'sender' ? tipFor(tier, profile, preset?.tipSol ?? null, settings.safety.maxTipSol) : 0;
    return NETWORK_FEE_LAMPORTS + Math.ceil((cuPrice * cuLimit) / 1e6) + Math.round(tipSol * LAMPORTS_PER_SOL);
  }

  /** Starts background refreshes. Errors are swallowed: the click path refetches if a cache is cold. */
  async start(): Promise<void> {
    if (this.storage) this.cu = new CuCalibration(await this.storage.loadCu().catch(() => undefined));
    await this.ledger.load();
    const quiet = (p: Promise<unknown>) => void p.catch(() => {});
    quiet(this.blockhash.refresh());
    quiet(this.fees.refresh());
    quiet(this.own.load());
    this.timers.push(setInterval(() => quiet(this.blockhash.refresh()), BLOCKHASH_EVERY_MS));
    this.timers.push(setInterval(() => quiet(this.fees.refresh()), FEES_EVERY_MS));
    const price = async () => {
      const p = await fetchSolUsd(this.conn);
      if (p !== null && p !== this.solUsd) {
        this.solUsd = p;
        this.markets.refreshAll();
      }
    };
    quiet(price());
    this.timers.push(setInterval(() => quiet(price()), PRICE_EVERY_MS));
    // Keep the TLS connection to Sender warm so the first click doesn't pay a handshake.
    this.timers.push(
      setInterval(() => {
        if (this.settings?.sendMode === 'sender' && !this.settings.safety.dryRun && now() - this.lastSendAt > PING_IDLE_MS) {
          quiet(pingSender());
        }
      }, PING_IDLE_MS),
    );
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.hover) clearInterval(this.hover.timer);
    this.hover = null;
    this.prebuilt = null;
    for (const t of this.resyncs.values()) clearTimeout(t);
    this.resyncs.clear();
    this.markets.dispose();
  }

  async trade(req: TradeRequest, settings: Settings, profile: Profile): Promise<TradeResult> {
    this.settings = settings;
    const received = now();
    let live = this.markets.get(req.mint);
    if (!live) {
      if (req.tabId === undefined) throw new Error('Token is not loaded');
      await this.markets.watch(req.mint, req.tabId);
      live = this.markets.get(req.mint)!;
    }
    // A curve can complete between clicks: re-resolve (to PumpSwap) before quoting.
    let market = live.market;
    if (!market.tradable() && migratesOnComplete(market.venue)) {
      const target = migrationTarget(market.venue);
      market = await this.markets.reopen(req.mint).catch(() => {
        throw new Error(`This coin just bonded and its ${target} pool isn't open yet. The panel switches over by itself as soon as it is: try again in a few seconds.`);
      });
    }

    const preTokens = this.markets.tokenBalance(req.mint);
    // Resolve the destination before signing, so a bad config fails without a signed tx lying around.
    const sendUrl = settings.safety.dryRun ? null : sendUrlFor(settings, profile, req.tier, this.endpoints);

    // Built while the button was hovered, against exactly this state: only signing is left.
    const ready = this.takePrebuilt(req, settings, profile, market);
    let prepared: Prepared;
    try {
      prepared = ready ?? (await this.prepare(req, settings, profile, market, live));
    } catch (e) {
      if (!(e instanceof TooBigError)) throw e;
      // A long route nobody's public tables cover: hold its accounts in this wallet's own table (once), then trade.
      const rent = TABLE_RENT_PER_ADDRESS_SOL * e.accounts.length + (this.own.current().length ? 0 : TABLE_RENT_SOL);
      if (sendUrl === null) {
        throw new Error(
          `This route is too big for one transaction until your wallet has its own lookup table for it (a one-time setup, about ${fmtSol(rent)} SOL of refundable rent). Dry run never sends anything, so turn it off to set it up.`,
        );
      }
      if (req.tabId !== undefined) this.events.toast(req.tabId, { id: `table-${req.mint}`, level: 'info', text: `Setting up this route (one time, about ${fmtSol(rent)} SOL rent)…` });
      await this.own.ensure(e.accounts);
      prepared = await this.prepare(req, settings, profile, market, live);
    }
    const { plan, built, bh } = prepared;
    built.tx.sign([this.signer]);
    const signed = now();
    const buildTiming = `click→worker ${Math.round(received - req.clickedAt)} ms · ${ready ? 'prebuilt, sign' : 'build+sign'} ${Math.round(signed - received)} ms${bh.cached ? '' : ' (blockhash fetched)'}`;

    if (sendUrl === null) return this.dryRun(req, market, plan, built, live.userAta, preTokens, signed, buildTiming);

    // ------------------------------------------------------------ live send
    const signature = bs58.encode(built.tx.signatures[0]!);
    this.sent.add(signature);
    if (this.sent.size > 500) this.sent.delete(this.sent.values().next().value!);
    const rawTx = Buffer.from(built.tx.serialize()).toString('base64');
    let markSent!: (at: number) => void;
    const sent = new Promise<number>((r) => (markSent = r));
    this.lastSendAt = now();
    const done = sendAndConfirm({
      conn: this.conn,
      sendUrl,
      // If the sender fails on its side, the same transaction goes through the user's own RPC.
      fallbackUrl: sendUrl === this.endpoints.rpcUrl ? undefined : this.endpoints.rpcUrl,
      rawTx,
      signature,
      lastValidBlockHeight: bh.lastValidBlockHeight,
      onSent: (at) => markSent(at),
    });
    this.pending.add(done);
    // A sell empties the holding the moment it lands, but is booked only once confirmed and read back: hold the PnL till then.
    if (req.side === 'sell') this.markets.holdPnl(req.mint, signature, true);

    const first = await Promise.race([sent.then((at) => ({ at })), done.then((outcome) => ({ outcome }))]);
    const log = (o: SendOutcome) =>
      void this.storage
        ?.appendTradeLog?.({
          at: Date.now(),
          mint: req.mint,
          venue: market.venue,
          side: req.side,
          amount: req.amount,
          tier: req.tier,
          sendMode: settings.sendMode,
          status: o.status,
          signature,
          slot: o.slot ?? null,
          clickToSentMs: o.sentAt ? Math.round(o.sentAt - req.clickedAt) : null,
          sentToSettledMs: o.sentAt ? Math.round(o.settledAt - o.sentAt) : null,
          rebroadcasts: o.rebroadcasts,
          error: o.error?.message ?? null,
        })
        .catch(() => {});

    if ('outcome' in first && first.outcome.status === 'rejected') {
      this.pending.delete(done);
      this.markets.holdPnl(req.mint, signature, false);
      log(first.outcome);
      throw new Error(first.outcome.error!.message);
    }
    const sentAt = 'at' in first ? first.at : (first.outcome.sentAt ?? now());

    void done
      .then(async (o) => {
        log(o);
        await this.afterSettled(req, market.venue, built.cuKey, o);
      })
      .finally(() => {
        this.pending.delete(done);
        this.markets.holdPnl(req.mint, signature, false);
      });

    const what = req.side === 'buy' ? `Buy ${fmtSol(req.amount)} SOL` : `Sell ${fmtPct(req.amount)}`;
    return {
      kind: 'sent',
      signature,
      text: `${what} sent (${req.tier === 'fast' ? 'Fast' : 'Eco'}) · waiting to land…`,
      detail: `${describePlan(market, plan)} · ${buildTiming} · click→sent ${Math.round(sentAt - req.clickedAt)} ms`,
    };
  }

  /** Quotes and builds (unsigned) one trade against the market as it is now. Throws TooBigError for a route that needs a lookup table. */
  private async prepare(
    req: PrebuildRequest,
    settings: Settings,
    profile: Profile,
    market: Market,
    live: { userAta: PublicKey; userAtaInfo: AccountInfo<Buffer> | null },
  ): Promise<Prepared> {
    const version = this.markets.stateVersion(req.mint);
    const plan = planTrade(market, req, settings, profile, this.markets.tokenBalance(req.mint));
    const cuPrice = this.cuPriceFor(req, profile);
    const bh = await this.blockhash.get();
    const ownTables = this.own.current();
    const built = await buildTrade({
      market,
      plan,
      user: this.signer.publicKey,
      userAta: live.userAta,
      userAtaInfo: live.userAtaInfo,
      tier: req.tier,
      tipSol: presetFor(req, profile)?.tipSol ?? null,
      profile,
      settings,
      blockhash: bh.blockhash,
      cuLimit: (k) => this.cu.limit(k),
      cuPrice,
      closeAfterFullSell: settings.safety.autoCloseAta,
      ownTables,
    });
    return { plan, built, bh, market, version, cuPrice, ownTables, key: prebuildKey(req, settings, profile) };
  }

  private cuPriceFor(req: PrebuildRequest, profile: Profile): number {
    const tierCfg = profile.tiers[req.tier];
    return presetFor(req, profile)?.cuPriceMicroLamports ?? tierCfg.cuPriceMicroLamports ?? this.fees.get(tierCfg.priorityLevel);
  }

  /**
   * The panel's pointer is on a trade button: build that trade now (unsigned),
   * and keep rebuilding it as the market moves, so a click only has to sign and
   * send. Null clears it. Nothing is signed here.
   */
  prebuild(req: PrebuildRequest | null, settings: Settings, profile: Profile): void {
    if (this.hover) clearInterval(this.hover.timer);
    this.hover = null;
    this.prebuilt = null;
    if (!req) return;
    const key = prebuildKey(req, settings, profile);
    const started = Date.now();
    let building = false;
    // A heavy route (up to ~85 ms a build) mustn't keep the worker busy: rebuild at most a third of the time.
    let nextAt = 0;
    const tick = async () => {
      if (building || Date.now() < nextAt) return;
      if (Date.now() - started > PREBUILD_FOR_MS) return this.prebuild(null, settings, profile);
      const live = this.markets.get(req.mint);
      if (!live || !live.market.tradable()) return;
      const p = this.prebuilt;
      if (p && p.market === live.market && p.version === this.markets.stateVersion(req.mint)) return; // still current
      building = true;
      const t0 = Date.now();
      try {
        const next = await this.prepare(req, settings, profile, live.market, live);
        if (this.hover?.key === key) this.prebuilt = next;
      } catch {
        // Nothing to prebuild (no tokens to sell, a route needing a table…): the click builds and reports it.
      } finally {
        building = false;
        nextAt = Date.now() + 2 * (Date.now() - t0);
      }
    };
    this.hover = { key, timer: setInterval(() => void tick(), PREBUILD_EVERY_MS) };
    void tick();
  }

  /** The prebuilt trade for this click, if it was built for exactly this request against the current state; used once. */
  private takePrebuilt(req: PrebuildRequest, settings: Settings, profile: Profile, market: Market): Prepared | null {
    const p = this.prebuilt;
    this.prebuilt = null;
    if (!p || p.key !== prebuildKey(req, settings, profile) || p.market !== market) return null;
    if (p.version !== this.markets.stateVersion(req.mint)) return null; // the pool or the holding moved since
    if (p.bh.blockhash !== this.blockhash.peek()?.blockhash || p.ownTables !== this.own.current()) return null;
    if (p.cuPrice !== this.cuPriceFor(req, profile)) return null;
    if (p.built.cuLimit !== Math.max(this.cu.limit(p.built.cuKey), market.cuFloor?.() ?? 0)) return null;
    return { ...p, bh: { ...p.bh, cached: true } };
  }

  private async afterSettled(req: TradeRequest, venue: string, cuKey: CuKey, o: SendOutcome): Promise<void> {
    // From send: into a block, then confirmed by the cluster's votes.
    const timing = `in block ${secs(o.sentAt, o.inBlockAt)} · confirmed ${secs(o.sentAt, o.settledAt)}`;
    const slot = `Slot ${o.slot}`;
    if (o.status === 'confirmed') {
      this.events.toast(req.tabId, { id: o.signature, level: 'success', text: 'Landed', detail: timing, hover: slot, link: solscanTx(o.signature), sound: 'landed' });
      const tx = await this.fetchLanded(o.signature);
      // Size future CU limits from what this trade actually used.
      const used = tx?.meta?.computeUnitsConsumed;
      if (used) {
        this.cu.record(cuKey, used);
        await this.storage?.saveCu(this.cu.snapshot()).catch(() => {});
      }
      const fill = tx ? await this.recordFill(tx, req.mint) : null;
      this.events.notice?.({ kind: 'landed', text: (fill && fillLine(fill, this.ticker(req.mint))) ?? `${this.tradeName(req)} landed`, signature: o.signature });
      if (fill) {
        this.events.toast(req.tabId, {
          id: o.signature,
          level: 'success',
          text: describeFill(fill) ?? 'Landed',
          detail: timing,
          hover: `${slot} · ${fillCosts(fill)}`,
          link: solscanTx(o.signature),
        });
      }
    } else if (o.status === 'failed') {
      this.events.toast(req.tabId, { id: o.signature, level: 'error', text: `Failed on chain: ${o.error!.message}`, hover: slot, link: solscanTx(o.signature), sound: 'failed' });
      this.events.notice?.({ kind: 'failed', text: `${this.tradeName(req)} failed: ${o.error!.message}`, signature: o.signature });
      // A failed transaction still paid its fee: book it.
      const tx = await this.fetchLanded(o.signature);
      // Out of compute on chain: the next click gets a higher limit (as the message says).
      if (o.error?.kind === 'compute') {
        this.cu.bump(cuKey, tx?.meta?.computeUnitsConsumed ?? this.cu.limit(cuKey));
        await this.storage?.saveCu(this.cu.snapshot()).catch(() => {});
      }
      if (tx) await this.recordFill(tx, req.mint);
      if (o.error?.kind === 'curve_complete' && migratesOnComplete(venue)) await this.markets.reopen(req.mint).catch(() => {});
    } else if (o.status === 'expired') {
      this.events.toast(req.tabId, {
        id: o.signature,
        level: 'error',
        text: `Expired, not landed (rebroadcast ${o.rebroadcasts}×). Nothing was spent. Click again if you still want it.`,
        sound: 'failed',
      });
      this.events.notice?.({ kind: 'expired', text: `${this.tradeName(req)} expired without landing. Nothing was spent.`, signature: null });
    }
  }

  /**
   * Sends all SOL (minus the network fee) to `to` through the user's own RPC.
   * Token accounts and their rent are left alone.
   */
  async sweep(to: PublicKey): Promise<SendOutcome & { lamports: number }> {
    const user = this.signer.publicKey;
    if (to.equals(user)) throw new Error('The sweep address is this burner wallet');
    const BASE_FEE = 5_000; // one signature, no priority fee
    const [balance, bh] = await Promise.all([this.conn.getBalance(user, 'confirmed'), this.conn.getLatestBlockhash('confirmed')]);
    const lamports = balance - BASE_FEE;
    if (lamports <= 0) throw new Error('Nothing to sweep');
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: user,
        recentBlockhash: bh.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }), SystemProgram.transfer({ fromPubkey: user, toPubkey: to, lamports })],
      }).compileToV0Message(),
    );
    guardTransaction(tx, { payer: user, venuePrograms: [], maxTipLamports: 0n, maxPriorityFeeLamports: 0n, requireTip: false, sweepTo: to.toBase58() });
    tx.sign([this.signer]);
    const outcome = await sendAndConfirm({
      conn: this.conn,
      sendUrl: this.endpoints.rpcUrl,
      rawTx: Buffer.from(tx.serialize()).toString('base64'),
      signature: bs58.encode(tx.signatures[0]!),
      lastValidBlockHeight: bh.lastValidBlockHeight,
    });
    return { ...outcome, lamports };
  }

  /** The landed transaction; RPCs can lag a moment behind the confirmation. */
  private async fetchLanded(signature: string): Promise<VersionedTransactionResponse | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const tx = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
      if (tx?.meta) return tx;
      await new Promise((r) => setTimeout(r, 700));
    }
    return null;
  }

  /**
   * Fills in this wallet's history for a token it holds or has traded here:
   * buys and sells made anywhere (Axiom, its TP/SL orders, other bots), read
   * from the chain, so P&L and Sell Init. know what went in and came out. Once
   * per token per session; trades already in the ledger are skipped by signature.
   */
  async backfill(mint: string): Promise<void> {
    // Already read this session: just look for anything since, in case a change was missed.
    if (this.backfilled.has(mint)) return this.resync(mint);
    if (this.markets.tokenBalance(mint).isZero() && !this.ledger.position(mint)) return;
    this.backfilled.add(mint);
    await this.syncHistory(mint, BACKFILL_LIMIT);
  }

  /**
   * The token balance changed while the coin is open, maybe from a trade made
   * elsewhere: read its latest transactions once the RPC has them. Looks again,
   * a few times and further apart, until the ledger accounts for the balance,
   * since the balance can change well before the history is indexed.
   */
  private resync(mint: string, attempt = 0): void {
    // A sell made elsewhere: hold the PnL until it's found (or we stop looking).
    if (attempt === 0 && BigInt(this.markets.tokenBalance(mint).toString()) < BigInt(this.ledger.position(mint)?.tokensRaw ?? '0')) this.markets.holdPnl(mint, 'resync', true);
    const t = this.resyncs.get(mint);
    if (t) clearTimeout(t);
    this.resyncs.set(
      mint,
      setTimeout(() => {
        this.resyncs.delete(mint);
        void this.syncHistory(mint, RESYNC_LIMIT, true).then(() => {
          if (!this.ledgerMatchesBalance(mint) && attempt + 1 < RESYNC_DELAY_MS.length) this.resync(mint, attempt + 1);
          else this.markets.holdPnl(mint, 'resync', false);
        });
      }, RESYNC_DELAY_MS[attempt]),
    );
  }

  /** The ledger's token count equals what the wallet holds, so no trade is missing (transfers aside). */
  private ledgerMatchesBalance(mint: string): boolean {
    return (this.ledger.position(mint)?.tokensRaw ?? '0') === this.markets.tokenBalance(mint).toString();
  }

  /** The coin's symbol, or its shortened address. */
  private ticker(mint: string): string {
    return this.markets.symbol(mint) ?? shortAddr(mint);
  }

  /** "Buy 0.1 SOL of FRIC" / "Sell 50% of FRIC". */
  private tradeName(req: { side: 'buy' | 'sell'; amount: number; mint: string }): string {
    return `${req.side === 'buy' ? `Buy ${fmtSol(req.amount)} SOL` : `Sell ${fmtPct(req.amount)}`} of ${this.ticker(req.mint)}`;
  }

  /**
   * Books the wallet's trades of `mint` among its last `limit` transactions;
   * returns how many were new. With `alert`, a recent one this engine didn't
   * send (an Axiom TP/SL, another bot) raises an "outside" notice.
   */
  private async syncHistory(mint: string, limit: number, alert = false): Promise<number> {
    const entry = this.markets.get(mint);
    if (!entry) return 0;
    const sigs = await this.conn.getSignaturesForAddress(entry.userAta, { limit }, 'confirmed').catch(() => []);
    const known = new Set(this.ledger.position(mint)?.fills.map((f) => f.signature) ?? []);
    let added = 0;
    // Oldest first, so positions build up in order.
    for (const s of [...sigs].reverse()) {
      if (s.err || known.has(s.signature)) continue;
      const tx = await this.conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
      if (!tx?.meta) continue;
      try {
        const fill = parseFill(tx, this.signer.publicKey, new PublicKey(mint), SENDER.tipAccounts);
        // Only trades: a transfer in or out moves tokens without SOL.
        if (fill.side === 'none' || fill.tradeLamports === 0 || (fill.side === 'buy') !== fill.tradeLamports < 0) continue;
        if (this.ledger.position(mint)?.fills.some((f) => f.signature === fill.signature)) continue; // booked meanwhile
        await this.ledger.record(fill);
        added++;
        const recent = fill.blockTime !== null && Date.now() / 1000 - fill.blockTime < OUTSIDE_NOTICE_MAX_AGE_S;
        const line = fillLine(fill, this.ticker(mint));
        if (alert && recent && line && !this.sent.has(fill.signature)) this.events.notice?.({ kind: 'outside', text: `${line} (outside Quickdraw)`, signature: fill.signature });
      } catch {
        // Not a fill for this wallet; skip it.
      }
    }
    if (added) this.markets.refresh(mint);
    return added;
  }

  private async recordFill(tx: VersionedTransactionResponse, mint: string): Promise<Fill | null> {
    try {
      const fill = parseFill(tx, this.signer.publicKey, new PublicKey(mint), SENDER.tipAccounts);
      await this.ledger.record(fill);
      this.markets.refresh(mint);
      return fill;
    } catch {
      return null;
    }
  }

  private async dryRun(
    req: TradeRequest,
    market: Market,
    plan: TradePlan,
    built: BuiltTrade,
    userAta: PublicKey,
    preTokens: BN,
    signed: number,
    buildTiming: string,
  ): Promise<TradeResult> {
    const user = this.signer.publicKey;
    const sim = await simulate(
      this.conn,
      built.tx,
      { user, userAta, preLamports: this.markets.solLamports(), preTokens },
      // A real dry run: verify our signature and use our cached blockhash, as a send would.
      { sigVerify: true, replaceRecentBlockhash: false },
    );
    const simulated = now();

    if (sim.ok && sim.unitsConsumed) {
      this.cu.record(built.cuKey, sim.unitsConsumed);
      void this.storage?.saveCu(this.cu.snapshot()).catch(() => {});
    } else if (sim.error?.kind === 'compute') {
      this.cu.bump(built.cuKey, built.cuLimit);
      void this.storage?.saveCu(this.cu.snapshot()).catch(() => {});
    } else if (sim.error?.kind === 'curve_complete' && migratesOnComplete(market.venue)) {
      void this.markets.reopen(req.mint).catch(() => {});
    } else if (sim.error?.kind === 'blockhash') {
      void this.blockhash.refresh().catch(() => {});
    }

    const timing = `${buildTiming} · simulate ${Math.round(simulated - signed)} ms`;
    const d = market.mint.decimals;
    if (!sim.ok) {
      return { kind: 'simulated', ok: false, text: `Dry run failed: ${sim.error!.message}`, detail: `${describePlan(market, plan)} · ${timing}` };
    }
    const tokens = sim.tokenDelta ? fmtCompact(Number(sim.tokenDelta.abs().toString()) / 10 ** d) : '?';
    const sol = sim.solDelta === null ? '?' : `${sim.solDelta >= 0 ? '+' : '−'}${fmtSol(Math.abs(sim.solDelta) / LAMPORTS_PER_SOL)}`;
    const what = plan.quote.side === 'buy' ? `+${tokens} tokens, ${sol} SOL` : `−${tokens} tokens, ${sol} SOL`;
    return {
      kind: 'simulated',
      ok: true,
      text: `Dry run OK: ${what} (tip ${fmtSol(Number(built.tipLamports) / LAMPORTS_PER_SOL)}, ${Math.round((sim.unitsConsumed ?? 0) / 1000)}k CU of ${Math.round(built.cuLimit / 1000)}k)`,
      detail: `${describePlan(market, plan)} · ${timing}`,
    };
  }
}
