import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import '../../src/ui/page.css';
import type { Endpoints, WalletState } from '../../src/messages';
import { call } from '../../src/ui/pageClient';
import { Wizard } from '../../src/ui/options/Wizard';
import { WalletTab } from '../../src/ui/options/WalletTab';
import { SettingsTab } from '../../src/ui/options/SettingsTab';
import { FeesTab } from '../../src/ui/options/FeesTab';
import { DisplayTab } from '../../src/ui/options/DisplayTab';
import { EndpointsForm } from '../../src/ui/options/EndpointsForm';
import { LedgerTab } from '../../src/ui/options/LedgerTab';
import { AutomationsTab } from '../../src/ui/options/AutomationsTab';
import type { AutomationsState } from '../../src/messages';

type Tab = 'wallet' | 'endpoints' | 'fees' | 'settings' | 'display' | 'copytrade' | 'autosell' | 'deploy' | 'activity' | 'ledger';
interface Page {
  id: Tab;
  label: string;
  title: string;
  sub: string;
  glyph: string;
}
/** The sidebar, in groups. Pages marked soon show greyed out until they exist. */
const GROUPS: { name: string; pages: (Page | { soon: string; glyph: string })[] }[] = [
  {
    name: 'Trading',
    pages: [
      { id: 'wallet', label: 'Wallets', title: 'Wallets', sub: 'burners, backups and the sweep', glyph: '◫' },
      { id: 'endpoints', label: 'Endpoints', title: 'Endpoints', sub: 'RPC, WebSocket and sender', glyph: '⇄' },
      { id: 'fees', label: 'Fees', title: 'Fees', sub: 'profiles, tiers and per-button overrides', glyph: '%' },
      { id: 'settings', label: 'Settings', title: 'Settings', sub: 'safety caps, alerts and hotkeys', glyph: '⚙' },
      { id: 'display', label: 'Display', title: 'Display', sub: "the panel's look", glyph: '▣' },
    ],
  },
  {
    name: 'Automations',
    pages: [
      { id: 'copytrade', label: 'Copytrade', title: 'Copytrade', sub: "copy other wallets' trades", glyph: '⧉' },
      { id: 'autosell', label: 'Auto-sell', title: 'Auto-sell', sub: 'take-profit, stop-loss, trailing and timed sells', glyph: '⤓' },
      { soon: 'Twitter', glyph: '𝕏' },
      { soon: 'Callouts', glyph: '◉' },
      { id: 'deploy', label: 'Deploy sniper', title: 'Deploy sniper', sub: 'buy new pump.fun coins that match your rules', glyph: '⌖' },
      { soon: 'PF claims', glyph: '◈' },
      { id: 'activity', label: 'Activity', title: 'Activity', sub: 'every signal and what was done about it', glyph: '≡' },
    ],
  },
  { name: 'Records', pages: [{ id: 'ledger', label: 'Ledger', title: 'Ledger', sub: 'positions, fills and the latency log', glyph: '▤' }] },
];
const PAGES = GROUPS.flatMap((g) => g.pages).filter((p): p is Page => 'id' in p);

function tabFromHash(): Tab {
  const h = location.hash.slice(1);
  if (h === 'automations') return 'copytrade';
  return PAGES.some((p) => p.id === h) ? (h as Tab) : 'wallet';
}

function App() {
  const [state, setState] = useState<WalletState | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash());
  const [endpoints, setEndpoints] = useState<Endpoints | null>(null);
  const [epLoaded, setEpLoaded] = useState(false);
  const [setup, setSetup] = useState(false);

  const [auto, setAuto] = useState<AutomationsState | null>(null);
  const refresh = () => void call<WalletState>({ type: 'GET_STATE' }).then(setState);
  useEffect(refresh, []);
  // The sidebar's counts (copytrades on, ladders open).
  useEffect(() => {
    const load = () => void call<AutomationsState>({ type: 'GET_AUTOMATIONS' }).then(setAuto).catch(() => {});
    load();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (tab !== 'endpoints' || !state?.hasWallet || state.needsPassword) return;
    setEpLoaded(false);
    void call<Endpoints | null>({ type: 'GET_ENDPOINTS' })
      .then(setEndpoints)
      .finally(() => setEpLoaded(true));
  }, [tab, state?.hasWallet, state?.needsPassword]);

  if (!state) return null;
  if (!state.onboarded || setup) {
    return (
      <Wizard
        state={state}
        onDone={() => {
          setSetup(false);
          refresh();
        }}
      />
    );
  }

  const page = PAGES.find((p) => p.id === tab)!;
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
  };
  const count: Partial<Record<Tab, number>> = {
    copytrade: auto?.automations.copytrades.filter((c) => c.enabled).length ?? 0,
    autosell: auto?.ladders.length ?? 0,
    deploy: auto?.automations.deploys.filter((d) => d.enabled).length ?? 0,
  };
  const mode = state.preview ? 'preview' : state.settings.safety.dryRun ? 'dry' : 'live';

  return (
    <div class="app">
      <aside class="side">
        <div class="side-brand">
          <img src="/icon/128.png" alt="" />
          <span>Quickdraw</span>
          <small class="mono">v{browser.runtime.getManifest().version}</small>
        </div>
        <nav>
          {GROUPS.map((g) => (
            <div key={g.name} class="side-group">
              <div class="side-label">{g.name}</div>
              {g.pages.map((p) =>
                'id' in p ? (
                  <button key={p.id} class={tab === p.id ? 'on' : ''} onClick={() => go(p.id)}>
                    <span class="glyph">{p.glyph}</span>
                    <span>{p.label}</span>
                    {count[p.id] !== undefined && <span class="count mono">{count[p.id]}</span>}
                  </button>
                ) : (
                  <button key={p.soon} disabled title="Coming soon">
                    <span class="glyph">{p.glyph}</span>
                    <span>{p.soon}</span>
                    <small class="mono">soon</small>
                  </button>
                ),
              )}
            </div>
          ))}
        </nav>
        <div class="side-foot">
          <span class={`state ${mode}`} title={mode === 'live' ? 'Clicks send real transactions' : mode === 'dry' ? 'Clicks are simulated, nothing is sent' : 'No wallet yet'}>
            {mode === 'live' ? 'LIVE' : mode === 'dry' ? 'DRY RUN' : 'PREVIEW'}
          </span>
          <a href="https://github.com/UseQuickdraw/quickdraw" target="_blank" rel="noopener noreferrer">
            Source ↗
          </a>
          <a href="https://github.com/UseQuickdraw/quickdraw/issues/new/choose" target="_blank" rel="noopener noreferrer">
            Support ↗
          </a>
        </div>
      </aside>

      <main class="content">
        <header class="page-head">
          <div>
            <h1>{page.title}</h1>
            <p class="mono">{page.sub}</p>
          </div>
        </header>
        <div class="page-body">
          {state.preview && (
            <div class="card">
              <b>Preview mode.</b> There's no wallet yet, so the panel only shows what each click would do.{' '}
              <button class="primary" onClick={() => setSetup(true)}>
                Set up wallet
              </button>
            </div>
          )}
          {tab === 'wallet' && (state.hasWallet ? <WalletTab state={state} refresh={refresh} /> : <p>No wallet yet.</p>)}
          {tab === 'endpoints' &&
            (!state.hasWallet ? (
              <p>Set up a wallet first. Endpoints are stored encrypted alongside it.</p>
            ) : state.needsPassword ? (
              <p class="warn">Convert the wallet on the Wallets page first (one-time old password).</p>
            ) : (
              epLoaded && <EndpointsForm initial={endpoints} sendMode={state.settings.sendMode} onSaved={refresh} />
            ))}
          {tab === 'fees' && <FeesTab key={JSON.stringify(state.settings)} state={state} refresh={refresh} />}
          {tab === 'settings' && <SettingsTab key={JSON.stringify(state.settings)} state={state} refresh={refresh} />}
          {tab === 'display' && <DisplayTab key={JSON.stringify(state.settings)} state={state} refresh={refresh} />}
          {(tab === 'copytrade' || tab === 'autosell' || tab === 'deploy' || tab === 'activity') && <AutomationsTab state={state} view={tab} />}
          {tab === 'ledger' && <LedgerTab />}
        </div>
      </main>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
