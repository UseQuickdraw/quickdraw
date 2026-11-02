import { useState } from 'preact/hooks';
import type { WalletState } from '../../messages';
import { STARTER_PROFILES } from '../../settings/defaults';
import { call, download } from '../pageClient';
import { EndpointsForm } from './EndpointsForm';

type Step = 'disclaimer' | 'wallet' | 'backup' | 'endpoints' | 'profile';
const STEPS: Step[] = ['disclaimer', 'wallet', 'backup', 'endpoints', 'profile'];

export function Wizard({ state, onDone }: { state: WalletState; onDone(): void }) {
  // A wallet may already exist if onboarding was interrupted; resume at endpoints then.
  const [step, setStep] = useState<Step>(state.hasWallet ? 'endpoints' : 'disclaimer');
  const [accepted, setAccepted] = useState(false);
  const [mode, setMode] = useState<'generate' | 'import'>('generate');
  const [importText, setImportText] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(state.pubkey);
  const [secret, setSecret] = useState<string | null>(null);
  const [filePw, setFilePw] = useState('');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const r =
        mode === 'generate'
          ? await call<{ pubkey: string }>({ type: 'WALLET_GENERATE' })
          : await call<{ pubkey: string }>({ type: 'WALLET_IMPORT', secret: importText });
      setImportText('');
      setPubkey(r.pubkey);
      setStep(mode === 'generate' ? 'backup' : 'endpoints');
    });

  return (
    <main>
      <h1>Set up Quickdraw</h1>
      <div class="steps">
        Step {STEPS.indexOf(step) + 1} of {STEPS.length}
      </div>

      {step === 'disclaimer' && (
        <div class="card">
          <h2>Read this first</h2>
          <ul>
            <li>Use at your own risk. This is not financial advice. Memecoins can and often do go to zero.</li>
            <li>
              Use a <b>burner wallet</b> holding only what you are willing to lose. <b>Never import your main wallet.</b>
            </li>
            <li>Trades are sent with one click and no confirmation. Max tip and max priority fee in Settings are your safety net.</li>
            <li>There's no password. Anyone who can use this browser profile can trade with the burner.</li>
            <li>The extension is fully client-side. It talks only to the RPC and send endpoints you configure.</li>
          </ul>
          <label class="inline">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted((e.target as HTMLInputElement).checked)} />I
            understand and accept these risks.
          </label>
          <div class="row" style={{ marginTop: 12 }}>
            <button class="primary" disabled={!accepted} onClick={() => setStep('wallet')}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'wallet' && (
        <div class="card">
          <h2>Burner wallet</h2>
          <label class="inline">
            <input type="radio" checked={mode === 'generate'} onChange={() => setMode('generate')} />
            Generate a new burner wallet (recommended)
          </label>
          <label class="inline">
            <input type="radio" checked={mode === 'import'} onChange={() => setMode('import')} />
            Import an existing burner key
          </label>
          {mode === 'import' && (
            <>
              <p class="warn">Never import your main wallet. Paste a base58 secret key or a JSON byte array.</p>
              <textarea
                value={importText}
                spellcheck={false}
                autocomplete="off"
                onInput={(e) => {
                  setImportText((e.target as HTMLTextAreaElement).value);
                  setPreview(null);
                }}
              />
              {preview && (
                <p>
                  Wallet address: <span class="mono">{preview}</span>. Confirm this is your burner.
                </p>
              )}
            </>
          )}
          <div class="row" style={{ marginTop: 12 }}>
            {mode === 'import' && !preview ? (
              <button
                class="primary"
                disabled={busy || !importText.trim()}
                onClick={() =>
                  void run(async () => setPreview((await call<{ pubkey: string }>({ type: 'WALLET_PREVIEW_IMPORT', secret: importText })).pubkey))
                }
              >
                Check key
              </button>
            ) : (
              <button class="primary" disabled={busy} onClick={() => void create()}>
                {mode === 'generate' ? 'Create wallet' : 'Import wallet'}
              </button>
            )}
          </div>
        </div>
      )}

      {step === 'backup' && (
        <div class="card">
          <h2>Back up your new key</h2>
          <p>
            Address: <span class="mono">{pubkey}</span>
          </p>
          <p>Store the secret key somewhere safe and offline. Anyone with it controls the funds. You can show it again later from the Wallet tab.</p>
          {secret ? (
            <div class="secret mono">{secret}</div>
          ) : (
            <button
              disabled={busy}
              onClick={() => void run(async () => setSecret((await call<{ secret: string }>({ type: 'WALLET_REVEAL' })).secret))}
            >
              Show secret key
            </button>
          )}
          <p style={{ marginTop: 14 }}>Optional: download a backup file, encrypted with a password just for the file.</p>
          <div class="row">
            <input type="password" placeholder="Password for the file" value={filePw} onInput={(e) => setFilePw((e.target as HTMLInputElement).value)} style={{ maxWidth: 240 }} />
            <button
              disabled={busy || !filePw}
              onClick={() =>
                void run(async () => {
                  download('quickdraw-backup.json', (await call<{ json: string }>({ type: 'WALLET_EXPORT_ENCRYPTED', password: filePw })).json);
                  setFilePw('');
                })
              }
            >
              Download backup file
            </button>
          </div>
          <label class="inline" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved((e.target as HTMLInputElement).checked)} />I have saved my
            secret key.
          </label>
          <div class="row" style={{ marginTop: 12 }}>
            <button
              class="primary"
              disabled={!saved}
              onClick={() => {
                setSecret(null);
                setStep('endpoints');
              }}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'endpoints' && (
        <>
          <h2>Endpoints</h2>
          <p>Bring your own RPC. Default sending goes through Helius Sender's global endpoint.</p>
          <EndpointsForm initial={null} sendMode={state.settings.sendMode} onSaved={() => setStep('profile')} />
        </>
      )}

      {step === 'profile' && (
        <div class="card">
          <h2>Pick your starting profile</h2>
          <p>
            All three are available as P1 / P2 / P3 in the panel, each with its own fees. Pick the one to start on. Dry-run mode is on: trades are
            simulated until you turn it off.
          </p>
          <div class="row">
            {STARTER_PROFILES.map((p) => (
              <button
                key={p.id}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    // All three stay available as P1/P2/P3; the choice is just the active one.
                    const settings = { ...state.settings, profiles: STARTER_PROFILES.map((x) => structuredClone(x)), activeProfileId: p.id };
                    await call({ type: 'SAVE_SETTINGS', settings });
                    await call({ type: 'SET_ONBOARDED' });
                    onDone();
                  })
                }
              >
                {p.name} · {p.defaultTier} · {p.slippagePct}% slip
              </button>
            ))}
          </div>
        </div>
      )}

      {err && <p class="err">{err}</p>}

      {!state.hasWallet && !pubkey && (step === 'disclaimer' || step === 'wallet') && (
        <p style={{ marginTop: 24 }}>
          Just want to see the panel?{' '}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await call({ type: 'SET_ONBOARDED' });
                onDone();
              })
            }
          >
            Skip setup — preview the panel
          </button>
          <br />
          <small>Buttons work but only show what they would do. No wallet, no RPC, nothing is signed. You can set up later.</small>
        </p>
      )}
    </main>
  );
}
