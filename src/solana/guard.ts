// Last line of defence before signing. Inspects the *compiled* message (what
// will actually be signed), not the instruction list we think we built.
//
// Rules:
//  - exactly one signer, and it is our wallet (fee payer)
//  - address lookup tables only if the caller supplied them; they are expanded
//    here so every rule below sees the real addresses, and programs must be
//    static keys, never loaded from a table
//  - every top-level program is allowlisted (core + registered venues)
//  - System: only Transfer, from us, to a Sender tip account (<= max tip) or
//    to one of our own accounts (WSOL wrap)
//  - Token/Token-2022: only init-account, SyncNative and CloseAccount that
//    pay back to us
//  - Associated Token: only (idempotent) create, paid by and owned by us
//  - ComputeBudget: CU limit / price / data-size only; price x limit <= max fee
import { PublicKey, type AddressLookupTableAccount, type VersionedMessage, type VersionedTransaction } from '@solana/web3.js';
import { PROGRAMS, SENDER } from '../constants';

export class GuardError extends Error {
  constructor(reason: string) {
    super(`Refusing to sign: ${reason}`);
    this.name = 'GuardError';
  }
}

export interface GuardPolicy {
  payer: PublicKey;
  /** Venue programs (from the pinned SDKs) allowed in addition to the core set. */
  venuePrograms: Iterable<string>;
  /** Accounts we own that may receive System transfers (e.g. our WSOL ATA). */
  selfAccounts?: Iterable<string>;
  maxTipLamports: bigint;
  maxPriorityFeeLamports: bigint;
  /** Sender rejects transactions without a tip + CU price, so require both. */
  requireTip: boolean;
  tipAccounts?: readonly string[];
  /** Sweep only: the user's configured main wallet may receive exactly one transfer. */
  sweepTo?: string;
  /** A wallet's own lookup-table setup: allows creating and extending tables it owns and pays for (nothing else). */
  lookupTableSetup?: boolean;
  /** Lookup tables the builder used, as fetched. Any other table is refused. */
  lookupTables?: readonly AddressLookupTableAccount[];
}

export interface GuardReport {
  tipLamports: bigint;
  priorityFeeLamports: bigint;
  cuLimit: number;
  cuPriceMicroLamports: bigint;
  programs: string[];
}

export const CORE_PROGRAMS: readonly string[] = Object.values(PROGRAMS);
const LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

const MAX_CU = 1_400_000;
const DEFAULT_CU_PER_IX = 200_000;

function u32(data: Uint8Array, off: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(off, true);
}
function u64(data: Uint8Array, off: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(off, true);
}

export function guardTransaction(tx: VersionedTransaction, policy: GuardPolicy): GuardReport {
  return guardMessage(tx.message, policy);
}

export function guardMessage(msg: VersionedMessage, policy: GuardPolicy): GuardReport {
  const payer = policy.payer.toBase58();
  const tipAccounts = new Set(policy.tipAccounts ?? SENDER.tipAccounts);
  const allowed = new Set([...CORE_PROGRAMS, ...policy.venuePrograms, ...(policy.lookupTableSetup ? [LOOKUP_TABLE_PROGRAM] : [])]);
  const self = new Set([payer, ...(policy.selfAccounts ?? [])]);

  if (msg.header.numRequiredSignatures !== 1) throw new GuardError('transaction requires extra signers');
  const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
  if (staticKeys[0] !== payer) throw new GuardError('fee payer is not the wallet');

  // v0 account order: static keys, then every table's writable, then readonly entries.
  const tables = new Map((policy.lookupTables ?? []).map((t) => [t.key.toBase58(), t]));
  const loaded = { writable: [] as string[], readonly: [] as string[] };
  for (const lookup of msg.addressTableLookups) {
    const table = tables.get(lookup.accountKey.toBase58());
    if (!table) throw new GuardError(`unknown address lookup table ${lookup.accountKey.toBase58()}`);
    for (const [list, indexes] of [[loaded.writable, lookup.writableIndexes], [loaded.readonly, lookup.readonlyIndexes]] as const) {
      for (const i of indexes) {
        const address = table.state.addresses[i];
        if (!address) throw new GuardError('lookup table index out of range');
        list.push(address.toBase58());
      }
    }
  }
  const keys = [...staticKeys, ...loaded.writable, ...loaded.readonly];

  const key = (i: number | undefined): string => {
    const k = i === undefined ? undefined : keys[i];
    if (k === undefined) throw new GuardError('instruction references a missing account');
    return k;
  };

  let tipLamports = 0n;
  let tipCount = 0;
  let sweepCount = 0;
  let cuLimit: number | null = null;
  let cuPrice: bigint | null = null;
  let nonBudgetIxs = 0;
  const programs: string[] = [];

  for (const ix of msg.compiledInstructions) {
    if (ix.programIdIndex >= staticKeys.length) throw new GuardError('program loaded from a lookup table');
    const program = key(ix.programIdIndex);
    if (!allowed.has(program)) throw new GuardError(`program ${program} is not allowlisted`);
    programs.push(program);
    const data = ix.data;
    const acct = (n: number) => key(ix.accountKeyIndexes[n]);

    switch (program) {
      case PROGRAMS.system: {
        nonBudgetIxs++;
        if (data.length !== 12 || u32(data, 0) !== 2) throw new GuardError('only System transfers are allowed');
        const from = acct(0);
        const to = acct(1);
        const lamports = u64(data, 4);
        if (from !== payer) throw new GuardError('System transfer not from the wallet');
        if (tipAccounts.has(to)) {
          tipCount++;
          tipLamports += lamports;
        } else if (policy.sweepTo !== undefined && to === policy.sweepTo) {
          sweepCount++;
        } else if (!self.has(to)) {
          throw new GuardError(`SOL transfer to unknown account ${to}`);
        }
        break;
      }
      case PROGRAMS.computeBudget: {
        const kind = data[0];
        if (kind === 2 && data.length === 5) {
          if (cuLimit !== null) throw new GuardError('duplicate CU limit');
          cuLimit = u32(data, 1);
        } else if (kind === 3 && data.length === 9) {
          if (cuPrice !== null) throw new GuardError('duplicate CU price');
          cuPrice = u64(data, 1);
        } else if (kind === 4 && data.length === 5) {
          // SetLoadedAccountsDataSizeLimit: harmless.
        } else {
          throw new GuardError('unexpected ComputeBudget instruction');
        }
        break;
      }
      case PROGRAMS.token:
      case PROGRAMS.token2022: {
        nonBudgetIxs++;
        const kind = data[0];
        if (kind === 17 && data.length === 1) break; // SyncNative
        if (kind === 9 && data.length === 1) {
          // CloseAccount [account, destination, owner]
          if (acct(1) !== payer || acct(2) !== payer) throw new GuardError('CloseAccount must refund the wallet');
          break;
        }
        if (kind === 1 && data.length === 1) {
          // InitializeAccount [account, mint, owner, rent]
          if (acct(2) !== payer) throw new GuardError('token account owner is not the wallet');
          break;
        }
        if ((kind === 16 || kind === 18) && data.length === 33) {
          // InitializeAccount2/3 carry the owner in data.
          if (new PublicKey(data.subarray(1, 33)).toBase58() !== payer) {
            throw new GuardError('token account owner is not the wallet');
          }
          break;
        }
        throw new GuardError(`token instruction ${kind} is not allowed`);
      }
      case PROGRAMS.associatedToken: {
        nonBudgetIxs++;
        const kind = data.length === 0 ? 0 : data[0];
        if ((kind !== 0 && kind !== 1) || data.length > 1) throw new GuardError('only ATA create is allowed');
        // [payer, ata, wallet, mint, system, tokenProgram]
        if (acct(0) !== payer) throw new GuardError('ATA create not paid by the wallet');
        if (acct(2) !== payer) throw new GuardError('ATA create for a foreign wallet');
        break;
      }
      case LOOKUP_TABLE_PROGRAM: {
        nonBudgetIxs++;
        // CreateLookupTable (0) / ExtendLookupTable (2): [table, authority, payer, system]. Never freeze, deactivate or close.
        const kind = data.length >= 4 ? u32(data, 0) : -1;
        if (kind !== 0 && kind !== 2) throw new GuardError('only lookup table create/extend is allowed');
        if (acct(1) !== payer || acct(2) !== payer) throw new GuardError('lookup table not owned and paid for by the wallet');
        break;
      }
      default:
        // Registered venue program. Its own accounts/CPIs are the swap itself.
        nonBudgetIxs++;
    }
  }

  if (tipCount > 1) throw new GuardError('more than one tip transfer');
  if (sweepCount > 1) throw new GuardError('more than one sweep transfer');
  if (tipLamports > policy.maxTipLamports) throw new GuardError('tip exceeds the configured maximum');
  if (policy.requireTip && tipCount === 0) throw new GuardError('missing Sender tip');
  if (policy.requireTip && cuPrice === null) throw new GuardError('missing compute unit price');

  const effectiveLimit = cuLimit ?? Math.min(MAX_CU, DEFAULT_CU_PER_IX * nonBudgetIxs);
  const price = cuPrice ?? 0n;
  const priorityFeeLamports = (price * BigInt(effectiveLimit) + 999_999n) / 1_000_000n;
  if (priorityFeeLamports > policy.maxPriorityFeeLamports) {
    throw new GuardError('priority fee exceeds the configured maximum');
  }

  return { tipLamports, priorityFeeLamports, cuLimit: effectiveLimit, cuPriceMicroLamports: price, programs };
}
