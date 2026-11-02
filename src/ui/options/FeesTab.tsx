// The Fees tab: each profile (the panel's P1, P2, P3...) with its name, tab
// label, presets, slippage, tiers and per-preset overrides.
import { useState } from 'preact/hooks';
import type { WalletState } from '../../messages';
import type { Profile, TierName } from '../../settings/schema';
import { deleteProfile, newProfileId, upsertProfile } from '../../settings/profiles';
import { HARD_LIMITS, SENDER } from '../../constants';
import { useSettingsDraft } from './settingsDraft';

type Overrides = { tier: TierName | null; slippagePct: number | null; tipSol: number | null; cuPriceMicroLamports: number | null };

/** One row per preset; blank fields inherit from the profile. */
function PresetOverrides({ rows, onChange }: { rows: { label: string; o: Overrides }[]; onChange(i: number, patch: Partial<Overrides>): void }) {
  const num = (v: string, int = false) => (v.trim() === '' ? null : int ? Math.round(Number(v)) : Number(v));
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
          <th>Preset</th>
          <th>Tier</th>
          <th>Slippage %</th>
          <th>Tip SOL</th>
          <th>CU price µL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ label, o }, i) => (
          <tr key={i}>
            <td>{label}</td>
            <td>
              <select value={o.tier ?? ''} onChange={(e) => onChange(i, { tier: ((e.target as HTMLSelectElement).value || null) as TierName | null })}>
                <option value="">profile</option>
                <option value="fast">Fast</option>
                <option value="eco">Eco</option>
              </select>
            </td>
            <td>
              <input type="number" step="0.5" value={o.slippagePct ?? ''} onChange={(e) => onChange(i, { slippagePct: num((e.target as HTMLInputElement).value) })} />
            </td>
            <td>
              <input type="number" step="0.000005" value={o.tipSol ?? ''} onChange={(e) => onChange(i, { tipSol: num((e.target as HTMLInputElement).value) })} />
            </td>
            <td>
              <input type="number" min="0" value={o.cuPriceMicroLamports ?? ''} onChange={(e) => onChange(i, { cuPriceMicroLamports: num((e.target as HTMLInputElement).value, true) })} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const NO_OVERRIDES = { tier: null, slippagePct: null, tipSol: null, cuPriceMicroLamports: null };

function nums(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
}

/** The panel can show this many profile tabs. */
const MAX_TABS = 5;

export function FeesTab({ state, refresh }: { state: WalletState; refresh(): void }) {
  const { s, setS, guarded, status } = useSettingsDraft(state, refresh);
  // The profile being edited; starts on the one the panel is using.
  const [editId, setEditId] = useState(s.activeProfileId);
  const p = s.profiles.find((x) => x.id === editId) ?? s.profiles[0]!;
  const slot = s.profiles.indexOf(p);

  const setProfile = (patch: Partial<Profile>) => setS(upsertProfile(s, { ...p, ...patch }));
  const setTier = (t: TierName, patch: Partial<Profile['tiers']['fast']>) =>
    setProfile({ tiers: { ...p.tiers, [t]: { ...p.tiers[t], ...patch } } });
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const checked = (e: Event) => (e.target as HTMLInputElement).checked;

  return (
    <>
      <nav class="tabs">
        {s.profiles.map((x, i) => (
          <button key={x.id} class={x.id === p.id ? 'on' : ''} title={x.name} onClick={() => setEditId(x.id)}>
            {x.tabLabel?.trim() || `P${i + 1}`}
            {x.id === s.activeProfileId && <small style={{ marginLeft: 6, color: 'var(--muted)' }}>in use</small>}
          </button>
        ))}
        {s.profiles.length < MAX_TABS && (
          <button
            title="A new profile, copied from this one"
            onClick={() =>
              guarded(() => {
                const id = newProfileId();
                setS(upsertProfile(s, { ...structuredClone(p), id, name: `${p.name} copy`, tabLabel: undefined }));
                setEditId(id);
              })
            }
          >
            + New
          </button>
        )}
      </nav>

      <div class="card">
        <div class="grid2">
          <label>
            Tab name (shown on the panel, up to 10 characters)
            <input value={p.tabLabel ?? ''} maxLength={10} placeholder={`P${slot + 1}`} onInput={(e) => guarded(() => setProfile({ tabLabel: (e.target as HTMLInputElement).value }))} />
          </label>
          <label>
            Profile name
            <input value={p.name} onInput={(e) => guarded(() => setProfile({ name: (e.target as HTMLInputElement).value }))} />
          </label>
          <label>
            Buy presets (SOL)
            <input
              value={p.buyPresets.map((b) => b.sol).join(' ')}
              onChange={(e) =>
                guarded(() => setProfile({ buyPresets: nums((e.target as HTMLInputElement).value).map((sol, i) => ({ ...NO_OVERRIDES, ...p.buyPresets[i], sol })) }))
              }
            />
          </label>
          <label>
            Sell presets (%)
            <input
              value={p.sellPresets.map((b) => b.pct).join(' ')}
              onChange={(e) =>
                guarded(() => setProfile({ sellPresets: nums((e.target as HTMLInputElement).value).map((pct, i) => ({ ...NO_OVERRIDES, ...p.sellPresets[i], pct })) }))
              }
            />
          </label>
          <label>
            Slippage %
            <input type="number" step="0.5" min={HARD_LIMITS.minSlippagePct} max={HARD_LIMITS.maxSlippagePct} value={p.slippagePct} onChange={(e) => guarded(() => setProfile({ slippagePct: num(e) }))} />
          </label>
          <label>
            Default tier
            <select value={p.defaultTier} onChange={(e) => setProfile({ defaultTier: (e.target as HTMLSelectElement).value as TierName })}>
              <option value="fast">Fast (Sender Max)</option>
              <option value="eco">Eco (SWQOS only)</option>
            </select>
          </label>
          <label>
            Use Eco for buys below (SOL)
            <input type="number" step="0.05" min="0" value={p.ecoBelowSol} onChange={(e) => guarded(() => setProfile({ ecoBelowSol: num(e) }))} />
          </label>
        </div>
        {(['fast', 'eco'] as const).map((t) => (
          <div key={t} class="grid2" style={{ marginTop: 12 }}>
            <label>
              {t === 'fast' ? 'Fast' : 'Eco'} tip (SOL, min {t === 'fast' ? SENDER.minTipFastSol : SENDER.minTipEcoSol})
              <input type="number" step="0.000005" min="0" value={p.tiers[t].tipSol} onChange={(e) => guarded(() => setTier(t, { tipSol: num(e) }))} />
            </label>
            <label>
              Priority level
              <select value={p.tiers[t].priorityLevel} onChange={(e) => setTier(t, { priorityLevel: (e.target as HTMLSelectElement).value as Profile['tiers']['fast']['priorityLevel'] })}>
                {['min', 'low', 'medium', 'high', 'veryHigh'].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <label>
              Fixed CU price (µlamports, blank = live estimate)
              <input
                type="number"
                min="0"
                value={p.tiers[t].cuPriceMicroLamports ?? ''}
                onChange={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  guarded(() => setTier(t, { cuPriceMicroLamports: v === '' ? null : Math.round(Number(v)) }));
                }}
              />
            </label>
            <label class="inline">
              <input type="checkbox" checked={p.tiers[t].mevProtect} onChange={(e) => setTier(t, { mevProtect: checked(e) })} />
              MEV protect
            </label>
          </div>
        ))}
        <div class="row" style={{ marginTop: 12 }}>
          {p.id !== s.activeProfileId && <button onClick={() => setS({ ...s, activeProfileId: p.id })}>Use in the panel</button>}
          <button
            class="danger"
            onClick={() =>
              guarded(() => {
                const next = deleteProfile(s, p.id);
                setS(next);
                setEditId(next.activeProfileId);
              })
            }
          >
            Delete this profile
          </button>
        </div>
      </div>

      <details class="card">
        <summary>Per-preset overrides</summary>
        <p>Blank = use the profile's setting. Useful for, say, a big buy button with tighter slippage or a fixed Fast tip.</p>
        <PresetOverrides
          rows={p.buyPresets.map((b) => ({ label: `Buy ${b.sol} SOL`, o: b }))}
          onChange={(i, patch) => guarded(() => setProfile({ buyPresets: p.buyPresets.map((b, k) => (k === i ? { ...b, ...patch } : b)) }))}
        />
        <PresetOverrides
          rows={p.sellPresets.map((x) => ({ label: `Sell ${x.pct}%`, o: x }))}
          onChange={(i, patch) => guarded(() => setProfile({ sellPresets: p.sellPresets.map((x, k) => (k === i ? { ...x, ...patch } : x)) }))}
        />
      </details>
      {status}
    </>
  );
}
