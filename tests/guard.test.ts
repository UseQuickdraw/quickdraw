import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token';
import { PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { guardTransaction, GuardError, type GuardPolicy } from '../src/solana/guard';
import { SENDER } from '../src/constants';

const user = Keypair.generate();
const payer = user.publicKey;
const mint = Keypair.generate().publicKey;
const tipAccount = new PublicKey(SENDER.tipAccounts[0]);
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer);
const VENUE = PUMP_PROGRAM_ID.toBase58();

const policy: GuardPolicy = {
  payer,
  venuePrograms: [VENUE],
  selfAccounts: [wsolAta.toBase58()],
  maxTipLamports: 10_000_000n,
  maxPriorityFeeLamports: 5_000_000n,
  requireTip: true,
};

const venueIx = new TransactionInstruction({
  programId: PUMP_PROGRAM_ID,
  keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
  data: Buffer.from([1, 2, 3]),
});
const tip = (lamports = 1_000_000) => SystemProgram.transfer({ fromPubkey: payer, toPubkey: tipAccount, lamports });

function tx(ixs: TransactionInstruction[]): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

const budget = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
];
const ata = createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(mint, payer), payer, mint);

describe('guard', () => {
  it('accepts a well-formed buy', () => {
    const r = guardTransaction(tx([...budget, ata, venueIx, tip()]), policy);
    expect(r.tipLamports).toBe(1_000_000n);
    expect(r.priorityFeeLamports).toBe(5_000n); // 50_000 uLamports * 100k CU
  });

  it('accepts a WSOL wrap to our own ATA and a self-refunding close', () => {
    const ixs = [
      ...budget,
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: wsolAta, lamports: 5_000_000 }),
      createSyncNativeInstruction(wsolAta),
      venueIx,
      createCloseAccountInstruction(wsolAta, payer, payer),
      tip(),
    ];
    expect(() => guardTransaction(tx(ixs), policy)).not.toThrow();
  });

  const reject = (name: string, ixs: TransactionInstruction[], re: RegExp, p: GuardPolicy = policy) =>
    it(`rejects: ${name}`, () => {
      expect(() => guardTransaction(tx(ixs), p)).toThrow(GuardError);
      expect(() => guardTransaction(tx(ixs), p)).toThrow(re);
    });

  const attacker = Keypair.generate().publicKey;
  reject('extra SOL transfer', [...budget, venueIx, tip(), SystemProgram.transfer({ fromPubkey: payer, toPubkey: attacker, lamports: 1 })], /unknown account/);
  reject('unknown program', [...budget, venueIx, tip(), new TransactionInstruction({ programId: attacker, keys: [], data: Buffer.alloc(0) })], /not allowlisted/);
  reject('tip over max', [...budget, venueIx, tip(20_000_000)], /tip exceeds/);
  reject('two tips', [...budget, venueIx, tip(), tip()], /more than one tip/);
  reject('missing tip', [...budget, venueIx], /missing Sender tip/);
  reject('missing CU price', [budget[0]!, venueIx, tip()], /compute unit price/);
  reject(
    'priority fee over max',
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }), venueIx, tip()],
    /priority fee exceeds/,
  );
  reject('SPL token transfer out', [...budget, venueIx, tip(), createTransferInstruction(wsolAta, getAssociatedTokenAddressSync(NATIVE_MINT, attacker), payer, 1n)], /token instruction 3/);
  reject('close account to attacker', [...budget, venueIx, tip(), createCloseAccountInstruction(wsolAta, attacker, payer)], /refund the wallet/);
  reject(
    'ATA for a foreign wallet',
    [...budget, createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(mint, attacker), attacker, mint), venueIx, tip()],
    /foreign wallet/,
  );
  reject(
    'extra required signer',
    [...budget, venueIx, tip(), new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys: [{ pubkey: attacker, isSigner: true, isWritable: false }], data: Buffer.alloc(0) })],
    /extra signers/,
  );

  it('allows exactly one transfer to the configured sweep address, and only then', () => {
    const main = Keypair.generate().publicKey;
    const sweep = SystemProgram.transfer({ fromPubkey: payer, toPubkey: main, lamports: 1_000 });
    const p = { ...policy, venuePrograms: [], requireTip: false, sweepTo: main.toBase58() };
    expect(() => guardTransaction(tx([sweep]), p)).not.toThrow();
    expect(() => guardTransaction(tx([sweep, SystemProgram.transfer({ fromPubkey: payer, toPubkey: main, lamports: 2 })]), p)).toThrow(/more than one sweep/);
    expect(() => guardTransaction(tx([sweep]), { ...policy, requireTip: false })).toThrow(/unknown account/);
  });

  it('rejects a different fee payer', () => {
    expect(() => guardTransaction(tx([...budget, venueIx, tip()]), { ...policy, payer: attacker })).toThrow(/fee payer/);
  });

  describe('address lookup tables', () => {
    const table = (addresses: PublicKey[]) =>
      new AddressLookupTableAccount({
        key: Keypair.generate().publicKey,
        state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses },
      });
    const withTable = (ixs: TransactionInstruction[], t: AddressLookupTableAccount) =>
      new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message([t]));

    it('expands a supplied table and checks the real addresses', () => {
      const ok = table([wsolAta, mint, Keypair.generate().publicKey]);
      const wrap = [...budget, SystemProgram.transfer({ fromPubkey: payer, toPubkey: wsolAta, lamports: 1 }), createSyncNativeInstruction(wsolAta), venueIx, tip()];
      const t = withTable(wrap, ok);
      expect(t.message.addressTableLookups).toHaveLength(1);
      expect(() => guardTransaction(t, { ...policy, lookupTables: [ok] })).not.toThrow();
      // A transfer hidden behind the table is still seen for what it is.
      const hidden = attacker;
      const bad = table([hidden]);
      const steal = withTable([...budget, venueIx, SystemProgram.transfer({ fromPubkey: payer, toPubkey: hidden, lamports: 5 }), tip()], bad);
      expect(() => guardTransaction(steal, { ...policy, lookupTables: [bad] })).toThrow(/unknown account/);
    });

    it('refuses tables it was not given', () => {
      const t = table([wsolAta]);
      const wrap = withTable([...budget, SystemProgram.transfer({ fromPubkey: payer, toPubkey: wsolAta, lamports: 1 }), venueIx, tip()], t);
      expect(() => guardTransaction(wrap, policy)).toThrow(/unknown address lookup table/);
    });

    it('refuses a program loaded from a table', () => {
      const t = table([PUMP_PROGRAM_ID]);
      const msg = new MessageV0({
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
        staticAccountKeys: [payer],
        recentBlockhash: '11111111111111111111111111111111',
        compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: new Uint8Array([1]) }],
        addressTableLookups: [{ accountKey: t.key, writableIndexes: [], readonlyIndexes: [0] }],
      });
      expect(() => guardTransaction(new VersionedTransaction(msg), { ...policy, requireTip: false, lookupTables: [t] })).toThrow(/program loaded from a lookup table/);
    });
  });
});

describe('pinned SDK program IDs', () => {
  // If the SDK is bumped and these change, review the guard allowlist before updating.
  it('match the known mainnet programs', () => {
    expect(PUMP_PROGRAM_ID.toBase58()).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    expect(PUMP_AMM_PROGRAM_ID.toBase58()).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    expect(PUMP_FEE_PROGRAM_ID.toBase58()).toBe('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
  });
});
