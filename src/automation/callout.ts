// Callout automations: signals from the home signal server (pump.fun callouts
// and FOMO theses by the accounts you follow), matched against each config's
// rules. The matcher is pure; SignalFeed is the WebSocket client.
import type { Callout, SignalServer, SignalSource } from './schema';

/** One post, as the signal server sends it. */
export interface Signal {
  id: string;
  source: SignalSource;
  kind: 'callout' | 'thesis';
  /** Wallet (or id) of the poster. */
  author: string;
  authorName?: string;
  authorWallet?: string;
  authorId?: string;
  authorX?: string;
  followers?: number;
  mint: string;
  symbol?: string;
  name?: string;
  text: string;
  /** Market cap (USD) when posted. */
  mcapUsd?: number;
  /** When it was posted (ms), and when the server got it. */
  at?: number;
  receivedAt: number;
}

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A well-formed signal, or null. */
export function readSignal(raw: unknown): Signal | null {
  const s = raw as Partial<Signal> & { type?: string };
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.mint !== 'string' || !MINT.test(s.mint)) return null;
  if (s.source !== 'pumpfun' && s.source !== 'fomo') return null;
  return {
    id: s.id,
    source: s.source,
    kind: s.kind === 'thesis' ? 'thesis' : 'callout',
    author: String(s.author ?? ''),
    authorName: s.authorName,
    authorWallet: s.authorWallet,
    authorId: s.authorId,
    authorX: s.authorX,
    followers: s.followers,
    mint: s.mint,
    symbol: s.symbol,
    name: s.name,
    text: typeof s.text === 'string' ? s.text : '',
    mcapUsd: typeof s.mcapUsd === 'number' ? s.mcapUsd : undefined,
    at: typeof s.at === 'number' ? s.at : undefined,
    receivedAt: typeof s.receivedAt === 'number' ? s.receivedAt : Date.now(),
  };
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9$]+/).map((w) => w.replace(/^\$/, '')).filter(Boolean);

/**
 * Does `caller` (a username, wallet or account id from the config's list for
 * this signal's site) name its author? X handles don't count: they aren't the
 * site's own name, and could belong to someone else there.
 */
export function isCaller(caller: string, s: Signal): boolean {
  const c = caller.trim().replace(/^@/, '').toLowerCase();
  return [s.author, s.authorName, s.authorWallet, s.authorId].some((v) => v && v.toLowerCase() === c);
}

/** Who posted, for the activity log. */
export function signalLabel(s: Signal): string {
  const who = s.authorName ? `@${s.authorName}` : s.author.slice(0, 6);
  const where = s.source === 'pumpfun' ? 'pump.fun callout' : 'FOMO thesis';
  const text = s.text.replace(/\s+/g, ' ').trim();
  return `${where} by ${who}${text ? `: "${text.length > 80 ? `${text.slice(0, 79)}…` : text}"` : ''}`;
}

/** Why this signal doesn't match the config (before looking at the market), or null when it does. */
export function signalMisses(cfg: Callout, s: Signal, now: number): string | null {
  if (!cfg.sources.includes(s.source)) return `${s.source === 'pumpfun' ? 'pump.fun' : 'FOMO'} isn't one of this automation's sources`;
  const callers = cfg.callers[s.source];
  if (callers.length && !callers.some((c) => isCaller(c, s))) return `not one of the ${s.source === 'pumpfun' ? 'pump.fun' : 'FOMO'} callers listed`;
  const age = (now - (s.at ?? s.receivedAt)) / 1000;
  if (age > cfg.maxAgeSec) return `posted ${Math.round(age)}s ago, over the ${cfg.maxAgeSec}s limit`;
  const have = new Set(words(`${s.text} ${s.symbol ?? ''} ${s.name ?? ''}`));
  if (cfg.contains.length && !cfg.contains.some((w) => have.has(w.toLowerCase().replace(/^\$/, '')))) return `the post has none of ${cfg.contains.join(', ')}`;
  const bad = cfg.excludes.find((w) => have.has(w.toLowerCase().replace(/^\$/, '')));
  if (bad) return `the post has "${bad}"`;
  return null;
}

/** Distinct callers of a coin inside the window, counting this one. `seen` is the config's memory (mint -> caller -> time). */
export function callersOf(seen: Map<string, Map<string, number>>, mint: string, caller: string, at: number, windowSec: number): number {
  const callers = seen.get(mint) ?? new Map<string, number>();
  callers.set(caller, at);
  for (const [c, t] of callers) if (at - t > windowSec * 1000) callers.delete(c);
  seen.set(mint, callers);
  return callers.size;
}

export interface FeedStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  detail?: string;
  /** Signals received since the worker started, and the last one's time. */
  count: number;
  lastAt: number | null;
}

/** The signal server's WebSocket, reconnecting with backoff. */
export class SignalFeed {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private closed = false;
  readonly status: FeedStatus = { state: 'connecting', count: 0, lastAt: null };

  constructor(
    readonly server: SignalServer,
    private readonly onSignal: (s: Signal) => void,
  ) {
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    this.status.state = 'connecting';
    let ws: WebSocket;
    try {
      const url = new URL(this.server.url);
      url.searchParams.set('token', this.server.token);
      ws = new WebSocket(url.toString());
    } catch (e) {
      this.status.state = 'error';
      this.status.detail = (e as Error).message;
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.status.state = 'connected';
      this.status.detail = undefined;
    };
    ws.onmessage = (e) => {
      let msg: { type?: string; recent?: unknown[] };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      // Heartbeat: answering keeps the extension's worker (and this socket) awake while no one posts.
      if (msg.type === 'ping') {
        ws.send('{"type":"pong"}');
        return;
      }
      const list = msg.type === 'hello' ? (msg.recent ?? []) : msg.type === 'signal' ? [msg] : [];
      for (const raw of list) {
        const s = readSignal(raw);
        if (!s) continue;
        this.status.count++;
        this.status.lastAt = Date.now();
        this.onSignal(s);
      }
    };
    ws.onclose = (e) => {
      this.ws = null;
      if (this.closed) return;
      this.status.state = 'error';
      this.status.detail = e.code === 4001 ? 'the server refused the token' : `disconnected (${e.code}); retrying`;
      this.timer = setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
  }

  close(): void {
    this.closed = true;
    this.status.state = 'off';
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
