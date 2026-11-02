// An options tab's working copy of the settings: edits stay local until saved,
// and the save bar offers to save or discard them.
import { useState } from 'preact/hooks';
import type { WalletState } from '../../messages';
import { SettingsSchema, type Settings } from '../../settings/schema';
import { call } from '../pageClient';

export function useSettingsDraft(state: WalletState, refresh: () => void) {
  const [s, setS] = useState<Settings>(state.settings);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(next = s) {
    setErr(null);
    setMsg(null);
    const parsed = SettingsSchema.safeParse(next);
    if (!parsed.success) {
      setErr(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    try {
      await call({ type: 'SAVE_SETTINGS', settings: parsed.data });
      setMsg('Saved');
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  /** Runs an edit, showing what it throws (e.g. deleting the last profile) instead of failing silently. */
  const guarded = (fn: () => void) => {
    try {
      setErr(null);
      fn();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const status = (
    <>
      {msg && <p class="ok">{msg}</p>}
      {err && <p class="err">{err}</p>}
      {JSON.stringify(s) !== JSON.stringify(state.settings) && (
        <div class="savebar">
          <span>You have unsaved changes.</span>
          <button onClick={() => setS(state.settings)}>Discard</button>
          <button class="primary" onClick={() => void save()}>
            Save settings
          </button>
        </div>
      )}
    </>
  );

  return { s, setS, save, guarded, setErr, status };
}
