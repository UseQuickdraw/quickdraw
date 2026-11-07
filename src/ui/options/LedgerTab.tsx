import { useEffect, useState } from 'preact/hooks';
import type { Fill, Position } from '../../ledger/ledger';
import { LAMPORTS_PER_SOL } from '../../constants';
import { call, download } from '../pageClient';
import { fmtCompact, fmtSol, shortAddr } from '../format';
import { TradeLogTab } from './TradeLogTab';

interface LedgerData {
  positions: Position[];
  feesAvoidedLamports: number;
}

const sol = (lamports: number) => fmtSol(lamports / LAMPORTS_PER_SOL);
const tokens = (raw: string, decimals: number) => fmtCompact(Number(raw) / 10 ** decimals);

const FILL_COLUMNS = ['time', 'mint', 'side', 'ok', 'trade_sol', 'tokens', 'fee_sol', 'tip_sol', 'rent_sol', 'wallet_change_sol', 'slot', 'signature'] as const;

function fillsCsv(positions: Position[]): string {
  const rows = positions
    .flatMap((p) => p.fills)
    .sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0))
    .map((f: Fill) =>
      [
        f.blockTime ? new Date(f.blockTime * 1000).toISOString() : '',
        f.mint,
        f.side,
        f.ok,
        f.tradeLamports / LAMPORTS_PER_SOL,
        Number(f.tokenDelta) / 10 ** f.decimals,
        f.feeLamports / LAMPORTS_PER_SOL,
        f.tipLamports / LAMPORTS_PER_SOL,
        f.rentLamports / LAMPORTS_PER_SOL,
        f.walletLamports / LAMPORTS_PER_SOL,
        f.slot,
        f.signature,
      ].join(','),
    );
  return [FILL_COLUMNS.join(','), ...rows].join('\n');
}

export function LedgerTab() {
  const [data, setData] = useState<LedgerData | null>(null);
  useEffect(() => {
    void call<LedgerData>({ type: 'GET_LEDGER' }).then(setData);
  }, []);
  if (!data) return null;
  const positions = [...data.positions].sort((a, b) => b.lastAt - a.lastAt);

  return (
    <>
      <h2>Positions</h2>
      <p>
        From trades that landed through Quickdraw. Realized = sold − bought; open positions are valued live in the panel.{' '}
        {data.feesAvoidedLamports > 0 && (
          <>
            Platform fees avoided so far: <b>{sol(data.feesAvoidedLamports)} SOL</b> (1% of your volume).
          </>
        )}
      </p>
      <div class="row">
        <button disabled={!positions.length} onClick={() => download('quickdraw-fills.csv', fillsCsv(positions), 'text/csv')}>
          Export fills CSV
        </button>
      </div>
      {positions.length === 0 ? (
        <p>No positions yet.</p>
      ) : (
        <div class="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th>Token</th>
                <th>Bought</th>
                <th>Sold</th>
                <th>Realized</th>
                <th>Held (here)</th>
                <th>Fees + tips</th>
                <th>Trades</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                // After the network fees, priority fees and tips, like the panel's PnL.
                const realized = p.soldLamports - p.boughtLamports - p.feesLamports - p.tipsLamports;
                return (
                  <tr key={p.mint} style={{ borderTop: '1px solid var(--border)' }}>
                    <td>
                      <a class="mono" href={`https://solscan.io/token/${p.mint}`} target="_blank" rel="noopener noreferrer">
                        {shortAddr(p.mint)}
                      </a>
                    </td>
                    <td>{sol(p.boughtLamports)}</td>
                    <td>{sol(p.soldLamports)}</td>
                    <td class={realized >= 0 ? 'ok' : 'err'} title="Sold − bought − fees and tips. Only meaningful once the position is closed; open positions show unrealized PnL in the panel">
                      {realized >= 0 ? '+' : '−'}
                      {sol(Math.abs(realized))}
                    </td>
                    <td>{tokens(p.tokensRaw, p.decimals)}</td>
                    <td>
                      {sol(p.feesLamports)} + {sol(p.tipsLamports)}
                    </td>
                    <td>
                      {p.buys} buy{p.buys === 1 ? '' : 's'}, {p.sells} sell{p.sells === 1 ? '' : 's'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <h2>Latency log</h2>
      <TradeLogTab />
    </>
  );
}
