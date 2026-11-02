import type { WalletState } from '../../messages';
import type { Settings } from '../../settings/schema';
import { activeProfile, exportSettings, importSettings } from '../../settings/profiles';
import { download } from '../pageClient';
import { useSettingsDraft } from './settingsDraft';
import { comboFromEvent, duplicateCombos } from '../hotkeys';
import { BASE58_ADDRESS } from '../../sites/types';
import { LIVE_WARNING } from '../warnings';

/** Click, then press a key combo. Backspace/Delete clears it. */
function HotkeyInput({ value, onChange }: { value: string | null; onChange(v: string | null): void }) {
  return (
    <input
      readOnly
      placeholder="Click, then press keys"
      value={value ?? ''}
      style={{ maxWidth: 170 }}
      onKeyDown={(e) => {
        e.preventDefault();
        if ((e.key === 'Backspace' || e.key === 'Delete') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) return onChange(null);
        if (e.key === 'Tab' || e.key === 'Escape') return;
        const combo = comboFromEvent(e);
        if (combo) onChange(combo);
      }}
    />
  );
}

export function SettingsTab({ state, refresh }: { state: WalletState; refresh(): void }) {
  const { s, setS, save, setErr, status } = useSettingsDraft(state, refresh);
  // Hotkeys follow the presets of the profile the panel is using.
  const p = activeProfile(s);
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const checked = (e: Event) => (e.target as HTMLInputElement).checked;

  return (
    <>
      <p>Each profile's presets, slippage and tips are on the Fees tab, and the panel's look on the Display tab.</p>

      <h2>Safety</h2>
      <div class="card grid2">
        <label>
          Max tip (SOL)
          <input type="number" step="0.001" min="0" value={s.safety.maxTipSol} onChange={(e) => setS({ ...s, safety: { ...s.safety, maxTipSol: num(e) } })} />
        </label>
        <label>
          Max priority fee (SOL)
          <input type="number" step="0.001" min="0" value={s.safety.maxPriorityFeeSol} onChange={(e) => setS({ ...s, safety: { ...s.safety, maxPriorityFeeSol: num(e) } })} />
        </label>
        <label class="inline">
          <input type="checkbox" checked={s.safety.autoCloseAta} onChange={(e) => setS({ ...s, safety: { ...s.safety, autoCloseAta: checked(e) } })} />
          Close token account after a 100% sell (reclaims rent)
        </label>
        <label class="inline">
          <input
            type="checkbox"
            checked={s.safety.dryRun}
            onChange={(e) => {
              const on = checked(e);
              if (!on && !confirm(LIVE_WARNING)) {
                (e.target as HTMLInputElement).checked = true;
                return;
              }
              setS({ ...s, safety: { ...s.safety, dryRun: on } });
            }}
          />
          Dry run (simulate, never send)
        </label>
        {s.safety.dryRun !== state.settings.safety.dryRun && (
          <p class="err">{s.safety.dryRun ? 'Dry run turns back on' : 'Live trading turns on'} when you save.</p>
        )}
        <label>
          Sweep address (your main wallet)
          <input value={s.sweepAddress ?? ''} onChange={(e) => setS({ ...s, sweepAddress: (e.target as HTMLInputElement).value.trim() || null })} />
          {s.sweepAddress && !BASE58_ADDRESS.test(s.sweepAddress) && <span class="err">Not a Solana address</span>}
          {s.sweepAddress && s.sweepAddress === state.pubkey && <span class="err">That's this burner, not your main wallet</span>}
        </label>
        <label>
          Send via
          <select value={s.sendMode} onChange={(e) => setS({ ...s, sendMode: (e.target as HTMLSelectElement).value as Settings['sendMode'] })}>
            <option value="sender">Helius Sender (default)</option>
            <option value="rpc">My RPC sendTransaction</option>
            <option value="custom">Custom URL</option>
          </select>
        </label>
      </div>

      <h2>Hotkeys</h2>
      <div class="card">
        <label class="inline">
          <input type="checkbox" checked={s.hotkeys.enabled} onChange={(e) => setS({ ...s, hotkeys: { ...s.hotkeys, enabled: checked(e) } })} />
          Enable hotkeys on trading pages
        </label>
        <p>
          Shortcuts fire instantly, like clicking the preset. They're ignored while you type in a page's text box. Pick combos the site doesn't
          already use.
        </p>
        <div class="grid2">
          {p.buyPresets.map((b, i) => (
            <label key={`b${i}`}>
              Buy {b.sol} SOL
              <HotkeyInput
                value={s.hotkeys.buy[i] ?? null}
                onChange={(v) => {
                  const buy = [...s.hotkeys.buy];
                  buy[i] = v;
                  setS({ ...s, hotkeys: { ...s.hotkeys, buy: Array.from({ length: Math.max(buy.length, i + 1) }, (_, k) => buy[k] ?? null) } });
                }}
              />
            </label>
          ))}
          {p.sellPresets.map((x, i) => (
            <label key={`s${i}`}>
              Sell {x.pct}%
              <HotkeyInput
                value={s.hotkeys.sell[i] ?? null}
                onChange={(v) => {
                  const sell = [...s.hotkeys.sell];
                  sell[i] = v;
                  setS({ ...s, hotkeys: { ...s.hotkeys, sell: Array.from({ length: Math.max(sell.length, i + 1) }, (_, k) => sell[k] ?? null) } });
                }}
              />
            </label>
          ))}
          <label>
            Switch Fast / Eco
            <HotkeyInput value={s.hotkeys.toggleTier} onChange={(v) => setS({ ...s, hotkeys: { ...s.hotkeys, toggleTier: v } })} />
          </label>
          <label>
            Show / hide panel
            <HotkeyInput value={s.hotkeys.togglePanel} onChange={(v) => setS({ ...s, hotkeys: { ...s.hotkeys, togglePanel: v } })} />
          </label>
        </div>
        {(() => {
          const dup = duplicateCombos([...s.hotkeys.buy, ...s.hotkeys.sell, s.hotkeys.toggleTier, s.hotkeys.togglePanel]);
          return dup.length > 0 && <p class="err">Used more than once: {dup.join(', ')}</p>;
        })()}
      </div>

      <div class="row" style={{ marginTop: 16 }}>
        <button class="primary" onClick={() => void save()}>
          Save settings
        </button>
        <button onClick={() => download('quickdraw-settings.json', exportSettings(s))}>Export JSON</button>
        <label style={{ display: 'inline-flex' }}>
          <input
            type="file"
            accept="application/json"
            onChange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (!f) return;
              try {
                const imported = importSettings(await f.text(), s);
                setS(imported);
                await save(imported);
              } catch (ex) {
                setErr((ex as Error).message);
              }
            }}
          />
        </label>
      </div>
      {status}
    </>
  );
}
