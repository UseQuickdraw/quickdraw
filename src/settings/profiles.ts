import { ProfileSchema, SettingsSchema, type Profile, type Settings } from './schema';
import { defaultSettings } from './defaults';

export const EXPORT_KIND = 'instanttrench-settings';

export function activeProfile(s: Settings): Profile {
  // The schema guarantees the active id exists.
  return s.profiles.find((p) => p.id === s.activeProfileId)!;
}

export function upsertProfile(s: Settings, profile: Profile): Settings {
  const p = ProfileSchema.parse(profile);
  const exists = s.profiles.some((x) => x.id === p.id);
  const profiles = exists ? s.profiles.map((x) => (x.id === p.id ? p : x)) : [...s.profiles, p];
  return SettingsSchema.parse({ ...s, profiles });
}

export function deleteProfile(s: Settings, id: string): Settings {
  if (s.profiles.length <= 1) throw new Error('Cannot delete the last profile');
  const profiles = s.profiles.filter((p) => p.id !== id);
  const activeProfileId = s.activeProfileId === id ? profiles[0]!.id : s.activeProfileId;
  return SettingsSchema.parse({ ...s, profiles, activeProfileId });
}

export function setActiveProfile(s: Settings, id: string): Settings {
  return SettingsSchema.parse({ ...s, activeProfileId: id });
}

export function newProfileId(): string {
  return `p-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Shareable JSON. Settings never contain key material or endpoints, and the
 * sweep address is dropped too since it identifies the user.
 */
export function exportSettings(s: Settings): string {
  const { sweepAddress: _omit, ...shareable } = s;
  return JSON.stringify({ kind: EXPORT_KIND, settings: shareable }, null, 2);
}

/**
 * Parses a shared settings file. Unknown keys are stripped by the schema, so a
 * crafted file can't smuggle extra fields into storage. The importer's own
 * sweep address is kept.
 */
export function importSettings(json: string, current: Settings = defaultSettings()): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { kind?: unknown }).kind !== EXPORT_KIND) {
    throw new Error('Not a Quickdraw (or InstantTrench) settings file');
  }
  const incoming = (parsed as { settings?: unknown }).settings;
  const result = SettingsSchema.safeParse({
    ...(incoming as object),
    sweepAddress: current.sweepAddress,
  });
  if (!result.success) throw new Error(`Invalid settings: ${result.error.issues[0]?.message ?? 'unknown'}`);
  return result.data;
}
