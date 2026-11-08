import '../src/polyfills';
import { PublicKey } from '@solana/web3.js';
import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import * as keystore from '../src/keystore/keystore';
import { WrongPasswordError } from '../src/keystore/crypto';
import {
  ContentRequest,
  PANEL_PORT,
  PageRequest,
  type EndpointTestResult,
  type Endpoints,
  type MarketView,
  type PanelEvent,
  type Result,
  type SellQuote,
  type AutomationsState,
  type BuyQuote,
  type TradeResult,
  type WalletRow,
  type WalletState,
} from '../src/messages';
import { loadPanelState, loadSettings, saveSettings, savePanelState } from '../src/settings/store';
import { activeProfile, newProfileId, setActiveProfile, upsertProfile } from '../src/settings/profiles';
import { STARTER_PROFILES, padBuyPresets, padSellPresets } from '../src/settings/defaults';
import type { Profile, Settings } from '../src/settings/schema';
import { pingSender } from '../src/solana/sender';
import { LAMPORTS_PER_SOL, SWEEP_CONFIRM_PHRASE } from '../src/constants';
import { connectionFor, dropConnection } from '../src/solana/connection';
import { TradeEngine, type TradeLogEntry } from '../src/solana/engine';
import { perWalletIntent } from '../src/solana/trade';
import { fmtSol, shortAddr } from '../src/ui/format';
import { hasOrigins } from '../src/solana/permissions';
import { TELEGRAM_ORIGIN, findChat, formatNotice, sendTelegram, wants, type TradeNotice } from '../src/notify/telegram';
import { parseLedger } from '../src/ledger/store';
import { platformFeesAvoided, type Position } from '../src/ledger/ledger';
import { AutomationRunner } from '../src/automation/runner';
import { parseAutomations, type ActivityRow } from '../src/automation/schema';

const ONBOARDED_KEY = 'onboarded';

type Sender = Browser.runtime.MessageSender;

/** Open panels, by the tab they live in. */
const ports = new Map<Browser.runtime.Port, number | undefined>();

function post(p: Browser.runtime.Port, ev: PanelEvent): void {
  try {
    p.postMessage(ev);
  } catch {
    ports.delete(p);
  }
}

function broadcast(ev: PanelEvent, tabs?: ReadonlySet<number>): void {
  for (const [p, tab] of ports) if (!tabs || (tab !== undefined && tabs.has(tab))) post(p, ev);
}

// One trading engine per (endpoints, wallet), for each wallet in use.
const engines = new Map<string, { key: string; eng: TradeEngine }>();
const CU_KEY = 'cuCalibration';
const TRADE_LOG_KEY = 'tradeLog';
const TRADE_LOG_MAX = 200;
const LEDGER_KEY = 'ledger';
/** The selected wallets as of the last trade-path call; views merge across these. */
let activeWallets: string[] = [];

/** Each wallet keeps its own ledger. The single pre-multi-wallet ledger goes to the first wallet. */
async function ledgerKeyFor(pubkey: string): Promise<string> {
  const key = `${LEDGER_KEY}:${pubkey}`;
  const got = await browser.storage.local.get([key, LEDGER_KEY]);
  if (got[key] === undefined && got[LEDGER_KEY] !== undefined && (await keystore.listWallets())[0]?.pubkey === pubkey) {
    await browser.storage.local.set({ [key]: got[LEDGER_KEY] });
    await browser.storage.local.remove(LEDGER_KEY);
  }
  return key;
}

// Engines append to one shared log; serialize the read-modify-writes.
let logQueue: Promise<unknown> = Promise.resolve();
function appendTradeLog(entry: TradeLogEntry): Promise<void> {
  const next = logQueue.then(async () => {
    const log = ((await browser.storage.local.get(TRADE_LOG_KEY))[TRADE_LOG_KEY] ?? []) as TradeLogEntry[];
    await browser.storage.local.set({ [TRADE_LOG_KEY]: [...log, entry].slice(-TRADE_LOG_MAX) });
  });
  logQueue = next.catch(() => {});
  return next;
}

async function engineFor(pubkey: string): Promise<TradeEngine> {
  const kp = await keystore.getKeypair(pubkey);
  const ep = await keystore.getEndpoints();
  if (!ep) throw new Error('No RPC configured. Open the extension options to add one.');
  const key = `${ep.rpcUrl}|${ep.wsUrl}`;
  const have = engines.get(pubkey);
  if (have?.key === key) return have.eng;
  have?.eng.dispose();
  const ledgerKey = await ledgerKeyFor(pubkey);
  const eng = new TradeEngine(
    connectionFor(ep),
    kp,
    ep,
    {
      market: (market, tabs) => onMarket(pubkey, market, tabs),
      toast: (tabId, t) => broadcast({ type: 'TOAST', ...t }, tabId === undefined ? undefined : new Set([tabId])),
      notice: (n) => void alert(pubkey, n),
    },
    {
      loadCu: async () => (await browser.storage.local.get(CU_KEY))[CU_KEY],
      saveCu: (snapshot) => browser.storage.local.set({ [CU_KEY]: snapshot }),
      ledger: {
        get: async () => (await browser.storage.local.get(ledgerKey))[ledgerKey],
        set: (value) => browser.storage.local.set({ [ledgerKey]: value }),
      },
      appendTradeLog: (entry) => appendTradeLog({ ...entry, wallet: pubkey }),
      ownTables: {
        load: async () => (await browser.storage.local.get(`ownTables:${pubkey}`))[`ownTables:${pubkey}`] as string[] | undefined,
        save: (addresses) => browser.storage.local.set({ [`ownTables:${pubkey}`]: addresses }),
      },
    },
  );
  eng.setSettings(await loadSettings());
  engines.set(pubkey, { key, eng });
  await eng.start();
  return eng;
}

/** Engines for every selected wallet, primary first; wallets no longer selected stop watching. */
async function tradeEngines(): Promise<{ pubkey: string; eng: TradeEngine }[]> {
  const active = await keystore.getActive();
  if (!active.length) throw (await keystore.needsPassword()) ? new keystore.NeedsPasswordError() : new keystore.NoWalletError();
  activeWallets = active;
  for (const [pk, e] of engines) {
    // A wallet an automation trades from stays up even when it isn't selected for clicks.
    if (!active.includes(pk) && !automationWallets.has(pk)) {
      e.eng.dispose();
      engines.delete(pk);
    }
  }
  return Promise.all(active.map(async (pubkey) => ({ pubkey, eng: await engineFor(pubkey) })));
}

/** The primary wallet's engine. */
async function tradeEngine(): Promise<TradeEngine> {
  return (await tradeEngines())[0]!.eng;
}

function eachEngine(fn: (eng: TradeEngine) => void): void {
  for (const e of engines.values()) fn(e.eng);
}

function stopMarkets(): void {
  runner?.dispose();
  runner = null;
  eachEngine((eng) => eng.dispose());
  engines.clear();
  views.clear();
  dropConnection();
}

// ------------------------------------------------------------- automations

const AUTOMATIONS_KEY = 'automations';
const ACTIVITY_KEY = 'automationActivity';
const ACTIVITY_MAX = 300;
const SPEND_KEY = 'automationSpend';
const FIRES_KEY = 'automationFires';
let runner: AutomationRunner | null = null;
/** Wallets enabled automations trade from (their engines aren't shut down with the click selection). */
let automationWallets = new Set<string>();

const utcDay = () => new Date().toISOString().slice(0, 10);
const local = async <T>(key: string): Promise<T | undefined> => (await browser.storage.local.get(key))[key] as T | undefined;

async function spentToday(): Promise<number> {
  const s = await local<{ day: string; sol: number }>(SPEND_KEY);
  return s?.day === utcDay() ? s.sol : 0;
}

/** Starts (or re-syncs) the automation runner once there's a wallet and an RPC; quietly does nothing before that. */
async function syncAutomations(): Promise<void> {
  try {
    const ep = await keystore.getEndpoints();
    if (!ep || !(await keystore.hasWallet())) return;
    runner ??= new AutomationRunner({
      conn: connectionFor(ep),
      load: async () => parseAutomations(await local(AUTOMATIONS_KEY)),
      engineFor: async (wallet) => (wallet && (await keystore.getActive()).concat((await keystore.listWallets()).map((w) => w.pubkey)).includes(wallet) ? engineFor(wallet) : tradeEngine()),
      settings: async () => {
        const settings = await loadSettings();
        return { settings, profile: activeProfile(settings) };
      },
      log: async (row: ActivityRow) => {
        const rows = (await local<ActivityRow[]>(ACTIVITY_KEY)) ?? [];
        await browser.storage.local.set({ [ACTIVITY_KEY]: [row, ...rows].slice(0, ACTIVITY_MAX) });
      },
      spentToday,
      addSpent: async (sol) => browser.storage.local.set({ [SPEND_KEY]: { day: utcDay(), sol: (await spentToday()) + sol } }),
      fires: async (id) => ((await local<Record<string, number>>(FIRES_KEY)) ?? {})[id] ?? 0,
      addFire: async (id) => {
        const f = (await local<Record<string, number>>(FIRES_KEY)) ?? {};
        await browser.storage.local.set({ [FIRES_KEY]: { ...f, [id]: (f[id] ?? 0) + 1 } });
      },
    });
    const cfg = parseAutomations(await local(AUTOMATIONS_KEY));
    automationWallets = new Set(cfg.copytrades.filter((c) => c.enabled && c.wallet).map((c) => c.wallet!));
    await runner.sync();
  } catch (e) {
    console.warn('[quickdraw] automations not started:', errorMessage(e));
  }
}

// ---- one market view across the selected wallets: balances and P&L add up
const views = new Map<string, Map<string, MarketView>>();

function onMarket(pubkey: string, view: MarketView, tabs?: ReadonlySet<number>): void {
  rememberView(pubkey, view);
  const merged = mergedView(view.mint);
  if (merged) broadcast({ type: 'MARKET', market: merged }, tabs);
}

function rememberView(pubkey: string, view: MarketView): void {
  let byWallet = views.get(view.mint);
  if (!byWallet) views.set(view.mint, (byWallet = new Map()));
  byWallet.set(pubkey, view);
}

function mergedView(mint: string): MarketView | null {
  const list = activeWallets.map((pk) => views.get(mint)?.get(pk)).filter((v): v is MarketView => !!v);
  const first = list[0];
  if (!first || list.length === 1) return first ?? null;
  const sum = (f: (v: MarketView) => number | null) => {
    const vs = list.map(f).filter((v): v is number => v !== null);
    return vs.length ? vs.reduce((a, b) => a + b, 0) : null;
  };
  const bought = sum((v) => v.boughtSol);
  const pnl = sum((v) => v.pnlSol);
  return {
    ...first,
    tokenBalance: sum((v) => v.tokenBalance) ?? 0,
    solBalance: sum((v) => v.solBalance),
    boughtSol: bought,
    soldSol: sum((v) => v.soldSol),
    pnlSol: pnl,
    pnlPct: bought && pnl !== null ? (pnl / bought) * 100 : null,
    feesSavedSol: sum((v) => v.feesSavedSol) ?? 0,
  };
}

/** The picker's rows: every wallet with its SOL balance (one RPC call). */
async function walletRows(): Promise<WalletRow[]> {
  const [wallets, active, ep] = await Promise.all([keystore.listWallets(), keystore.getActive(), keystore.getEndpoints()]);
  let lamports: (number | null)[] = wallets.map(() => null);
  if (ep && wallets.length) {
    const infos = await connectionFor(ep)
      .getMultipleAccountsInfo(wallets.map((w) => new PublicKey(w.pubkey)), 'confirmed')
      .catch(() => null);
    if (infos) lamports = infos.map((i) => i?.lamports ?? 0);
  }
  return wallets.map((w, i) => ({ ...w, selected: active.includes(w.pubkey), sol: lamports[i] === null ? null : lamports[i]! / 1e9 }));
}

async function walletState(): Promise<WalletState> {
  const [hasWallet, needsPassword, pubkey, hasEndpoints, settings, onboarded, wallets, active] = await Promise.all([
    keystore.hasWallet(),
    keystore.needsPassword(),
    keystore.getPubkey(),
    keystore.hasEndpoints(),
    loadSettings(),
    browser.storage.local.get(ONBOARDED_KEY).then((r) => r[ONBOARDED_KEY] === true),
    keystore.listWallets(),
    keystore.getActive(),
  ]);
  return { hasWallet, needsPassword, pubkey, hasEndpoints, onboarded, preview: onboarded && !hasWallet, settings, wallets, active, feesSavedSol: await feesSavedSol(wallets) };
}

/** What a 1% platform fee would have cost across every wallet's ledger (read straight from storage, no RPC). */
async function feesSavedSol(wallets: { pubkey: string }[]): Promise<number> {
  const keys = [LEDGER_KEY, ...wallets.map((w) => `${LEDGER_KEY}:${w.pubkey}`)];
  const stored = await browser.storage.local.get(keys).catch(() => ({}) as Record<string, unknown>);
  let lamports = 0;
  for (const k of keys) if (stored[k] !== undefined) lamports += platformFeesAvoided(parseLedger(stored[k]).values());
  return lamports / LAMPORTS_PER_SOL;
}

async function pushState(): Promise<void> {
  broadcast({ type: 'STATE', state: await walletState() });
}

function isExtensionPage(sender: Sender): boolean {
  if (!sender.url) return false;
  try {
    return new URL(sender.url).origin === new URL(browser.runtime.getURL('/')).origin;
  } catch {
    return false;
  }
}

function errorMessage(e: unknown): string {
  // Never echo arbitrary error objects: they could carry request payloads.
  if (e instanceof WrongPasswordError) return 'Wrong password';
  if (e instanceof keystore.NeedsPasswordError || e instanceof keystore.NoWalletError) return e.message;
  if (e instanceof Error) return e.message.slice(0, 300);
  return 'Unexpected error';
}

/**
 * One click, every selected wallet: each trades on its own (its own transaction,
 * so one can land while another fails) and reports as its own toast. A buy's
 * amount is the total across them, split evenly; a sell's % is of each wallet's holding.
 */
async function tradeAll(
  engs: { pubkey: string; eng: TradeEngine }[],
  req: Parameters<TradeEngine['trade']>[0],
  settings: Settings,
  profile: Profile,
): Promise<TradeResult> {
  const names = new Map((await keystore.listWallets()).map((w) => [w.pubkey, w.name]));
  const tabs = req.tabId === undefined ? undefined : new Set([req.tabId]);
  const share = perWalletIntent(req, engs.length);
  const results = await Promise.allSettled(engs.map((e) => e.eng.trade(share, settings, profile)));
  let ok = 0;
  let empty = 0;
  results.forEach((r, i) => {
    const name = names.get(engs[i]!.pubkey) ?? 'Wallet';
    if (r.status === 'rejected') {
      const msg = errorMessage(r.reason);
      // A sell skips wallets that hold none of the token.
      if (req.side === 'sell' && /no tokens/i.test(msg)) return void empty++;
      broadcast({ type: 'TOAST', id: `w-${engs[i]!.pubkey}-${req.clickedAt}`, level: 'error', text: `${name}: ${msg}` }, tabs);
      return;
    }
    const v = r.value;
    if (v.kind === 'sent') {
      ok++;
      broadcast({ type: 'TOAST', id: v.signature, level: 'info', text: `${name}: ${v.text}`, link: `https://solscan.io/tx/${v.signature}` }, tabs);
    } else {
      if (v.ok) ok++;
      broadcast({ type: 'TOAST', id: `w-${engs[i]!.pubkey}-${req.clickedAt}`, level: v.ok ? 'success' : 'error', text: `${name}: ${v.text}` }, tabs);
    }
  });
  const tried = engs.length - empty;
  return {
    kind: 'multi',
    ok: ok > 0,
    text:
      req.side === 'buy'
        ? `Buy ${fmtSol(req.amount)} SOL split ${fmtSol(share.amount)} each: ${ok} of ${tried} wallet${tried === 1 ? '' : 's'} ${settings.safety.dryRun ? 'simulated OK' : 'sent'}`
        : `Sell: ${ok} of ${tried} wallet${tried === 1 ? '' : 's'} ${settings.safety.dryRun ? 'simulated OK' : 'sent'}`,
    detail: empty ? `${empty} selected wallet${empty === 1 ? '' : 's'} had none to sell` : '',
  };
}

/** Two wallets' positions in one token, added together for the Ledger tab. */
function addPositions(a: Position | undefined, b: Position): Position {
  if (!a) return b;
  return {
    ...a,
    boughtLamports: a.boughtLamports + b.boughtLamports,
    soldLamports: a.soldLamports + b.soldLamports,
    tokensRaw: (BigInt(a.tokensRaw) + BigInt(b.tokensRaw)).toString(),
    feesLamports: a.feesLamports + b.feesLamports,
    tipsLamports: a.tipsLamports + b.tipsLamports,
    rentLamports: a.rentLamports + b.rentLamports,
    buys: a.buys + b.buys,
    sells: a.sells + b.sells,
    firstAt: Math.min(a.firstAt, b.firstAt),
    lastAt: Math.max(a.lastAt, b.lastAt),
    fills: [...a.fills, ...b.fills].sort((x, y) => (x.blockTime ?? 0) - (y.blockTime ?? 0)),
  };
}

async function handleContent(req: ContentRequest, sender: Sender): Promise<unknown> {
  const tabId = sender.tab?.id;
  switch (req.type) {
    case 'GET_STATE':
      return walletState();
    case 'GET_PANEL_STATE':
      return loadPanelState(req.site);
    case 'SAVE_PANEL_STATE':
      await savePanelState(req.site, req.state);
      return null;
    case 'SET_PROFILE_SLOT': {
      const s = await loadSettings();
      const existing = s.profiles[req.slot];
      let next: Settings;
      if (existing) {
        next = setActiveProfile(s, existing.id);
      } else {
        if (req.slot !== s.profiles.length) throw new Error('Create the earlier profiles first');
        const starter = STARTER_PROFILES[req.slot] ?? STARTER_PROFILES[0]!;
        const id = s.profiles.some((p) => p.id === starter.id) ? newProfileId() : starter.id;
        next = setActiveProfile(upsertProfile(s, { ...structuredClone(starter), id }), id);
      }
      const saved = await saveSettings(next);
      eachEngine((eng) => eng.setSettings(saved));
      await pushState();
      return null;
    }
    case 'SET_HOTKEYS': {
      const s = await loadSettings();
      const saved = await saveSettings({ ...s, hotkeys: { ...s.hotkeys, enabled: req.enabled } });
      eachEngine((eng) => eng.setSettings(saved));
      await pushState();
      return null;
    }
    case 'SET_PRESET_VALUES': {
      const s = await loadSettings();
      const p = activeProfile(s);
      // Only the amounts change; each preset keeps its own tier and fee overrides.
      const saved = await saveSettings(
        upsertProfile(s, {
          ...p,
          // A third row shown in the panel may add presets the profile didn't have yet.
          buyPresets: padBuyPresets(p.buyPresets, Math.max(p.buyPresets.length, req.buy.length)).map((b, i) => ({ ...b, sol: req.buy[i] ?? b.sol })),
          sellPresets: padSellPresets(p.sellPresets, Math.max(p.sellPresets.length, req.sell.length)).map((x, i) => ({ ...x, pct: req.sell[i] ?? x.pct })),
          sellSolPresets: req.sellSol ?? p.sellSolPresets,
        }),
      );
      eachEngine((eng) => eng.setSettings(saved));
      await pushState();
      return null;
    }
    case 'UPDATE_FEES': {
      const s = await loadSettings();
      const p = activeProfile(s);
      const { type: _t, tier, slippagePct, ...tierPatch } = req;
      const patch = Object.fromEntries(Object.entries(tierPatch).filter(([, v]) => v !== undefined));
      // upsertProfile validates against the schema (bounds, hard limits).
      const saved = await saveSettings(
        upsertProfile(s, { ...p, slippagePct: slippagePct ?? p.slippagePct, tiers: { ...p.tiers, [tier]: { ...p.tiers[tier], ...patch } } }),
      );
      eachEngine((eng) => eng.setSettings(saved));
      await pushState();
      return null;
    }
    case 'LIST_WALLETS':
      return walletRows();
    case 'SET_ACTIVE_WALLETS': {
      await keystore.setActive(req.pubkeys);
      await pushState();
      return walletRows();
    }
    case 'OPEN_OPTIONS':
      await browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}#${req.section ?? 'settings'}` });
      return null;
    case 'RESOLVE': {
      new PublicKey(req.address); // throws on an invalid key
      if (tabId === undefined) throw new Error('RESOLVE must come from a tab');
      const engs = await tradeEngines();
      const watched = await Promise.all(engs.map(async (e) => ({ pubkey: e.pubkey, view: await e.eng.markets.watch(req.address, tabId) })));
      watched.forEach((w) => rememberView(w.pubkey, w.view));
      // A token held or traded before: read its history (trades made elsewhere too) in the background.
      for (const [i, w] of watched.entries()) void engs[i]!.eng.backfill(w.view.mint);
      return (mergedView(watched[0]!.view.mint) ?? watched[0]!.view) satisfies MarketView;
    }
    case 'TRADE': {
      const settings = await loadSettings();
      const profile = activeProfile(settings);
      new PublicKey(req.mint); // throws on an invalid key
      const engs = await tradeEngines();
      if (engs.length === 1) return (await engs[0]!.eng.trade({ ...req, tabId }, settings, profile)) satisfies TradeResult;
      return tradeAll(engs, { ...req, tabId }, settings, profile);
    }
    case 'QUOTE_SELL': {
      const settings = await loadSettings();
      const profile = activeProfile(settings);
      // Each selected wallet sells the same % of its own holding: add them up.
      const quotes = (await tradeEngines()).map((e) => e.eng.quoteSell(req, settings, profile)).filter((q) => q !== null);
      if (!quotes.length) return null;
      const out = quotes.reduce((a, q) => a + q.outLamports, 0) / LAMPORTS_PER_SOL;
      const fees = quotes.reduce((a, q) => a + q.feesLamports, 0) / LAMPORTS_PER_SOL;
      return { outSol: out, feesSol: fees, netSol: out - fees } satisfies SellQuote;
    }
    case 'PREBUILD': {
      const settings = await loadSettings();
      const profile = activeProfile(settings);
      const engs = await tradeEngines();
      // Each wallet builds its own share, exactly as a click would split it.
      for (const e of engs) e.eng.prebuild(req.trade && perWalletIntent(req.trade, engs.length), settings, profile);
      return null;
    }
    case 'QUOTE_BUY': {
      const settings = await loadSettings();
      const profile = activeProfile(settings);
      const engs = await tradeEngines();
      // The amount is the total, split between the wallets as a click would.
      const share = perWalletIntent({ side: 'buy' as const, amount: req.sol, presetIndex: req.presetIndex }, engs.length).amount;
      const quotes = engs.map((e) => e.eng.quoteBuy({ ...req, sol: share }, settings, profile)).filter((q) => q !== null);
      if (!quotes.length) return null;
      const value = quotes.reduce((a, q) => a + q.valueLamports, 0) / LAMPORTS_PER_SOL;
      const fees = quotes.reduce((a, q) => a + q.feesLamports, 0) / LAMPORTS_PER_SOL;
      return { tokens: quotes.reduce((a, q) => a + q.tokens, 0), valueSol: value, feesSol: fees, netSol: value - fees } satisfies BuyQuote;
    }
  }
}

// ------------------------------------------------------------ Telegram alerts

/** Sent one at a time, a second apart: Telegram allows about one message a second per chat. */
let alertQueue: Promise<void> = Promise.resolve();

/** Sends a trade notice to the user's Telegram bot, if they connected one and want this kind. */
async function alert(pubkey: string, n: TradeNotice): Promise<void> {
  const notify = await keystore.getNotify().catch(() => null);
  if (!wants(notify, n.kind) || !(await hasOrigins([TELEGRAM_ORIGIN]).catch(() => false))) return;
  const wallets = await keystore.listWallets();
  // Name the wallet only when there's more than one.
  const name = wallets.length > 1 ? (wallets.find((w) => w.pubkey === pubkey)?.name ?? shortAddr(pubkey)) : null;
  const text = formatNotice(n, name);
  alertQueue = alertQueue.then(async () => {
    await sendTelegram(notify!.botToken, notify!.chatId, text).catch((e) => console.warn('[quickdraw] Telegram alert not sent:', errorMessage(e)));
    await new Promise((r) => setTimeout(r, 1_000));
  });
}

async function testEndpoints(ep: Endpoints): Promise<EndpointTestResult> {
  const out: EndpointTestResult = { rpc: { ok: false }, ws: { ok: false }, sender: { ok: false } };
  const t0 = performance.now();
  try {
    const r = await fetch(ep.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
    });
    const body = (await r.json()) as { result?: number; error?: { message?: string } };
    if (typeof body.result !== 'number') throw new Error(body.error?.message ?? `HTTP ${r.status}`);
    out.rpc = { ok: true, slot: body.result, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    out.rpc = { ok: false, error: errorMessage(e) };
  }
  const t1 = performance.now();
  out.ws = await new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(ep.wsUrl);
    } catch (e) {
      resolve({ ok: false, error: errorMessage(e) });
      return;
    }
    const timer = setTimeout(() => {
      ws.close();
      resolve({ ok: false, error: 'Timed out' });
    }, 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve({ ok: true, ms: Math.round(performance.now() - t1) });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'Connection failed' });
    };
  });
  const ms = await pingSender();
  out.sender = ms === null ? { ok: false, error: 'Ping failed' } : { ok: true, ms: Math.round(ms) };
  return out;
}

async function handlePage(req: PageRequest): Promise<unknown> {
  switch (req.type) {
    case 'WALLET_GENERATE': {
      const pubkey = await keystore.generateWallet(req.name);
      await pushState();
      return { pubkey };
    }
    case 'WALLET_PREVIEW_IMPORT':
      return { pubkey: keystore.previewImport(req.secret) };
    case 'WALLET_IMPORT': {
      const pubkey = await keystore.importWallet(req.secret, req.name);
      await pushState();
      return { pubkey };
    }
    case 'WALLET_REVEAL':
      return { secret: await keystore.revealSecret(req.pubkey) };
    case 'WALLET_EXPORT_ENCRYPTED':
      return { json: await keystore.exportEncryptedBackup(req.password, req.pubkey) };
    case 'WALLET_RENAME':
      await keystore.renameWallet(req.pubkey, req.name);
      await pushState();
      return null;
    case 'WALLET_REMOVE':
      await keystore.removeWallet(req.pubkey);
      engines.get(req.pubkey)?.eng.dispose();
      engines.delete(req.pubkey);
      await pushState();
      return null;
    case 'WALLET_DELETE':
      await keystore.deleteWallet();
      stopMarkets();
      await pushState();
      return null;
    case 'CONVERT_WALLET': {
      const pubkey = await keystore.migrateWithPassword(req.password);
      await pushState();
      return { pubkey };
    }
    case 'SET_ENDPOINTS':
      await keystore.setEndpoints(req.endpoints);
      stopMarkets();
      await pushState();
      void syncAutomations();
      return null;
    case 'GET_AUTOMATIONS':
      return {
        automations: parseAutomations(await local(AUTOMATIONS_KEY)),
        fires: (await local<Record<string, number>>(FIRES_KEY)) ?? {},
        spentTodaySol: await spentToday(),
        following: runner?.following() ?? [],
      } satisfies AutomationsState;
    case 'SAVE_AUTOMATIONS':
      await browser.storage.local.set({ [AUTOMATIONS_KEY]: req.automations });
      await syncAutomations();
      return null;
    case 'GET_AUTOMATION_ACTIVITY':
      return (await local<ActivityRow[]>(ACTIVITY_KEY)) ?? [];
    case 'GET_ENDPOINTS':
      return keystore.getEndpoints();
    case 'TEST_ENDPOINTS':
      return testEndpoints(req.endpoints);
    case 'GET_NOTIFY':
      return keystore.getNotify();
    case 'SET_NOTIFY':
      await keystore.setNotify(req.notify);
      return null;
    case 'NOTIFY_CONNECT':
      return findChat(req.botToken);
    case 'NOTIFY_TEST': {
      const notify = await keystore.getNotify();
      if (!notify) throw new Error('Connect a Telegram bot first');
      await sendTelegram(notify.botToken, notify.chatId, '✅ Quickdraw alerts are on. Trades will show up here.');
      return null;
    }
    case 'SAVE_SETTINGS': {
      const saved = await saveSettings(req.settings);
      eachEngine((eng) => eng.setSettings(saved));
      await pushState();
      return saved;
    }
    case 'SWEEP': {
      if (req.phrase !== SWEEP_CONFIRM_PHRASE) throw new Error(`Type "${SWEEP_CONFIRM_PHRASE}" to confirm`);
      const to = (await loadSettings()).sweepAddress;
      if (!to) throw new Error('Set a sweep address in Settings → Safety first');
      let dest: PublicKey;
      try {
        dest = new PublicKey(to);
      } catch {
        throw new Error('The sweep address is not a valid Solana address');
      }
      const eng = req.pubkey ? await engineFor(req.pubkey) : await tradeEngine();
      const out = await eng.sweep(dest);
      return { status: out.status, signature: out.signature, lamports: out.lamports, error: out.error?.message ?? null };
    }
    case 'GET_LEDGER': {
      // Every wallet's ledger, positions in the same token added together.
      const all = await browser.storage.local.get(null);
      const byMint = new Map<string, Position>();
      for (const [k, v] of Object.entries(all)) {
        if (k !== LEDGER_KEY && !k.startsWith(`${LEDGER_KEY}:`)) continue;
        for (const p of parseLedger(v).values()) byMint.set(p.mint, addPositions(byMint.get(p.mint), p));
      }
      const positions = [...byMint.values()];
      return { positions, feesAvoidedLamports: platformFeesAvoided(positions) };
    }
    case 'GET_TRADE_LOG':
      return ((await browser.storage.local.get(TRADE_LOG_KEY))[TRADE_LOG_KEY] ?? []) as TradeLogEntry[];
    case 'SET_DRY_RUN': {
      const s = await loadSettings();
      const saved = await saveSettings({ ...s, safety: { ...s.safety, dryRun: req.dryRun } });
      eachEngine((eng) => eng.setSettings(saved));
      await pushState();
      return saved;
    }
    case 'SET_ONBOARDED':
      await browser.storage.local.set({ [ONBOARDED_KEY]: true });
      await pushState();
      return null;
  }
}

async function route(msg: unknown, sender: Sender): Promise<Result<unknown>> {
  if (sender.id !== browser.runtime.id) return { ok: false, error: 'Unknown sender' };
  try {
    if (isExtensionPage(sender)) {
      const page = PageRequest.safeParse(msg);
      if (page.success) return { ok: true, data: await handlePage(page.data) };
    }
    const content = ContentRequest.safeParse(msg);
    if (content.success) return { ok: true, data: await handleContent(content.data, sender) };
    return { ok: false, error: 'Invalid request', code: 'BAD_REQUEST' };
  } catch (e) {
    return { ok: false, error: errorMessage(e), code: e instanceof keystore.NeedsPasswordError ? 'NEEDS_PASSWORD' : undefined };
  }
}

export default defineBackground(() => {
  // Automations pick up where they were whenever the worker starts.
  void syncAutomations();
  browser.runtime.onMessage.addListener((msg: unknown, sender: Sender, sendResponse: (r: unknown) => void) => {
    void route(msg, sender).then(sendResponse);
    return true; // keep the channel open for the async response
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT || port.sender?.id !== browser.runtime.id) {
      port.disconnect();
      return;
    }
    const tab = port.sender?.tab?.id;
    ports.set(port, tab);
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      // Stop watching this tab's token unless another panel in the same tab is still open.
      if (tab !== undefined && ![...ports.values()].includes(tab)) eachEngine((eng) => eng.markets.release(tab));
    });
    void walletState().then((state) => port.postMessage({ type: 'STATE', state } satisfies PanelEvent));
  });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') await browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}#onboarding` });
  });
});
