// Buys on PumpSwap and on cashback curves spend exactly the amount asked:
// the swap goes out as an exact-SOL-in instruction with a token floor.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-sdk/swap';
import { loadFixture, replay } from './helpers/fixtures';
import { TEST_USER } from './helpers/compare';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket } from '../src/venues/registry';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { DISC, toExactIn } from '../src/venues/exactIn';

const head = (ix: TransactionInstruction) => [...ix.data.subarray(0, 8)];
const u64At = (ix: TransactionInstruction, at: number) => ix.data.readBigUInt64LE(at).toString();

describe('exact SOL in buys', () => {
  it('rewrites only the swap, keeping its accounts and trailing flag', () => {
    const program = PUMP_AMM_PROGRAM_ID;
    const other = new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.from([1, 2, 3]) });
    const swap = new TransactionInstruction({
      programId: program,
      keys: [{ pubkey: TEST_USER, isSigner: true, isWritable: true }],
      data: Buffer.concat([Buffer.from(DISC.ammBuy), Buffer.alloc(16, 9), Buffer.from([1, 1])]),
    });
    const [a, b] = toExactIn([other, swap], program, DISC.ammBuy, DISC.ammBuyExactQuoteIn, new BN(500_000_000), new BN(1234));
    expect(a).toBe(other);
    expect(head(b!)).toEqual([...DISC.ammBuyExactQuoteIn]);
    expect(u64At(b!, 8)).toBe('500000000');
    expect(u64At(b!, 16)).toBe('1234');
    expect([...b!.data.subarray(24)]).toEqual([1, 1]);
    expect(b!.keys).toBe(swap.keys);
    expect(() => toExactIn([other], program, DISC.ammBuy, DISC.ammBuyExactQuoteIn, new BN(1), new BN(1))).toThrow(/found 0/);
    expect(() => toExactIn([swap], program, DISC.ammBuy, DISC.ammBuyExactQuoteIn, new BN(1), new BN(0))).toThrow(/above zero/);
  });

  it.each([
    ['PumpSwap', 'tests/fixtures/pumpswap.json', PUMP_AMM_PROGRAM_ID, DISC.ammBuyExactQuoteIn],
    ['cashback curve', 'tests/fixtures/curve-cashback.json', PUMP_PROGRAM_ID, DISC.curveBuyExactQuoteInV2],
  ] as const)('%s: a 0.5 SOL buy spends exactly 0.5 SOL', async (_name, path, program, disc) => {
    __resetCurveProtocolCache();
    const fx = loadFixture(path);
    const conn = replay(fx);
    const r = await resolveAddress(conn, new PublicKey(fx.address));
    const market = await openMarket(conn, r.mint, r.hint);
    const lamports = new BN(500_000_000);
    const q = market.quoteBuy(lamports, 25);
    expect(q.maxIn.toString()).toBe(lamports.toString());
    expect(q.minOut.lt(q.out)).toBe(true);
    const ixs = await market.buildBuy(TEST_USER, null, q, 25);
    const swaps = ixs.filter((ix) => ix.programId.equals(program));
    expect(swaps).toHaveLength(1);
    expect(head(swaps[0]!)).toEqual([...disc]);
    expect(u64At(swaps[0]!, 8)).toBe(lamports.toString());
    expect(u64At(swaps[0]!, 16)).toBe(q.minOut.toString());
  });
});
