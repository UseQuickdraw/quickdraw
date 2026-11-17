// Turns an "exact tokens out, cost capped" buy into "exact SOL in, min tokens
// out", so a 0.5 SOL button never spends more than 0.5 SOL.
//
// pump's exact-in instructions take the same accounts as their exact-out
// twins, and the same argument layout with the two amounts' meanings swapped:
//   PumpSwap  buy(base_out, max_quote_in, track_volume)
//          -> buy_exact_quote_in(spendable_quote_in, min_base_out, track_volume)
//   curve     buy_v2(amount, max_sol_cost, partial_fill)
//          -> buy_exact_quote_in_v2(spendable_quote_in, min_tokens_out, partial_fill)
// So the SDK's exact-out builder (which also wraps / creates the accounts the
// trade needs) is used, and the swap instruction's data rewritten.
import { TransactionInstruction, type PublicKey } from '@solana/web3.js';
import type BN from 'bn.js';

export const DISC = {
  ammBuy: [102, 6, 61, 18, 1, 218, 235, 234],
  ammBuyExactQuoteIn: [198, 46, 21, 82, 180, 217, 232, 112],
  curveBuyV2: [184, 23, 238, 97, 103, 197, 211, 61],
  curveBuyExactQuoteInV2: [194, 171, 28, 70, 104, 77, 91, 47],
} as const;

const u64 = (n: BN) => n.toArrayLike(Buffer, 'le', 8);

/** `ixs` with the one `from` swap (on `program`) replaced by `to`, spending exactly `spend` for at least `minOut`. */
export function toExactIn(ixs: TransactionInstruction[], program: PublicKey, from: readonly number[], to: readonly number[], spend: BN, minOut: BN): TransactionInstruction[] {
  const isSwap = (ix: TransactionInstruction) => ix.programId.equals(program) && ix.data.length >= 24 && from.every((b, i) => ix.data[i] === b);
  const hits = ixs.filter(isSwap);
  if (hits.length !== 1) throw new Error(`Expected one buy instruction to convert, found ${hits.length}`);
  if (minOut.isZero()) throw new Error('Minimum tokens out must be above zero');
  return ixs.map((ix) =>
    isSwap(ix)
      ? new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.concat([Buffer.from(to), u64(spend), u64(minOut), ix.data.subarray(24)]) })
      : ix,
  );
}
