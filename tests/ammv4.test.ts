// Raydium AMM v4 from a recorded mainnet snapshot (tests/fixtures/ammv4.json,
// FRIC/SOL: the coin on the pool's "pc" side). tests/live-ammv4.test.ts checks
// the same maths against the program's own swaps.
import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { loadFixture, replay } from './helpers/fixtures';
import { resolveAddress } from '../src/solana/resolver';
import { openMarket, venueAllowlist } from '../src/venues/registry';
import { AMM_V4_PROGRAM_ID, type AmmMarket } from '../src/venues/raydiumAmm';
import { buildTrade } from '../src/solana/execute';
import { guardTransaction } from '../src/solana/guard';
import { planTrade } from '../src/solana/trade';
import { tokenAmount } from '../src/solana/tokens';
import { defaultSettings } from '../src/settings/defaults';
import { activeProfile } from '../src/settings/profiles';

const fx = loadFixture('tests/fixtures/ammv4.json');
const FRIC = 'EsP4kJfKUDLfX274WoBSiiEy74Sh4tZKUCDjfULHpump';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

async function open(): Promise<AmmMarket> {
  const conn = replay(fx);
  const r = await resolveAddress(conn, new PublicKey(fx.address));
  return (await openMarket(conn, r.mint, r.hint)) as AmmMarket;
}

function tokenAccount(amount: bigint, mint: PublicKey, owner: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

describe('Raydium AMM v4 (FRIC/SOL)', () => {
  it('resolves the pool address to the coin, not SOL, and opens it there', async () => {
    const m = await open();
    expect(m.mint.mint.toBase58()).toBe(FRIC);
    expect(m.venue).toBe('RAYDIUM_AMM');
    expect(m.state.coinMint.equals(NATIVE_MINT)).toBe(true); // the coin is the "pc" side here
    expect(m.tradable()).toBe(true);
    expect(m.spotLamportsPerToken()).toBeGreaterThan(0);
  });

  it('quotes swap_base_in: 0.25% off the input, rounded up, then constant product', async () => {
    const m = await open();
    const conn = replay(fx);
    const [coin, pc] = await conn.getMultipleAccountsInfo([m.state.coinVault, m.state.pcVault]);
    const sol = BigInt(tokenAmount(coin).sub(m.state.needTakePnlCoin).toString());
    const fric = BigInt(tokenAmount(pc).sub(m.state.needTakePnlPc).toString());
    const swap = (amount: bigint, rin: bigint, rout: bigint) => {
      const net = amount - (amount * 25n + 9_999n) / 10_000n;
      return (net * rout) / (rin + net);
    };
    expect(BigInt(m.quoteBuy(new BN(10_000_000), 15).out.toString())).toBe(swap(10_000_000n, sol, fric));
    expect(BigInt(m.quoteSell(new BN(1_000_000_000), 15).out.toString())).toBe(swap(1_000_000_000n, fric, sol));
  });

  it('builds swap_base_in_v2 buys and sells the guard accepts', async () => {
    const m = await open();
    const settings = defaultSettings();
    const profile = activeProfile(settings);
    const user = Keypair.generate().publicKey;
    const held = tokenAccount(5_000_000_000n, m.mint.mint, user);
    for (const [side, amount, ata] of [['buy', 0.1, null], ['sell', 50, held]] as const) {
      const plan = planTrade(m, { side, amount, presetIndex: null }, settings, profile, tokenAmount(ata));
      const built = await buildTrade({
        market: m, plan, user, userAta: Keypair.generate().publicKey, userAtaInfo: ata, tier: 'fast', tipSol: null,
        profile, settings, blockhash: BLOCKHASH, cuLimit: () => 46_000, cuPrice: 1_000, closeAfterFullSell: false,
      });
      const msg = built.tx.message;
      const swap = msg.compiledInstructions.find((ix) => msg.staticAccountKeys[ix.programIdIndex]!.equals(AMM_V4_PROGRAM_ID))!;
      expect(swap.data[0]).toBe(16); // swap_base_in_v2: no OpenBook accounts
      expect(swap.accountKeyIndexes).toHaveLength(8);
      const policy = { payer: user, venuePrograms: venueAllowlist(), selfAccounts: m.selfAccounts(user).map(String), maxTipLamports: 10_000_000n, maxPriorityFeeLamports: 10_000_000n, requireTip: true };
      expect(() => guardTransaction(built.tx, policy)).not.toThrow();
    }
  });
});
