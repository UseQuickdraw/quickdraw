import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import './popup.css';
import type { WalletRow, WalletState } from '../../src/messages';
import { call } from '../../src/ui/pageClient';
import { fmtSol, shortAddr } from '../../src/ui/format';
import { ConvertWalletCard } from '../../src/ui/options/WalletTab';

// The toolbar popup: the wallets page (total balance, every wallet with its
// balance, and which ones trade), with a Settings tab that opens the options page.

const svg = (d: string) => () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const Icon = {
  wallet: svg('M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 12h.01M17 8h3v8h-3a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z'),
  gear: svg('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'),
  refresh: svg('M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5'),
  copy: svg('M9 9h10v10H9zM5 15V5h10'),
  check: svg('M5 12l5 5L20 7'),
  plus: svg('M12 5v14M5 12h14'),
};
/** The Solana mark, in its own colours. */
const Sol = () => (
  <svg class="sol" viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <linearGradient id="sol-g" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stop-color="#9945ff" />
        <stop offset="1" stop-color="#14f195" />
      </linearGradient>
    </defs>
    <path fill="url(#sol-g)" d="M6 16.5h13.5l-1.5 2H4.5zM6 5.5h13.5l-1.5 2H4.5zM4.5 11h13.5l1.5 2H6z" />
  </svg>
);

function Popup() {
  const [state, setState] = useState<WalletState | null>(null);
  const [rows, setRows] = useState<WalletRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = async () => {
    setErr(null);
    const st = await call<WalletState>({ type: 'GET_STATE' }).catch((e: Error) => (setErr(e.message), null));
    setState(st);
    if (!st?.hasWallet || st.needsPassword) return;
    setLoading(true);
    try {
      setRows(await call<WalletRow[]>({ type: 'LIST_WALLETS' }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => void refresh(), []);

  const open = (section: 'wallet' | 'endpoints' | 'settings') => {
    void call({ type: 'OPEN_OPTIONS', section }).then(() => window.close());
  };
  const select = async (pubkeys: string[]) => {
    if (!pubkeys.length) return;
    try {
      setRows(await call<WalletRow[]>({ type: 'SET_ACTIVE_WALLETS', pubkeys }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const copy = (pubkey: string) => {
    void navigator.clipboard.writeText(pubkey).then(() => {
      setCopied(pubkey);
      setTimeout(() => setCopied((c) => (c === pubkey ? null : c)), 1200);
    });
  };

  if (!state) return err ? <p class="err pad">{err}</p> : null;
  const s = state.settings;
  const ready = state.hasWallet && state.onboarded;
  const mode = !ready ? 'Setup' : s.safety.dryRun ? 'Dry run' : 'Live';
  const known = rows?.filter((w) => w.sol !== null) ?? [];
  const total = known.reduce((a, w) => a + w.sol!, 0);
  const selected = rows?.filter((w) => w.selected).length ?? state.active.length;

  return (
    <div class="popup">
      <header class="top">
        <img src="/icon/32.png" width={22} height={22} alt="" />
        <h1>Wallets</h1>
        <span class="spacer" />
        {ready && (
          <label class="profile">
            <span>Profile</span>
            <select
              class="pill"
              title="Fee profile"
              value={s.activeProfileId}
              // Only the active profile changes; saving a whole copy could undo edits made elsewhere.
              onChange={(e) => void call({ type: 'SET_PROFILE_SLOT', slot: (e.target as HTMLSelectElement).selectedIndex }).then(refresh)}
            >
              {s.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span class={`mode mode-${mode === 'Live' ? 'live' : mode === 'Dry run' ? 'dry' : 'setup'}`}>{mode}</span>
      </header>

      <div class="body">
        {!ready ? (
          <div class="empty">
            <p>{state.preview ? 'Preview mode: the panel shows what clicks would do. Nothing is signed.' : 'No wallet yet.'}</p>
            <button class="primary" onClick={() => void browser.runtime.openOptionsPage().then(() => window.close())}>
              Set up wallet
            </button>
          </div>
        ) : (
          <>
            {state.needsPassword && <ConvertWalletCard refresh={() => void refresh()} />}

            <section class="total">
              <div class="label">
                <span>Total · SOL across your wallets</span>
                <button class="icon" title="Refresh balances" disabled={loading} onClick={() => void refresh()}>
                  <span class={loading ? 'spin' : ''}>
                    <Icon.refresh />
                  </span>
                </button>
              </div>
              <div class="amount">
                <Sol />
                {rows && known.length ? fmtSol(total) : loading ? '…' : '—'}
              </div>
              <div class="sub">
                {selected} of {rows?.length ?? state.wallets.length} trading
                {rows && known.length < rows.length && ' · some balances unavailable'}
              </div>
            </section>

            <div class="actions">
              <button onClick={() => open('wallet')}>
                <Icon.plus /> Wallet
              </button>
              {rows && rows.length > 1 && (
                <>
                  <button onClick={() => void select(rows.map((w) => w.pubkey))}>Select All</button>
                  <button onClick={() => void select(rows.filter((w) => (w.sol ?? 0) > 0).map((w) => w.pubkey))}>Select All With Balance</button>
                </>
              )}
            </div>

            <ul class="list">
              {(rows ?? state.wallets.map((w) => ({ ...w, selected: state.active.includes(w.pubkey), sol: null }))).map((w) => {
                const toggle = () => {
                  const current = (rows ?? []).filter((x) => x.selected).map((x) => x.pubkey);
                  // Keep the order (the first selected is the primary); never empty.
                  const next = w.selected ? current.filter((k) => k !== w.pubkey) : [...current, w.pubkey];
                  if (next.length) void select(next);
                };
                return (
                  <li key={w.pubkey} class={w.selected ? 'on' : ''} onClick={toggle} title={w.selected ? 'Trading from this wallet · click to stop' : 'Click to trade from this wallet too'}>
                    <span class={`box ${w.selected ? 'on' : ''}`}>{w.selected && <Icon.check />}</span>
                    <span class="who">
                      <b>{w.name}</b>
                      <small>
                        {shortAddr(w.pubkey, 4)}
                        <button
                          class="icon"
                          title="Copy address"
                          onClick={(e) => {
                            e.stopPropagation();
                            copy(w.pubkey);
                          }}
                        >
                          {copied === w.pubkey ? <Icon.check /> : <Icon.copy />}
                        </button>
                      </small>
                    </span>
                    <span class="bal">
                      <Sol /> {w.sol === null ? '—' : fmtSol(w.sol)}
                    </span>
                  </li>
                );
              })}
            </ul>
            {!state.hasEndpoints && (
              <p class="warn">
                No RPC set, so balances can't load. <a onClick={() => open('endpoints')}>Add one</a>
              </p>
            )}
          </>
        )}
        {err && <p class="err">{err}</p>}
      </div>

      <nav class="tabs">
        <button class="on" title="Wallets">
          <Icon.wallet />
        </button>
        <button title="Settings" onClick={() => open('settings')}>
          <Icon.gear />
        </button>
      </nav>
    </div>
  );
}

render(<Popup />, document.getElementById('app')!);
