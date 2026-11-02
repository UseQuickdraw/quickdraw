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

type Tab = 'wallet' | 'endpoints' | 'fees' | 'settings' | 'display' | 'ledger';
const TABS: Tab[] = ['wallet', 'endpoints', 'fees', 'settings', 'display', 'ledger'];

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
    <main>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src="/icon/48.png" width={32} height={32} alt="" /> Quickdraw
      </h1>
      <p>
        Self-custody trading panel. No platform fee, no server.{' '}
        {state.settings.safety.dryRun && <b class="warn">Dry run is ON.</b>}
      </p>
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
      {tab === 'ledger' && <LedgerTab />}
    </main>
  );
}

render(<App />, document.getElementById('app')!);
