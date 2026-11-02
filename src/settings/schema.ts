// Single source of truth for every user-facing option. Anything persisted or
// imported goes through these schemas; nothing reads raw storage shapes.
// Secrets (key material, RPC URLs, Sender API key) are NOT part of settings:
// they live in the encrypted vault (src/keystore).
import { z } from 'zod';
import { HARD_LIMITS } from '../constants';

// No runtime code generation anywhere: MV3 CSP forbids it and we don't want the probe.
z.config({ jitless: true });

export const TierName = z.enum(['fast', 'eco']);
export type TierName = z.infer<typeof TierName>;

export const PriorityLevel = z.enum(['min', 'low', 'medium', 'high', 'veryHigh']);
export type PriorityLevel = z.infer<typeof PriorityLevel>;

const sol = (max: number) => z.number().finite().nonnegative().max(max);

export const TierSchema = z.object({
  tipSol: sol(HARD_LIMITS.maxTipSol),
  priorityLevel: PriorityLevel,
  /** Fixed CU price in micro-lamports; overrides the live estimate when set. */
  cuPriceMicroLamports: z.number().int().nonnegative().nullable(),
  mevProtect: z.boolean(),
});
export type Tier = z.infer<typeof TierSchema>;

/** Per-preset overrides; null = inherit from the profile. */
const PresetOverrides = {
  tier: TierName.nullable(),
  slippagePct: z.number().min(HARD_LIMITS.minSlippagePct).max(HARD_LIMITS.maxSlippagePct).nullable(),
  tipSol: sol(HARD_LIMITS.maxTipSol).nullable(),
  cuPriceMicroLamports: z.number().int().nonnegative().nullable(),
};

export const BuyPresetSchema = z.object({
  sol: z.number().positive().max(HARD_LIMITS.maxTradeSol),
  ...PresetOverrides,
});
export type BuyPreset = z.infer<typeof BuyPresetSchema>;

export const SellPresetSchema = z.object({
  pct: z.number().positive().max(100),
  ...PresetOverrides,
});
export type SellPreset = z.infer<typeof SellPresetSchema>;

export const ProfileSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(40),
  /** The panel tab's label in place of "P1", "P2"...; unset or blank = the slot number. */
  tabLabel: z.string().max(10).optional(),
  buyPresets: z.array(BuyPresetSchema).min(1).max(16),
  sellPresets: z.array(SellPresetSchema).min(1).max(16),
  /** Sells by SOL amount (the panel's Sell ⇄ switch); unset = the buy amounts. */
  sellSolPresets: z.array(z.number().positive().max(HARD_LIMITS.maxTradeSol)).max(16).optional(),
  defaultTier: TierName,
  /** Buys at or below this size default to Eco, since a fixed Fast tip dominates small trades. */
  ecoBelowSol: sol(HARD_LIMITS.maxTradeSol),
  tiers: z.object({ fast: TierSchema, eco: TierSchema }),
  slippagePct: z.number().min(HARD_LIMITS.minSlippagePct).max(HARD_LIMITS.maxSlippagePct),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const SafetySchema = z.object({
  maxTipSol: sol(HARD_LIMITS.maxTipSol),
  maxPriorityFeeSol: sol(HARD_LIMITS.maxPriorityFeeSol),
  autoCloseAta: z.boolean(),
  /** Simulate instead of sending. Default on until live sending is verified. */
  dryRun: z.boolean(),
});

export const SendModeSchema = z.enum(['sender', 'rpc', 'custom']);

export const UiSchema = z.object({
  theme: z.enum(['dark', 'light', 'auto']),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** The panel's background colour; null follows the theme. Defaulted, so settings saved before it still load. */
  panelBg: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  /** How strongly the background image (if any) shows over the panel colour. */
  panelImageOpacity: z.number().min(0).max(1).default(0.35),
  layout: z.enum(['compact', 'full']),
  opacity: z.number().min(0.3).max(1),
  scale: z.number().min(0.6).max(1.6),
  startCollapsed: z.boolean(),
  /** Stacking vs the site: below its pop-ups (tweet cards, menus), above them, or always on top. */
  layer: z.enum(['below-popups', 'above-popups', 'top']).default('below-popups'),
  /** Where pop-ups appear: under the panel, or pinned to a corner or edge of the window. */
  toastPosition: z.enum(['panel', 'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']).default('panel'),
  /** How long each pop-up stays, in seconds. */
  toastSeconds: z.number().min(1).max(60).default(10),
  /** Rows of four buttons on each side. */
  rows: z.object({ buy: z.number().int().min(1).max(3), sell: z.number().int().min(1).max(3) }).default({ buy: 2, sell: 2 }),
  /** Sell buttons: follow the SOL/% switch, SOL amounts on the first row then %, or always %. */
  sellRows: z.enum(['follow', 'mixed', 'pct']).default('follow'),
  buttonShape: z.enum(['square', 'rounded']).default('square'),
  /** The most pop-ups on screen at once; older ones drop off first. */
  toastMax: z.number().int().min(1).max(4).default(4),
  /** A sound when a trade lands or fails on chain. */
  sound: z.object({ enabled: z.boolean(), volume: z.number().min(0).max(1) }).default({ enabled: false, volume: 0.6 }),
  show: z.object({
    pnl: z.boolean(),
    feesSaved: z.boolean(),
    venueBadge: z.boolean(),
    /** Trade pop-ups (sending, sent, landed); failures always show. Defaulted, so settings saved before it still load. */
    tradeToasts: z.boolean().default(true),
    /** The SOL / % labels and the Sell switch in the buy and sell headers. */
    currencySwitch: z.boolean().default(true),
    /** Your holdings (tokens, USD, SOL) in the sell header. */
    tokenAmounts: z.boolean().default(true),
  }),
});

const Hotkey = z.string().max(32).nullable();
export const HotkeysSchema = z.object({
  enabled: z.boolean(),
  buy: z.array(Hotkey).max(16),
  sell: z.array(Hotkey).max(16),
  toggleTier: Hotkey,
  togglePanel: Hotkey,
});

export const SettingsSchema = z.object({
  schemaVersion: z.literal(1),
  activeProfileId: z.string(),
  profiles: z.array(ProfileSchema).min(1).max(20),
  safety: SafetySchema,
  sendMode: SendModeSchema,
  ui: UiSchema,
  hotkeys: HotkeysSchema,
  /** Destination for "Sweep to main wallet". Not secret, but never defaulted. */
  sweepAddress: z.string().max(64).nullable(),
  /** Opt-in only. Must stay null by default; see README "Fees". */
  developerFee: z.null(),
}).refine((s) => s.profiles.some((p) => p.id === s.activeProfileId), {
  message: 'activeProfileId must reference an existing profile',
  path: ['activeProfileId'],
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Panel position is UI state, not a setting, so it's not exported with settings. */
export const PanelStateSchema = z.object({
  x: z.number(),
  y: z.number(),
  collapsed: z.boolean(),
  compact: z.boolean().optional(),
  /** Size the user dragged the panel to; unset = natural size. */
  w: z.number().optional(),
  h: z.number().optional(),
  /** The P&L footer shows USD instead of SOL (click it to switch). */
  usd: z.boolean().optional(),
  /** Sell buttons are SOL amounts instead of percentages (the Sell ⇄ switch). */
  sellSol: z.boolean().optional(),
});
export type PanelState = z.infer<typeof PanelStateSchema>;
