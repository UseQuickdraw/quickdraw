import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '../src/settings/schema';
import { defaultSettings, STARTER_PROFILES } from '../src/settings/defaults';
import { deleteProfile, exportSettings, importSettings, upsertProfile } from '../src/settings/profiles';
import { adapterFor } from '../src/sites/registry';
import { axiom } from '../src/sites/axiom';
import { senderUrl } from '../src/solana/sender';

describe('settings', () => {
  it('defaults and starter profiles validate', () => {
    expect(SettingsSchema.safeParse(defaultSettings()).success).toBe(true);
    for (const p of STARTER_PROFILES) {
      expect(upsertProfile(defaultSettings(), p).profiles.some((x) => x.id === p.id)).toBe(true);
    }
  });

  it('defaults are safe: dry-run on, no developer fee, 1 SOL cap', () => {
    const s = defaultSettings();
    expect(s.safety.dryRun).toBe(true);
    expect(s.developerFee).toBeNull();
    expect(s.hotkeys.enabled).toBe(false);
  });

  it('export drops the sweep address and round-trips', () => {
    const s = { ...defaultSettings(), sweepAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' };
    const json = exportSettings(s);
    expect(json).not.toContain(s.sweepAddress);
    const back = importSettings(json, s);
    expect(back.sweepAddress).toBe(s.sweepAddress);
    expect(back.profiles).toEqual(s.profiles);
  });

  it('import strips unknown keys and rejects bad values', () => {
    const payload = JSON.parse(exportSettings(defaultSettings()));
    payload.settings.secretKey = 'smuggled';
    payload.settings.profiles[0].stolen = true;
    const imported = importSettings(JSON.stringify(payload));
    expect(JSON.stringify(imported)).not.toContain('smuggled');
    expect(JSON.stringify(imported)).not.toContain('stolen');

    payload.settings.safety.maxTipSol = 1e9;
    expect(() => importSettings(JSON.stringify(payload))).toThrow(/Invalid settings/);
    payload.settings.safety.maxTipSol = 0.01;
    payload.settings.developerFee = { bps: 100 };
    expect(() => importSettings(JSON.stringify(payload))).toThrow(/Invalid settings/);
    expect(() => importSettings('{"kind":"other"}')).toThrow(/Not a Quickdraw/);
  });

  it('settings saved before the panel-layer option still load', () => {
    const old = structuredClone(defaultSettings()) as unknown as { ui: Record<string, unknown>; safety: { maxTipSol: number } };
    delete old.ui.layer;
    old.safety.maxTipSol = 0.02; // a customised value that must survive
    const r = SettingsSchema.safeParse(old);
    expect(r.success).toBe(true);
    expect(r.data!.ui.layer).toBe('below-popups');
    expect(r.data!.safety.maxTipSol).toBe(0.02);
  });

  it('ships P1/P2/P3 with different fees, and the last profile cannot be deleted', () => {
    const s = defaultSettings();
    expect(s.profiles.map((p) => p.id)).toEqual(['default', 'sniping', 'swing']);
    const fees = s.profiles.map((p) => JSON.stringify([p.slippagePct, p.defaultTier, p.tiers]));
    expect(new Set(fees).size).toBe(3);
    const one = deleteProfile(deleteProfile(s, 'sniping'), 'swing');
    expect(() => deleteProfile(one, 'default')).toThrow(/last profile/);
  });
});

describe('sites', () => {
  it('extracts the address from Axiom token URLs only', () => {
    const doc = { querySelectorAll: () => [], querySelector: () => null } as unknown as Document;
    const addr = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    expect(axiom.extractAddress(doc, new URL(`https://axiom.trade/meme/${addr}?chain=sol`))).toBe(addr);
    expect(axiom.extractAddress(doc, new URL('https://axiom.trade/discover'))).toBeNull();
    expect(adapterFor(new URL('https://axiom.trade/meme/x')).id).toBe('axiom');
    expect(adapterFor(new URL('https://example.com/')).id).toBe('generic');
    expect(axiom.isTradingPage!(new URL(`https://axiom.trade/meme/${addr}`))).toBe(true);
    expect(axiom.isTradingPage!(new URL('https://axiom.trade/discover'))).toBe(false);
    expect(axiom.isTradingPage!(new URL('https://axiom.trade/pulse'))).toBe(false);
  });
});

describe('sender url', () => {
  it('maps tiers and options to query params', () => {
    expect(senderUrl({ tier: 'fast', mevProtect: false, apiKey: null })).toBe('https://sender.helius-rpc.com/fast');
    const eco = new URL(senderUrl({ tier: 'eco', mevProtect: true, apiKey: 'k' }));
    expect(eco.searchParams.get('swqos_only')).toBe('true');
    expect(eco.searchParams.get('mev-protect')).toBe('true');
    expect(eco.searchParams.get('api-key')).toBe('k');
  });
});

describe('settings saved by an older version', () => {
  it('still load when they predate the trade pop-up setting, with pop-ups on', () => {
    const old = structuredClone(defaultSettings()) as unknown as { ui: { show: Record<string, boolean> } };
    delete old.ui.show.tradeToasts;
    const parsed = SettingsSchema.safeParse(old);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.ui.show.tradeToasts).toBe(true);
  });
});
