export function shortAddr(a: string, n = 4): string {
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function fmtSol(x: number): string {
  if (x === 0) return '0';
  if (x < 0.001) return x.toPrecision(2);
  if (x < 1) return x.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return x.toFixed(2).replace(/\.?0+$/, '');
}

/** 1234567 -> "1.23M" */
export function fmtCompact(x: number): string {
  const abs = Math.abs(x);
  for (const [div, s] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (abs >= div) return `${(x / div).toFixed(2).replace(/\.?0+$/, '')}${s}`;
  }
  return abs >= 1 ? x.toFixed(2).replace(/\.?0+$/, '') : x === 0 ? '0' : x.toPrecision(3);
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';

/**
 * Small SOL amounts with the leading zeros counted in a subscript:
 * 0.0001 -> "0.0₃1", 0.00125 -> "0.0₂125". Amounts >= 0.01 use fmtSol.
 */
export function fmtTiny(x: number): string {
  if (x === 0) return '0';
  if (Math.abs(x) >= 0.01) return fmtSol(x);
  const m = Math.abs(x).toFixed(12).match(/^0\.(0+)(\d+)$/);
  if (!m) return fmtSol(x);
  const zeros = m[1]!.length;
  const digits = m[2]!.slice(0, 3).replace(/0+$/, '') || '0';
  const sub = String(zeros).split('').map((d) => SUB[Number(d)]).join('');
  return `${x < 0 ? '-' : ''}0.0${sub}${digits}`;
}

export function fmtPct(x: number): string {
  return `${x >= 10 ? x.toFixed(0) : x.toFixed(2).replace(/\.?0+$/, '')}%`;
}
