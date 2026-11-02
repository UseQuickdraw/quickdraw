// Each wallet's own address lookup tables. A routed trade through a chain of
// pools can be too big for one transaction when no public table holds its
// accounts; the first time that happens, the wallet adds those accounts to a
// table it owns (one small setup transaction, rent only, about 0.0002 SOL per
// address), and that trade and every later one through the same pools fit.
// Tables are only ever created and extended here, never frozen or closed.
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Keypair,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { guardTransaction } from './guard';
import { sendAndConfirm } from './confirm';

/** A table holds 256 addresses; past that a new one starts. */
const TABLE_CAPACITY = 256;
/** Addresses one extend instruction can carry and still fit a transaction. */
const PER_EXTEND = 28;
/** How long to wait for a fresh extension to become usable (it is from the next slot on). */
const WARM_TIMEOUT_MS = 8_000;

export interface PersonalTableStore {
  load(): Promise<string[] | undefined>;
  save(addresses: string[]): Promise<void>;
}

export class PersonalTables {
  private tables: AddressLookupTableAccount[] = [];
  private loaded: Promise<void> | null = null;
  /** One setup at a time: two clicks on the same route share it. */
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private readonly conn: Connection,
    private readonly signer: Keypair,
    private readonly rpcUrl: string,
    private readonly store?: PersonalTableStore,
  ) {}

  /** The wallet's tables as last loaded (empty until `load` has run). */
  current(): AddressLookupTableAccount[] {
    return this.tables;
  }

  /** Loads the tables this wallet made before (best effort). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const keys = ((await this.store?.load().catch(() => undefined)) ?? []).map((k) => new PublicKey(k));
      this.tables = (await Promise.all(keys.map((k) => this.fetch(k)))).filter((t): t is AddressLookupTableAccount => t !== null);
    })().catch(() => {});
    return this.loaded;
  }

  private async fetch(key: PublicKey): Promise<AddressLookupTableAccount | null> {
    const r = await this.conn.getAddressLookupTable(key, { commitment: 'confirmed' }).catch(() => null);
    const t = r?.value ?? null;
    // Only tables this wallet still controls and that are still active.
    return t && t.isActive() && t.state.authority?.equals(this.signer.publicKey) ? t : null;
  }

  /** Makes sure every one of `accounts` is in one of this wallet's tables, sending setup transactions as needed. */
  ensure(accounts: PublicKey[]): Promise<void> {
    const run = this.busy.then(() => this.add(accounts));
    this.busy = run.catch(() => {});
    return run;
  }

  private async add(accounts: PublicKey[]): Promise<void> {
    await this.load();
    const have = new Set(this.tables.flatMap((t) => t.state.addresses.map((a) => a.toBase58())));
    const missing = [...new Set(accounts.map((a) => a.toBase58()))].filter((a) => !have.has(a)).map((a) => new PublicKey(a));
    if (!missing.length) return;

    let table = this.tables.find((t) => t.state.addresses.length + missing.length <= TABLE_CAPACITY) ?? null;
    let key = table?.key ?? null;
    for (let i = 0; i < missing.length; i += PER_EXTEND) {
      const chunk = missing.slice(i, i + PER_EXTEND);
      const ixs = [];
      if (!key) {
        const [create, created] = AddressLookupTableProgram.createLookupTable({
          authority: this.signer.publicKey,
          payer: this.signer.publicKey,
          recentSlot: await this.conn.getSlot('finalized'),
        });
        ixs.push(create);
        key = created;
      }
      ixs.push(AddressLookupTableProgram.extendLookupTable({ lookupTable: key, authority: this.signer.publicKey, payer: this.signer.publicKey, addresses: chunk }));
      await this.send(ixs);
      if (!table) {
        await this.store?.save([...this.tables.map((t) => t.key.toBase58()), key.toBase58()]).catch(() => {});
      }
      table = null; // refetched below
    }
    // Usable from the slot after the last extension: wait for it, then reload.
    const fresh = await this.warm(key!);
    this.tables = [...this.tables.filter((t) => !t.key.equals(key!)), fresh];
  }

  private async send(instructions: ReturnType<typeof AddressLookupTableProgram.extendLookupTable>[]): Promise<void> {
    const bh = await this.conn.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: this.signer.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ...instructions],
      }).compileToV0Message(),
    );
    guardTransaction(tx, {
      payer: this.signer.publicKey,
      venuePrograms: [],
      maxTipLamports: 0n,
      maxPriorityFeeLamports: 5_000_000n,
      requireTip: false,
      lookupTableSetup: true,
    });
    tx.sign([this.signer]);
    const o = await sendAndConfirm({
      conn: this.conn,
      sendUrl: this.rpcUrl,
      rawTx: Buffer.from(tx.serialize()).toString('base64'),
      signature: bs58.encode(tx.signatures[0]!),
      lastValidBlockHeight: bh.lastValidBlockHeight,
    });
    if (o.status !== 'confirmed') throw new Error(`Setting up this route's lookup table failed: ${o.error?.message ?? o.status}`);
  }

  private async warm(key: PublicKey): Promise<AddressLookupTableAccount> {
    const deadline = Date.now() + WARM_TIMEOUT_MS;
    for (;;) {
      const [t, slot] = await Promise.all([this.fetch(key), this.conn.getSlot('confirmed')]);
      if (t && slot > Number(t.state.lastExtendedSlot)) return t;
      if (Date.now() > deadline) throw new Error("This route's lookup table isn't usable yet. Try again in a moment.");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
