import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { dammPoolAddress } from '../src/venues/meteoraDammV2';

describe('Meteora curve graduation', () => {
  it('derives the DAMM v2 pool a curve migrated into from its config and mints, in either order', () => {
    // TRUMPCOIN (a Bags coin): its curve migrated into this pool under the customizable migration config.
    const config = new PublicKey('A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck');
    const coin = new PublicKey('EZr3zaL9oojKAtpNUYEihk4zWoZxbcKrNUM6SjEeBAGS');
    const pool = 'ABmU8jpd7RoW945H27XzznRhsoAQEm7CiPn1VfpmFDZH';
    expect(dammPoolAddress(config, coin, NATIVE_MINT).toBase58()).toBe(pool);
    expect(dammPoolAddress(config, NATIVE_MINT, coin).toBase58()).toBe(pool);
  });
});
