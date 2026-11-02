// Orca Whirlpool maths. Exactness against the chain is checked by
// tests/live-stonk.test.ts (our leg quote equals the program's output when the
// pool hasn't moved); these pin the tick maths to Orca's own constants and run
// the swap over a recorded STONK/SOL pool.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { accountOf, loadFixture } from './helpers/fixtures';
import { WhirlpoolLeg, decodeTickArray, sqrtPriceFromTick, tickFromSqrtPrice } from '../src/venues/whirlpool';
import { ROUTED_QUOTES, STONK_MINT } from '../src/venues/routes';

describe('tick maths', () => {
  it('matches Orca at the ends and the middle of the range', () => {
    expect(sqrtPriceFromTick(0)).toBe(1n << 64n);
    expect(sqrtPriceFromTick(-443636)).toBe(4295048016n); // MIN_SQRT_PRICE_X64
    expect(sqrtPriceFromTick(443636)).toBe(79226673515401279992447579055n); // MAX_SQRT_PRICE_X64
  });

  it('round-trips tick -> sqrt price -> tick, and rounds prices between ticks down', () => {
    for (const t of [-443636, -200000, -64704, -1, 0, 1, 96, 64704, 200000, 443635]) {
      const p = sqrtPriceFromTick(t);
      expect(tickFromSqrtPrice(p)).toBe(t);
      expect(tickFromSqrtPrice(p + 1n)).toBe(t);
      if (t > -443636) expect(tickFromSqrtPrice(p - 1n)).toBe(t - 1);
    }
  });
});

describe('STONK/SOL pool (recorded)', () => {
  const fx = loadFixture('tests/fixtures/launchlab-stonk.json');
  const address = ROUTED_QUOTES[STONK_MINT.toBase58()]!.whirlpool;

  function leg(): WhirlpoolLeg {
    const l = new WhirlpoolLeg(address, accountOf(fx, address), STONK_MINT);
    for (const a of l.arraysToLoad()) {
      const raw = fx.accounts[a.key.toBase58()];
      l.setArray(a.start, a.key, raw ? accountOf(fx, a.key) : null);
    }
    return l;
  }

  it('decodes the variable-length tick arrays', () => {
    const l = leg();
    const keys = l.arraysToLoad().filter((a) => fx.accounts[a.key.toBase58()]);
    expect(keys.length).toBeGreaterThan(0);
    for (const a of keys) {
      const t = decodeTickArray(accountOf(fx, a.key))!;
      expect(t.start).toBe(a.start);
      for (const off of t.ticks.keys()) expect(off >= 0 && off < 88).toBe(true);
    }
  });

  it('swaps both ways at about the spot price, less the 0.65% fee', () => {
    const l = leg();
    const spot = l.lamportsPerToken();
    const lamports = 100_000_000n;
    const stonk = l.swapExactIn(lamports, l.aToB(true));
    const implied = Number(lamports) / Number(stonk);
    expect(implied / spot).toBeGreaterThan(1.0065);
    expect(implied / spot).toBeLessThan(1.02);
    const back = l.swapExactIn(stonk, l.aToB(false));
    expect(back < lamports).toBe(true);
    expect(Number(back) / Number(lamports)).toBeGreaterThan(0.98);
    // Bigger trades get a worse average price.
    const big = l.swapExactIn(lamports * 100n, l.aToB(true));
    expect(Number(big) / 100).toBeLessThan(Number(stonk));
  });

  it('SOL is token A of this pool', () => {
    expect(new PublicKey(accountOf(fx, address).data.subarray(101, 133)).equals(NATIVE_MINT)).toBe(true);
    expect(leg().aToB(true)).toBe(true);
  });
});
