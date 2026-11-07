// Typed message contracts between the content script, extension pages and the
// background worker. The worker parses every request with these schemas;
// nothing from a sender is trusted until it has passed through here.
import { z } from 'zod';
import { PanelStateSchema, PriorityLevel, SettingsSchema, TierName, type Settings } from './settings/schema';
import type { MintRisk } from './solana/tokens';

const Base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'not a base58 address');
const SiteKey = z.string().min(1).max(253);

/** Requests a content script may send. Deliberately small: no key, vault or settings writes. */
export const ContentRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('GET_STATE') }),
  z.object({ type: z.literal('GET_PANEL_STATE'), site: SiteKey }),
  z.object({ type: z.literal('SAVE_PANEL_STATE'), site: SiteKey, state: PanelStateSchema }),
  z.object({ type: z.literal('RESOLVE'), address: Base58Address }),
  z.object({
    type: z.literal('TRADE'),
    side: z.enum(['buy', 'sell']),
    mint: Base58Address,
    /** Buy: SOL in. Sell: percent of holdings. */
    amount: z.number().finite().positive(),
    tier: TierName,
    presetIndex: z.number().int().min(0).max(15).nullable(),
    /** performance.now()-style click timestamp for the latency harness. */
    clickedAt: z.number().finite(),
  }),
  /** What a sell button would bring in right now, for its hover preview. Nothing is built or signed. */
  z.object({
    type: z.literal('QUOTE_SELL'),
    mint: Base58Address,
    pct: z.number().finite().positive().max(100),
    tier: TierName,
    presetIndex: z.number().int().min(0).max(15).nullable(),
  }),
  /**
   * The pointer is on a trade button: the worker builds that trade (unsigned) and
   * keeps it current, so a click only signs and sends. `trade: null` clears it.
   */
  z.object({
    type: z.literal('PREBUILD'),
    trade: z
      .object({
        mint: Base58Address,
        side: z.enum(['buy', 'sell']),
        amount: z.number().finite().positive(),
        tier: TierName,
        presetIndex: z.number().int().min(0).max(15).nullable(),
      })
      .nullable(),
  }),
  /** What a buy button would get right now, for its hover preview. `sol` is the total across the wallets. */
  z.object({
    type: z.literal('QUOTE_BUY'),
    mint: Base58Address,
    sol: z.number().finite().positive(),
    tier: TierName,
    presetIndex: z.number().int().min(0).max(15).nullable(),
  }),
  z.object({ type: z.literal('OPEN_OPTIONS'), section: z.enum(['wallet', 'endpoints', 'fees', 'settings', 'display', 'ledger']).optional() }),
  /**
   * The panel's P1/P2/P3 tabs: activate the profile in that slot, creating the
   * next one from its starter template if it doesn't exist yet.
   */
  z.object({ type: z.literal('SET_PROFILE_SLOT'), slot: z.number().int().min(0).max(4) }),
  /** The panel's keyboard icon. */
  z.object({ type: z.literal('SET_HOTKEYS'), enabled: z.boolean() }),
  /** Inline fee edits for the active profile; the worker validates against the schema. */
  z.object({
    type: z.literal('UPDATE_FEES'),
    tier: TierName,
    slippagePct: z.number().finite().optional(),
    tipSol: z.number().finite().optional(),
    priorityLevel: PriorityLevel.optional(),
    cuPriceMicroLamports: z.number().int().nonnegative().nullable().optional(),
    mevProtect: z.boolean().optional(),
  }),
  /** The pencil: new values for the active profile's buy (SOL) and sell (%) presets, in order. */
  /** The wallet picker: balances of every wallet, and which are selected. */
  z.object({ type: z.literal('LIST_WALLETS') }),
  /** Trade with these wallets (in order; the first is the primary). */
  z.object({ type: z.literal('SET_ACTIVE_WALLETS'), pubkeys: z.array(z.string().min(32).max(44)).min(1).max(25) }),
  z.object({
    type: z.literal('SET_PRESET_VALUES'),
    buy: z.array(z.number().positive().finite()).max(16),
    sell: z.array(z.number().positive().max(100)).max(16),
    /** Sell-by-SOL amounts, when those were the ones edited. */
    sellSol: z.array(z.number().positive().finite()).max(16).optional(),
  }),
]);
export type ContentRequest = z.infer<typeof ContentRequest>;

const Password = z.string().min(1).max(1024);

export const EndpointsSchema = z.object({
  rpcUrl: z.url({ protocol: /^https$/ }),
  wsUrl: z.url({ protocol: /^wss$/ }),
  /** Optional; keyless Sender is limited to 1 req/s. */
  senderApiKey: z.string().max(256).nullable(),
  /** Only used when settings.sendMode === 'custom'. */
  customSendUrl: z.url({ protocol: /^https$/ }).nullable(),
});
export type Endpoints = z.infer<typeof EndpointsSchema>;

/** Telegram trade alerts. Sealed with the endpoints, never exported with settings. */
export const NotifySchema = z.object({
  /** From @BotFather: "123456789:AA…". */
  botToken: z.string().regex(/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/, 'not a Telegram bot token'),
  chatId: z.number().int(),
  /** For display: the bot's @name and who it messages. */
  botName: z.string().max(64),
  chatName: z.string().max(64),
  enabled: z.boolean(),
  events: z.object({
    /** Trades made here landing. */
    trades: z.boolean(),
    /** Trades made here failing on chain or expiring. */
    failures: z.boolean(),
    /** Trades found on chain that weren't made here (an Axiom TP/SL, another bot). */
    outside: z.boolean(),
  }),
});
export type Notify = z.infer<typeof NotifySchema>;
const BotToken = NotifySchema.shape.botToken;

/** Requests only extension pages (options / popup) may send. */
export const PageRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('WALLET_GENERATE'), name: z.string().max(32).optional() }),
  z.object({ type: z.literal('WALLET_PREVIEW_IMPORT'), secret: z.string().max(2048) }),
  z.object({ type: z.literal('WALLET_IMPORT'), secret: z.string().max(2048), name: z.string().max(32).optional() }),
  z.object({ type: z.literal('WALLET_REVEAL'), pubkey: z.string().min(32).max(44).optional() }),
  /** A backup file encrypted with a password chosen just for the file. */
  z.object({ type: z.literal('WALLET_EXPORT_ENCRYPTED'), password: Password, pubkey: z.string().min(32).max(44).optional() }),
  z.object({ type: z.literal('WALLET_RENAME'), pubkey: z.string().min(32).max(44), name: z.string().max(32) }),
  z.object({ type: z.literal('WALLET_REMOVE'), pubkey: z.string().min(32).max(44) }),
  /** Deletes every wallet, the endpoints and the Telegram bot. */
  z.object({ type: z.literal('WALLET_DELETE') }),
  /** One-time conversion of a wallet created with the old password version. */
  z.object({ type: z.literal('CONVERT_WALLET'), password: Password }),
  z.object({ type: z.literal('SET_ENDPOINTS'), endpoints: EndpointsSchema }),
  z.object({ type: z.literal('GET_ENDPOINTS') }),
  z.object({ type: z.literal('TEST_ENDPOINTS'), endpoints: EndpointsSchema }),
  z.object({ type: z.literal('GET_NOTIFY') }),
  /** Null disconnects the bot. */
  z.object({ type: z.literal('SET_NOTIFY'), notify: NotifySchema.nullable() }),
  /** Finds the bot's name and the chat that last messaged it. */
  z.object({ type: z.literal('NOTIFY_CONNECT'), botToken: BotToken }),
  z.object({ type: z.literal('NOTIFY_TEST') }),
  z.object({ type: z.literal('SAVE_SETTINGS'), settings: SettingsSchema }),
  z.object({ type: z.literal('SET_ONBOARDED') }),
  z.object({ type: z.literal('GET_TRADE_LOG') }),
  /** Changes only safety.dryRun, so a stale copy of other settings can't be written back. */
  z.object({ type: z.literal('SET_DRY_RUN'), dryRun: z.boolean() }),
  z.object({ type: z.literal('GET_LEDGER') }),
  /** Sends all SOL to settings.sweepAddress; `phrase` must match SWEEP_CONFIRM_PHRASE. */
  z.object({ type: z.literal('SWEEP'), phrase: z.string().max(64), pubkey: z.string().min(32).max(44).optional() }),
]);
export type PageRequest = z.infer<typeof PageRequest>;

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string; code?: string };
export type Result<T> = Ok<T> | Err;

export interface WalletInfo {
  pubkey: string;
  name: string;
}

/** A row of the panel's wallet picker. */
export interface WalletRow extends WalletInfo {
  selected: boolean;
  /** SOL balance; null when it couldn't be read (no RPC yet). */
  sol: number | null;
}

export interface WalletState {
  hasWallet: boolean;
  /** Every stored wallet, and the selected ones in trading order (the first is the primary). */
  wallets: WalletInfo[];
  active: string[];
  /** An old password-version wallet that needs its password once to convert. */
  needsPassword: boolean;
  pubkey: string | null;
  hasEndpoints: boolean;
  onboarded: boolean;
  /** Setup was skipped: the panel works as a clickable preview with no wallet or RPC. */
  preview: boolean;
  settings: Settings;
  /** 1% of all volume traded here, across every wallet: the panel's "Saved" line before a coin has loaded. */
  feesSavedSol: number;
}

export interface EndpointTestResult {
  rpc: { ok: boolean; slot?: number; ms?: number; error?: string };
  ws: { ok: boolean; ms?: number; error?: string };
  sender: { ok: boolean; ms?: number; error?: string };
}

export type Venue = 'PUMP_CURVE' | 'PUMP_CURVE_ROUTED' | 'PUMPSWAP' | 'PUMPSWAP_ROUTED' | 'LAUNCHLAB' | 'LAUNCHLAB_ROUTED' | 'RAYDIUM_CPMM' | 'RAYDIUM_CPMM_ROUTED' | 'CLMM_ROUTED' | 'RAYDIUM_AMM' | 'METEORA_DBC' | 'METEORA_DBC_ROUTED' | 'METEORA_DAMM_V2' | 'METEORA_DAMM_V2_ROUTED' | 'UNSUPPORTED';

/** What the panel shows for the token it's on. Numbers are display-only. */
export interface MarketView {
  mint: string;
  venue: Exclude<Venue, 'UNSUPPORTED'>;
  /** The curve or pool account. */
  address: string;
  decimals: number;
  tradable: boolean;
  spotSolPerToken: number;
  tokenBalance: number;
  solBalance: number | null;
  /** From the ledger (trades made with this extension); null when there are none. */
  boughtSol: number | null;
  soldSol: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  /** 1% of all volume traded here: what a platform fee would have cost. */
  feesSavedSol: number;
  /** Estimated priority fee for a buy, per tier, in SOL (live estimate x calibrated CU limit). */
  priorityFeeSol?: { fast: number; eco: number };
  /** On-chain token metadata, when the mint has any. */
  symbol?: string | null;
  /** SOL/USD from the Orca SOL/USDC pool, for display. */
  solUsd?: number | null;
  /** What the coin's creator can do to holders (freeze, take back, hook transfers); absent or [] when nothing. */
  risks?: MintRisk[];
}

/** A sell's proceeds across the trading wallets, in SOL. */
export interface SellQuote {
  /** What the pool pays out, after its fee, price impact and any transfer tax. */
  outSol: number;
  /** Network fee, priority fee and landing tip. */
  feesSol: number;
  /** outSol − feesSol: what the wallets end up with. */
  netSol: number;
}

/** A buy's result across the trading wallets. */
export interface BuyQuote {
  /** Tokens received, after the pool's fee and price impact. */
  tokens: number;
  /** Their value at the current price, in SOL. */
  valueSol: number;
  /** Network fee, priority fee and landing tip, paid on top. */
  feesSol: number;
  /** valueSol − feesSol: what the SOL spent is worth once bought. */
  netSol: number;
}

export type TradeResult =
  /** Live: sent; landed / failed / expired follow as TOAST events with id = signature. */
  | { kind: 'sent'; signature: string; text: string; detail: string }
  /** Dry run: the signed transaction was simulated, not sent. */
  | { kind: 'simulated'; ok: boolean; text: string; detail: string }
  /** Several wallets traded at once; each wallet's own result arrives as a TOAST. */
  | { kind: 'multi'; ok: boolean; text: string; detail: string };

/** Pushed from the worker to open panels over the long-lived 'panel' port. */
export type PanelEvent =
  | { type: 'STATE'; state: WalletState }
  | { type: 'MARKET'; market: MarketView }
  | {
      type: 'TOAST';
      id: string;
      level: 'info' | 'success' | 'error';
      text: string;
      /** A second, smaller line. */
      detail?: string;
      /** Shown only on hover. */
      hover?: string;
      link?: string;
      /** A trade's on-chain result: the panel may play a sound for it. */
      sound?: 'landed' | 'failed';
      /** Replaces an earlier toast with the same id (sent → landed). */
      sticky?: boolean;
    };

export const PANEL_PORT = 'panel';
