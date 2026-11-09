// Copytrade's fast path: read a followed wallet's trade straight from the logs
// its log notification carries, with no getTransaction round trip. pump.fun and
// PumpSwap write their trade events into the logs ("Program data: …"), which
// covers most memecoin trades; anything else returns null and the runner
// fetches the transaction instead.
import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { WSOL_MINT } from '../constants';

/** Anchor event tags: sha256("event:<Name>")[0..8]. */
const TRADE_EVENT = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]); // pump.fun curve
const AMM_BUY_EVENT = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]); // PumpSwap
const AMM_SELL_EVENT = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
const SOL_QUOTES = new Set([WSOL_MINT, PublicKey.default.toBase58()]);

/** What the logs say the leader did. PumpSwap events name the pool, not the coin: the runner looks its mints up. */
export type LogTrade =
  | { venue: 'curve'; mint: string; side: 'buy' | 'sell'; lamports: bigint; tokens: bigint; deploy: boolean }
  | { venue: 'pumpswap'; pool: string; side: 'buy' | 'sell'; lamports: bigint; tokens: bigint; holdingBefore: bigint; deploy: boolean };

function events(logs: readonly string[]): Buffer[] {
  const out: Buffer[] = [];
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue;
    try {
      out.push(Buffer.from(l.slice(14), 'base64'));
    } catch {
      // not base64: not an event
    }
  }
  return out;
}

/**
 * The leader's single SOL-priced pump.fun or PumpSwap trade in these logs, or
 * null (another venue, a curve priced in another token, several trades at once,
 * or nothing the leader did).
 */
export function decodeLeaderLogs(logs: readonly string[], leader: string): LogTrade | null {
  // A pump.fun create in the same transaction: the leader launched the coin.
  const deploy = logs.some((l) => l === 'Program log: Instruction: Create' || l === 'Program log: Instruction: CreateV2');
  const found: LogTrade[] = [];
  for (const d of events(logs)) {
    const tag = d.subarray(0, 8);
    try {
      if (tag.equals(TRADE_EVENT)) {
        const e = PUMP_SDK.decodeTradeEventBc(d.subarray(8));
        if (e.user.toBase58() !== leader) continue;
        if (e.quoteMint && !SOL_QUOTES.has(e.quoteMint.toBase58())) return null; // a curve priced in another token
        const fees = BigInt(e.fee.add(e.creatorFee).toString());
        const sol = BigInt(e.solAmount.toString());
        // A buy pays the fees on top; a sell's solAmount is before them (as the SDK's proceeds maths does).
        found.push({ venue: 'curve', mint: e.mint.toBase58(), side: e.isBuy ? 'buy' : 'sell', lamports: e.isBuy ? sol + fees : sol - fees, tokens: BigInt(e.tokenAmount.toString()), deploy });
      } else if (tag.equals(AMM_BUY_EVENT)) {
        const e = PUMP_SDK.decodeBuyEventAmm(d.subarray(8));
        if (e.user.toBase58() !== leader) continue;
        // quoteAmountIn is the whole cost, the pool's and creator's fees included.
        found.push({ venue: 'pumpswap', pool: e.pool.toBase58(), side: 'buy', lamports: BigInt(e.quoteAmountIn.toString()), tokens: BigInt(e.baseAmountOut.toString()), holdingBefore: BigInt(e.userBaseTokenReserves.toString()), deploy });
      } else if (tag.equals(AMM_SELL_EVENT)) {
        const e = PUMP_SDK.decodeSellEventAmm(d.subarray(8));
        if (e.user.toBase58() !== leader) continue;
        found.push({ venue: 'pumpswap', pool: e.pool.toBase58(), side: 'sell', lamports: BigInt(e.userQuoteAmountOut.toString()), tokens: BigInt(e.baseAmountIn.toString()), holdingBefore: BigInt(e.userBaseTokenReserves.toString()), deploy });
      }
    } catch {
      // an older or newer layout we can't read: let the slow path handle it
      return null;
    }
  }
  return found.length === 1 ? found[0]! : null;
}
