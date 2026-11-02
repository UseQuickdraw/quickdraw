// Token-2022 transfer fees, shared by the venues and the route legs.
import type { AccountInfo, Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, calculateEpochFee, getTransferFeeConfig, unpackMint, type TransferFeeConfig } from '@solana/spl-token';
import BN from 'bn.js';
import type { MintInfo } from '../solana/tokens';

/** A Token-2022 transfer fee, and the epoch that picks which schedule applies. */
export interface TransferFee {
  config: TransferFeeConfig;
  epoch: bigint;
}

export async function transferFeeOf(conn: Connection, mint: MintInfo, info: AccountInfo<Buffer>): Promise<TransferFee | null> {
  if (!mint.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const config = getTransferFeeConfig(unpackMint(mint.mint, info, TOKEN_2022_PROGRAM_ID));
  if (!config || (config.newerTransferFee.transferFeeBasisPoints === 0 && config.olderTransferFee.transferFeeBasisPoints === 0)) return null;
  return { config, epoch: BigInt((await conn.getEpochInfo('confirmed')).epoch) };
}

/** The fee withheld from a transfer of `amount` tokens (0 without a fee). */
export function transferFeeOn(fee: TransferFee | null, amount: BN): BN {
  if (!fee) return new BN(0);
  return new BN(calculateEpochFee(fee.config, fee.epoch, BigInt(amount.toString())).toString());
}

/** As `transferFeeOn`, for BigInt amounts. */
export function transferFeeOnRaw(fee: TransferFee | null, amount: bigint): bigint {
  return fee ? calculateEpochFee(fee.config, fee.epoch, amount) : 0n;
}
