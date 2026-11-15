import { useState } from 'preact/hooks';
import type { AutomationsState, WalletState } from '../../messages';
import { CalloutSchema, PLATFORMS, SIGNAL_SOURCES, SignalServerSchema, newCallout, type Automations, type Callout, type Platform, type SignalSource } from '../../automation/schema';
import { shortAddr } from '../format';
import { ListField } from './ListField';

// Callouts: buys coins that the callers you follow call out on pump.fun or post
// a thesis about in FOMO. Signals come from your home signal server.

const SOURCE_LABEL: Record<SignalSource, string> = { pumpfun: 'pump.fun callouts', fomo: 'FOMO theses' };
const PLATFORM_LABEL: Record<Platform, string> = { pump: 'pump.fun / PumpSwap', raydium: 'Raydium', meteora: 'Meteora', orca: 'Orca / CLMM' };
const num = (e: Event) => Number((e.target as HTMLInputElement).value);
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
const text = (e: Event) => (e.target as HTMLInputElement).value;
const listOf = (raw: string) => [...new Set(raw.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export function CalloutsView(props: {
  data: AutomationsState;
  state: WalletState;
  save(next: Automations): Promise<void>;
  ladderEditor(steps: Callout['ladder'], onChange: (s: Callout['ladder']) => void): preact.JSX.Element;
}) {
  const a = props.data.automations;
  const [editing, setEditing] = useState<Callout | null>(null);
  return (
    <>
      <ServerCard data={props.data} save={props.save} />
      <div class="auto-head">
        <h3>Callout snipers</h3>
        <span class="spacer" />
        <button class="primary" onClick={() => setEditing(newCallout(crypto.randomUUID()))}>
          + New callout sniper
        </button>
      </div>
      <p class="muted">
        Buys a coin when a caller you follow calls it out on pump.fun or posts a thesis on it in FOMO. Your signal server only passes posts by accounts
        its logged-in pump.fun and FOMO accounts follow.
      </p>
      {a.callouts.length === 0 && <div class="card empty">No callout snipers yet.</div>}
      {a.callouts.map((c) => (
        <div key={c.id} class={`card auto-item ${c.enabled ? '' : 'off'}`} onClick={() => setEditing(structuredClone(c))}>
          <div>
            <span class="auto-title">
              <b>{c.name}</b>
              {c.dryRun && <span class="chip dry">Dry run</span>}
            </span>
            <small>
              {c.sources
                .map((s) => `${SOURCE_LABEL[s]} (${c.callers[s].length ? `${c.callers[s].length} caller${c.callers[s].length === 1 ? '' : 's'}` : 'everyone followed'})`)
                .join(' + ')}{' '}
              ·{' '}
              {c.buySol} SOL · within {c.maxAgeSec}s{c.consensus ? ` · ${c.consensus.count}+ callers` : ''} · bought {props.data.fires[c.id] ?? 0}
              {c.maxFires ? ` / ${c.maxFires}` : ''}
            </small>
          </div>
          <input
            type="checkbox"
            class="switch"
            checked={c.enabled}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => void props.save({ ...a, callouts: a.callouts.map((x) => (x.id === c.id ? { ...x, enabled: checked(e) } : x)) })}
          />
        </div>
      ))}
      {editing && (
        <CalloutEditor
          value={editing}
          state={props.state}
          isNew={!a.callouts.some((c) => c.id === editing.id)}
          ladderEditor={props.ladderEditor}
          onClose={() => setEditing(null)}
          onSave={async (c) => {
            const exists = a.callouts.some((x) => x.id === c.id);
            await props.save({ ...a, callouts: exists ? a.callouts.map((x) => (x.id === c.id ? c : x)) : [...a.callouts, c] });
            setEditing(null);
          }}
          onDelete={async () => {
            await props.save({ ...a, callouts: a.callouts.filter((x) => x.id !== editing.id) });
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function ServerCard({ data, save }: { data: AutomationsState; save(next: Automations): Promise<void> }) {
  const a = data.automations;
  const [url, setUrl] = useState(a.signalServer?.url ?? '');
  const [token, setToken] = useState(a.signalServer?.token ?? '');
  const [err, setErr] = useState<string | null>(null);
  const st = data.signals;
  const status =
    st.state === 'connected'
      ? `Connected · ${st.count} signal${st.count === 1 ? '' : 's'}${st.lastAt ? `, last ${ago(st.lastAt)}` : ''}`
      : st.state === 'connecting'
        ? 'Connecting…'
        : st.state === 'error'
          ? `Not connected: ${st.detail ?? 'error'}`
          : a.signalServer
            ? 'Idle (connects while a callout sniper is on)'
            : 'Not set up';
  const submit = async () => {
    setErr(null);
    if (!url && !token) return save({ ...a, signalServer: null });
    const r = SignalServerSchema.safeParse({ url: url.trim(), token: token.trim() });
    if (!r.success) return setErr(r.error.issues[0]!.message);
    await save({ ...a, signalServer: r.data });
  };
  return (
    <div class="card">
      <h4>Signal server</h4>
      <div class="grid2">
        <label>
          Address
          <input class="mono" placeholder="ws://your-server:8787" value={url} onInput={(e) => setUrl(text(e))} />
        </label>
        <label>
          Token
          <input class="mono" type="password" placeholder="from the server's config.json" value={token} onInput={(e) => setToken(text(e))} />
        </label>
      </div>
      <div class="row">
        <span class={`chip ${st.state === 'connected' ? 'ok' : st.state === 'error' ? 'bad' : ''}`}>{status}</span>
        <span class="spacer" />
        <button class="primary" onClick={() => void submit()}>
          Save
        </button>
      </div>
      {err && <p class="err">{err}</p>}
    </div>
  );
}

function CalloutEditor(props: {
  value: Callout;
  state: WalletState;
  isNew: boolean;
  ladderEditor(steps: Callout['ladder'], onChange: (s: Callout['ladder']) => void): preact.JSX.Element;
  onClose(): void;
  onSave(c: Callout): Promise<void>;
  onDelete(): Promise<void>;
}) {
  const [c, setC] = useState<Callout>(props.value);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Callout>) => setC({ ...c, ...patch });
  const toggle = <T,>(list: readonly T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const submit = async () => {
    const parsed = CalloutSchema.safeParse(c);
    if (!parsed.success) return setErr(`${parsed.error.issues[0]!.path.join('.')}: ${parsed.error.issues[0]!.message}`);
    await props.onSave(parsed.data);
  };
  return (
    <div class="modal-back" onClick={props.onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{props.isNew ? 'New callout sniper' : c.name}</h3>
          <button class="icon" onClick={props.onClose} title="Close">
            ✕
          </button>
        </header>
        <div class="modal-body">
          <h4>General</h4>
          <div class="grid2">
            <label>
              Name
              <input maxLength={16} value={c.name} onInput={(e) => set({ name: text(e) })} />
            </label>
            <div class="toggles">
              <label class="inline">
                <input type="checkbox" class="switch" checked={c.enabled} onChange={(e) => set({ enabled: checked(e) })} /> Enabled
              </label>
              <label class="inline">
                <input type="checkbox" class="switch" checked={c.dryRun} onChange={(e) => set({ dryRun: checked(e) })} /> Dry run
              </label>
            </div>
          </div>

          <h4>Signals</h4>
          <div class="row">
            {SIGNAL_SOURCES.map((s) => (
              <label key={s} class="inline">
                <input type="checkbox" checked={c.sources.includes(s)} onChange={(e) => set({ sources: toggle(c.sources, s, checked(e)) })} /> {SOURCE_LABEL[s]}
              </label>
            ))}
          </div>
          <div class="grid2">
            {SIGNAL_SOURCES.map((src) => (
              <label key={src}>
                Only these {src === 'pumpfun' ? 'pump.fun' : 'FOMO'} callers
                <ListField
                  multiline
                  sep={'\n'}
                  placeholder={`${src === 'pumpfun' ? 'pump.fun' : 'FOMO'} usernames or wallets. Empty = everyone your server follows there.`}
                  value={c.callers[src]}
                  parse={(raw) => [...new Set(listOf(raw).map((x) => x.replace(/^@/, '')).filter(Boolean))]}
                  onList={(list) => set({ callers: { ...c.callers, [src]: list } })}
                />
              </label>
            ))}
          </div>
          <p class="muted">Each list only matches posts from its own site, so a name on one site can't match someone else on the other.</p>
          <div class="grid3">
            <label>
              Max post age (s)
              <input type="number" step="5" min="5" max="3600" value={c.maxAgeSec} onInput={(e) => set({ maxAgeSec: Math.round(num(e)) })} />
            </label>
            <label>
              Post contains
              <ListField placeholder="any words" value={c.contains} parse={listOf} onList={(contains) => set({ contains })} />
            </label>
            <label>
              Post excludes
              <ListField placeholder="rug, scam" value={c.excludes} parse={listOf} onList={(excludes) => set({ excludes })} />
            </label>
          </div>
          <label class="inline">
            <input
              type="checkbox"
              checked={!!c.consensus}
              onChange={(e) => set({ consensus: checked(e) ? { count: 2, windowSec: 600 } : null })}
            />{' '}
            Only buy once several callers post the same coin
          </label>
          {c.consensus && (
            <div class="grid2">
              <label>
                Callers needed
                <input type="number" min="2" max="20" value={c.consensus.count} onInput={(e) => set({ consensus: { ...c.consensus!, count: Math.round(num(e)) } })} />
              </label>
              <label>
                Within (s)
                <input type="number" min="10" step="30" value={c.consensus.windowSec} onInput={(e) => set({ consensus: { ...c.consensus!, windowSec: Math.round(num(e)) } })} />
              </label>
            </div>
          )}

          <h4>Market filters</h4>
          <div class="grid3">
            <label>
              Min market cap ($)
              <input type="number" min="0" step="1000" placeholder="none" value={c.minMcapUsd ?? ''} onInput={(e) => set({ minMcapUsd: text(e) ? num(e) : null })} />
            </label>
            <label>
              Max market cap ($)
              <input type="number" min="1" step="1000" placeholder="none" value={c.maxMcapUsd ?? ''} onInput={(e) => set({ maxMcapUsd: text(e) ? num(e) : null })} />
            </label>
            <label class="inline">
              <input type="checkbox" checked={c.skipRisky} onChange={(e) => set({ skipRisky: checked(e) })} /> Skip risky coins
            </label>
          </div>
          <div class="row">
            {PLATFORMS.map((p) => (
              <label key={p} class="inline">
                <input type="checkbox" checked={c.platforms.includes(p)} onChange={(e) => set({ platforms: toggle(c.platforms, p, checked(e)) })} /> {PLATFORM_LABEL[p]}
              </label>
            ))}
          </div>
          <p class="muted">No platform ticked = all of them.</p>

          <h4>Size</h4>
          <div class="grid3">
            <label>
              Buy (SOL)
              <input type="number" step="0.01" min="0.001" value={c.buySol} onInput={(e) => set({ buySol: num(e) })} />
            </label>
            <label>
              Max buys
              <input type="number" step="1" min="1" placeholder="unlimited" value={c.maxFires ?? ''} onInput={(e) => set({ maxFires: text(e) ? Math.round(num(e)) : null })} />
            </label>
            <label>
              Slippage (%)
              <input type="number" step="1" min="0.1" max="100" value={c.slippagePct} onInput={(e) => set({ slippagePct: num(e) })} />
            </label>
          </div>

          <h4>Auto-sell ladder</h4>
          {props.ladderEditor(c.ladder, (ladder) => set({ ladder }))}

          <h4>Trading wallet</h4>
          <select value={c.wallet ?? ''} onChange={(e) => set({ wallet: (e.target as HTMLSelectElement).value || null })}>
            <option value="">The wallet selected for trading</option>
            {props.state.wallets.map((w) => (
              <option key={w.pubkey} value={w.pubkey}>
                {w.name} · {shortAddr(w.pubkey, 4)}
              </option>
            ))}
          </select>
          {err && <p class="err">{err}</p>}
        </div>
        <footer>
          {!props.isNew && (
            <button class="danger" onClick={() => confirm(`Delete "${c.name}"?`) && void props.onDelete()}>
              Delete
            </button>
          )}
          <span class="spacer" />
          <button onClick={props.onClose}>Discard</button>
          <button class="primary" onClick={() => void submit()}>
            {props.isNew ? 'Create callout sniper' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
