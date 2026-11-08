import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
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

type Tab = 'wallet' | 'endpoints' | 'fees' | 'settings' | 'display' | 'automations' | 'ledger';
const TABS: Tab[] = ['wallet', 'endpoints', 'fees', 'settings', 'display', 'automations', 'ledger'];

function tabFromHash(): Tab {
  const h = location.hash.slice(1);
  return (TABS as string[]).includes(h) ? (h as Tab) : 'wallet';
}

function App() {
  const [state, setState] = useState<WalletState | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash());
  const [endpoints, setEndpoints] = useState<Endpoints | null>(null);
  const [epLoaded, setEpLoaded] = useState(false);
  const [setup, setSetup] = useState(false);

  const refresh = () => void call<WalletState>({ type: 'GET_STATE' }).then(setState);
  useEffect(refresh, []);
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

  return (
    <main class={tab === 'automations' ? 'wide' : ''}>
      <header class="brand">
        <img src="/icon/128.png" alt="" />
        <div>
          <h1>Quickdraw</h1>
          <p class="tagline">
            <span class="serif">Self-custody</span> trading panel · 0% platform fee
          </p>
        </div>
        <span class="spacer" />
        {state.preview ? (
          <span class="chip preview">Preview</span>
        ) : state.settings.safety.dryRun ? (
          <span class="chip dry" title="Clicks are simulated, nothing is sent">Dry run</span>
        ) : (
          <span class="chip live" title="Clicks send real transactions">Live</span>
        )}
      </header>
      {state.preview && (
        <div class="card">
          <b>Preview mode.</b> There's no wallet yet, so the panel only shows what each click would do.{' '}
          <button class="primary" onClick={() => setSetup(true)}>
            Set up wallet
          </button>
        </div>
      )}
      <nav class="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            class={tab === t ? 'on' : ''}
            onClick={() => {
              setTab(t);
              history.replaceState(null, '', `#${t}`);
            }}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === 'wallet' && (state.hasWallet ? <WalletTab state={state} refresh={refresh} /> : <p>No wallet yet.</p>)}
      {tab === 'endpoints' &&
        (!state.hasWallet ? (
          <p>Set up a wallet first. Endpoints are stored encrypted alongside it.</p>
        ) : state.needsPassword ? (
          <p class="warn">Convert the wallet on the Wallet tab first (one-time old password).</p>
        ) : (
          epLoaded && <EndpointsForm initial={endpoints} sendMode={state.settings.sendMode} onSaved={refresh} />
        ))}
      {tab === 'fees' && <FeesTab key={JSON.stringify(state.settings)} state={state} refresh={refresh} />}
      {tab === 'settings' && <SettingsTab key={JSON.stringify(state.settings)} state={state} refresh={refresh} />}
      {tab === 'display' && <DisplayTab key={JSON.stringify(state.settings)} state={state} refresh={refresh} />}
      {tab === 'automations' && <AutomationsTab state={state} />}
      {tab === 'ledger' && <LedgerTab />}
    </main>
  );
}

render(<App />, document.getElementById('app')!);
