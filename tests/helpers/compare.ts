// Shared by the live test and the offline fixture test: open a market the way
// the extension does, quote from its cached state, and compare with what the
// SDK computes from its own fetch path. Also checks SDK-built instructions
// pass the signing guard.
import { expect } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import {
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, buyQuoteInput, sellBaseInput } from '@pump-fun/pump-sdk/swap';
import { resolveAddress } from '../../src/solana/resolver';
import { openMarket, venueAllowlist } from '../../src/venues/registry';
import { lessSlippage, plusSlippage, type Market } from '../../src/venues/types';
import type { CurveMarket } from '../../src/venues/pumpCurve';
import { guardTransaction } from '../../src/solana/guard';
import { SENDER } from '../../src/constants';
import type { Fixture } from './fixtures';

const BUYS_LAMPORTS = [1_000_000, 100_000_000, 1_000_000_000]; // 0.001, 0.1, 1 SOL
const SLIPPAGE = 15;
// Deterministic "user" so recorded and replayed runs ask for the same ATAs.
export const TEST_USER = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey;

export interface CompareResult {
  venue: Market['venue'];
  spot: number;
  market: Market;
}

function sellAmounts(m: Market): BN[] {
  const whole = new BN(10).pow(new BN(m.mint.decimals));
  return [whole.muln(1_000), whole.muln(1_000_000)];
}

async function sdkBuyOut(conn: Connection, m: Market, lamports: BN): Promise<{ out: BN; maxIn?: BN }> {
  if (m.venue === 'PUMP_CURVE') {
    const online = new OnlinePumpSdk(conn);
    const [global, feeConfig, st] = await Promise.all([
      online.fetchGlobal(),
      online.fetchFeeConfig(),
      online.fetchBuyState(m.mint.mint, TEST_USER, m.mint.tokenProgram),
    ]);
    const base = { global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: lamports };
    return {
      out: st.bondingCurve.isCashbackCoin
        ? getBuyTokenAmountFromSolAmount({ ...base, quoteMint: st.bondingCurve.quoteMint })
        : getBuyV3TokenAmountFromQuoteAmount({ ...base, curveBaseTokenBalance: st.curveBaseTokenBalance }),
    };
  }
  const st = await new OnlinePumpAmmSdk(conn).swapSolanaState(m.address, TEST_USER);
  const r = buyQuoteInput({
    quote: lamports,
    slippage: SLIPPAGE,
    quoteTransferFee: st.quoteTransferFee,
    baseReserve: st.poolBaseAmount,
    quoteReserve: st.poolQuoteAmount,
    virtualQuoteReserves: st.pool.virtualQuoteReserves,
    baseMintAccount: st.baseMintAccount,
    baseMint: st.baseMint,
    coinCreator: st.pool.coinCreator,
    creator: st.pool.creator,
    feeConfig: st.feeConfig,
    globalConfig: st.globalConfig,
    quoteMint: st.pool.quoteMint,
    isMayhemMode: st.pool.isMayhemMode,
    creatorFeeBps: st.pool.creatorFeeBps,
  });
  return { out: r.base, maxIn: r.maxQuote };
}

async function sdkSellOut(conn: Connection, m: Market, tokens: BN): Promise<BN> {
  if (m.venue === 'PUMP_CURVE') {
    const online = new OnlinePumpSdk(conn);
    const [global, feeConfig, st] = await Promise.all([
      online.fetchGlobal(),
      online.fetchFeeConfig(),
      // fetchSellState insists the user's ATA exists; fetchBuyState returns the same curve.
      online.fetchBuyState(m.mint.mint, TEST_USER, m.mint.tokenProgram),
    ]);
    return getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: tokens });
  }
  const st = await new OnlinePumpAmmSdk(conn).swapSolanaState(m.address, TEST_USER);
  return sellBaseInput({
    base: tokens,
    slippage: SLIPPAGE,
    quoteTransferFee: st.quoteTransferFee,
    baseReserve: st.poolBaseAmount,
    quoteReserve: st.poolQuoteAmount,
    virtualQuoteReserves: st.pool.virtualQuoteReserves,
    feeBucketsTotal: st.pool.protocolFees.add(st.pool.creatorFees),
    baseMintAccount: st.baseMintAccount,
    baseMint: st.baseMint,
    coinCreator: st.pool.coinCreator,
    creator: st.pool.creator,
    feeConfig: st.feeConfig,
    globalConfig: st.globalConfig,
    quoteMint: st.pool.quoteMint,
    isMayhemMode: st.pool.isMayhemMode,
    creatorFeeBps: st.pool.creatorFeeBps,
  }).uiQuote;
}

export function guardBuilt(m: Market, ixs: TransactionInstruction[]): void {
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: TEST_USER,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
        ...ixs,
        SystemProgram.transfer({ fromPubkey: TEST_USER, toPubkey: new PublicKey(SENDER.tipAccounts[0]), lamports: 1_000_000 }),
      ],
    }).compileToV0Message(),
  );
  guardTransaction(tx, {
    payer: TEST_USER,
    venuePrograms: venueAllowlist(),
    selfAccounts: m.selfAccounts(TEST_USER).map((k) => k.toBase58()),
    maxTipLamports: 10_000_000n,
    maxPriorityFeeLamports: 5_000_000n,
    requireTip: true,
  });
}

export async function compareWithSdk(conn: Connection, fx: Fixture, opts: { record?: boolean } = {}): Promise<CompareResult> {
  const resolved = await resolveAddress(conn, new PublicKey(fx.address));
  const market = await openMarket(conn, resolved.mint, resolved.hint);

  for (const l of BUYS_LAMPORTS) {
    const lamports = new BN(l);
    const ours = market.quoteBuy(lamports, SLIPPAGE);
    const sdk = await sdkBuyOut(conn, market, lamports);
    if (!opts.record) {
      expect(ours.out.toString(), `${fx.name} buy ${l}`).toBe(sdk.out.toString());
      if (sdk.maxIn) expect(ours.maxIn.toString()).toBe(sdk.maxIn.toString());
      if (market.venue === 'PUMP_CURVE') {
        const cashback = (market as CurveMarket).bondingCurve.isCashbackCoin;
        // v3 exact-in: min tokens out = quote - slippage. Cashback coins use v2 exact-out: cost cap = in + slippage.
        expect(ours.minOut.toString()).toBe((cashback ? sdk.out : lessSlippage(sdk.out, SLIPPAGE, 1)).toString());
        expect(ours.maxIn.toString()).toBe((cashback ? plusSlippage(lamports, SLIPPAGE) : lamports).toString());
      }
    }
    guardBuilt(market, await market.buildBuy(TEST_USER, null, ours, SLIPPAGE));
  }
  for (const tokens of sellAmounts(market)) {
    const ours = market.quoteSell(tokens, SLIPPAGE);
    const sdk = await sdkSellOut(conn, market, tokens);
    if (!opts.record) expect(ours.out.toString(), `${fx.name} sell ${tokens}`).toBe(sdk.toString());
    guardBuilt(market, await market.buildSell(TEST_USER, null, ours, SLIPPAGE));
  }
  return { venue: market.venue, spot: market.spotLamportsPerToken(), market };
}
