import { useEffect, useState } from 'preact/hooks';
import type { ActivityRow, AutomationsState, WalletState } from '../../messages';
import { CopytradeSchema, newCopytrade, type Automations, type Copytrade } from '../../automation/schema';
import { call } from '../pageClient';
import { shortAddr } from '../format';

// Automations: trades Quickdraw makes on its own. A left menu of kinds (copytrade
// first; the rest are on the way), the global caps and stop switch on top, and
// an activity log of every signal and what was done about it.

type View = 'copytrade' | 'twitter' | 'callouts' | 'deploy' | 'claims' | 'burns' | 'wallets' | 'activity';
const MENU: { id: View; label: string; soon?: boolean }[] = [
  { id: 'copytrade', label: 'Copytrade' },
  { id: 'twitter', label: 'Twitter', soon: true },
  { id: 'callouts', label: 'Callouts', soon: true },
  { id: 'deploy', label: 'Deploy sniper', soon: true },
  { id: 'claims', label: 'PF claims', soon: true },
  { id: 'burns', label: 'Burn sniper', soon: true },
  { id: 'wallets', label: 'Wallets', soon: true },
  { id: 'activity', label: 'Activity' },
];

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const num = (e: Event) => Number((e.target as HTMLInputElement).value);
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
const text = (e: Event) => (e.target as HTMLInputElement).value;

export function AutomationsTab({ state }: { state: WalletState }) {
  const [view, setView] = useState<View>('copytrade');
  const [data, setData] = useState<AutomationsState | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [editing, setEditing] = useState<Copytrade | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      setData(await call<AutomationsState>({ type: 'GET_AUTOMATIONS' }));
      setActivity(await call<ActivityRow[]>({ type: 'GET_AUTOMATION_ACTIVITY' }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // The log fills in as signals arrive.
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, []);

  const save = async (next: Automations) => {
    setErr(null);
    try {
      await call({ type: 'SAVE_AUTOMATIONS', automations: next });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (!data) return err ? <p class="err">{err}</p> : null;
  const a = data.automations;
  const counts: Partial<Record<View, number>> = { copytrade: a.copytrades.filter((c) => c.enabled).length, activity: activity.length };

  return (
    <div class="auto">
      <div class={`card auto-bar ${a.stopped ? 'stopped' : ''}`}>
        <label class="auto-stop">
          <input type="checkbox" class="switch" checked={!a.stopped} onChange={(e) => void save({ ...a, stopped: !checked(e) })} />
          <span>
            <b>{a.stopped ? 'Automations stopped' : 'Automations on'}</b>
            <small>{a.stopped ? 'Nothing trades on its own.' : `Following ${data.following.length} wallet${data.following.length === 1 ? '' : 's'} · runs only while this browser is open`}</small>
          </span>
        </label>
        <label>
          Max per trade (SOL)
          <input type="number" step="0.05" min="0.001" value={a.maxSolPerTrade} onChange={(e) => num(e) > 0 && void save({ ...a, maxSolPerTrade: num(e) })} />
        </label>
        <label>
          Max per day (SOL)
          <input type="number" step="0.1" min="0.001" value={a.maxSolPerDay} onChange={(e) => num(e) > 0 && void save({ ...a, maxSolPerDay: num(e) })} />
        </label>
        <div class="auto-spent">
          <small>Spent today</small>
          <b>{+data.spentTodaySol.toFixed(4)} SOL</b>
        </div>
      </div>
      {state.settings.safety.dryRun && <p class="warn">Dry run is on in Settings, so every automation only simulates for now.</p>}
      {err && <p class="err">{err}</p>}

      <div class="auto-grid">
        <nav class="auto-menu">
          {MENU.map((m) => (
            <button key={m.id} class={view === m.id ? 'on' : ''} disabled={m.soon} onClick={() => setView(m.id)} title={m.soon ? 'Coming soon' : undefined}>
              <span>{m.label}</span>
              {m.soon ? <small>soon</small> : <span class="count">{counts[m.id] ?? 0}</span>}
            </button>
          ))}
        </nav>

        <section class="auto-main">
          {view === 'copytrade' && (
            <>
              <div class="auto-head">
                <h3>Copytrade</h3>
                <span class="spacer" />
                <button class="primary" onClick={() => setEditing(newCopytrade(crypto.randomUUID()))}>
                  + New copytrade
                </button>
              </div>
              <p class="muted">Copy other wallets' buys (and sells) the moment they land, at your size, within your caps.</p>
              {a.copytrades.length === 0 && <div class="card empty">No copytrades yet.</div>}
              {a.copytrades.map((c) => (
                <div key={c.id} class={`card auto-item ${c.enabled ? '' : 'off'}`} onClick={() => setEditing(structuredClone(c))}>
                  <div>
                    <span class="auto-title">
                      <b>{c.name}</b>
                      {c.dryRun && <span class="chip dry">Dry run</span>}
                    </span>
                    <small>
                      {c.targets.length} wallet{c.targets.length === 1 ? '' : 's'} · {c.size.mode === 'fixed' ? `${c.size.sol} SOL` : `${c.size.pct}% of theirs (max ${c.size.maxSol})`} ·{' '}
                      {c.copySells ? 'buys and sells' : 'buys only'} · copied {data.fires[c.id] ?? 0}
                      {c.maxFires ? ` / ${c.maxFires}` : ''}
                    </small>
                  </div>
                  <input
                    type="checkbox"
                    class="switch"
                    checked={c.enabled}
                    title={c.enabled ? 'On' : 'Off'}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => void save({ ...a, copytrades: a.copytrades.map((x) => (x.id === c.id ? { ...x, enabled: checked(e) } : x)) })}
                  />
                </div>
              ))}
            </>
          )}
          {view === 'activity' && <ActivityView rows={activity} />}
        </section>
      </div>

      {editing && (
        <CopytradeEditor
          value={editing}
          state={state}
          isNew={!a.copytrades.some((c) => c.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={async (c) => {
            const exists = a.copytrades.some((x) => x.id === c.id);
            await save({ ...a, copytrades: exists ? a.copytrades.map((x) => (x.id === c.id ? c : x)) : [...a.copytrades, c] });
            setEditing(null);
          }}
          onDelete={async () => {
            await save({ ...a, copytrades: a.copytrades.filter((x) => x.id !== editing.id) });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ActivityView({ rows }: { rows: ActivityRow[] }) {
  if (!rows.length) return <div class="card empty">Nothing yet. Every signal an automation sees shows up here, with what it did and why.</div>;
  return (
    <div class="card" style={{ overflowX: 'auto' }}>
      <table class="log">
        <thead>
          <tr>
            <th>Time</th>
            <th>Automation</th>
            <th>They</th>
            <th>Coin</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{new Date(r.at).toLocaleTimeString([], { hour12: false })}</td>
              <td>{r.automationName}</td>
              <td>
                <b class={r.leaderSide}>{r.leaderSide === 'buy' ? 'Bought' : 'Sold'}</b> {+r.leaderSol.toFixed(3)} SOL
                <small>{shortAddr(r.leader, 4)}</small>
              </td>
              <td>
                <a class="mono" href={`https://solscan.io/token/${r.mint}`} target="_blank" rel="noopener noreferrer">
                  {shortAddr(r.mint, 4)}
                </a>
              </td>
              <td>
                <span class={`outcome ${r.outcome}`}>{r.outcome}</span> {r.detail}
                {r.signature && (
                  <>
                    {' '}
                    <a href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noopener noreferrer">
                      tx
                    </a>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopytradeEditor(props: { value: Copytrade; state: WalletState; isNew: boolean; onClose(): void; onSave(c: Copytrade): Promise<void>; onDelete(): Promise<void> }) {
  const [c, setC] = useState<Copytrade>(props.value);
  const [paste, setPaste] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Copytrade>) => setC({ ...c, ...patch });

  const addTargets = (raw: string) => {
    const found = raw.split(/[\s,]+/).filter((x) => BASE58.test(x));
    if (found.length) set({ targets: [...new Set([...c.targets, ...found])] });
    setPaste('');
  };

  const submit = async () => {
    const parsed = CopytradeSchema.safeParse(c);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return setErr(issue.path[0] === 'targets' && c.targets.length === 0 ? 'Add at least one wallet to copy.' : `${issue.path.join('.')}: ${issue.message}`);
    }
    await props.onSave(parsed.data);
  };

  return (
    <div class="modal-back" onClick={props.onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{props.isNew ? 'New copytrade' : c.name}</h3>
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
              <label class="inline" title="Simulate every copy instead of sending it">
                <input type="checkbox" class="switch" checked={c.dryRun} onChange={(e) => set({ dryRun: checked(e) })} /> Dry run
              </label>
            </div>
          </div>
          <label>
            Wallets to copy <small class="muted">paste one or many, Enter to add</small>
            <input
              placeholder="Wallet addresses"
              value={paste}
              onInput={(e) => setPaste(text(e))}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTargets(paste))}
              onBlur={() => paste && addTargets(paste)}
              onPaste={(e) => {
                e.preventDefault();
                addTargets(e.clipboardData?.getData('text') ?? '');
              }}
            />
          </label>
          <div class="tags">
            {c.targets.map((t) => (
              <span key={t} class="tag mono">
                {shortAddr(t, 5)}
                <button class="icon" title="Remove" onClick={() => set({ targets: c.targets.filter((x) => x !== t) })}>
                  ✕
                </button>
              </span>
            ))}
          </div>

          <h4>Size</h4>
          <div class="seg">
            <button class={c.size.mode === 'percent' ? 'on' : ''} onClick={() => set({ size: { mode: 'percent', pct: 10, maxSol: 0.5 } })}>
              Percent of theirs
            </button>
            <button class={c.size.mode === 'fixed' ? 'on' : ''} onClick={() => set({ size: { mode: 'fixed', sol: 0.1 } })}>
              Fixed SOL
            </button>
          </div>
          {c.size.mode === 'fixed' ? (
            <label>
              Buy (SOL)
              <input type="number" step="0.01" min="0.001" value={c.size.sol} onInput={(e) => set({ size: { mode: 'fixed', sol: num(e) } })} />
            </label>
          ) : (
            <div class="grid2">
              <label>
                Percent of what they spend
                <input type="number" step="1" min="1" value={c.size.pct} onInput={(e) => c.size.mode === 'percent' && set({ size: { ...c.size, pct: num(e) } })} />
              </label>
              <label>
                But at most (SOL)
                <input type="number" step="0.05" min="0.001" value={c.size.maxSol} onInput={(e) => c.size.mode === 'percent' && set({ size: { ...c.size, maxSol: num(e) } })} />
              </label>
            </div>
          )}

          <h4>Triggers</h4>
          <div class="grid3">
            <label>
              Min they spend (SOL)
              <input type="number" step="0.05" min="0" value={c.minTargetSol} onInput={(e) => set({ minTargetSol: num(e) })} />
            </label>
            <label>
              Max they spend (SOL)
              <input type="number" step="1" min="0" placeholder="no ceiling" value={c.maxTargetSol ?? ''} onInput={(e) => set({ maxTargetSol: text(e) ? num(e) : null })} />
            </label>
            <label>
              Max copies
              <input type="number" step="1" min="1" placeholder="unlimited" value={c.maxFires ?? ''} onInput={(e) => set({ maxFires: text(e) ? Math.round(num(e)) : null })} />
            </label>
          </div>

          <h4>Behaviour</h4>
          <div class="checks">
            <label class="inline" title="When they sell, sell the same share of our holding">
              <input type="checkbox" checked={c.copySells} onChange={(e) => set({ copySells: checked(e) })} /> Copy sells
            </label>
            <label class="inline" title="Only their first buy of each coin, not their adds">
              <input type="checkbox" checked={c.firstBuyOnly} onChange={(e) => set({ firstBuyOnly: checked(e) })} /> First buy only
            </label>
            <label class="inline">
              <input type="checkbox" checked={c.skipIfHolding} onChange={(e) => set({ skipIfHolding: checked(e) })} /> Skip if already holding
            </label>
            <label class="inline">
              <input type="checkbox" checked={c.skipIfBought} onChange={(e) => set({ skipIfBought: checked(e) })} /> Skip if bought before
            </label>
            <label class="inline" title="Don't copy them buying a coin they just created">
              <input type="checkbox" checked={c.skipDeploys} onChange={(e) => set({ skipDeploys: checked(e) })} /> Skip their own launches
            </label>
          </div>

          <h4>Fees</h4>
          <div class="grid2">
            <label>
              Slippage (%)
              <input type="number" step="1" min="0.1" max="100" value={c.slippagePct} onInput={(e) => set({ slippagePct: num(e) })} />
            </label>
            <label>
              Landing
              <select value={c.tier} onChange={(e) => set({ tier: (e.target as HTMLSelectElement).value as Copytrade['tier'] })}>
                <option value="fast">Fast (your profile's Fast tip and priority)</option>
                <option value="eco">Eco</option>
              </select>
            </label>
          </div>

          <h4>Trading wallet</h4>
          <select value={c.wallet ?? ''} onChange={(e) => set({ wallet: (e.target as HTMLSelectElement).value || null })}>
            <option value="">The wallet selected for trading ({props.state.wallets.find((w) => w.pubkey === props.state.active[0])?.name ?? 'primary'})</option>
            {props.state.wallets.map((w) => (
              <option key={w.pubkey} value={w.pubkey}>
                {w.name} · {shortAddr(w.pubkey, 4)}
              </option>
            ))}
          </select>
          <p class="muted">
            Copies go through the same checks as a click: the signing guard, your max tip and priority fee, and the caps at the top of this page.
            They only run while this browser is open.
          </p>
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
            {props.isNew ? 'Create copytrade' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
