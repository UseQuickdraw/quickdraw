import type { BuyPreset, Profile, SellPreset, Settings } from './schema';

const NO_OVERRIDES = { tier: null, slippagePct: null, tipSol: null, cuPriceMicroLamports: null } as const;

const buy = (sol: number): BuyPreset => ({ sol, ...NO_OVERRIDES });
const sell = (pct: number): SellPreset => ({ pct, ...NO_OVERRIDES });

export const DEFAULT_BUY_SOL = [0.1, 0.2, 0.3, 0.5, 0.001, 1, 2, 0.05];
export const DEFAULT_SELL_PCT = [10, 25, 50, 100, 30, 20, 40, 75];
/** What a third row of buttons starts with, until edited with the pencil. */
const EXTRA_BUY_SOL = [3, 5, 10, 0.25];
const EXTRA_SELL_PCT = [5, 15, 60, 90];

/** `presets` padded to `n` with the extra-row starting values (a profile may hold fewer than the rows shown). */
export function padBuyPresets(presets: BuyPreset[], n: number): BuyPreset[] {
  return Array.from({ length: n }, (_, i) => presets[i] ?? buy(EXTRA_BUY_SOL[i % 4]!));
}
export function padSellPresets(presets: SellPreset[], n: number): SellPreset[] {
  return Array.from({ length: n }, (_, i) => presets[i] ?? sell(EXTRA_SELL_PCT[i % 4]!));
}

function baseProfile(id: string, name: string): Profile {
  return {
    id,
    name,
    buyPresets: DEFAULT_BUY_SOL.map(buy),
    sellPresets: DEFAULT_SELL_PCT.map(sell),
    defaultTier: 'fast',
    ecoBelowSol: 0.5,
    tiers: {
      fast: { tipSol: 0.001, priorityLevel: 'high', cuPriceMicroLamports: null, mevProtect: true },
      eco: { tipSol: 0.00001, priorityLevel: 'medium', cuPriceMicroLamports: null, mevProtect: true },
    },
    slippagePct: 15,
  };
}

/** Starter profiles offered in onboarding. */
export const STARTER_PROFILES: Profile[] = [
  baseProfile('default', 'Default'),
  {
    ...baseProfile('sniping', 'Sniping'),
    defaultTier: 'fast',
    ecoBelowSol: 0,
    slippagePct: 25,
    tiers: {
      fast: { tipSol: 0.002, priorityLevel: 'veryHigh', cuPriceMicroLamports: null, mevProtect: true },
      eco: { tipSol: 0.00001, priorityLevel: 'high', cuPriceMicroLamports: null, mevProtect: true },
    },
  },
  {
    ...baseProfile('swing', 'Swing'),
    defaultTier: 'eco',
    ecoBelowSol: 100,
    slippagePct: 10,
  },
];

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    activeProfileId: 'default',
    // P1 / P2 / P3 in the panel, each with its own fees.
    profiles: STARTER_PROFILES.map((p) => structuredClone(p)),
    safety: {
      maxTipSol: 0.01,
      maxPriorityFeeSol: 0.005,
      autoCloseAta: false,
      dryRun: true,
    },
    sendMode: 'sender',
    ui: {
      theme: 'dark',
      accent: '#ffffff',
      panelBg: null,
      panelImageOpacity: 0.35,
      layout: 'full',
      opacity: 1,
      scale: 1,
      startCollapsed: false,
      layer: 'below-popups',
      toastPosition: 'panel',
      toastSeconds: 10,
      toastMax: 4,
      rows: { buy: 2, sell: 2 },
      sellRows: 'follow',
      buttonShape: 'square',
      sound: { enabled: false, volume: 0.6 },
      show: { pnl: true, feesSaved: true, venueBadge: true, tradeToasts: true, currencySwitch: true, tokenAmounts: true },
    },
    hotkeys: {
      enabled: false,
      buy: ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', null, null, null, null],
      sell: ['Alt+Shift+1', 'Alt+Shift+2', 'Alt+Shift+3', 'Alt+Shift+4', null, null, null, null],
      toggleTier: null,
      togglePanel: null,
    },
    sweepAddress: null,
    developerFee: null,
  };
}
