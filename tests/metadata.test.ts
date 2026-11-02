import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { loadFixture } from './helpers/fixtures';
import { parseMetaplexMetadata, parseToken2022Metadata } from '../src/solana/metadata';
import { solUsdFromWhirlpool } from '../src/solana/price';
import { WSOL_MINT } from '../src/constants';

describe('token metadata', () => {
  it('reads name and symbol from real Token-2022 pump mints', () => {
    let found = 0;
    for (const name of ['curve', 'curve-cashback', 'pumpswap']) {
      const fx = loadFixture(`tests/fixtures/${name}.json`);
      for (const raw of Object.values(fx.accounts)) {
        if (!raw || raw.owner !== TOKEN_2022_PROGRAM_ID.toBase58()) continue;
        const data = Buffer.from(raw.data, 'base64');
        if (data.length <= 165 || data[165] !== 1) continue; // mints only
        const m = parseToken2022Metadata(data);
        expect(m, name).not.toBeNull();
        expect(m!.symbol.length).toBeGreaterThan(0);
        expect(m!.symbol.length).toBeLessThan(40);
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('reads Metaplex metadata', () => {
    const str = (s: string, pad: number) => {
      const b = Buffer.alloc(4 + pad);
      b.writeUInt32LE(pad, 0);
      b.write(s, 4);
      return b;
    };
    const data = Buffer.concat([Buffer.from([4]), Keypair.generate().publicKey.toBuffer(), Keypair.generate().publicKey.toBuffer(), str('Moustache Cat', 32), str('MOUST', 10), str('https://x', 200)]);
    expect(parseMetaplexMetadata(data)).toEqual({ name: 'Moustache Cat', symbol: 'MOUST' });
  });
});

describe('SOL/USD from the whirlpool', () => {
  const pool = (sqrtPrice: bigint, mintA: string, mintB: string) => {
    const d = Buffer.alloc(653);
    d.writeBigUInt64LE(sqrtPrice & ((1n << 64n) - 1n), 65);
    d.writeBigUInt64LE(sqrtPrice >> 64n, 73);
    new PublicKey(mintA).toBuffer().copy(d, 101);
    new PublicKey(mintB).toBuffer().copy(d, 181);
    return d;
  };
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('converts sqrt price to dollars', () => {
    // $100 => p = 0.1 (per raw unit, 10^-3 scaling) => sqrt(0.1) * 2^64
    const sqrt = BigInt(Math.round(Math.sqrt(0.1) * 2 ** 32)) << 32n;
    expect(solUsdFromWhirlpool(pool(sqrt, WSOL_MINT, USDC))).toBeCloseTo(100, 3);
  });

  it('refuses a pool that is not WSOL/USDC', () => {
    expect(solUsdFromWhirlpool(pool(1n << 64n, USDC, WSOL_MINT))).toBeNull();
  });
});
