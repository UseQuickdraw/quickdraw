// Background-only. Keeps one live Market per watched mint: resolved once,
// then kept fresh over WebSocket account subscriptions so quotes on click
// are pure local work. Also tracks the wallet's SOL and token balances.
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import type { MarketView } from '../messages';
import { resolveAddress } from './resolver';
import { tokenAmount } from './tokens';
import { openMarket } from '../venues/registry';
import type { Market } from '../venues/types';
import { LAMPORTS_PER_SOL } from '../constants';
import { pnl, type Position } from '../ledger/ledger';
import { fetchTokenMeta } from './metadata';

export interface LedgerReader {
  position(mint: string): Position | undefined;
  feesAvoidedLamports(): number;
}

interface Entry {
  market: Market;
  /** Tabs currently showing this mint. */
  tabs: Set<number>;
  subs: number[];
  userAta: PublicKey;
  userAtaInfo: AccountInfo<Buffer> | null;
  lastPush: number;
  pushTimer: ReturnType<typeof setTimeout> | null;
  symbol: string | null;
  /** Bumped on every change to the market's state or the wallet's token account, so a prebuilt trade can tell it's stale. */
  version: number;
}

export type MarketListener = (view: MarketView, tabs: ReadonlySet<number>) => void;

/** Panel updates are batched at most this often (fast enough to feel live, without a render per account change). */
const PUSH_INTERVAL_MS = 100;
/**
 * Live updates (pool, token account, SOL balance) at "processed": the newest
 * state, as the sites' own charts show it, about a second sooner than
 * "confirmed". It only feeds the display and the next quote; what lands is
 * still read back at "confirmed", and slippage covers the odd rolled-back slot.
 */
const LIVE_COMMITMENT = 'processed' as const;
/** After a curve completes, how often (and how long) to look for the pool it migrates to. */
const MIGRATION_RETRY_MS = 2_000;
const MIGRATION_GIVE_UP_MS = 180_000;

export class MarketManager {
  private byMint = new Map<string, Entry>();
  private byAddress = new Map<string, string>(); // page address -> mint
  private tabMint = new Map<number, string>();
  private solLamports_: number | null = null;
  private solSub: number | null = null;

  constructor(
    private readonly conn: Connection,
    private readonly user: PublicKey,
    private readonly onUpdate: MarketListener,
    private readonly ledger?: LedgerReader,
    private readonly extras?: (m: Market) => Partial<MarketView>,
    /** The wallet's balance of a watched token changed: a trade here, or one made elsewhere. */
    private readonly onTokenChange?: (mint: string) => void,
  ) {}

  /** Push fresh views of every watched mint (e.g. after a settings change). */
  refreshAll(): void {
    for (const e of this.byMint.values()) this.push(e, true);
  }

  /** Push a fresh view of `mint` to its tabs now (e.g. after the ledger changed). */
  refresh(mint: string): void {
    const e = this.byMint.get(mint);
    if (e) this.push(e, true);
  }

  /** Resolve a page address and start watching it for `tabId` (replacing that tab's previous mint). */
  async watch(address: string, tabId: number): Promise<MarketView> {
    // A known address whose market failed to open (or was closed) is opened again.
    const known = this.byAddress.get(address);
    const mintKey = known && this.byMint.has(known) ? known : await this.open(address);
    const prev = this.tabMint.get(tabId);
    if (prev && prev !== mintKey) this.release(tabId);
    const e = this.byMint.get(mintKey)!;
    e.tabs.add(tabId);
    this.tabMint.set(tabId, mintKey);
    await this.ensureSolWatch();
    return this.view(e);
  }

  release(tabId: number): void {
    const mint = this.tabMint.get(tabId);
    this.tabMint.delete(tabId);
    if (!mint) return;
    const e = this.byMint.get(mint);
    if (!e) return;
    e.tabs.delete(tabId);
    if (e.tabs.size === 0) this.close(mint);
  }

  get(mint: string): { market: Market; userAta: PublicKey; userAtaInfo: AccountInfo<Buffer> | null } | null {
    const e = this.byMint.get(mint);
    return e ? { market: e.market, userAta: e.userAta, userAtaInfo: e.userAtaInfo } : null;
  }

  /** Changes whenever the mint's market state or the wallet's token account does; -1 when it isn't watched. */
  stateVersion(mint: string): number {
    return this.byMint.get(mint)?.version ?? -1;
  }

  /** Wallet SOL balance from the subscription, or null before the first read. */
  solLamports(): number | null {
    return this.solLamports_;
  }

  tokenBalance(mint: string): BN {
    return tokenAmount(this.byMint.get(mint)?.userAtaInfo ?? null);
  }

  /**
   * Re-resolves a mint whose venue stopped trading (curve completed). The new
   * market keeps the same watchers. The old one stays live until the new one
   * has opened (the pool can appear a few seconds after the curve completes),
   * and the user's token account is re-read so the holding carries over.
   */
  async reopen(mint: string): Promise<Market> {
    const e = this.byMint.get(mint);
    if (!e) throw new Error('Mint is not being watched');
    const [market, ataInfo] = await Promise.all([openMarket(this.conn, e.market.mint), this.conn.getAccountInfo(e.userAta, 'confirmed').catch(() => undefined)]);
    if (this.byMint.get(mint) !== e) return market; // closed meanwhile
    this.unsubscribe(e);
    e.market = market;
    if (ataInfo !== undefined) e.userAtaInfo = ataInfo;
    e.version++;
    this.subscribe(e);
    this.push(e, true);
    return e.market;
  }

  /** Mints whose completed curve we're following to its pool. */
  private readonly migrating = new Set<string>();

  /** A curve just completed: keep trying to open the pool it migrates to, so the panel moves over by itself. */
  private followMigration(e: Entry): void {
    const mint = e.market.mint.mint.toBase58();
    if (this.migrating.has(mint)) return;
    this.migrating.add(mint);
    const until = Date.now() + MIGRATION_GIVE_UP_MS;
    const attempt = async (): Promise<void> => {
      const cur = this.byMint.get(mint);
      if (!cur || cur.market.tradable()) return;
      try {
        if ((await this.reopen(mint)).tradable()) return;
      } catch {
        // Not migrated yet (no pool): try again shortly.
      }
      if (Date.now() < until) {
        await new Promise((r) => setTimeout(r, MIGRATION_RETRY_MS));
        return attempt();
      }
    };
    void attempt().finally(() => this.migrating.delete(mint));
  }

  dispose(): void {
    for (const mint of [...this.byMint.keys()]) this.close(mint);
    if (this.solSub !== null) void this.conn.removeAccountChangeListener(this.solSub).catch(() => {});
    this.solSub = null;
  }

  private async open(address: string): Promise<string> {
    const resolved = await resolveAddress(this.conn, new PublicKey(address));
    const mintKey = resolved.mint.mint.toBase58();
    this.byAddress.set(address, mintKey);
    if (this.byMint.has(mintKey)) return mintKey;

    const userAta = getAssociatedTokenAddressSync(resolved.mint.mint, this.user, true, resolved.mint.tokenProgram);
    const [market, userAtaInfo, meta] = await Promise.all([
      openMarket(this.conn, resolved.mint, resolved.hint),
      this.conn.getAccountInfo(userAta, 'confirmed'),
      fetchTokenMeta(this.conn, resolved.mint),
    ]);
    if (this.byMint.has(mintKey)) return mintKey; // a concurrent watch won the race
    const e: Entry = { market, tabs: new Set(), subs: [], userAta, userAtaInfo, lastPush: 0, pushTimer: null, symbol: meta?.symbol || null, version: 0 };
    this.byMint.set(mintKey, e);
    this.subscribe(e);
    return mintKey;
  }

  private subscribe(e: Entry): void {
    for (const key of e.market.watchAccounts()) {
      e.subs.push(
        this.conn.onAccountChange(
          key,
          (info) => {
            e.market.apply(key, info);
            e.version++;
            this.push(e);
            if (!e.market.tradable() && e.market.venue.startsWith('PUMP_CURVE')) this.followMigration(e);
          },
          { commitment: LIVE_COMMITMENT },
        ),
      );
    }
    e.subs.push(
      this.conn.onAccountChange(
        e.userAta,
        (info) => {
          const before = tokenAmount(e.userAtaInfo);
          e.userAtaInfo = info.data.length ? info : null;
          e.version++;
          this.push(e, true);
          if (!tokenAmount(e.userAtaInfo).eq(before)) this.onTokenChange?.(e.market.mint.mint.toBase58());
        },
        { commitment: LIVE_COMMITMENT },
      ),
    );
  }

  private unsubscribe(e: Entry): void {
    for (const id of e.subs) void this.conn.removeAccountChangeListener(id).catch(() => {});
    e.subs = [];
    if (e.pushTimer) clearTimeout(e.pushTimer);
    e.pushTimer = null;
  }

  private close(mint: string): void {
    const e = this.byMint.get(mint);
    if (!e) return;
    this.unsubscribe(e);
    this.byMint.delete(mint);
    for (const [addr, m] of this.byAddress) if (m === mint) this.byAddress.delete(addr);
  }

  private async ensureSolWatch(): Promise<void> {
    if (this.solSub !== null) return;
    this.solSub = this.conn.onAccountChange(
      this.user,
      (info) => {
        this.solLamports_ = info.lamports;
        for (const e of this.byMint.values()) this.push(e, true);
      },
      { commitment: LIVE_COMMITMENT },
    );
    this.solLamports_ = await this.conn.getBalance(this.user, 'confirmed');
  }

  /** Throttled push of the panel-facing view. */
  private push(e: Entry, now = false): void {
    if (e.tabs.size === 0) return;
    const send = () => {
      e.pushTimer = null;
      e.lastPush = Date.now();
      this.onUpdate(this.view(e), e.tabs);
    };
    const wait = PUSH_INTERVAL_MS - (Date.now() - e.lastPush);
    if (now || wait <= 0) {
      if (e.pushTimer) clearTimeout(e.pushTimer);
      send();
    } else if (!e.pushTimer) {
      e.pushTimer = setTimeout(send, wait);
    }
  }

  private view(e: Entry): MarketView {
    const m = e.market;
    const raw = tokenAmount(e.userAtaInfo);
    const pos = this.ledger?.position(m.mint.mint.toBase58());
    const lamportsPerRaw = m.spotLamportsPerToken() / 10 ** m.mint.decimals;
    const p = pos ? pnl(pos, BigInt(raw.toString()), lamportsPerRaw) : null;
    return {
      mint: m.mint.mint.toBase58(),
      venue: m.venue,
      address: m.address.toBase58(),
      decimals: m.mint.decimals,
      tradable: m.tradable(),
      spotSolPerToken: m.spotLamportsPerToken() / LAMPORTS_PER_SOL,
      risks: m.mint.risks,
      tokenBalance: Number(raw.toString()) / 10 ** m.mint.decimals,
      solBalance: this.solLamports_ === null ? null : this.solLamports_ / LAMPORTS_PER_SOL,
      boughtSol: pos ? pos.boughtLamports / LAMPORTS_PER_SOL : null,
      soldSol: pos ? pos.soldLamports / LAMPORTS_PER_SOL : null,
      pnlSol: p ? p.pnlLamports / LAMPORTS_PER_SOL : null,
      pnlPct: p?.pnlPct ?? null,
      feesSavedSol: (this.ledger?.feesAvoidedLamports() ?? 0) / LAMPORTS_PER_SOL,
      symbol: e.symbol,
      ...this.extras?.(m),
    };
  }
}
