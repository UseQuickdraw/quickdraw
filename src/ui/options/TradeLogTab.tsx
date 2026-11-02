import { useEffect, useState } from 'preact/hooks';
import type { TradeLogEntry } from '../../solana/engine';
import { call, download } from '../pageClient';
import { shortAddr } from '../format';

const COLUMNS: (keyof TradeLogEntry)[] = ['at', 'side', 'amount', 'tier', 'venue', 'mint', 'status', 'clickToSentMs', 'sentToSettledMs', 'slot', 'rebroadcasts', 'sendMode', 'signature', 'error'];

function csv(rows: TradeLogEntry[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => esc(c === 'at' ? new Date(r.at).toISOString() : r[c])).join(','))].join('\n');
}

export function TradeLogTab() {
  const [rows, setRows] = useState<TradeLogEntry[] | null>(null);
  useEffect(() => {
    void call<TradeLogEntry[]>({ type: 'GET_TRADE_LOG' }).then((r) => setRows([...r].reverse()));
  }, []);
  if (!rows) return null;

  const landed = rows.filter((r) => r.status === 'confirmed' && r.clickToSentMs !== null);
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const mSent = median(landed.map((r) => r.clickToSentMs!));
  const mLand = median(landed.map((r) => r.sentToSettledMs ?? 0));

  return (
    <>
      <p>
        Live trades (dry runs aren't logged).
        {landed.length > 0 && (
          <>
            {' '}
            Median click→sent <b>{mSent} ms</b>, sent→landed <b>{mLand} ms</b> over {landed.length} landed.
          </>
        )}
      </p>
      <div class="row">
        <button disabled={!rows.length} onClick={() => download('quickdraw-trades.csv', csv([...rows].reverse()), 'text/csv')}>
          Export CSV
        </button>
      </div>
      {rows.length === 0 ? (
        <p>No live trades yet.</p>
      ) : (
        <div class="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th>Time</th>
                <th>Trade</th>
                <th>Venue</th>
                <th>Status</th>
                <th>Click→sent</th>
                <th>Sent→landed</th>
                <th>Slot</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.signature} style={{ borderTop: '1px solid var(--border)' }}>
                  <td>{new Date(r.at).toLocaleTimeString()}</td>
                  <td>
                    {r.side} {r.side === 'buy' ? `${r.amount} SOL` : `${r.amount}%`} · {r.tier} · <span class="mono">{shortAddr(r.mint)}</span>
                  </td>
                  <td>{r.venue}</td>
                  <td class={r.status === 'confirmed' ? 'ok' : 'err'} title={r.error ?? ''}>
                    {r.status}
                    {r.rebroadcasts ? ` (${r.rebroadcasts}× rebroadcast)` : ''}
                  </td>
                  <td>{r.clickToSentMs ?? '—'} ms</td>
                  <td>{r.sentToSettledMs ?? '—'} ms</td>
                  <td>{r.slot ?? '—'}</td>
                  <td>
                    <a href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noopener noreferrer">
                      {shortAddr(r.signature, 5)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
