import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { MintRisk } from '../solana/tokens';
import type { BuyQuote, MarketView, PanelEvent, Result, SellQuote, TradeResult, WalletRow, WalletState } from '../messages';
import type { BuyPreset, PanelState, Profile, TierName } from '../settings/schema';
import { activeProfile } from '../settings/profiles';
import { STARTER_PROFILES, padBuyPresets, padSellPresets } from '../settings/defaults';
import type { PriorityLevel } from '../settings/schema';
import { send } from './client';
import { LiveQuote } from './liveQuote';
import { decodePanelImage, decodedPanelImage, peekPanelImage, watchPanelImage } from './panelImage';
import { playResult } from './sounds';
import type { ToolbarBridge } from './toolbar';
import { isTypingTarget, matches } from './hotkeys';
import { fmtCompact, fmtPct, fmtSol, fmtTiny, shortAddr } from './format';

export interface PanelProps {
  site: string;
  /** Subscribe to the address the site adapter detects (null = none). */
  subscribeAddress(cb: (addr: string | null) => void): () => void;
  /** Subscribe to worker events over the long-lived port. */
  subscribeEvents(cb: (ev: PanelEvent) => void): () => void;
  /** Toggle button in the site's toolbar, when the site has one. */
  toolbar?: ToolbarBridge;
  /** Whether the page is a token's chart page; the panel hides elsewhere. */
  subscribeTradingPage?(cb: (trading: boolean) => void): () => void;
}

interface Toast {
  id: string;
  level: 'info' | 'success' | 'error';
  text: string;
  link?: string;
  /** A second, smaller line. */
  detail?: string;
  /** Shown only on hover. */
  hover?: string;
  /** A trade's progress or result (not a failure): hidden when trade pop-ups are off. */
  trade?: boolean;
}

/**
 * A custom panel background, with the shades the panel draws from it: a
 * lighter fill and border, and text that stays readable (dark on light colours).
 */
function backgroundVars(bg: string): Record<string, string> {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const light = 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!) > 0.35;
  const toward = light ? 'black' : 'white';
  return {
    '--bg': bg,
    '--bg2': `color-mix(in srgb, ${bg} 92%, ${toward})`,
    '--border': `color-mix(in srgb, ${bg} 82%, ${toward})`,
    '--stroke': `color-mix(in srgb, ${bg} 78%, ${toward})`,
    // On a light colour: dark text, and the light theme's deeper buy/sell/tip colours.
    ...(light ? { '--fg': '#16161d', '--muted': '#5a5a66', '--buy': '#0c9e72', '--sell': '#d9345f', '--tip': '#b88a12' } : {}),
  };
}

/**
 * The background image, drawn on a canvas filling the panel (cover-fit). A
 * canvas, not an <img> or CSS url(): trading sites' Content-Security-Policy
 * blocks data: and blob: images, but not pixels we draw ourselves.
 */
function PanelImage({ src, opacity }: { src: string; opacity: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Before the first paint, so an image decoded earlier shows with the panel, not a frame after it.
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Decoded once per page (see panelImage.ts) and kept: drawn at once when it's ready.
    let bitmap: ImageBitmap | null = decodedPanelImage(src);
    let cancelled = false;
    const draw = () => {
      if (!bitmap) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
      const dw = bitmap.width * scale;
      const dh = bitmap.height * scale;
      canvas.getContext('2d')?.drawImage(bitmap, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    };
    if (bitmap) draw();
    else
      void decodePanelImage(src)
        .then((b) => {
          if (cancelled) return;
          bitmap = b;
          draw();
        })
        .catch(() => {});
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [src]);
  return <canvas class="it-bgimage" ref={ref} style={{ opacity }} aria-hidden="true" />;
}

const DEFAULT_POS: PanelState = { x: 24, y: 120, collapsed: false };

/**
 * Page stacking. Sites built on Tailwind put pop-ups (hover cards, menus, modals)
 * at z-50 and page chrome at z-10..40, so 45 sits above the page but under them.
 */
const LAYER_Z = { 'below-popups': 45, 'above-popups': 10_000, top: 2_147_483_646 } as const;
/**
 * "Below the site's pop-ups" per site: above its chart and side panels, under
 * its dialogs and tweet cards. Axiom's pop-ups start around 50; GMGN's chart
 * overlay is 800, its side panel 860 and its dialogs 1000 (checked 2026-11-02).
 */
const BELOW_POPUPS_Z: Record<string, number> = { 'gmgn.ai': 900 };
function layerZ(layer: keyof typeof LAYER_Z, site: string): number {
  if (layer !== 'below-popups') return LAYER_Z[layer];
  const host = Object.keys(BELOW_POPUPS_Z).find((h) => site === h || site.endsWith(`.${h}`));
  return host ? BELOW_POPUPS_Z[host]! : LAYER_Z[layer];
}

const RISK_TEXT: Record<MintRisk, string> = {
  freeze: "can freeze your tokens so you can't sell",
  delegate: 'can take your tokens back',
  hook: 'runs its own code on every transfer',
};
/** "<subject> can freeze your tokens so you can't sell and can take your tokens back". */
function riskText(risks: readonly MintRisk[], subject = 'Its creator'): string {
  const parts = risks.map((r) => RISK_TEXT[r]);
  return `${subject} ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}`;
}
/** How long a second buy click has to confirm a risky coin. */
const RISK_CONFIRM_MS = 5_000;

/** A hover quote from the worker, kept current as the market moves (see LiveQuote); null for no key, or until the first answer. */
function useLiveQuote<T>(key: string | null, tick: unknown, ask: () => Promise<Result<unknown>>): T | null {
  const [got, setGot] = useState<{ key: string; value: T } | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const askRef = useRef(ask);
  askRef.current = ask;
  const live = useRef<LiveQuote<T> | null>(null);
  live.current ??= new LiveQuote<T>(
    () => keyRef.current,
    () => askRef.current(),
    (k, value) => setGot({ key: k, value }),
  );
  useEffect(() => live.current!.refresh(), [key, tick]);
  return key && got?.key === key ? got.value : null;
}

function resolveBuyTier(p: BuyPreset | null, sol: number, toggle: TierName, profile: Profile): TierName {
  if (p?.tier) return p.tier;
  // A fixed Fast tip dominates small trades, so small buys drop to Eco (shown on the button).
  return toggle === 'fast' && sol < profile.ecoBelowSol ? 'eco' : toggle;
}

type Edge = 'e' | 's' | 'se';
const MIN_W = 280;
const MAX_W = 720;
const MIN_H = 220;
/** A preset row below this height isn't worth showing; rows sit 5px apart. */
const ROW_MIN = 28;
const ROW_GAP = 5;
/** How long a click made while the coin loads waits for it. */
const MARKET_WAIT_MS = 10_000;

/** Watches a preset area and says how many rows fit in it (only while the panel is sized). */
function useRowsThatFit(sized: boolean) {
  // A callback ref, so a re-mounted grid (panel reopened, layout switched) is the one measured.
  const [el, ref] = useState<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(Infinity);
  useEffect(() => {
    if (!sized || !el) return setFit(Infinity);
    const ro = new ResizeObserver(() => {
      if (el.isConnected) setFit(Math.max(1, Math.floor((el.clientHeight + ROW_GAP) / (ROW_MIN + ROW_GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sized, el]);
  return [ref, fit] as const;
}

export function Panel({ site, subscribeAddress, subscribeEvents, toolbar, subscribeTradingPage }: PanelProps) {
  const [state, setState] = useState<WalletState | null>(null);
  const [pos, setPos] = useState<PanelState>(DEFAULT_POS);
  const [detected, setDetected] = useState<string | null>(null);
  const [tier, setTier] = useState<TierName>('fast');
  const [feesOpen, setFeesOpen] = useState(false);
  // The wallet picker: its rows while open, null when closed.
  const [walletRows, setWalletRows] = useState<WalletRow[] | null>(null);
  // The pencil: preset amounts as editable text while editing, null otherwise.
  const [draft, setDraft] = useState<{ buy: string[]; sell: string[]; sellSol: string[] } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bgImage, setBgImage] = useState<string | null>(() => peekPanelImage() ?? null);
  // The "Saved" total last seen with a coin: kept while the next coin loads, so the line never blinks out.
  const lastSaved = useRef<number | null>(null);
  useEffect(() => watchPanelImage(setBgImage), []);
  const [busy, setBusy] = useState(false);
  // The hovered sell button: the % of the holding it would sell, shown in the sell header.
  // A coin whose creator can freeze, take back or hook tokens: the first buy only warns, a second click within a few seconds buys.
  const riskArmed = useRef<{ mint: string; until: number } | null>(null);
  const riskAccepted = useRef(new Set<string>());
  const [sellHover, setSellHover] = useState<{ pct: number; tier: TierName; presetIndex: number | null } | null>(null);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [marketErr, setMarketErr] = useState<string | null>(null);
  // What the hovered sell would really bring in (price impact and fees included), re-quoted as the market moves.
  const sellQuoteKey = sellHover && market && !state?.preview && sellHover.pct > 0 ? `${market.mint}:${sellHover.pct}:${sellHover.tier}:${sellHover.presetIndex}` : null;
  const sellQuote = useLiveQuote<SellQuote>(sellQuoteKey, `${market?.spotSolPerToken}:${market?.tokenBalance}`, () =>
    send({ type: 'QUOTE_SELL', mint: market!.mint, pct: Math.min(100, sellHover!.pct), tier: sellHover!.tier, presetIndex: sellHover!.presetIndex }),
  );
  // The same for a hovered buy button: what its SOL gets, after fees and price impact.
  const [buyHover, setBuyHover] = useState<{ sol: number; tier: TierName; presetIndex: number } | null>(null);
  const buyQuoteKey = buyHover && market && !state?.preview ? `${market.mint}:${buyHover.sol}:${buyHover.tier}:${buyHover.presetIndex}` : null;
  const buyQuote = useLiveQuote<BuyQuote>(buyQuoteKey, market?.spotSolPerToken, () =>
    send({ type: 'QUOTE_BUY', mint: market!.mint, sol: buyHover!.sol, tier: buyHover!.tier, presetIndex: buyHover!.presetIndex }),
  );
  // The hovered button's trade is built ahead in the worker (unsigned), so a click only signs and sends.
  const prebuildTrade = sellHover
    ? { side: 'sell' as const, amount: Math.min(100, sellHover.pct), tier: sellHover.tier, presetIndex: sellHover.presetIndex }
    : buyHover
      ? { side: 'buy' as const, amount: buyHover.sol, tier: buyHover.tier, presetIndex: buyHover.presetIndex }
      : null;
  const prebuildKey = prebuildTrade && market && !state?.preview && prebuildTrade.amount > 0 ? JSON.stringify([market.mint, prebuildTrade]) : null;
  useEffect(() => {
    if (!prebuildKey) return;
    const [mint, t] = JSON.parse(prebuildKey) as [string, NonNullable<typeof prebuildTrade>];
    void send({ type: 'PREBUILD', trade: { mint, ...t } });
    return () => void send({ type: 'PREBUILD', trade: null });
  }, [prebuildKey]);
  // A click before the coin has loaded waits for it here instead of the buttons looking dead.
  const marketNow = useRef<{ market: MarketView | null; err: string | null }>({ market: null, err: null });
  marketNow.current = { market, err: marketErr };
  const marketWaiters = useRef<(() => void)[]>([]);
  useEffect(() => {
    if (!market && !marketErr) return;
    const waiters = marketWaiters.current.splice(0);
    waiters.forEach((w) => w());
  }, [market, marketErr]);
  /** The loaded market, waiting up to `ms` for it; null when it failed or didn't arrive. */
  async function loadedMarket(ms: number): Promise<MarketView | null> {
    if (!marketNow.current.market && !marketNow.current.err) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        marketWaiters.current.push(done);
        setTimeout(done, ms);
      });
    }
    return marketNow.current.market;
  }
  const [toolbarPresent, setToolbarPresent] = useState(false);
  const [onTradingPage, setOnTradingPage] = useState(true);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  // While the panel is being moved it lifts: slightly larger and see-through.
  const [dragging, setDragging] = useState(false);
  const posRef = useRef(pos);
  posRef.current = pos;
  const resize = useRef<{ sx: number; sy: number; w: number; h: number; edge: Edge } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // How many rows of four presets each side has room for once the panel is sized.
  const [buyRef, buyFit] = useRowsThatFit(pos.h !== undefined);
  const [sellRef, sellFit] = useRowsThatFit(pos.h !== undefined);
  // Pill drag: a press that moves more than a few px is a drag, otherwise a click.
  const pillDrag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const tierInit = useRef(false);
  // Latest key handler; the listener is installed once and calls through this.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);

  useEffect(() => subscribeAddress(setDetected), [subscribeAddress]);
  useEffect(
    () =>
      subscribeTradingPage?.((t) => {
        setOnTradingPage(t);
        // Leaving the chart clears what was on screen, so nothing pops back when you return.
        if (!t) setToasts([]);
      }),
    [subscribeTradingPage],
  );
  useEffect(() => {
    if (!toolbar) return;
    const offPresence = toolbar.subscribePresence(setToolbarPresent);
    const offToggle = toolbar.onToggle(() => persist({ ...posRef.current, collapsed: !posRef.current.collapsed }));
    return () => {
      offPresence();
      offToggle();
    };
  }, [toolbar]);
  useEffect(() => {
    toolbar?.setOpen(!pos.collapsed);
  }, [toolbar, pos.collapsed]);
  useEffect(
    () =>
      subscribeEvents((ev) => {
        if (ev.type === 'STATE') setState(ev.state);
        else if (ev.type === 'MARKET') setMarket((m) => (m && m.mint === ev.market.mint ? ev.market : m));
        else {
          // Landed results; failures and other notices (a route's table setup) always show.
          pushToast({ ...ev, trade: ev.level !== 'error' && !ev.id.startsWith('table-') });
          const sound = uiRef.current?.sound;
          if (ev.sound && sound?.enabled) playResult(ev.sound, sound.volume);
        }
      }),
    [subscribeEvents],
  );
  useEffect(() => {
    void send<PanelState | null>({ type: 'GET_PANEL_STATE', site }).then((r) => {
      if (r.ok && r.data) setPos(clamp(r.data));
    });
  }, [site]);
  useEffect(() => {
    if (state && !tierInit.current) {
      tierInit.current = true;
      setTier(activeProfile(state.settings).defaultTier);
      if (state.settings.ui.startCollapsed) setPos((p) => ({ ...p, collapsed: true }));
    }
  }, [state]);

  // Read when a pop-up is pushed or an event arrives, so changed settings apply to the next one.
  const uiRef = useRef(state?.settings.ui);
  uiRef.current = state?.settings.ui;
  // Each pop-up's removal timer, by id: a replacement (sent → landed) restarts it, hovering pauses it.
  const toastTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const hoveredToast = useRef<string | null>(null);
  function dismissToast(id: string) {
    clearTimeout(toastTimers.current.get(id));
    toastTimers.current.delete(id);
    setToasts((ts) => ts.filter((x) => x.id !== id));
  }
  function expireToast(id: string) {
    clearTimeout(toastTimers.current.get(id));
    toastTimers.current.set(id, setTimeout(() => dismissToast(id), (uiRef.current?.toastSeconds ?? 10) * 1000));
  }
  function pushToast(t: Toast) {
    setToasts((ts) => [...ts.filter((x) => x.id !== t.id), t].slice(-4));
    if (hoveredToast.current !== t.id) expireToast(t.id);
  }

  const address = detected;
  const walletReady = !!state && state.hasWallet && !state.needsPassword;

  // The selected wallets' SOL, read directly while there's no market to carry it
  // (a coin still loading or one Quickdraw can't trade): a balance of 0 there looks like lost funds.
  const [walletSol, setWalletSol] = useState<number | null>(null);
  const activeKey = state?.active.join(',') ?? '';
  useEffect(() => {
    if (!walletReady || market) return;
    let current = true;
    const read = () =>
      void send<WalletRow[]>({ type: 'LIST_WALLETS' }).then((r) => {
        if (!current || !r.ok) return;
        const known = r.data.filter((w) => w.selected && w.sol !== null);
        setWalletSol(known.length ? known.reduce((a, w) => a + w.sol!, 0) : null);
      });
    read();
    const timer = setInterval(read, 15_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [walletReady, !!market, activeKey]);
  const solBalance = market?.solBalance ?? walletSol;
  // Resolve address -> mint -> venue in the worker, which then keeps it fresh.
  useEffect(() => {
    setMarket(null);
    setMarketErr(null);
    if (!address || !walletReady) return;
    let current = true;
    void send<MarketView>({ type: 'RESOLVE', address }).then((r) => {
      if (!current) return;
      if (r.ok) setMarket(r.data);
      else setMarketErr(r.error);
    });
    return () => {
      current = false;
    };
  }, [address, walletReady, state?.active.join(',')]);

  function persist(next: PanelState) {
    setPos(next);
    void send({ type: 'SAVE_PANEL_STATE', site, state: next });
  }

  function clamp(p: PanelState): PanelState {
    return {
      ...p,
      x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - 80)),
      y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 40)),
    };
  }

  // Resizing, from the right edge, the bottom edge or the corner (sizes are pre-scale).
  function onResizeDown(edge: Edge) {
    return (e: PointerEvent) => {
      e.stopPropagation();
      const r = panelRef.current!.getBoundingClientRect();
      const scale = state?.settings.ui.scale ?? 1;
      resize.current = { sx: e.clientX, sy: e.clientY, w: r.width / scale, h: r.height / scale, edge };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };
  }
  function onResizeMove(e: PointerEvent) {
    const r = resize.current;
    if (!r) return;
    const scale = state?.settings.ui.scale ?? 1;
    setPos((p) => ({
      ...p,
      w: r.edge === 's' ? p.w : Math.round(Math.min(MAX_W, Math.max(MIN_W, r.w + (e.clientX - r.sx) / scale))),
      h: r.edge === 'e' ? p.h : Math.round(Math.min(window.innerHeight / scale, Math.max(MIN_H, r.h + (e.clientY - r.sy) / scale))),
    }));
  }
  function onResizeUp() {
    if (!resize.current) return;
    resize.current = null;
    persist(posRef.current);
  }
  const resizeHandle = (edge: Edge) => (
    <span
      class={`it-rz it-rz-${edge}`}
      title="Drag to resize · double-click for the default size"
      onPointerDown={onResizeDown(edge)}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeUp}
      onDblClick={() => persist({ ...posRef.current, w: undefined, h: undefined })}
    />
  );

  function onPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button, input')) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag.current) return;
    setPos((p) => clamp({ ...p, x: e.clientX - drag.current!.dx, y: e.clientY - drag.current!.dy }));
  }
  function onPointerUp() {
    setDragging(false);
    if (!drag.current) return;
    drag.current = null;
    persist(pos);
  }

  const mint = market?.mint ?? null;
  const preview = !!state?.preview;
  // Live as soon as the wallet is: a click while the coin loads waits for it (see trade). Unsupported coins stay dimmed.
  const ready = (preview || (walletReady && !marketErr)) && !busy;

  async function trade(side: 'buy' | 'sell', amount: number, t: TierName, presetIndex: number | null) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (preview) {
      // No wallet or RPC: say what the click would do, touch nothing.
      const tip = activeProfile(state!.settings).tiers[t].tipSol;
      const what = side === 'buy' ? `buy ${fmtSol(amount)} SOL` : `sell ${fmtPct(amount)}`;
      const of = address ? ` of ${shortAddr(address)}` : '';
      const preset = presetIndex !== null ? `, preset ${presetIndex + 1}` : '';
      pushToast({
        id: `p-${Date.now()}`,
        level: 'info',
        text: `Preview: would ${what}${of} (${t === 'fast' ? 'Fast' : 'Eco'}, tip ${fmtSol(tip)} SOL${preset}). Set up a wallet to trade.`,
      });
      return;
    }
    if (!address) return;
    const clickedAt = performance.timeOrigin + performance.now();
    setBusy(true);
    const id = `t-${Date.now()}`;
    const doing = `${side === 'buy' ? 'Buying' : 'Selling'} ${side === 'buy' ? `${fmtSol(amount)} SOL` : fmtPct(amount)}`;
    let m = marketNow.current.market;
    if (!m) {
      pushToast({ id, level: 'info', text: `${doing}: loading this coin…` });
      m = await loadedMarket(MARKET_WAIT_MS);
      if (!m) {
        setBusy(false);
        pushToast({ id, level: 'error', text: marketNow.current.err ?? 'This coin is still loading. Try again in a moment.' });
        return;
      }
    }
    if (side === 'buy' && m.risks?.length && !riskAccepted.current.has(m.mint)) {
      const armed = riskArmed.current;
      if (!armed || armed.mint !== m.mint || Date.now() > armed.until) {
        riskArmed.current = { mint: m.mint, until: Date.now() + RISK_CONFIRM_MS };
        setBusy(false);
        pushToast({ id, level: 'error', text: `Careful: ${riskText(m.risks, "this coin's creator")}.`, detail: 'Click buy again within 5s to buy anyway.' });
        return;
      }
      riskAccepted.current.add(m.mint);
    }
    pushToast({ id, level: 'info', text: `${doing}…`, trade: true });
    const r: Result<TradeResult> = await send({ type: 'TRADE', side, mint: m.mint, amount, tier: t, presetIndex, clickedAt });
    setBusy(false);
    if (r.ok && r.data.kind === 'sent') {
      // Landed / failed / expired arrive later as TOAST events with this signature as id.
      setToasts((ts) => ts.filter((x) => x.id !== id));
      pushToast({ id: r.data.signature, level: 'info', text: r.data.text, detail: r.data.detail, link: `https://solscan.io/tx/${r.data.signature}`, trade: true });
      return;
    }
    if (!r.ok) pushToast({ id, level: 'error', text: r.error });
    else if (r.data.kind === 'simulated' || r.data.kind === 'multi') pushToast({ id, level: r.data.ok ? 'success' : 'error', text: r.data.text, detail: r.data.detail, trade: r.data.ok });
  }

  onKey.current = (e) => {
    // Typing in the page, or in our own panel (its closed shadow root shows up as the host element).
    const inPanel = (e.target as Element | null)?.tagName === 'INSTANT-TRENCH';
    if (!state?.settings.hotkeys.enabled || e.repeat || inPanel || isTypingTarget(e.target)) return;
    const hk = state.settings.hotkeys;
    const prof = activeProfile(state.settings);
    const hit = (): (() => void) | null => {
      if (matches(hk.togglePanel, e)) return () => persist({ ...posRef.current, collapsed: !posRef.current.collapsed });
      if (matches(hk.toggleTier, e)) return () => setTier((t) => (t === 'fast' ? 'eco' : 'fast'));
      const b = hk.buy.findIndex((c) => matches(c, e));
      const bp = b >= 0 ? prof.buyPresets[b] : undefined;
      if (bp) return () => ready && void trade('buy', bp.sol, resolveBuyTier(bp, bp.sol, tier, prof), b);
      const sIdx = hk.sell.findIndex((c) => matches(c, e));
      const sp = sIdx >= 0 ? prof.sellPresets[sIdx] : undefined;
      if (sp) return () => ready && void trade('sell', sp.pct, sp.tier ?? tier, sIdx);
      return null;
    };
    const action = hit();
    if (!action) return;
    // Ours: keep the site from also acting on it.
    e.preventDefault();
    e.stopPropagation();
    action();
  };

  if (!state) return null;
  const s = state.settings;
  const profile = activeProfile(s);
  const style = {
    left: `${pos.x}px`,
    top: `${pos.y}px`,
    opacity: s.ui.opacity,
    transform: `scale(${s.ui.scale})`,
    zIndex: layerZ(s.ui.layer, site),
    '--accent': s.ui.accent,
    ...(s.ui.panelBg ? backgroundVars(s.ui.panelBg) : {}),
  } as Record<string, string | number>;
  const theme = s.ui.theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.ui.theme;

  const toastsAt = s.ui.toastPosition ?? 'panel';
  const toastList = (
    <div class={toastsAt === 'panel' ? 'it-toasts' : `it-toasts it-toasts-${toastsAt}`}>
      {toasts
        .filter((t) => !t.trade || s.ui.show.tradeToasts !== false)
        .slice(-(s.ui.toastMax ?? 4))
        .map((t) => (
          <div
            key={t.id}
            class={`it-toast it-${t.level}`}
            title={[t.hover, 'Click to dismiss'].filter(Boolean).join('\n')}
            onClick={() => dismissToast(t.id)}
            onMouseEnter={() => {
              hoveredToast.current = t.id;
              clearTimeout(toastTimers.current.get(t.id));
            }}
            onMouseLeave={() => {
              hoveredToast.current = null;
              expireToast(t.id);
            }}
          >
            <span>
              {t.text}
              {t.detail && <small>{t.detail}</small>}
            </span>
            {t.link && (
              <a href={t.link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                Solscan ↗
              </a>
            )}
          </div>
        ))}
    </div>
  );

  // Away from a token's chart page: nothing at all, toasts included (the trade log keeps every result).
  if (!onTradingPage) return null;

  if (pos.collapsed) {
    // The toolbar button reopens the panel; no floating pill needed then.
    if (toolbarPresent) return null;
    return (
      <div class={`it-root it-${theme}`} style={style}>
        <button
          class="it-pill"
          title="Click to open Quickdraw · drag to move"
          onPointerDown={(e) => {
            pillDrag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, sx: e.clientX, sy: e.clientY, moved: false };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = pillDrag.current;
            if (!d) return;
            if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
            d.moved = true;
            setPos((p) => clamp({ ...p, x: e.clientX - d.dx, y: e.clientY - d.dy }));
          }}
          onPointerUp={() => {
            const d = pillDrag.current;
            pillDrag.current = null;
            if (d) persist({ ...posRef.current, collapsed: d.moved });
          }}
          onClick={(e) => {
            // Keyboard activation (Enter/Space) has no pointer events.
            if (e.detail === 0) persist({ ...pos, collapsed: false });
          }}
        >
          <Icon.bolt /> {mint ?? address ? shortAddr((mint ?? address)!) : 'Quickdraw'} {state.needsPassword && <Icon.lock />}
        </button>
      </div>
    );
  }

  const tierCfg = profile.tiers[tier];
  const holdingSol = market ? market.tokenBalance * market.spotSolPerToken : null;
  if (market) lastSaved.current = market.feesSavedSol;
  // Wallet-wide, so it doesn't wait for the coin: the state's total until the coin's view brings a fresher one.
  const savedSol = market?.feesSavedSol ?? lastSaved.current ?? state.feesSavedSol ?? 0;
  const venueLabel = preview ? 'PREVIEW' : market ? ({ PUMP_CURVE: 'CURVE', PUMP_CURVE_ROUTED: 'CURVE', PUMPSWAP: 'PUMPSWAP', PUMPSWAP_ROUTED: 'PUMPSWAP', LAUNCHLAB: 'LAUNCHLAB', LAUNCHLAB_ROUTED: 'LAUNCHLAB', RAYDIUM_CPMM: 'RAYDIUM', RAYDIUM_CPMM_ROUTED: 'RAYDIUM', CLMM_ROUTED: 'CLMM', RAYDIUM_AMM: 'RAYDIUM V4', METEORA_DBC: 'METEORA', METEORA_DBC_ROUTED: 'METEORA', METEORA_DAMM_V2: 'DAMM V2', METEORA_DAMM_V2_ROUTED: 'DAMM V2' } as const)[market.venue] : marketErr ? 'N/A' : address && walletReady ? '…' : '—';
  // On-chain symbol when the token has metadata, else the start of the mint.
  const symbol = market?.symbol || (market ? (mint ?? address ?? '').slice(0, 4) : '');
  const ticker = symbol.length > 8 ? `${symbol.slice(0, 7)}...` : symbol;
  const usd = (sol: number | null) => {
    const v = sol !== null && market?.solUsd ? sol * market.solUsd : 0;
    return v === 0 ? '$0' : v >= 1000 ? `$${fmtCompact(v)}` : `$${v.toFixed(v < 1 ? 3 : 2).replace(/\.?0+$/, '')}`;
  };
  /** A footer amount in SOL (with the SOL mark) or, once switched, in USD. */
  const amount = (sol: number, sign = '') =>
    pos.usd ? (
      <>
        {sign}
        {usd(sol)}
      </>
    ) : (
      <>
        <Icon.sol /> {sign}
        {fmtSol(sol)}
      </>
    );
  const prio = market?.priorityFeeSol?.[tier];
  const smallestBuy = Math.min(...profile.buyPresets.map((b) => b.sol));
  const tipHeavy = tierCfg.tipSol / smallestBuy > 0.01;
  const mode = preview ? 'PREVIEW' : s.safety.dryRun ? 'DRY' : 'LIVE';
  const remainingInitial = market?.boughtSol != null ? Math.max(0, market.boughtSol - (market.soldSol ?? 0)) : 0;
  const sellInitPct = holdingSol && holdingSol > 0 && remainingInitial > 0 ? Math.min(100, (remainingInitial / holdingSol) * 100) : null;

  const feeRow = (
    <button class={`it-fees it-fees-btn ${feesOpen ? 'on' : ''}`} title="Edit this profile's fees" onClick={() => setFeesOpen((o) => !o)}>
      <span title={`Slippage · ${tier === 'fast' ? 'Fast (Sender Max)' : 'Eco (SWQOS only)'}`}>
        <Icon.slippage /> {fmtPct(profile.slippagePct)}
      </span>
      <span
        title={
          prio !== undefined
            ? `Priority fee ≈ ${prio} SOL (${tierCfg.cuPriceMicroLamports !== null ? 'fixed CU price' : tierCfg.priorityLevel})`
            : `Priority: ${tierCfg.cuPriceMicroLamports ?? tierCfg.priorityLevel}`
        }
      >
        <Icon.gas /> {prio !== undefined ? fmtTiny(prio) : (tierCfg.cuPriceMicroLamports ?? tierCfg.priorityLevel)}
      </span>
      <span class="it-tip" title={`Sender tip${tipHeavy ? ': over 1% of your smallest buy' : ''}`}>
        <Icon.coin /> {fmtTiny(tierCfg.tipSol)}
        {tipHeavy && <Icon.warn />}
      </span>
      <span class="it-mev" title="MEV protection">
        <Icon.shield /> {tierCfg.mevProtect ? 'On' : 'Off'}
      </span>
    </button>
  );

  const slotOf = s.profiles.findIndex((x) => x.id === s.activeProfileId) + 1;
  const updateFees = (patch: Record<string, unknown>) =>
    void send({ type: 'UPDATE_FEES', tier, ...patch } as never).then((r) => {
      if (!r.ok) pushToast({ id: `fees-${Date.now()}`, level: 'error', text: `Fee setting not saved: ${r.error}` });
    });
  // Uncontrolled inputs keyed by the saved value: live market updates re-render the
  // panel several times a second and must not reset what you're typing.
  const k = (name: string, v: unknown) => `${profile.id}-${tier}-${name}-${String(v)}`;
  const numIn = (e: Event) => (e.target as HTMLInputElement).value.trim();
  const feeEditor = feesOpen && (
    <div class="it-dropdown it-fee-editor">
      <div class="it-dd-row">
        <span>Tier</span>
        <div class="it-tier">
          {(['fast', 'eco'] as const).map((t) => (
            <button key={t} class={tier === t ? 'on' : ''} onClick={() => setTier(t)}>
              {t === 'fast' ? 'Fast' : 'Eco'}
            </button>
          ))}
        </div>
      </div>
      <label class="it-dd-row">
        <span>Slip %</span>
        <input
          key={k('slip', profile.slippagePct)}
          type="number"
          step="0.5"
          defaultValue={String(profile.slippagePct)}
          onChange={(e) => numIn(e) && updateFees({ slippagePct: Number(numIn(e)) })}
        />
      </label>
      <label class="it-dd-row">
        <span>Priority</span>
        <select value={tierCfg.priorityLevel} onChange={(e) => updateFees({ priorityLevel: (e.target as HTMLSelectElement).value as PriorityLevel })}>
          {(['min', 'low', 'medium', 'high', 'veryHigh'] as const).map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label class="it-dd-row">
        <span>CU µL</span>
        <input
          key={k('cu', tierCfg.cuPriceMicroLamports)}
          type="number"
          min="0"
          placeholder="auto (live estimate)"
          defaultValue={tierCfg.cuPriceMicroLamports === null ? '' : String(tierCfg.cuPriceMicroLamports)}
          onChange={(e) => updateFees({ cuPriceMicroLamports: numIn(e) === '' ? null : Math.round(Number(numIn(e))) })}
        />
      </label>
      <label class="it-dd-row">
        <span>Tip</span>
        <input
          key={k('tip', tierCfg.tipSol)}
          type="number"
          step="0.000005"
          min="0"
          defaultValue={String(tierCfg.tipSol)}
          onChange={(e) => numIn(e) && updateFees({ tipSol: Number(numIn(e)) })}
        />
      </label>
      <label class="it-dd-row">
        <span>MEV</span>
        <span class="it-check">
          <input type="checkbox" checked={tierCfg.mevProtect} onChange={(e) => updateFees({ mevProtect: (e.target as HTMLInputElement).checked })} />
          protect
        </span>
      </label>
      <small class="it-note">
        P{slotOf} ({profile.name}) · {tier === 'fast' ? 'Fast' : 'Eco'} · saved instantly. Min tip: Fast 0.001, Eco 0.000005 SOL.
      </small>
    </div>
  );

  /** Presets in rows of four, each row its own bordered strip. */
  // ---- wallet picker (the wallet button): which wallets each click trades with
  async function toggleWalletPicker() {
    if (walletRows) return setWalletRows(null);
    setFeesOpen(false);
    const r: Result<WalletRow[]> = await send({ type: 'LIST_WALLETS' });
    if (r.ok) setWalletRows(r.data);
    else pushToast({ id: `w-${Date.now()}`, level: 'error', text: r.error });
  }
  async function selectWallets(pubkeys: string[]) {
    if (!pubkeys.length) return;
    const r: Result<WalletRow[]> = await send({ type: 'SET_ACTIVE_WALLETS', pubkeys });
    if (r.ok) setWalletRows(r.data);
    else pushToast({ id: `w-${Date.now()}`, level: 'error', text: r.error });
  }
  // A side menu beside the panel, the panel's height: on its right, or its left when the window ends too soon.
  const pickerOnLeft = pos.x + (panelRef.current?.offsetWidth ?? 330) * s.ui.scale + 340 * s.ui.scale > window.innerWidth;
  const walletPicker = walletRows && (
    <div
      class={`it-wallets${pickerOnLeft ? ' it-wallets-left' : ''}`}
      style={{ height: `${panelRef.current?.offsetHeight ?? 360}px` }}
      onKeyDown={(e) => e.key === 'Escape' && setWalletRows(null)}
    >
      <div class="it-wallets-bar">
        <button onClick={() => void selectWallets(walletRows.map((w) => w.pubkey))}>Select All</button>
        <button onClick={() => void selectWallets(walletRows.filter((w) => (w.sol ?? 0) > 0).map((w) => w.pubkey))}>Select All With Balance</button>
        <span class="it-spacer" />
        <button class="it-icon" title="Add or manage wallets" onClick={() => void send({ type: 'OPEN_OPTIONS', section: 'wallet' })}>
          <Icon.gear />
        </button>
      </div>
      <div class="it-wallets-list">
        {walletRows.map((w) => {
          const toggle = () => {
            const current = walletRows.filter((x) => x.selected).map((x) => x.pubkey);
            // Keep the order (the first selected is the primary); never empty.
            const next = w.selected ? current.filter((k) => k !== w.pubkey) : [...current, w.pubkey];
            if (next.length) void selectWallets(next);
          };
          return (
            <div key={w.pubkey} class={`it-wallet-row ${w.selected ? 'on' : ''}`} onClick={toggle}>
              <input type="checkbox" checked={w.selected} onClick={(e) => e.stopPropagation()} onChange={toggle} />
              <span class="it-wallet-id">
                <b>{w.name}</b>
                <small>
                  {shortAddr(w.pubkey, 4)}
                  <button
                    class="it-mini"
                    title="Copy address"
                    onClick={(e) => {
                      e.stopPropagation();
                      void navigator.clipboard.writeText(w.pubkey).catch(() => {});
                    }}
                  >
                    <Icon.copy />
                  </button>
                </small>
              </span>
              <span class="it-wallet-sol" title="SOL balance">
                <Icon.sol /> {w.sol === null ? '—' : fmtSol(w.sol)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  // Rows of four on each side (Display); presets past what the profile holds start from defaults.
  const buyPresets = padBuyPresets(profile.buyPresets, (s.ui.rows?.buy ?? 2) * 4);
  const sellCount = (s.ui.rows?.sell ?? 2) * 4;
  // Sell buttons as SOL amounts (each sells about that much of the holding's value): every row
  // while the Sell ⇄ switch is on, just the first row in the "SOL amounts + %" layout.
  const sellRows = s.ui.sellRows ?? 'follow';
  const sellSolMode = sellRows === 'follow' && !!pos.sellSol;
  const solCount = sellSolMode ? sellCount : sellRows === 'mixed' ? Math.min(4, sellCount) : 0;
  const allSellSol = profile.sellSolPresets ?? profile.buyPresets.map((b) => b.sol);
  const sellSolValues = padBuyPresets(profile.buyPresets, solCount).map((b, i) => allSellSol[i] ?? b.sol);
  const sellPresets = padSellPresets(profile.sellPresets, sellCount - solCount);
  const showSwitch = s.ui.show.currencySwitch !== false;
  // Hovering a sell button previews its share of the holding in the header (not while editing presets).
  const sellPreview = draft || !market?.tokenBalance ? null : (sellHover?.pct ?? null);
  const buyPreview = !draft && buyHover ? buyQuote : null;
  const share = sellPreview === null ? 1 : Math.min(100, Math.max(0, sellPreview)) / 100;
  // The hovered sell's real proceeds once quoted; until then (and in preview) the spot value of its share.
  const previewQuote = sellPreview !== null ? sellQuote : null;
  const headerSol = previewQuote ? Math.max(0, previewQuote.netSol) : holdingSol === null ? null : holdingSol * share;
  // While a sell is hovered, the footer's PnL shows where it would end up: the sold share's value at the live price swapped
  // for what the sell would really bring in, after the pool's fee, price impact, network fee, priority fee and tip.
  const projectedPnl = previewQuote && market?.pnlSol != null && holdingSol !== null ? market.pnlSol - holdingSol * share + previewQuote.netSol : null;
  const pnlSol = projectedPnl ?? market?.pnlSol ?? 0;
  const pnlPct = projectedPnl !== null ? (market?.boughtSol ? (projectedPnl / market.boughtSol) * 100 : 0) : (market?.pnlPct ?? 0);
  const hoverSell = (pct: number | null, t: TierName = tier, presetIndex: number | null = null) => ({
    onPointerEnter: () => setSellHover(pct === null ? null : { pct, tier: t, presetIndex }),
    onPointerLeave: () => setSellHover(null),
  });

  /** Pencil: open the presets for editing, or save the edits (invalid ones keep their old value). */
  async function togglePresetEdit() {
    if (!draft) {
      setFeesOpen(false);
      setDraft({ buy: buyPresets.map((p) => String(p.sol)), sell: sellPresets.map((p) => String(p.pct)), sellSol: sellSolValues.map(String) });
      return;
    }
    const parse = (v: string, old: number, max: number) => {
      const n = Number(v.trim());
      return Number.isFinite(n) && n > 0 && n <= max ? n : old;
    };
    const buy = draft.buy.map((v, i) => parse(v, buyPresets[i]!.sol, 100));
    const sell = draft.sell.map((v, i) => parse(v, sellPresets[i]!.pct, 100));
    setDraft(null);
    if (!draft.sellSol.length) return void (await send({ type: 'SET_PRESET_VALUES', buy, sell }));
    // Only the SOL buttons shown were edited; the rest of the list stays as it was.
    const sellSol = Array.from({ length: Math.max(allSellSol.length, draft.sellSol.length) }, (_, i) =>
      i < draft.sellSol.length ? parse(draft.sellSol[i]!, sellSolValues[i]!, 100) : allSellSol[i]!,
    );
    await send({ type: 'SET_PRESET_VALUES', buy, sell, sellSol });
  }
  const presetInput = (side: 'buy' | 'sell' | 'sellSol', i: number) => (
    <input
      key={i}
      class="it-preset-edit"
      inputMode="decimal"
      value={draft![side][i]}
      onInput={(e) => {
        const v = (e.target as HTMLInputElement).value;
        setDraft((d) => (d ? { ...d, [side]: d[side].map((x, j) => (j === i ? v : x)) } : d));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void togglePresetEdit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );

  const rows = <T,>(items: T[], fit: number) => Array.from({ length: Math.ceil(items.length / 4) }, (_, r) => items.slice(r * 4, r * 4 + 4)).slice(0, fit);
  const sized = pos.h !== undefined && !pos.compact;
  const panelSize = pos.compact ? {} : { width: pos.w !== undefined ? `${pos.w}px` : undefined, height: pos.h !== undefined ? `${pos.h}px` : undefined };

  const panel = (
    <div class={`it-root it-${theme} it-${pos.compact ? 'compact' : s.ui.layout}${sized ? ' it-sized' : ''}${s.ui.buttonShape === 'rounded' ? ' it-rounded' : ''}`} style={style}>
      <div class={`it-panel${dragging ? ' it-dragging' : ''}`} ref={panelRef} style={panelSize}>
        {bgImage && <PanelImage src={bgImage} opacity={s.ui.panelImageOpacity} />}
        <header class="it-header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span class="it-grip" aria-hidden="true" />
          <nav class="it-tabs">
            {Array.from({ length: Math.min(5, Math.max(3, s.profiles.length)) }, (_, i) => {
              const p = s.profiles[i];
              const starter = STARTER_PROFILES[i];
              return (
                <button
                  key={i}
                  class={`${p?.id === s.activeProfileId ? 'on' : p ? '' : 'it-new'}${p?.tabLabel?.trim() ? ' it-named' : ''}`}
                  disabled={!p && i > s.profiles.length}
                  title={p ? `${p.name}: ${p.slippagePct}% slippage, Fast tip ${p.tiers.fast.tipSol} SOL` : `Create P${i + 1} from the ${starter?.name ?? 'default'} fees`}
                  onClick={() => p?.id !== s.activeProfileId && void send({ type: 'SET_PROFILE_SLOT', slot: i })}
                >
                  {p?.tabLabel?.trim() || `P${i + 1}`}
                </button>
              );
            })}
          </nav>
          <button class={`it-icon ${draft ? 'on' : ''}`} title={draft ? 'Save preset values' : 'Edit preset values'} onClick={() => void togglePresetEdit()}>
            {draft ? <Icon.check /> : <Icon.pencil />}
          </button>
          <button class="it-icon" title="Settings" onClick={() => void send({ type: 'OPEN_OPTIONS', section: 'settings' })}>
            <Icon.gear />
          </button>
          <span class="it-spacer" />
          {state.needsPassword && (
            <button class="it-round" title="Enter your old password once to finish converting the wallet" onClick={() => void send({ type: 'OPEN_OPTIONS', section: 'wallet' })}>
              <Icon.lock />
            </button>
          )}
          <button
            class={`it-wallet it-mode-${mode.toLowerCase()} ${walletRows ? 'on' : ''}`}
            title={`${state.active.length} wallet${state.active.length === 1 ? '' : 's'} selected · ${mode === 'LIVE' ? 'Live: clicks send real transactions' : mode === 'DRY' ? 'Dry run: trades are simulated' : 'Preview: no wallet yet'}`}
            onClick={() => (state.hasWallet ? void toggleWalletPicker() : void send({ type: 'OPEN_OPTIONS', section: 'settings' }))}
          >
            <Icon.wallet /> {state.active.length || 0}
          </button>
          <button class="it-icon" title="Close" onClick={() => persist({ ...pos, collapsed: true })}>
            <Icon.close />
          </button>
        </header>
        {feeEditor}
        {marketErr && <div class="it-err">{marketErr}</div>}
        {!!market?.risks?.length && (
          <div class="it-err it-risk" title="Read from the coin's mint account. Plain pump.fun coins have none of these.">
            ⚠ {riskText(market.risks)}.
          </div>
        )}
        {state.needsPassword && address && <div class="it-err">Enter your old password once in the extension to finish converting the wallet.</div>}

        <section class="it-side it-buy">
          <div class="it-head">
            <span class="it-h">
              Buy{' '}
              {showSwitch && (
                <>
                  <small>SOL</small> <Icon.swap />
                </>
              )}
            </span>
            <span class="it-right">
              {buyPreview ? (
                <span
                  class="it-right it-previewing"
                  title={`What ${fmtSol(buyHover!.sol)} SOL buys: about ${fmtCompact(buyPreview.tokens)} ${ticker}, worth ${fmtSol(buyPreview.valueSol)} SOL at the current price (after the pool's fee and price impact), less ${fmtSol(buyPreview.feesSol)} SOL in network fee, priority fee and tip`}
                >
                  <span class="it-hold">
                    {fmtCompact(buyPreview.tokens)} {ticker}
                  </span>
                  <span class="it-muted">•</span>
                  <span>{usd(Math.max(0, buyPreview.netSol))}</span>
                  <span class="it-muted">•</span>
                  <span>
                    <Icon.sol /> {fmtSol(Math.max(0, buyPreview.netSol))}
                  </span>
                </span>
              ) : (
                <span title={`Wallet SOL balance · ${venueLabel}`}>
                  <Icon.sol /> {solBalance != null ? fmtSol(solBalance) : '0'}
                </span>
              )}
              <button class="it-mini" title={pos.compact ? 'Full size' : 'Compact'} onClick={() => persist({ ...pos, compact: !pos.compact })}>
                <Icon.expand />
              </button>
            </span>
          </div>
          <div class="it-rows" ref={buyRef}>
            {rows(buyPresets.map((p, i) => ({ p, i })), sized ? buyFit : Infinity).map((row, r) => (
              <div class="it-grid" key={r}>
                {row.map(({ p, i }) => {
                  if (draft) return presetInput('buy', i);
                  const t = resolveBuyTier(p, p.sol, tier, profile);
                  return (
                    <button
                      key={i}
                      disabled={!ready}
                      onClick={() => void trade('buy', p.sol, t, i)}
                      onPointerEnter={() => setBuyHover({ sol: p.sol, tier: t, presetIndex: i })}
                      onPointerLeave={() => setBuyHover(null)}
                    >
                      {fmtSol(p.sol)}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div class="it-row">
            {feeRow}
          </div>
        </section>

        <section class="it-side it-sell">
          <div class="it-head">
            <span class="it-h">
              Sell{' '}
              {showSwitch && <small>{sellSolMode ? 'SOL' : sellRows === 'mixed' ? 'SOL · %' : '%'}</small>}
              {showSwitch && sellRows === 'follow' && (
                <button
                  class="it-mini"
                  title={sellSolMode ? 'Selling by SOL amount · switch to %' : 'Selling by % · switch to SOL amounts'}
                  onClick={() => {
                    setDraft(null);
                    persist({ ...posRef.current, sellSol: !posRef.current.sellSol });
                  }}
                >
                  <Icon.swap />
                </button>
              )}
            </span>
            {s.ui.show.tokenAmounts !== false && (
            <span
              class={`it-right${sellPreview !== null ? ' it-previewing' : ''}`}
              title={
                sellPreview === null
                  ? `Your holdings of ${market?.symbol ?? mint ?? 'this token'}`
                  : previewQuote
                    ? `What this button sells: ${fmtPct(sellPreview)} of your ${ticker}
You get about ${fmtSol(Math.max(0, previewQuote.netSol))} SOL: ${fmtSol(previewQuote.outSol)} SOL from the pool (after its fee and price impact) less ${fmtSol(previewQuote.feesSol)} SOL in network fee, priority fee and tip`
                    : `What this button sells: ${fmtPct(sellPreview)} of your ${ticker}`
              }
            >
              <span class="it-hold">
                {market ? fmtCompact(market.tokenBalance * share) : '0'} {ticker}
              </span>
              <span class="it-muted">•</span>
              <span>{usd(headerSol)}</span>
              <span class="it-muted">•</span>
              <span>
                <Icon.sol /> {headerSol !== null ? fmtSol(headerSol) : '0'}
              </span>
            </span>
            )}
          </div>
          <div class="it-rows" ref={sellRef}>
            {rows(
              [...sellSolValues.map((sol, i) => ({ sol, i, p: null })), ...sellPresets.map((p, i) => ({ sol: null, i, p }))],
              sized ? sellFit : Infinity,
            ).map((row, r) => (
              <div class="it-grid" key={r}>
                {row.map(({ sol, i, p }) =>
                  sol !== null ? (
                    draft ? (
                      presetInput('sellSol', i)
                    ) : (
                      <button
                        key={`s${i}`}
                        disabled={!ready || !holdingSol}
                        title={holdingSol ? `Sell about ${fmtSol(sol)} SOL of ${ticker} (${fmtPct(Math.min(100, (sol / holdingSol) * 100))} of your holding)` : 'Nothing to sell'}
                        onClick={() => void trade('sell', Math.min(100, (sol / (holdingSol || 1)) * 100), tier, null)}
                        {...hoverSell(holdingSol ? Math.min(100, (sol / holdingSol) * 100) : null)}
                      >
                        {fmtSol(sol)}
                      </button>
                    )
                  ) : draft ? (
                    presetInput('sell', i)
                  ) : (
                    <button key={`p${i}`} disabled={!ready} onClick={() => void trade('sell', p!.pct, p!.tier ?? tier, i)} {...hoverSell(p!.pct, p!.tier ?? tier, i)}>
                      {p!.pct}%
                    </button>
                  ),
                )}
              </div>
            ))}
          </div>
          <div class="it-row">
            {feeRow}
            <button
              class="it-init"
              disabled={!ready}
              title={
                sellInitPct !== null
                  ? `Sell ${fmtPct(sellInitPct)}: takes your initial ${fmtSol(remainingInitial)} SOL back out, the rest rides`
                  : 'Sell your initial: needs a position bought with Quickdraw'
              }
              onClick={() => {
                if (preview || sellInitPct !== null) return void trade('sell', sellInitPct ?? 0, tier, null);
                const text = market ? 'Sell Init. needs a position bought with Quickdraw on this coin.' : 'This coin is still loading. Try again in a moment.';
                pushToast({ id: `init-${Date.now()}`, level: 'info', text });
              }}
              {...hoverSell(sellInitPct)}
            >
              Sell Init.
            </button>
          </div>
        </section>

        {s.ui.show.pnl && (
          <footer
            class="it-stats"
            title={pos.usd ? 'Showing USD · click for SOL' : 'Showing SOL · click for USD'}
            onClick={() => persist({ ...posRef.current, usd: !posRef.current.usd })}
          >
            <span class="it-buy-c" title="Spent buying this token here">
              {amount(market?.boughtSol ?? 0)}
            </span>
            <span class="it-sell-c" title="Received selling this token here">
              {amount(market?.soldSol ?? 0)}
            </span>
            <span title="Value of what you hold, at the current price">{amount(holdingSol ?? 0)}</span>
            <span
              class={`${pnlSol >= 0 ? 'it-buy-c' : 'it-sell-c'}${projectedPnl !== null ? ' it-projected' : ''}`}
              title={
                projectedPnl !== null
                  ? `Your PnL if you sell ${fmtPct(sellPreview ?? 0)} now: what the sell brings in after the pool's fee, price impact, network fee, priority fee and tip`
                  : 'Holding value + sold − bought − the network fees, priority fees and tips paid, for trades made with Quickdraw'
              }
            >
              {amount(Math.abs(pnlSol), pnlSol >= 0 ? '+' : '−')}({pnlPct >= 0 ? '+' : '−'}
              {fmtPct(Math.abs(pnlPct))})
            </span>
          </footer>
        )}
        {s.ui.show.feesSaved && savedSol > 0 && (
          <div class="it-saved" title="1% of all the volume you've traded with Quickdraw: what a platform fee would have cost">
            Saved {amount(savedSol)} vs a 1% platform fee
          </div>
        )}
        {!pos.compact && resizeHandle('e')}
        {!pos.compact && resizeHandle('s')}
        {!pos.compact && resizeHandle('se')}
      </div>
      {walletPicker}

      {toastsAt === 'panel' && toastList}
    </div>
  );
  if (toastsAt === 'panel') return panel;
  // Pinned to the window: outside the panel's scaled box, which would otherwise carry them along.
  return (
    <>
      {panel}
      <div class={`it-root it-${theme}`} style={{ ...style, left: 0, top: 0, opacity: 1, transform: 'none' }}>
        {toastList}
      </div>
    </>
  );
}

/** Small inline icons: no icon font, no remote assets. */
const svg = (d: string, fill = false) => () => (
  <svg
    class="it-svg"
    viewBox="0 0 24 24"
    aria-hidden="true"
    fill={fill ? 'currentColor' : 'none'}
    stroke={fill ? 'none' : 'currentColor'}
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d={d} />
  </svg>
);

const Icon = {
  bolt: svg('M13 2 4 14h6l-1 8 9-12h-6z', true),
  lock: svg('M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4'),
  // A toothed cog (Lucide's "settings", ISC licence), so it doesn't read as a brightness sun.
  gear: svg(
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  ),
  close: svg('M18 6 6 18M6 6l12 12'),
  pencil: svg('M4 20h4L19 9l-4-4L4 16zM14 6l4 4'),
  check: svg('M5 12.5l4.5 4.5L19 7'),
  wallet: svg('M3 7h16v12H3zM3 7l2-3h12l2 3M15 13h2'),
  copy: svg('M8 8h11v11H8zM5 16V5h11'),
  swap: svg('M7 7h12l-3-3M17 17H5l3 3'),
  expand: svg('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'),
  warn: svg('M12 3 2 20h20zM12 10v4M12 17h.01'),
  slippage: svg('M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4'),
  gas: svg('M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3M4 10h10'),
  coin: svg('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v10M9 9.5h4.5a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3H15'),
  shield: svg('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'),
  /** The Solana mark: three slanted bars, teal to purple. */
  // The official Solana mark (solana.com brand kit), with its gradient.
  sol: () => (
    <svg class="it-svg it-sol" viewBox="0 0 101 88" aria-hidden="true">
      <defs>
        <linearGradient id="it-sol-grad" x1="8.52558" y1="90.0973" x2="88.9933" y2="-3.01622" gradientUnits="userSpaceOnUse">
          <stop offset="0.08" stop-color="#9945FF" />
          <stop offset="0.3" stop-color="#8752F3" />
          <stop offset="0.5" stop-color="#5497D5" />
          <stop offset="0.6" stop-color="#43B4CA" />
          <stop offset="0.72" stop-color="#28E0B9" />
          <stop offset="0.97" stop-color="#19FB9B" />
        </linearGradient>
      </defs>
      <path fill="url(#it-sol-grad)" d="M100.48 69.3817L83.8068 86.8015C83.4444 87.1799 83.0058 87.4816 82.5185 87.6878C82.0312 87.894 81.5055 88.0003 80.9743 88H1.93563C1.55849 88 1.18957 87.8926 0.874202 87.6912C0.558829 87.4897 0.31074 87.2029 0.160416 86.8659C0.0100923 86.529 -0.0359181 86.1566 0.0280382 85.7945C0.0919944 85.4324 0.263131 85.0964 0.520422 84.8278L17.2061 67.408C17.5676 67.0306 18.0047 66.7295 18.4904 66.5234C18.9762 66.3172 19.5002 66.2104 20.0301 66.2095H99.0644C99.4415 66.2095 99.8104 66.3169 100.126 66.5183C100.441 66.7198 100.689 67.0067 100.84 67.3436C100.99 67.6806 101.036 68.0529 100.972 68.415C100.908 68.7771 100.737 69.1131 100.48 69.3817ZM83.8068 34.3032C83.4444 33.9248 83.0058 33.6231 82.5185 33.4169C82.0312 33.2108 81.5055 33.1045 80.9743 33.1048H1.93563C1.55849 33.1048 1.18957 33.2121 0.874202 33.4136C0.558829 33.6151 0.31074 33.9019 0.160416 34.2388C0.0100923 34.5758 -0.0359181 34.9482 0.0280382 35.3103C0.0919944 35.6723 0.263131 36.0083 0.520422 36.277L17.2061 53.6968C17.5676 54.0742 18.0047 54.3752 18.4904 54.5814C18.9762 54.7875 19.5002 54.8944 20.0301 54.8952H99.0644C99.4415 54.8952 99.8104 54.7879 100.126 54.5864C100.441 54.3849 100.689 54.0981 100.84 53.7612C100.99 53.4242 101.036 53.0518 100.972 52.6897C100.908 52.3277 100.737 51.9917 100.48 51.723L83.8068 34.3032ZM1.93563 21.7905H80.9743C81.5055 21.7907 82.0312 21.6845 82.5185 21.4783C83.0058 21.2721 83.4444 20.9704 83.8068 20.592L100.48 3.17219C100.737 2.90357 100.908 2.56758 100.972 2.2055C101.036 1.84342 100.99 1.47103 100.84 1.13408C100.689 0.79713 100.441 0.510296 100.126 0.308823C99.8104 0.107349 99.4415 1.24074e-05 99.0644 0L20.0301 0C19.5002 0.000878397 18.9762 0.107699 18.4904 0.313848C18.0047 0.519998 17.5676 0.821087 17.2061 1.19848L0.524723 18.6183C0.267681 18.8866 0.0966198 19.2223 0.0325185 19.5839C-0.0315829 19.9456 0.0140624 20.3177 0.163856 20.6545C0.31365 20.9913 0.561081 21.2781 0.875804 21.4799C1.19053 21.6817 1.55886 21.7896 1.93563 21.7905Z" />
    </svg>
  ),
};
