// Click -> signed transaction, and what a simulation of it says.
// Everything here is local except `simulate`, which is one RPC call.
import {
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type AddressLookupTableAccount,
  type Connection,
  type PublicKey,
  type SimulatedTransactionResponse,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import BN from 'bn.js';
import { LAMPORTS_PER_SOL } from '../constants';
import type { Profile, Settings, TierName } from '../settings/schema';
import type { Market } from '../venues/types';
import { venueAllowlist } from '../venues/registry';
import { capCuPrice, cuKey, type CuKey } from './fees';
import { guardTransaction, type GuardReport } from './guard';
import { minTipSol, solToLamports, tipInstruction } from './sender';
import { decodeError, type DecodedError } from './errors';
import type { TradePlan } from './trade';
import { tokenAmount } from './tokens';

export interface BuildInput {
  market: Market;
  plan: TradePlan;
  user: PublicKey;
  userAta: PublicKey;
  userAtaInfo: AccountInfo<Buffer> | null;
  tier: TierName;
  /** Preset override for the tip, if any. */
  tipSol: number | null;
  profile: Profile;
  settings: Settings;
  blockhash: string;
  cuLimit(key: CuKey): number;
  cuPrice: number;
  /** Close the token account after a full sell (reclaims ~0.002 SOL rent). */
  closeAfterFullSell: boolean;
  /** The wallet's own lookup tables, used alongside the market's. */
  ownTables?: AddressLookupTableAccount[];
}

/**
 * Too big for one transaction. `accounts` are the ones it carries in full
 * that a lookup table could hold instead (everything but the signer and the
 * programs it calls), so a wallet table holding them makes it fit.
 */
export class TooBigError extends Error {
  constructor(
    readonly size: number,
    readonly accounts: PublicKey[],
  ) {
    super(`This trade doesn't fit in one transaction (${size} of ${PACKET_DATA_SIZE} bytes)`);
    this.name = 'TooBigError';
  }
}

export interface BuiltTrade {
  tx: VersionedTransaction;
  guard: GuardReport;
  cuKey: CuKey;
  cuLimit: number;
  tipLamports: bigint;
}

export function tipFor(tier: TierName, profile: Profile, override: number | null, maxTipSol: number): number {
  const tip = Math.max(override ?? profile.tiers[tier].tipSol, minTipSol(tier));
  if (tip > maxTipSol) throw new Error(`Tip ${tip} SOL is above your max tip (${maxTipSol} SOL)`);
  return tip;
}

const compactLen = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);
/** How long a click waits for lookup tables still being found. */
const TABLE_WAIT_MS = 5_000;

/**
 * The transaction's wire size. web3.js throws a RangeError instead of
 * serializing one over the packet limit, so for those it's counted from the
 * compiled message (signatures, header, keys, blockhash, instructions,
 * lookups) to say by how much.
 */
export function serializedSize(tx: VersionedTransaction): number {
  try {
    return tx.serialize().length;
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    const m = tx.message;
    const sigs = m.header.numRequiredSignatures;
    let n = compactLen(sigs) + 64 * sigs + 1 + 3 + compactLen(m.staticAccountKeys.length) + 32 * m.staticAccountKeys.length + 32;
    n += compactLen(m.compiledInstructions.length);
    for (const ix of m.compiledInstructions) n += 1 + compactLen(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + compactLen(ix.data.length) + ix.data.length;
    n += compactLen(m.addressTableLookups.length);
    for (const l of m.addressTableLookups) n += 32 + compactLen(l.writableIndexes.length) + l.writableIndexes.length + compactLen(l.readonlyIndexes.length) + l.readonlyIndexes.length;
    return n;
  }
}

export async function buildTrade(i: BuildInput): Promise<BuiltTrade> {
  const { market, plan, user } = i;
  const q = plan.quote;
  const fullSell = q.side === 'sell' && q.inAmount.eq(tokenAmount(i.userAtaInfo));
  const close = fullSell && i.closeAfterFullSell && market.canCloseTokenAccount?.() !== false;
  const key = cuKey(market.venue, q.side, q.side === 'buy' ? i.userAtaInfo === null : close);
  const cuLimit = Math.max(i.cuLimit(key), market.cuFloor?.() ?? 0);
  const maxPriorityLamports = Math.floor(i.settings.safety.maxPriorityFeeSol * LAMPORTS_PER_SOL);
  const cuPrice = capCuPrice(i.cuPrice, cuLimit, maxPriorityLamports);

  const venueIxs = () =>
    q.side === 'buy' ? market.buildBuy(user, i.userAtaInfo, q, plan.slippagePct) : market.buildSell(user, i.userAtaInfo, q, plan.slippagePct);

  const tail: TransactionInstruction[] = close ? [createCloseAccountInstruction(i.userAta, user, user, [], market.mint.tokenProgram)] : [];
  const requireTip = i.settings.sendMode === 'sender';
  const tipSol = requireTip ? tipFor(i.tier, i.profile, i.tipSol, i.settings.safety.maxTipSol) : 0;

  const compile = async () => {
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
      ...(await venueIxs()),
      ...tail,
      ...(requireTip ? [tipInstruction(user, tipSol, i.tier)] : []),
    ];
    const tables = pickLookupTables(ixs, user, [...(i.ownTables ?? []), ...(market.lookupTables?.() ?? [])]);
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: i.blockhash, instructions: ixs }).compileToV0Message(tables));
    return { tables, tx, size: serializedSize(tx) };
  };
  let { tables, tx, size } = await compile();
  // Too big right after a routed coin opened: the tables that make it fit may still be on their way.
  if (size > PACKET_DATA_SIZE && market.whenTablesReady) {
    await Promise.race([market.whenTablesReady(), new Promise((r) => setTimeout(r, TABLE_WAIT_MS))]);
    ({ tables, tx, size } = await compile());
  }
  // Still too big: drop the route's spare tick arrays (a trade that then moves past them fails, not misfills).
  if (size > PACKET_DATA_SIZE && market.setLean) {
    market.setLean(true);
    try {
      ({ tables, tx, size } = await compile());
    } finally {
      market.setLean(false);
    }
  }
  if (size > PACKET_DATA_SIZE) {
    const m = tx.message;
    const invoked = new Set(m.compiledInstructions.map((ix) => ix.programIdIndex));
    throw new TooBigError(size, m.staticAccountKeys.filter((_, k) => k >= m.header.numRequiredSignatures && !invoked.has(k)));
  }

  const guard = guardTransaction(tx, {
    payer: user,
    venuePrograms: venueAllowlist(),
    selfAccounts: market.selfAccounts(user).map((k) => k.toBase58()),
    maxTipLamports: solToLamports(i.settings.safety.maxTipSol),
    maxPriorityFeeLamports: BigInt(maxPriorityLamports),
    requireTip,
    lookupTables: tables,
  });
  return { tx, guard, cuKey: key, cuLimit, tipLamports: guard.tipLamports };
}

/**
 * The lookup tables worth referencing, greedily: each must take at least two
 * accounts off the static list (a table reference costs about as much as one
 * account). Signers and invoked programs can't come from a table.
 */
export function pickLookupTables(ixs: TransactionInstruction[], payer: PublicKey, tables: AddressLookupTableAccount[]): AddressLookupTableAccount[] {
  const eligible = new Set<string>();
  for (const ix of ixs) for (const k of ix.keys) if (!k.isSigner) eligible.add(k.pubkey.toBase58());
  eligible.delete(payer.toBase58());
  for (const ix of ixs) eligible.delete(ix.programId.toBase58());

  const chosen: AddressLookupTableAccount[] = [];
  const covered = new Set<string>();
  const left = [...tables];
  for (;;) {
    const gain = (t: AddressLookupTableAccount) => new Set(t.state.addresses.map(String).filter((a) => eligible.has(a) && !covered.has(a))).size;
    left.sort((a, b) => gain(b) - gain(a));
    const best = left[0];
    if (!best || gain(best) < 2) return chosen;
    chosen.push(best);
    for (const a of best.state.addresses.map(String)) if (eligible.has(a)) covered.add(a);
    left.shift();
  }
}

// --------------------------------------------------------------- simulation

export interface SimulationOutcome {
  ok: boolean;
  unitsConsumed: number | null;
  /** Token balance change (raw units), when the token account was readable. */
  tokenDelta: BN | null;
  /** Wallet SOL change in lamports (includes tip, rent, and the network fee if the RPC charges it in simulation). */
  solDelta: number | null;
  error: DecodedError | null;
  logs: string[];
}

export async function simulate(
  conn: Connection,
  tx: VersionedTransaction,
  watch: { user: PublicKey; userAta: PublicKey; preLamports: number | null; preTokens: BN },
  opts: { sigVerify: boolean; replaceRecentBlockhash: boolean },
): Promise<SimulationOutcome> {
  const res = await conn.simulateTransaction(tx, {
    sigVerify: opts.sigVerify,
    replaceRecentBlockhash: opts.replaceRecentBlockhash,
    commitment: 'processed',
    accounts: { encoding: 'base64', addresses: [watch.user.toBase58(), watch.userAta.toBase58()] },
  });
  return interpretSimulation(res.value, watch);
}

export function interpretSimulation(
  v: SimulatedTransactionResponse,
  watch: { preLamports: number | null; preTokens: BN },
): SimulationOutcome {
  const logs = v.logs ?? [];
  if (v.err) {
    return { ok: false, unitsConsumed: v.unitsConsumed ?? null, tokenDelta: null, solDelta: null, error: decodeError(v.err, logs), logs };
  }
  const [wallet, ata] = v.accounts ?? [];
  const postTokens = ata ? tokenAmount({ data: Buffer.from(ata.data[0]!, 'base64') } as AccountInfo<Buffer>) : new BN(0);
  return {
    ok: true,
    unitsConsumed: v.unitsConsumed ?? null,
    tokenDelta: ata !== undefined ? postTokens.sub(watch.preTokens) : null,
    solDelta: wallet && watch.preLamports !== null ? wallet.lamports - watch.preLamports : null,
    error: null,
    logs,
  };
}
