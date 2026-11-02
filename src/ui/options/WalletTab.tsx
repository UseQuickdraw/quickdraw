import { useState } from 'preact/hooks';
import type { WalletInfo, WalletState } from '../../messages';
import { call, download } from '../pageClient';
import { SWEEP_CONFIRM_PHRASE } from '../../constants';

/** One-time conversion for wallets made with the old password version. */
export function ConvertWalletCard({ refresh }: { refresh(): void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div class="card">
      <p>
        <b>One last password.</b> This wallet was created when the extension used a password. Enter it once and the wallet switches to
        no-password mode for good.
      </p>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          setErr(null);
          void call({ type: 'CONVERT_WALLET', password: pw })
            .then(() => {
              setPw('');
              refresh();
            })
            .catch((x: Error) => setErr(x.message));
        }}
      >
        <input type="password" placeholder="Old password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} style={{ maxWidth: 260 }} />
        <button class="primary" disabled={!pw}>
          Convert
        </button>
      </form>
      {err && <p class="err">{err}</p>}
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

export function WalletTab({ state, refresh }: { state: WalletState; refresh(): void }) {
  const [confirmDelete, setConfirmDelete] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const [sweepFrom, setSweepFrom] = useState(state.active[0] ?? state.wallets[0]?.pubkey ?? '');
  const [sweeping, setSweeping] = useState(false);

  const run: Run = async (fn, done) => {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (done) setMsg(done);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      {state.needsPassword && <ConvertWalletCard refresh={refresh} />}
      <h2>Wallets</h2>
      <p>
        Each wallet is sealed on this browser profile, with no password. Pick which ones trade from the wallet button on the panel: every click
        trades once per selected wallet.
      </p>
      {state.wallets.map((w, i) => (
        <WalletCard
          key={w.pubkey}
          wallet={w}
          index={i}
          selected={state.active.includes(w.pubkey)}
          primary={state.active[0] === w.pubkey}
          onlyOne={state.wallets.length === 1}
          run={run}
        />
      ))}
      <AddWallet run={run} />
      {msg && <p class="ok">{msg}</p>}
      {err && <p class="err">{err}</p>}

      <h2>Sweep to main wallet</h2>
      <div class="card">
        {state.settings.sweepAddress ? (
          <>
            <p>
              Send all SOL in a burner (minus the 0.000005 SOL network fee) to <span class="mono">{state.settings.sweepAddress}</span>. Tokens
              stay where they are.
            </p>
            <div class="row">
              <select value={sweepFrom} onChange={(e) => setSweepFrom((e.target as HTMLSelectElement).value)} style={{ maxWidth: 200 }}>
                {state.wallets.map((w) => (
                  <option key={w.pubkey} value={w.pubkey}>
                    {w.name}
                  </option>
                ))}
              </select>
              <input
                placeholder={`Type "${SWEEP_CONFIRM_PHRASE}"`}
                value={phrase}
                onInput={(e) => setPhrase((e.target as HTMLInputElement).value)}
                style={{ maxWidth: 220 }}
              />
              <button
                class="danger"
                disabled={phrase !== SWEEP_CONFIRM_PHRASE || state.needsPassword || sweeping || !sweepFrom}
                onClick={() =>
                  void run(async () => {
                    setSweeping(true);
                    try {
                      const r = await call<{ status: string; signature: string; lamports: number; error: string | null }>({ type: 'SWEEP', phrase, pubkey: sweepFrom });
                      setPhrase('');
                      if (r.status !== 'confirmed') throw new Error(r.error ?? `Sweep ${r.status}`);
                      setMsg(`Swept ${(r.lamports / 1e9).toFixed(6)} SOL · ${r.signature.slice(0, 12)}…`);
                    } finally {
                      setSweeping(false);
                    }
                  })
                }
              >
                {sweeping ? 'Sweeping…' : 'Sweep all SOL'}
              </button>
            </div>
          </>
        ) : (
          <p>Set your main wallet as the sweep address in Settings → Safety to enable this.</p>
        )}
      </div>

      <h2>Danger zone</h2>
      <div class="card">
        <p>Deletes every wallet and the endpoints from this browser. Make sure you have backups.</p>
        <div class="row">
          <input placeholder='Type "DELETE"' value={confirmDelete} onInput={(e) => setConfirmDelete((e.target as HTMLInputElement).value)} style={{ maxWidth: 180 }} />
          <button class="danger" disabled={confirmDelete !== 'DELETE'} onClick={() => void run(() => call({ type: 'WALLET_DELETE' }), 'All wallets deleted')}>
            Delete all wallets
          </button>
        </div>
      </div>
    </>
  );
}

function WalletCard(props: { wallet: WalletInfo; index: number; selected: boolean; primary: boolean; onlyOne: boolean; run: Run }) {
  const { wallet, index, selected, primary, onlyOne, run } = props;
  const [name, setName] = useState(wallet.name);
  const [secret, setSecret] = useState<string | null>(null);
  const [filePw, setFilePw] = useState('');
  const [backupOpen, setBackupOpen] = useState(false);
  const rename = () => {
    if (name.trim() && name.trim() !== wallet.name) void run(() => call({ type: 'WALLET_RENAME', pubkey: wallet.pubkey, name }));
  };
  const removeWarning = onlyOne
    ? `Remove "${wallet.name}"? It is your only wallet, so this also deletes the endpoints. Make sure you have a backup.`
    : `Remove "${wallet.name}" from this browser? Make sure you have a backup of its key.`;

  return (
    <div class="card">
      <div class="row">
        <input
          value={name}
          aria-label={`Name of wallet ${index + 1}`}
          maxLength={32}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          style={{ maxWidth: 220, fontWeight: 600 }}
        />
        {primary ? <span class="ok">Selected · primary</span> : selected ? <span class="ok">Selected</span> : <span class="muted">Not selected</span>}
      </div>
      <p>
        <span class="mono">{wallet.pubkey}</span>{' '}
        <a href={`https://solscan.io/account/${wallet.pubkey}`} target="_blank" rel="noopener noreferrer">
          Solscan ↗
        </a>
      </p>
      <div class="row">
        {secret ? (
          <button onClick={() => setSecret(null)}>Hide key</button>
        ) : (
          <button
            onClick={() =>
              confirm(`Show the secret key of "${wallet.name}" on screen? Anyone who sees it controls the wallet.`) &&
              void run(async () => setSecret((await call<{ secret: string }>({ type: 'WALLET_REVEAL', pubkey: wallet.pubkey })).secret))
            }
          >
            Show secret key
          </button>
        )}
        <button onClick={() => setBackupOpen((o) => !o)}>Backup file</button>
        <button class="danger" onClick={() => confirm(removeWarning) && void run(() => call({ type: 'WALLET_REMOVE', pubkey: wallet.pubkey }), `Removed ${wallet.name}`)}>
          Remove
        </button>
      </div>
      {secret && (
        <div class="secret mono" style={{ marginTop: 8 }}>
          {secret}
        </div>
      )}
      {backupOpen && (
        <div class="row" style={{ marginTop: 8 }}>
          <input type="password" placeholder="Password for the file" value={filePw} onInput={(e) => setFilePw((e.target as HTMLInputElement).value)} style={{ maxWidth: 240 }} />
          <button
            disabled={!filePw}
            onClick={() =>
              void run(async () => {
                const safe = wallet.name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
                download(`quickdraw-${safe}.json`, (await call<{ json: string }>({ type: 'WALLET_EXPORT_ENCRYPTED', password: filePw, pubkey: wallet.pubkey })).json);
                setFilePw('');
                setBackupOpen(false);
              })
            }
          >
            Download
          </button>
        </div>
      )}
    </div>
  );
}

function AddWallet({ run }: { run: Run }) {
  const [mode, setMode] = useState<'generate' | 'import'>('generate');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const add = () =>
    void run(
      async () => {
        if (mode === 'generate') await call({ type: 'WALLET_GENERATE', name: name || undefined });
        else await call({ type: 'WALLET_IMPORT', secret, name: name || undefined });
        setSecret('');
        setPreview(null);
        setName('');
      },
      mode === 'generate' ? 'Wallet created. Back up its key from its card above.' : 'Wallet imported.',
    );

  return (
    <div class="card">
      <h3 style={{ marginTop: 0 }}>Add a wallet</h3>
      <div class="row">
        <label class="inline">
          <input type="radio" checked={mode === 'generate'} onChange={() => setMode('generate')} />
          Generate a new burner
        </label>
        <label class="inline">
          <input type="radio" checked={mode === 'import'} onChange={() => setMode('import')} />
          Import a key
        </label>
      </div>
      <input placeholder="Name (optional)" maxLength={32} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} style={{ maxWidth: 220, marginTop: 8 }} />
      {mode === 'import' && (
        <>
          <p class="muted">Paste a base58 secret key or a JSON byte array.</p>
          <textarea
            value={secret}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => {
              setSecret((e.target as HTMLTextAreaElement).value);
              setPreview(null);
            }}
          />
          {preview && (
            <p>
              Wallet address: <span class="mono">{preview}</span>
            </p>
          )}
        </>
      )}
      <div class="row" style={{ marginTop: 10 }}>
        {mode === 'import' && !preview ? (
          <button
            class="primary"
            disabled={!secret.trim()}
            onClick={() => void run(async () => setPreview((await call<{ pubkey: string }>({ type: 'WALLET_PREVIEW_IMPORT', secret })).pubkey))}
          >
            Check key
          </button>
        ) : (
          <button class="primary" onClick={add}>
            {mode === 'generate' ? 'Create wallet' : 'Import wallet'}
          </button>
        )}
      </div>
      <p class="muted">New wallets are added unselected: tick them in the panel's wallet picker to trade with them.</p>
    </div>
  );
}
