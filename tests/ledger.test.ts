import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { applyFill, parseFill, platformFeesAvoided, pnl, type Fill } from '../src/ledger/ledger';
import { SENDER, WSOL_MINT } from '../src/constants';

const user = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const ata = Keypair.generate().publicKey;
const wsolAta = Keypair.generate().publicKey;
const curve = Keypair.generate().publicKey;
const feeVault = Keypair.generate().publicKey;
const tipAcct = new PublicKey(SENDER.tipAccounts[3]);
const RENT = 2_039_280;
const FEE = 5_000 + 12_000; // base + priority
const TIP = 10_000;

interface Acct {
  key: PublicKey;
  pre: number;
  post: number;
}
interface Tok {
  index: number;
  mint: string;
  pre?: bigint;
  post?: bigint;
}

/** A fake getTransaction() response with exactly the balances we specify. */
function tx(accounts: Acct[], tokens: Tok[], opts: { fee?: number; err?: unknown } = {}): VersionedTransactionResponse {
  const tb = (which: 'pre' | 'post') =>
    tokens
      .filter((t) => t[which] !== undefined)
      .map((t) => ({ accountIndex: t.index, mint: t.mint, owner: user.toBase58(), uiTokenAmount: { amount: t[which]!.toString(), decimals: 6, uiAmount: null, uiAmountString: '' } }));
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: [`sig-${Math.random()}`],
      message: { getAccountKeys: () => ({ length: accounts.length, get: (i: number) => accounts[i]?.key }) },
    },
    meta: {
      fee: opts.fee ?? FEE,
      err: (opts.err ?? null) as never,
      preBalances: accounts.map((a) => a.pre),
      postBalances: accounts.map((a) => a.post),
      preTokenBalances: tb('pre'),
      postTokenBalances: tb('post'),
    },
  } as unknown as VersionedTransactionResponse;
}

describe('parseFill', () => {
  it('curve buy that creates the token account: trade = SOL into the curve and fees', () => {
    const spend = 100_000_000; // 0.1 SOL into the trade
    const t = tx(
      [
        { key: user, pre: 1_000_000_000, post: 1_000_000_000 - spend - FEE - TIP - RENT },
        { key: ata, pre: 0, post: RENT },
        { key: curve, pre: 5_000_000_000, post: 5_000_000_000 + 98_750_000 },
        { key: feeVault, pre: 0, post: 1_250_000 },
        { key: tipAcct, pre: 7, post: 7 + TIP },
      ],
      [{ index: 1, mint: mint.toBase58(), post: 1_234_567_890n }],
    );
    const f = parseFill(t, user, mint, SENDER.tipAccounts);
    expect(f).toMatchObject({ side: 'buy', ok: true, tradeLamports: -spend, feeLamports: FEE, tipLamports: TIP, rentLamports: RENT, tokenDelta: '1234567890' });
    expect(f.walletLamports).toBe(-(spend + FEE + TIP + RENT)); // what Solscan shows
  });

  it('full sell that closes the token account: rent comes back but is not counted as proceeds', () => {
    const proceeds = 55_000_000;
    const t = tx(
      [
        { key: user, pre: 500_000_000, post: 500_000_000 + proceeds - FEE - TIP + RENT },
        { key: ata, pre: RENT, post: 0 },
        { key: tipAcct, pre: 0, post: TIP },
      ],
      [{ index: 1, mint: mint.toBase58(), pre: 1_000n }],
    );
    const f = parseFill(t, user, mint, SENDER.tipAccounts);
    expect(f).toMatchObject({ side: 'sell', tradeLamports: proceeds, rentLamports: -RENT, tokenDelta: '-1000' });
  });

  it('PumpSwap buy through WSOL, unwrapping WSOL the wallet already held', () => {
    const spend = 20_000_000;
    const heldWsol = 300_000_000; // closing the WSOL account returns this as SOL
    const t = tx(
      [
        { key: user, pre: 1_000_000_000, post: 1_000_000_000 - spend - FEE - TIP - RENT + heldWsol + RENT },
        { key: wsolAta, pre: heldWsol + RENT, post: 0 },
        { key: ata, pre: 0, post: RENT },
        { key: tipAcct, pre: 0, post: TIP },
      ],
      [
        { index: 1, mint: WSOL_MINT, pre: BigInt(heldWsol) },
        { index: 2, mint: mint.toBase58(), post: 777n },
      ],
    );
    const f = parseFill(t, user, mint, SENDER.tipAccounts);
    expect(f.side).toBe('buy');
    expect(f.tradeLamports).toBe(-spend); // the unwrapped WSOL is not mistaken for profit
  });

  it('a failed transaction costs only the fee', () => {
    const t = tx([{ key: user, pre: 1_000_000, post: 1_000_000 - FEE }, { key: tipAcct, pre: 0, post: 0 }], [], { err: { InstructionError: [2, { Custom: 6002 }] } });
    const f = parseFill(t, user, mint, SENDER.tipAccounts);
    expect(f).toMatchObject({ ok: false, side: 'none', tradeLamports: 0, feeLamports: FEE, tipLamports: 0 });
  });
});

describe('positions', () => {
  const fill = (over: Partial<Fill>): Fill => ({
    signature: `s${Math.random()}`,
    slot: 1,
    blockTime: null,
    mint: mint.toBase58(),
    side: 'buy',
    ok: true,
    tradeLamports: 0,
    tokenDelta: '0',
    decimals: 6,
    feeLamports: FEE,
    tipLamports: TIP,
    rentLamports: 0,
    walletLamports: 0,
    ...over,
  });

  it('buy, buy, sell 50%, sell 100% adds up', () => {
    let p = applyFill(undefined, fill({ tradeLamports: -100_000_000, tokenDelta: '1000', rentLamports: RENT }));
    p = applyFill(p, fill({ tradeLamports: -50_000_000, tokenDelta: '400' }));
    p = applyFill(p, fill({ side: 'sell', tradeLamports: 80_000_000, tokenDelta: '-700' }));
    p = applyFill(p, fill({ side: 'sell', tradeLamports: 90_000_000, tokenDelta: '-700', rentLamports: -RENT }));
    expect(p).toMatchObject({ boughtLamports: 150_000_000, soldLamports: 170_000_000, tokensRaw: '0', buys: 2, sells: 2, rentLamports: 0 });
    expect(p.feesLamports).toBe(4 * FEE);
    expect(p.tipsLamports).toBe(4 * TIP);
    const r = pnl(p, 0n, 1);
    expect(r.pnlLamports).toBe(20_000_000);
    expect(r.pnlPct).toBeCloseTo(13.333, 2);
    expect(r.netLamports).toBe(20_000_000 - 4 * FEE - 4 * TIP);
    // The panel's %: net of fees and tips, against what was bought.
    expect(r.netPct).toBeCloseTo(((20_000_000 - 4 * FEE - 4 * TIP) / 150_000_000) * 100, 6);
  });

  it('records each signature once', () => {
    const f = fill({ tradeLamports: -1_000, tokenDelta: '10' });
    const p = applyFill(applyFill(undefined, f), f);
    expect(p.buys).toBe(1);
    expect(p.fills).toHaveLength(1);
  });

  it('values only tokens this ledger paid for (capped at the wallet balance)', () => {
    const p = applyFill(undefined, fill({ tradeLamports: -100, tokenDelta: '50' }));
    expect(pnl(p, 1_000n, 2).valueLamports).toBe(100); // 50 counted, not 1000
    expect(pnl(p, 20n, 2).valueLamports).toBe(40); // sold some elsewhere
  });

  it('platform fees avoided = 1% of volume', () => {
    const a = applyFill(undefined, fill({ tradeLamports: -100_000_000, tokenDelta: '1' }));
    const b = applyFill(a, fill({ side: 'sell', tradeLamports: 50_000_000, tokenDelta: '-1' }));
    expect(platformFeesAvoided([b])).toBe(1_500_000);
  });
});
