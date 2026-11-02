// Turns simulation / transaction errors into one human sentence.
// Anchor programs (pump, PumpSwap, LaunchLab) log "Error Code: X. Error Number: N. Error
// Message: ..." so the logs carry the name even when the error is a bare code.

export interface DecodedError {
  /** Short, user-facing explanation. */
  message: string;
  /** Machine-readable kind for retry logic. */
  kind: 'slippage' | 'curve_complete' | 'insufficient_sol' | 'insufficient_tokens' | 'compute' | 'blockhash' | 'program' | 'unknown';
  /** Anchor error name / number when known. */
  code?: string;
}

const ANCHOR = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.*$/;

const FRIENDLY: Record<string, Pick<DecodedError, 'message' | 'kind'>> = {
  // pump bonding curve
  TooMuchSolRequired: { kind: 'slippage', message: 'Slippage exceeded: the price moved up past your slippage.' },
  TooLittleSolReceived: { kind: 'slippage', message: 'Slippage exceeded: you would receive less SOL than your minimum.' },
  BuySlippageBelowMinTokensOut: { kind: 'slippage', message: 'Slippage exceeded: you would receive fewer tokens than your minimum.' },
  BondingCurveComplete: { kind: 'curve_complete', message: 'The bonding curve just completed (migrating to PumpSwap). Click again.' },
  NotEnoughTokensToBuy: { kind: 'curve_complete', message: 'Not enough tokens left on the curve for this buy.' },
  NotEnoughTokensToSell: { kind: 'insufficient_tokens', message: "You don't hold that many tokens." },
  BuyNotEnoughSolToCoverRent: { kind: 'insufficient_sol', message: 'Not enough SOL to cover the token account rent.' },
  BuyNotEnoughSolToCoverFees: { kind: 'insufficient_sol', message: 'Not enough SOL to cover the trade fees.' },
  BuyZeroAmount: { kind: 'program', message: 'Buy amount rounds to zero tokens.' },
  SellZeroAmount: { kind: 'program', message: 'Sell amount is zero.' },
  // PumpSwap (pump_amm IDL)
  ExceededSlippage: { kind: 'slippage', message: 'Slippage exceeded: the pool price moved past your slippage.' },
  BuySlippageBelowMinBaseAmountOut: { kind: 'slippage', message: 'Slippage exceeded: you would receive fewer tokens than your minimum.' },
  BuyMoreBaseAmountThanPoolReserves: { kind: 'program', message: 'Buy is larger than the pool can fill.' },
  BuyNotEnoughQuoteTokensToCoverFees: { kind: 'insufficient_sol', message: 'Not enough SOL to cover the trade fees.' },
  DisabledBuy: { kind: 'program', message: 'Buying is currently disabled on PumpSwap.' },
  DisabledSell: { kind: 'program', message: 'Selling is currently disabled on PumpSwap.' },
  // Raydium LaunchLab (raydium_launchpad IDL); ExceededSlippage is shared with PumpSwap
  PoolMigrated: { kind: 'curve_complete', message: 'This coin just left its LaunchLab curve for a Raydium pool (not supported yet).' },
  PoolFunding: { kind: 'program', message: 'This LaunchLab curve is still filling.' },
  // Raydium CPMM (ExceededSlippage shared)
  NotApproved: { kind: 'program', message: 'Swaps are not open on this Raydium pool.' },
};

function fromAnchorLogs(logs: readonly string[]): DecodedError | null {
  for (const line of logs) {
    const m = line.match(ANCHOR);
    if (!m) continue;
    const [, name, number, text] = m;
    const pascal = name![0]!.toUpperCase() + name!.slice(1);
    const known = FRIENDLY[pascal];
    return {
      kind: known?.kind ?? 'program',
      message: known?.message ?? `${pascal}: ${text}`,
      code: `${pascal} (${number})`,
    };
  }
  return null;
}

export function decodeError(err: unknown, logs: readonly string[] = []): DecodedError {
  const anchor = fromAnchorLogs(logs);
  if (anchor) return anchor;

  const text = typeof err === 'string' ? err : JSON.stringify(err);
  const all = `${text}\n${logs.join('\n')}`;

  if (/AccountNotFound|no record of a prior credit/i.test(all)) {
    return { kind: 'insufficient_sol', message: 'The wallet has no SOL yet. Fund your burner to trade or simulate.' };
  }
  if (/insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent|insufficient funds for (fee|rent)/i.test(all)) {
    return { kind: 'insufficient_sol', message: 'Not enough SOL for this trade plus fees, tip and rent.' };
  }
  // Not just "compute units": every program logs "consumed N of M compute units".
  if (/ComputationalBudgetExceeded|exceeded CUs meter/i.test(all)) {
    return { kind: 'compute', message: 'Ran out of compute units. The limit was raised; click again.' };
  }
  if (/BlockhashNotFound|blockhash not found/i.test(all)) {
    return { kind: 'blockhash', message: 'The blockhash expired before it was used. Click again.' };
  }
  // SPL Token custom error 1 = insufficient funds (selling more than held).
  if (/Program Tokenkeg|Program TokenzQd/.test(all) && /"Custom":1\b|custom program error: 0x1\b/.test(all)) {
    return { kind: 'insufficient_tokens', message: "You don't hold that many tokens." };
  }
  return { kind: 'unknown', message: `Transaction failed: ${text.slice(0, 160)}` };
}
