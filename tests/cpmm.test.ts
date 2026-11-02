// Offline Raydium CPMM tests on mainnet snapshots recorded by
// `LIVE=1 npx vitest run tests/live-cpmm.test.ts`, which also checks each
// swap against the pool's own SwapEvent to the unit.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import type { WhirlpoolLeg } from '../src/venues/whirlpool';
import { Keypair, PACKET_DATA_SIZE, PublicKey, type AccountInfo } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import { accountOf, loadFixture, replay, type Fixture } from './helpers/fixtures';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket, venueAllowlist } from '../src/venues/registry';
import { CPMM_PROGRAM_ID, type CpmmMarket } from '../src/venues/raydiumCpmm';
import { JUPITER_PROGRAM_ID } from '../src/venues/jupiter';
import { STONK_MINT } from '../src/venues/routes';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { buildTrade } from '../src/solana/execute';
import { guardTransaction } from '../src/solana/guard';
import { planTrade } from '../src/solana/trade';
import { tokenAmount } from '../src/solana/tokens';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';

const stonk = loadFixture('tests/fixtures/cpmm-stonk.json');
const sol = loadFixture('tests/fixtures/cpmm-sol.json');
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

async function open(fx: Fixture): Promise<CpmmMarket> {
  __resetCurveProtocolCache();
  const conn = replay(fx);
  const r = await resolveAddress(conn, new PublicKey(fx.address));
  return (await openMarket(conn, r.mint, r.hint)) as CpmmMarket;
}

/** swap_base_input written out from the raw accounts: reserves are vaults less fees owed. */
function reference(fx: Fixture, m: CpmmMarket) {
  const p = accountOf(fx, m.address).data;
  const cfg = accountOf(fx, m.state.ammConfig).data;
  const owed0 = p.readBigUInt64LE(341) + p.readBigUInt64LE(357) + p.readBigUInt64LE(397);
  const owed1 = p.readBigUInt64LE(349) + p.readBigUInt64LE(365) + p.readBigUInt64LE(405);
  const r0 = BigInt(tokenAmount(accountOf(fx, m.state.vault0)).toString()) - owed0;
  const r1 = BigInt(tokenAmount(accountOf(fx, m.state.vault1)).toString()) - owed1;
  const baseIs0 = m.state.mint0.equals(m.mint.mint);
  const trade = cfg.readBigUInt64LE(12);
  const creator = p[390] === 1 ? cfg.readBigUInt64LE(108) : 0n;
  const ceil = (x: bigint, r: bigint) => (x * r + 999_999n) / 1_000_000n;
  return (amountIn: bigint, fromBase: boolean) => {
    const inputIs0 = fromBase === baseIs0;
    const [rin, rout] = inputIs0 ? [r0, r1] : [r1, r0];
    const on = p[389];
    if (on === 0 || (on === 1 && inputIs0) || (on === 2 && !inputIs0)) {
      const net = amountIn - ceil(amountIn, trade + creator);
      return (net * rout) / (rin + net);
    }
    const net = amountIn - ceil(amountIn, trade);
    const swapped = (net * rout) / (rin + net);
    return swapped - ceil(swapped, creator);
  };
}

function tokenAccount(amount: bigint, mint: PublicKey, owner: PublicKey, programId: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { data, owner: programId, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

describe('SOL-paired CPMM pool', () => {
  it('resolves the pool address and quotes like the program', async () => {
    const r = await resolveAddress(replay(sol), new PublicKey(sol.address));
    expect(r.hint?.venue).toBe('RAYDIUM_CPMM');
    const m = await open(sol);
    expect(m.venue).toBe('RAYDIUM_CPMM');
    expect(m.quoteMint.equals(NATIVE_MINT)).toBe(true);
    const ref = reference(sol, m);
    expect(m.quoteBuy(new BN(100_000_000), 15).out.toString()).toBe(ref(100_000_000n, false).toString());
    expect(m.quoteSell(new BN(5_000_000_000), 15).out.toString()).toBe(ref(5_000_000_000n, true).toString());
  });

  it('builds a direct swap_base_input the guard accepts, closing the account on a full sell', async () => {
    const m = await open(sol);
    const settings = defaultSettings();
    const profile = activeProfile(settings);
    const user = Keypair.generate().publicKey;
    const held = 5_000_000_000n;
    const plan = planTrade(m, { side: 'sell', amount: 100, presetIndex: null }, settings, profile, new BN(held.toString()));
    const built = await buildTrade({
      market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: tokenAccount(held, m.mint.mint, user, m.mint.tokenProgram),
      tier: 'eco', tipSol: null, profile, settings, blockhash: BLOCKHASH, cuLimit: () => 64_000, cuPrice: 1_000, closeAfterFullSell: true,
    });
    expect(built.cuKey).toBe('RAYDIUM_CPMM:sell+close');
    const keys = built.tx.message.staticAccountKeys;
    const swap = built.tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex]!.equals(CPMM_PROGRAM_ID))!;
    expect(swap.accountKeyIndexes).toHaveLength(13);
    expect([...Buffer.from(swap.data).subarray(0, 8)]).toEqual([143, 190, 90, 218, 196, 30, 51, 222]);
    expect(built.tx.message.addressTableLookups).toHaveLength(0);
  });
});

describe('STONK-paired CPMM pool (a graduated stonk.fun coin)', () => {
  it('opens from the pool address or the mint, through the graduated curve', async () => {
    const m = await open(stonk);
    expect(m.venue).toBe('RAYDIUM_CPMM_ROUTED');
    expect(m.quoteMint.equals(STONK_MINT)).toBe(true);
    __resetCurveProtocolCache();
    const conn = replay(stonk);
    const viaMint = await openMarket(conn, (await resolveAddress(conn, m.mint.mint)).mint);
    expect(viaMint.address.equals(m.address)).toBe(true);
  });

  it('quotes the CPMM leg like the program, after the Orca leg', async () => {
    const m = await open(stonk);
    const ref = reference(stonk, m);
    const leg = m.leg as WhirlpoolLeg;
    const stonkIn = leg.swapExactIn(10_000_000n, leg.aToB(true));
    expect(m.quoteBuy(new BN(10_000_000), 15).out.toString()).toBe(ref(stonkIn, false).toString());
    const stonkOut = ref(1_000_000_000n, true);
    expect(m.quoteSell(new BN(1_000_000_000), 15).out.toString()).toBe(leg.swapExactIn(stonkOut, leg.aToB(false)).toString());
  });

  it('builds a Jupiter route that fits with lookup tables and passes the guard only with them', async () => {
    const m = await open(stonk);
    const settings = defaultSettings();
    const profile = activeProfile(settings);
    const user = Keypair.generate().publicKey;
    for (const side of ['buy', 'sell'] as const) {
      const held = side === 'sell' ? 1_000_000_000n : 0n;
      const plan = planTrade(m, { side, amount: side === 'buy' ? 0.05 : 100, presetIndex: null }, settings, profile, new BN(held.toString()));
      const built = await buildTrade({
        market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: held ? tokenAccount(held, m.mint.mint, user, m.mint.tokenProgram) : null,
        tier: 'fast', tipSol: null, profile, settings, blockhash: BLOCKHASH, cuLimit: () => 145_000, cuPrice: 10_000, closeAfterFullSell: true,
      });
      expect(built.cuKey).toBe(side === 'buy' ? 'RAYDIUM_CPMM_ROUTED:buy+ata' : 'RAYDIUM_CPMM_ROUTED:sell+close');
      expect(built.tx.serialize().length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const keys = built.tx.message.staticAccountKeys;
      const programs = built.tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58());
      expect(programs).toContain(JUPITER_PROGRAM_ID.toBase58());
      expect(programs).not.toContain(CPMM_PROGRAM_ID.toBase58());
      const policy = { payer: user, venuePrograms: venueAllowlist(), selfAccounts: m.selfAccounts(user).map(String), maxTipLamports: 10_000_000n, maxPriorityFeeLamports: 10_000_000n, requireTip: true };
      expect(() => guardTransaction(built.tx, policy)).toThrow(/unknown address lookup table/);
      expect(() => guardTransaction(built.tx, { ...policy, lookupTables: m.lookupTables() })).not.toThrow();
    }
  });
});
