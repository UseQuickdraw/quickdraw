// A wallet's own lookup table makes a route nobody's public tables cover fit,
// and the guard only lets setup transactions create and extend such tables.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { loadFixture, replay } from './helpers/fixtures';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket, venueAllowlist } from '../src/venues/registry';
import { TooBigError, buildTrade, type BuildInput } from '../src/solana/execute';
import { guardTransaction } from '../src/solana/guard';
import { planTrade } from '../src/solana/trade';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';
import type { Market } from '../src/venues/types';

const chad = loadFixture('tests/fixtures/launchlab-chain.json');
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

const table = (addresses: PublicKey[], authority: PublicKey) =>
  new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority, addresses },
  });

describe("a wallet's own lookup table", () => {
  it('makes a too-big chained route fit, holding exactly what the error asked for', async () => {
    const conn = replay(chad);
    const r = await resolveAddress(conn, new PublicKey(chad.address));
    const m = (await openMarket(conn, r.mint, r.hint)) as Market;
    const settings = defaultSettings();
    const profile = activeProfile(settings);
    const user = Keypair.generate().publicKey;
    const plan = planTrade(m, { side: 'buy', amount: 0.05, presetIndex: null }, settings, profile, new BN(0));
    const input = (own: AddressLookupTableAccount[]): BuildInput => ({
      market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: null, tier: 'fast', tipSol: null, profile, settings,
      blockhash: BLOCKHASH, cuLimit: () => 300_000, cuPrice: 10_000, closeAfterFullSell: true, ownTables: own,
    });
    const err = await buildTrade(input([])).catch((e) => e);
    expect(err).toBeInstanceOf(TooBigError);
    expect(err.accounts.length).toBeGreaterThan(10);
    // Never the signer, never a program the transaction calls.
    expect(err.accounts.some((a: PublicKey) => a.equals(user))).toBe(false);

    const own = table(err.accounts, user);
    const built = await buildTrade(input([own]));
    expect(built.tx.serialize().length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(built.tx.message.addressTableLookups.some((l) => l.accountKey.equals(own.key))).toBe(true);
    // The guard expands it like any table.
    const policy = { payer: user, venuePrograms: venueAllowlist(), selfAccounts: m.selfAccounts(user).map(String), maxTipLamports: 10_000_000n, maxPriorityFeeLamports: 10_000_000n, requireTip: true };
    expect(() => guardTransaction(built.tx, { ...policy, lookupTables: [own, ...(m.lookupTables?.() ?? [])] })).not.toThrow();
  });
});

describe('the guard on lookup-table setup', () => {
  const wallet = Keypair.generate().publicKey;
  const tx = (...ixs: TransactionInstruction[]) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message());
  const policy = { payer: wallet, venuePrograms: [], maxTipLamports: 0n, maxPriorityFeeLamports: 5_000_000n, requireTip: false };
  const [create, key] = AddressLookupTableProgram.createLookupTable({ authority: wallet, payer: wallet, recentSlot: 1 });
  const extend = AddressLookupTableProgram.extendLookupTable({ lookupTable: key, authority: wallet, payer: wallet, addresses: [Keypair.generate().publicKey] });

  it("allows creating and extending the wallet's own table, only in setup", () => {
    expect(() => guardTransaction(tx(create, extend), { ...policy, lookupTableSetup: true })).not.toThrow();
    expect(() => guardTransaction(tx(create, extend), policy)).toThrow(/not allowlisted/);
  });

  it('refuses closing, deactivating, or a table someone else owns', () => {
    const close = AddressLookupTableProgram.closeLookupTable({ lookupTable: key, authority: wallet, recipient: wallet });
    const deactivate = AddressLookupTableProgram.deactivateLookupTable({ lookupTable: key, authority: wallet });
    expect(() => guardTransaction(tx(close), { ...policy, lookupTableSetup: true })).toThrow(/create\/extend/);
    expect(() => guardTransaction(tx(deactivate), { ...policy, lookupTableSetup: true })).toThrow(/create\/extend/);
    const other = Keypair.generate().publicKey;
    const foreign = AddressLookupTableProgram.extendLookupTable({ lookupTable: key, authority: other, payer: wallet, addresses: [other] });
    expect(() => guardTransaction(tx(foreign), { ...policy, lookupTableSetup: true })).toThrow();
  });
});
