import { useEffect, useState } from 'preact/hooks';
import type { ActivityRow, AutomationsState, WalletState } from '../../messages';
import { CopytradeSchema, DeploySchema, PLATFORMS, newCopytrade, newDeploy, type Automations, type Copytrade, type Deploy, type Platform } from '../../automation/schema';

const PLATFORM_LABEL: Record<Platform, string> = { pump: 'pump.fun / PumpSwap', raydium: 'Raydium', meteora: 'Meteora', orca: 'Orca / CLMM' };
import { describeStep, type LadderStep } from '../../automation/ladder';
import { call } from '../pageClient';
import { shortAddr } from '../format';

// Automations: trades Quickdraw makes on its own. A left menu of kinds (copytrade
// first; the rest are on the way), the global caps and stop switch on top, and
// an activity log of every signal and what was done about it.

/** The automation pages, each its own entry in the options sidebar. */
export type AutomationView = 'copytrade' | 'autosell' | 'deploy' | 'activity';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const num = (e: Event) => Number((e.target as HTMLInputElement).value);
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
const text = (e: Event) => (e.target as HTMLInputElement).value;

export function AutomationsTab({ state, view, onNew }: { state: WalletState; view: AutomationView; onNew?: (open: () => void) => void }) {
  const [data, setData] = useState<AutomationsState | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [editing, setEditing] = useState<Copytrade | null>(null);
  const [editingDeploy, setEditingDeploy] = useState<Deploy | null>(null);
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
          {view === 'autosell' && (
            <>
              <div class="auto-head">
                <h3>Auto-sell</h3>
              </div>
              <p class="muted">
                A ladder of take-profit, stop-loss, trailing and timed sells that rides on a position. Copytrades carry their own (in each copytrade); this
                one rides on every buy you make by clicking.
              </p>
              <div class="card">
                <label class="inline">
                  <input type="checkbox" class="switch" checked={a.manualLadder.enabled} onChange={(e) => void save({ ...a, manualLadder: { ...a.manualLadder, enabled: checked(e) } })} />
                  <b>Attach to every manual buy</b>
                </label>
                <LadderEditor steps={a.manualLadder.steps} onChange={(steps) => void save({ ...a, manualLadder: { ...a.manualLadder, steps } })} />
              </div>
              <h4 class="auto-sub">Active ladders</h4>
              {data.ladders.length === 0 && <div class="card empty">No open positions have a ladder.</div>}
              {data.ladders.map((l) => (
                <div key={`${l.wallet}:${l.mint}`} class="card auto-item static">
                  <div>
                    <span class="auto-title">
                      <a class="mono" href={`https://solscan.io/token/${l.mint}`} target="_blank" rel="noopener noreferrer">
                        {shortAddr(l.mint, 4)}
                      </a>
                      <small>
                        {l.source} · wallet {shortAddr(l.wallet, 4)}
                      </small>
                    </span>
                    <small>{l.steps.map(describeStep).join(' · ')}</small>
                  </div>
                  <button
                    onClick={() =>
                      void call({ type: 'REMOVE_LADDER', wallet: l.wallet, mint: l.mint })
                        .then(load)
                        .catch((e: Error) => setErr(e.message))
                    }
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </>
          )}
          {view === 'deploy' && (
            <>
              <div class="auto-head">
                <h3>Deploy sniper</h3>
                <span class="spacer" />
                <button class="primary" onClick={() => setEditingDeploy(newDeploy(crypto.randomUUID()))}>
                  + New deploy sniper
                </button>
              </div>
              <p class="muted">
                Buys new pump.fun coins the moment they launch, when they match your rules: a name or ticker, words, a pre-announced mint or a deployer
                you follow. Seconds behind the launch, not in the same block.
              </p>
              {a.deploys.length === 0 && <div class="card empty">No deploy snipers yet.</div>}
              {a.deploys.map((d) => (
                <div key={d.id} class={`card auto-item ${d.enabled ? '' : 'off'}`} onClick={() => setEditingDeploy(structuredClone(d))}>
                  <div>
                    <span class="auto-title">
                      <b>{d.name}</b>
                      {d.dryRun && <span class="chip dry">Dry run</span>}
                    </span>
                    <small>
                      {[d.exact && `exactly "${d.exact}"`, d.contains.length && `has ${d.contains.join('/')}`, d.mints.length && `${d.mints.length} mint(s)`, d.deployers.length && `${d.deployers.length} deployer(s)`]
                        .filter(Boolean)
                        .join(' · ') || 'no rules yet'}{' '}
                      · {d.buySol} SOL · sniped {data.fires[d.id] ?? 0}
                      {d.maxFires ? ` / ${d.maxFires}` : ''}
                    </small>
                  </div>
                  <input
                    type="checkbox"
                    class="switch"
                    checked={d.enabled}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => void save({ ...a, deploys: a.deploys.map((x) => (x.id === d.id ? { ...x, enabled: checked(e) } : x)) })}
                  />
                </div>
              ))}
            </>
          )}
          {view === 'activity' && <ActivityView rows={activity} />}
      </section>

      {editingDeploy && (
        <DeployEditor
          value={editingDeploy}
          state={state}
          isNew={!a.deploys.some((d) => d.id === editingDeploy.id)}
          onClose={() => setEditingDeploy(null)}
          onSave={async (d) => {
            const exists = a.deploys.some((x) => x.id === d.id);
            await save({ ...a, deploys: exists ? a.deploys.map((x) => (x.id === d.id ? d : x)) : [...a.deploys, d] });
            setEditingDeploy(null);
          }}
          onDelete={async () => {
            await save({ ...a, deploys: a.deploys.filter((x) => x.id !== editingDeploy.id) });
            setEditingDeploy(null);
          }}
        />
      )}
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

/** Comma- or space-separated words or addresses, as a list. */
const listOf = (raw: string, re?: RegExp) => [...new Set(raw.split(/[\s,]+/).filter((x) => x && (!re || re.test(x))))];

function DeployEditor(props: { value: Deploy; state: WalletState; isNew: boolean; onClose(): void; onSave(d: Deploy): Promise<void>; onDelete(): Promise<void> }) {
  const [d, setD] = useState<Deploy>(props.value);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Deploy>) => setD({ ...d, ...patch });
  const submit = async () => {
    const parsed = DeploySchema.safeParse(d);
    if (!parsed.success) return setErr(`${parsed.error.issues[0]!.path.join('.')}: ${parsed.error.issues[0]!.message}`);
    if (!d.exact && !d.contains.length && !d.mints.length && !d.deployers.length) return setErr('Set at least one target: a name/ticker, words, a mint or a deployer.');
    await props.onSave(parsed.data);
  };
  return (
    <div class="modal-back" onClick={props.onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{props.isNew ? 'New deploy sniper' : d.name}</h3>
          <button class="icon" onClick={props.onClose} title="Close">
            ✕
          </button>
        </header>
        <div class="modal-body">
          <h4>General</h4>
          <div class="grid2">
            <label>
              Name
              <input maxLength={16} value={d.name} onInput={(e) => set({ name: text(e) })} />
            </label>
            <div class="toggles">
              <label class="inline">
                <input type="checkbox" class="switch" checked={d.enabled} onChange={(e) => set({ enabled: checked(e) })} /> Enabled
              </label>
              <label class="inline">
                <input type="checkbox" class="switch" checked={d.dryRun} onChange={(e) => set({ dryRun: checked(e) })} /> Dry run
              </label>
            </div>
          </div>

          <h4>Targets (all that are set must match)</h4>
          <div class="grid3">
            <label>
              Exact name / ticker
              <input placeholder="e.g. WIF" value={d.exact ?? ''} onInput={(e) => set({ exact: text(e).trim() || null })} />
            </label>
            <label>
              Name / ticker contains
              <input placeholder="pepe, wojak" value={d.contains.join(', ')} onChange={(e) => set({ contains: listOf(text(e)) })} />
            </label>
            <label>
              Name / ticker excludes
              <input placeholder="farm, rekt" value={d.excludes.join(', ')} onChange={(e) => set({ excludes: listOf(text(e)) })} />
            </label>
          </div>
          <label>
            Whitelisted mints
            <textarea rows={2} placeholder="Mint addresses" value={d.mints.join('\n')} onChange={(e) => set({ mints: listOf(text(e), BASE58) })} />
          </label>
          <label>
            Whitelisted deployers
            <textarea rows={2} placeholder="Deployer wallet addresses" value={d.deployers.join('\n')} onChange={(e) => set({ deployers: listOf(text(e), BASE58) })} />
          </label>

          <h4>Size and triggers</h4>
          <div class="grid3">
            <label>
              Buy (SOL)
              <input type="number" step="0.01" min="0.001" value={d.buySol} onInput={(e) => set({ buySol: num(e) })} />
            </label>
            <label>
              Min dev buy (SOL)
              <input type="number" step="0.1" min="0" placeholder="no floor" value={d.minDevBuySol ?? ''} onInput={(e) => set({ minDevBuySol: text(e) ? num(e) : null })} />
            </label>
            <label>
              Max dev buy (SOL)
              <input type="number" step="0.1" min="0" placeholder="no ceiling" value={d.maxDevBuySol ?? ''} onInput={(e) => set({ maxDevBuySol: text(e) ? num(e) : null })} />
            </label>
            <label>
              Max snipes
              <input type="number" step="1" min="1" placeholder="unlimited" value={d.maxFires ?? ''} onInput={(e) => set({ maxFires: text(e) ? Math.round(num(e)) : null })} />
            </label>
            <label>
              Slippage (%)
              <input type="number" step="1" min="0.1" max="100" value={d.slippagePct} onInput={(e) => set({ slippagePct: num(e) })} />
            </label>
            <label class="inline">
              <input type="checkbox" checked={d.skipRisky} onChange={(e) => set({ skipRisky: checked(e) })} /> Skip risky coins
            </label>
          </div>

          <h4>Auto-sell ladder</h4>
          <LadderEditor steps={d.ladder} onChange={(ladder) => set({ ladder })} />

          <h4>Trading wallet</h4>
          <select value={d.wallet ?? ''} onChange={(e) => set({ wallet: (e.target as HTMLSelectElement).value || null })}>
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
            <button class="danger" onClick={() => confirm(`Delete "${d.name}"?`) && void props.onDelete()}>
              Delete
            </button>
          )}
          <span class="spacer" />
          <button onClick={props.onClose}>Discard</button>
          <button class="primary" onClick={() => void submit()}>
            {props.isNew ? 'Create deploy sniper' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

const STEP_HELP: Record<LadderStep['kind'], string> = { tp: 'up %', sl: 'down %', trail: '% off the peak', time: 'seconds held' };

/** Rows of [when] [value] [sell %], plus quick adds for the usual shapes. */
function LadderEditor({ steps, onChange }: { steps: LadderStep[]; onChange(steps: LadderStep[]): void }) {
  const add = (kind: LadderStep['kind'], value: number, sellPct: number) => onChange([...steps, { id: crypto.randomUUID().slice(0, 8), kind, value, sellPct }].slice(0, 10));
  const patch = (i: number, p: Partial<LadderStep>) => onChange(steps.map((s, k) => (k === i ? { ...s, ...p } : s)));
  return (
    <div class="ladder">
      {steps.length === 0 && <p class="muted">No steps. Add one to sell into profit, cut a loss, or exit after a while.</p>}
      {steps.map((s, i) => (
        <div key={s.id} class="ladder-row">
          <select value={s.kind} onChange={(e) => patch(i, { kind: (e.target as HTMLSelectElement).value as LadderStep['kind'] })}>
            <option value="tp">Take profit</option>
            <option value="sl">Stop loss</option>
            <option value="trail">Trailing stop</option>
            <option value="time">After time</option>
          </select>
          <label>
            <input type="number" min="0.1" step="any" value={s.value} onInput={(e) => num(e) > 0 && patch(i, { value: num(e) })} />
            <small>{STEP_HELP[s.kind]}</small>
          </label>
          <label>
            <input type="number" min="1" max="100" step="1" value={s.sellPct} onInput={(e) => num(e) > 0 && num(e) <= 100 && patch(i, { sellPct: num(e) })} />
            <small>% to sell</small>
          </label>
          <button class="icon" title="Remove" onClick={() => onChange(steps.filter((_, k) => k !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div class="row">
        <button onClick={() => add('tp', 100, 50)}>+ Take profit</button>
        <button onClick={() => add('sl', 30, 100)}>+ Stop loss</button>
        <button onClick={() => add('trail', 20, 100)}>+ Trailing</button>
        <button onClick={() => add('time', 600, 100)}>+ After time</button>
      </div>
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
                {r.leader ? (
                  <>
                    <b class={r.leaderSide}>{r.leaderSide === 'buy' ? 'Bought' : 'Sold'}</b> {+r.leaderSol.toFixed(3)} SOL
                    <small>{shortAddr(r.leader, 4)}</small>
                  </>
                ) : (
                  <small>(your position)</small>
                )}
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

          <h4>Filters</h4>
          <div class="grid3">
            <label>
              Min market cap (USD)
              <input type="number" step="1000" min="0" placeholder="no floor" value={c.minMcapUsd ?? ''} onInput={(e) => set({ minMcapUsd: text(e) ? num(e) : null })} />
            </label>
            <label>
              Max market cap (USD)
              <input type="number" step="1000" min="0" placeholder="no ceiling" value={c.maxMcapUsd ?? ''} onInput={(e) => set({ maxMcapUsd: text(e) ? num(e) : null })} />
            </label>
            <label class="inline" title="Freeze authority, permanent delegate or transfer hook">
              <input type="checkbox" checked={c.skipRisky} onChange={(e) => set({ skipRisky: checked(e) })} /> Skip risky coins
            </label>
          </div>
          <div class="checks">
            <span class="muted">Platforms</span>
            {PLATFORMS.map((p) => (
              <label key={p} class="inline">
                <input
                  type="checkbox"
                  checked={!c.platforms.length || c.platforms.includes(p)}
                  onChange={(e) => {
                    const all = c.platforms.length ? c.platforms : [...PLATFORMS];
                    const next = checked(e) ? [...new Set([...all, p])] : all.filter((x) => x !== p);
                    set({ platforms: next.length === PLATFORMS.length ? [] : next });
                  }}
                />
                {PLATFORM_LABEL[p]}
              </label>
            ))}
          </div>

          <h4>Consensus</h4>
          <div class="grid3">
            <label class="inline" title="Buy only when several of the followed wallets buy the same coin">
              <input type="checkbox" checked={!!c.consensus} onChange={(e) => set({ consensus: checked(e) ? { count: 2, windowSec: 600 } : null })} /> Wait for several wallets
            </label>
            {c.consensus && (
              <>
                <label>
                  Wallets that must buy
                  <input type="number" min="2" max="50" step="1" value={c.consensus.count} onInput={(e) => num(e) >= 2 && set({ consensus: { ...c.consensus!, count: Math.round(num(e)) } })} />
                </label>
                <label>
                  Within (seconds)
                  <input type="number" min="10" step="10" value={c.consensus.windowSec} onInput={(e) => num(e) >= 10 && set({ consensus: { ...c.consensus!, windowSec: Math.round(num(e)) } })} />
                </label>
              </>
            )}
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

          <h4>Auto-sell ladder</h4>
          <LadderEditor steps={c.ladder} onChange={(ladder) => set({ ladder })} />

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
