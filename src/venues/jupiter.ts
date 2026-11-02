// Jupiter v6 `route_v2`, built locally from the program's on-chain IDL; no
// Jupiter API is involved. It chains swap legs on chain: each leg spends
// exactly what the previous one produced, so nothing is left in between, and
// the last leg's output must reach quoted_out * (1 - slippage).
//
// Each leg's accounts are that program's own swap accounts, prefixed by its
// program id (as in Jupiter's own transactions).
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import type BN from 'bn.js';

export const JUPITER_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], JUPITER_PROGRAM_ID)[0];
const ROUTE_V2 = Buffer.from([187, 100, 250, 204, 49, 196, 175, 20]);

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

/** Swap enum variants (index in the IDL's `Swap` enum) and their fields. */
export const SWAP = {
  /** 46 RaydiumCP (Raydium CPMM swap_base_input) */
  raydiumCp: () => Buffer.from([46]),
  /** 47 WhirlpoolSwapV2 { a_to_b, remaining_accounts_info: None } */
  whirlpoolV2: (aToB: boolean) => Buffer.from([47, aToB ? 1 : 0, 0]),
  /** 81 RaydiumLaunchlabBuy { share_fee_rate: 0 } */
  launchLabBuy: () => Buffer.concat([Buffer.from([81]), u64(0n)]),
  /** 82 RaydiumLaunchlabSell { share_fee_rate: 0 } */
  launchLabSell: () => Buffer.concat([Buffer.from([82]), u64(0n)]),
  /** 193 PumpSwapBuyV4 { close_user_volume_accumulator: false } */
  pumpSwapBuy: () => Buffer.from([193, 0]),
  /** 194 PumpSwapSellV4 { close_user_volume_accumulator: false } */
  pumpSwapSell: () => Buffer.from([194, 0]),
  /** 191 PumpWrappedBuyV7 { allow_partial_fill: false, close_user_volume_accumulator: false } */
  pumpWrappedBuyV7: () => Buffer.from([191, 0, 0]),
  /** 192 PumpWrappedSellV6 { close_user_volume_accumulator: false } */
  pumpWrappedSellV6: () => Buffer.from([192, 0]),
  /** 40 RaydiumClmmV2 */
  raydiumClmmV2: () => Buffer.from([40]),
};

export interface RouteLeg {
  swap: Buffer;
  accounts: AccountMeta[];
}

export interface RouteV2 {
  user: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  sourceMint: PublicKey;
  destinationMint: PublicKey;
  sourceTokenProgram: PublicKey;
  destinationTokenProgram: PublicKey;
  inAmount: BN;
  quotedOut: BN;
  slippageBps: number;
  legs: RouteLeg[];
}

/** The output floor route_v2 enforces for a quote and slippage. */
export function routeMinOut(quotedOut: BN, slippageBps: number): BN {
  return quotedOut.muln(10_000 - slippageBps).divn(10_000);
}

/** Slippage in the 0.1% steps the rest of the app uses, as basis points. */
export function slippageBps(pct: number): number {
  return Math.min(10_000, Math.max(0, Math.floor(pct * 10) * 10));
}

export function routeV2Instruction(r: RouteV2): TransactionInstruction {
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const steps = r.legs.map((leg, i) => Buffer.concat([leg.swap, u16(10_000), Buffer.from([i, i + 1])]));
  const count = Buffer.alloc(4);
  count.writeUInt32LE(steps.length);
  const data = Buffer.concat([
    ROUTE_V2,
    u64(BigInt(r.inAmount.toString())),
    u64(BigInt(r.quotedOut.toString())),
    u16(r.slippageBps),
    u16(0), // platform_fee_bps: none
    u16(0), // positive_slippage_bps: none
    count,
    ...steps,
  ]);
  return new TransactionInstruction({
    programId: JUPITER_PROGRAM_ID,
    keys: [
      { pubkey: r.user, isSigner: true, isWritable: true },
      w(r.source),
      w(r.destination),
      ro(r.sourceMint),
      ro(r.destinationMint),
      ro(r.sourceTokenProgram),
      ro(r.destinationTokenProgram),
      ro(JUPITER_PROGRAM_ID), // destination_token_account: None
      ro(EVENT_AUTHORITY),
      ro(JUPITER_PROGRAM_ID),
      ...r.legs.flatMap((l) => l.accounts),
    ],
    data,
  });
}
