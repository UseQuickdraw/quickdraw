import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import '../../src/ui/page.css';
import type { WalletState } from '../../src/messages';
import { call } from '../../src/ui/pageClient';
import { shortAddr } from '../../src/ui/format';
import { ConvertWalletCard } from '../../src/ui/options/WalletTab';

function Popup() {
  const [state, setState] = useState<WalletState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => void call<WalletState>({ type: 'GET_STATE' }).then(setState);
  useEffect(refresh, []);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (!state) return null;
  const s = state.settings;

  return (
    <main style={{ width: 300, padding: 14 }}>
      <h1 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
        <img src="/icon/32.png" width={20} height={20} alt="" /> Quickdraw
      </h1>
      {!state.hasWallet || !state.onboarded ? (
        <>
          {state.preview && <p>Preview mode: the panel shows what clicks would do. Nothing is signed.</p>}
          <button class="primary" onClick={() => void browser.runtime.openOptionsPage()}>
            Set up wallet
          </button>
        </>
      ) : (
        <>
          <p class="mono" style={{ margin: '4px 0' }}>
            {state.pubkey && shortAddr(state.pubkey, 6)}
          </p>
          {state.needsPassword && <ConvertWalletCard refresh={refresh} />}
          <label style={{ marginTop: 10 }}>
            Profile
            <select
              value={s.activeProfileId}
              // Only the active profile changes; saving a whole copy could undo edits made elsewhere.
              onChange={(e) => void run(() => call({ type: 'SET_PROFILE_SLOT', slot: (e.target as HTMLSelectElement).selectedIndex }))}
            >
              {s.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {/* Dry run is switched in Settings; here it's only flagged while on. */}
          {s.safety.dryRun && <p class="warn">Dry run is on: clicks are simulated.</p>}
          {!state.hasEndpoints && <p class="warn">No endpoints configured.</p>}
          <div class="row" style={{ marginTop: 10 }}>
            <button onClick={() => void browser.runtime.openOptionsPage()}>Settings</button>
          </div>
        </>
      )}
      {err && <p class="err">{err}</p>}
    </main>
  );
}

render(<Popup />, document.getElementById('app')!);
