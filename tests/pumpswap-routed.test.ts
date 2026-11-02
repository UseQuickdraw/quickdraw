// Offline tests for a PumpSwap coin quoted in another pump coin (MEIMEI /
// MeiMei), on the snapshot recorded by
// `LIVE=1 npx vitest run tests/live-pumproute.test.ts`, which also checks each
// routed trade against the chain to the unit.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Keypair, PACKET_DATA_SIZE, PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { loadFixture, replay } from './helpers/fixtures';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket, venueAllowlist } from '../src/venues/registry';
import type { PoolMarket } from '../src/venues/pumpSwap';
import { JUPITER_PROGRAM_ID } from '../src/venues/jupiter';
import { PumpSwapSolLeg } from '../src/venues/pumpPool';
import { __resetCurveProtocolCache } from '../src/venues/pumpCurve';
import { buildTrade } from '../src/solana/execute';
import { guardTransaction } from '../src/solana/guard';
import { planTrade } from '../src/solana/trade';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';

const fx = loadFixture('tests/fixtures/pumpswap-routed.json');
const COIN = 'okQfvYTBDXcAAVhDKXMm4sacKCqCoKqgSab7SDbpump';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

async function open(address = fx.address): Promise<PoolMarket> {
  __resetCurveProtocolCache();
  const conn = replay(fx);
  const r = await resolveAddress(conn, new PublicKey(address));
  return (await openMarket(conn, r.mint, r.hint)) as PoolMarket;
}

function tokenAccount(amount: bigint, mint: PublicKey, owner: PublicKey, programId: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { data, owner: programId, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

describe('PumpSwap pool quoted in a pump coin', () => {
  it('opens from the pool or the mint as a routed market through the quote token', async () => {
    for (const address of [fx.address, COIN]) {
      const m = await open(address);
      expect(m.venue).toBe('PUMPSWAP_ROUTED');
      expect(m.routedVia).toBe('MeiMei');
      expect(m.leg).toBeInstanceOf(PumpSwapSolLeg);
      expect(m.spotLamportsPerToken()).toBeGreaterThan(0);
    }
  });

  it('quotes as the SOL leg followed by the coin pool (and back)', async () => {
    const m = await open();
    const leg = m.leg!;
    const buy = m.quoteBuy(new BN(10_000_000), 15);
    expect(buy.out.gtn(0)).toBe(true);
    expect(buy.minOut.lt(buy.out)).toBe(true);
    // Spending more SOL buys more, and selling back returns less than spent.
    expect(m.quoteBuy(new BN(20_000_000), 15).out.gt(buy.out)).toBe(true);
    const back = m.quoteSell(buy.out, 15).out;
    expect(back.ltn(10_000_000)).toBe(true);
    expect(back.gtn(9_000_000)).toBe(true);
    expect(leg.quote(10_000_000n, true) > 0n).toBe(true);
  });

  it('builds a Jupiter route that fits and passes the guard', async () => {
    const m = await open();
    const settings = defaultSettings();
    const profile = activeProfile(settings);
    const user = Keypair.generate().publicKey;
    for (const side of ['buy', 'sell'] as const) {
      const held = side === 'sell' ? 1_000_000_000_000n : 0n;
      const plan = planTrade(m, { side, amount: side === 'buy' ? 0.05 : 100, presetIndex: null }, settings, profile, new BN(held.toString()));
      const built = await buildTrade({
        market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: held ? tokenAccount(held, m.mint.mint, user, m.mint.tokenProgram) : null,
        tier: 'fast', tipSol: null, profile, settings, blockhash: BLOCKHASH, cuLimit: () => 200_000, cuPrice: 10_000, closeAfterFullSell: true,
      });
      expect(built.cuKey).toBe(side === 'buy' ? 'PUMPSWAP_ROUTED:buy+ata' : 'PUMPSWAP_ROUTED:sell+close');
      expect(built.tx.serialize().length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const keys = built.tx.message.staticAccountKeys;
      const programs = built.tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58());
      expect(programs).toContain(JUPITER_PROGRAM_ID.toBase58());
      const policy = { payer: user, venuePrograms: venueAllowlist(), selfAccounts: m.selfAccounts(user).map(String), maxTipLamports: 10_000_000n, maxPriorityFeeLamports: 10_000_000n, requireTip: true };
      expect(() => guardTransaction(built.tx, { ...policy, lookupTables: m.lookupTables() })).not.toThrow();
    }
  });
});
