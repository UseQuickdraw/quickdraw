// Deploy sniper: new pump.fun coins, read from their launch transaction's logs,
// matched against a config's rules. Pure; the runner subscribes and buys.
import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { WSOL_MINT } from '../constants';
import type { Deploy } from './schema';

/** Only pump.fun's launch instructions touch its mint authority, so following it hears launches and nothing else. */
export const PUMP_MINT_AUTHORITY = new PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');

const CREATE_EVENT = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const TRADE_EVENT = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);

export interface Launch {
  signature: string;
  mint: string;
  bondingCurve: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  /** SOL the creator bought with in the launch transaction (0 for none), fees included. */
  devBuySol: number;
}

/** The SOL-priced pump.fun launch in these logs, or null. */
export function decodeLaunch(signature: string, logs: readonly string[]): Launch | null {
  let launch: Launch | null = null;
  const buys: { user: string; lamports: bigint }[] = [];
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue;
    const d = Buffer.from(l.slice(14), 'base64');
    try {
      if (d.subarray(0, 8).equals(CREATE_EVENT)) {
        const e = PUMP_SDK.decodeCreateEventBc(d.subarray(8));
        const quote = e.quoteMint?.toBase58();
        if (quote && quote !== WSOL_MINT && quote !== PublicKey.default.toBase58()) return null; // priced in another token
        launch = { signature, mint: e.mint.toBase58(), bondingCurve: e.bondingCurve.toBase58(), name: e.name, symbol: e.symbol, uri: e.uri, creator: e.creator.toBase58(), devBuySol: 0 };
      } else if (d.subarray(0, 8).equals(TRADE_EVENT)) {
        const e = PUMP_SDK.decodeTradeEventBc(d.subarray(8));
        if (e.isBuy) buys.push({ user: e.user.toBase58(), lamports: BigInt(e.solAmount.add(e.fee).add(e.creatorFee).toString()) });
      }
    } catch {
      // a layout we can't read
    }
  }
  if (!launch) return null;
  const dev = buys.filter((b) => b.user === launch!.creator).reduce((s, b) => s + b.lamports, 0n);
  return { ...launch, devBuySol: Number(dev) / 1e9 };
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Why a launch doesn't match the config, or null when it does. Every rule that's set must hold (AND). */
export function launchMisses(cfg: Deploy, l: Launch): string | null {
  const hasTarget = !!cfg.exact || cfg.contains.length > 0 || cfg.mints.length > 0 || cfg.deployers.length > 0;
  if (!hasTarget) return 'no target rules set';
  if (cfg.mints.length && !cfg.mints.includes(l.mint)) return 'not a whitelisted mint';
  if (cfg.deployers.length && !cfg.deployers.includes(l.creator)) return 'not a whitelisted deployer';
  const name = l.name.toLowerCase();
  const symbol = l.symbol.toLowerCase();
  if (cfg.exact && name !== cfg.exact.toLowerCase() && symbol !== cfg.exact.toLowerCase()) return `name/ticker isn't "${cfg.exact}"`;
  const have = new Set([...words(l.name), ...words(l.symbol)]);
  if (cfg.contains.length && !cfg.contains.some((w) => have.has(w.toLowerCase()))) return `name/ticker has none of ${cfg.contains.join(', ')}`;
  const bad = cfg.excludes.find((w) => have.has(w.toLowerCase()));
  if (bad) return `name/ticker has "${bad}"`;
  if (cfg.minDevBuySol !== null && l.devBuySol < cfg.minDevBuySol) return `dev bought ${l.devBuySol.toFixed(3)} SOL, under ${cfg.minDevBuySol}`;
  if (cfg.maxDevBuySol !== null && l.devBuySol > cfg.maxDevBuySol) return `dev bought ${l.devBuySol.toFixed(3)} SOL, over ${cfg.maxDevBuySol}`;
  void symbol;
  return null;
}
