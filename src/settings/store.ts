// Background-only persistence for settings and per-site panel state.
import { browser } from 'wxt/browser';
import { PanelStateSchema, SettingsSchema, type PanelState, type Settings } from './schema';
import { defaultSettings } from './defaults';

const SETTINGS_KEY = 'settings';
const PANEL_KEY = 'panelState';

export async function loadSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) return defaultSettings();
  // 0.97 was the old default and let the page show through; treat it as unset.
  if (parsed.data.ui.opacity === 0.97) parsed.data.ui.opacity = 1;
  // The old purple default; the panel now follows Axiom's white accent.
  if (parsed.data.ui.accent === '#7c5cff') parsed.data.ui.accent = '#ffffff';
  return parsed.data;
}

export async function saveSettings(s: Settings): Promise<Settings> {
  const valid = SettingsSchema.parse(s);
  await browser.storage.local.set({ [SETTINGS_KEY]: valid });
  return valid;
}

export async function loadPanelState(site: string): Promise<PanelState | null> {
  const all = ((await browser.storage.local.get(PANEL_KEY))[PANEL_KEY] ?? {}) as Record<string, unknown>;
  const parsed = PanelStateSchema.safeParse(all[site]);
  return parsed.success ? parsed.data : null;
}

export async function savePanelState(site: string, state: PanelState): Promise<void> {
  const valid = PanelStateSchema.parse(state);
  const all = ((await browser.storage.local.get(PANEL_KEY))[PANEL_KEY] ?? {}) as Record<string, unknown>;
  await browser.storage.local.set({ [PANEL_KEY]: { ...all, [site]: valid } });
}
