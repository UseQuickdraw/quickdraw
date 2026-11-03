import '../src/polyfills';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { ExtensionType, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { decodeMint, mintRisks } from '../src/solana/tokens';

const mint = Keypair.generate().publicKey;
const someone = Keypair.generate().publicKey;

/** A mint account: the base layout, then (Token-2022) the account type and TLV extensions. */
function mintAccount(opts: { freeze?: PublicKey; program?: PublicKey; extensions?: [ExtensionType, Buffer][] }): AccountInfo<Buffer> {
  const base = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: opts.freeze ? 1 : 0,
      freezeAuthority: opts.freeze ?? PublicKey.default,
    },
    base,
  );
  let data = base;
  if (opts.extensions) {
    const tlv = opts.extensions.map(([type, value]) => {
      const head = Buffer.alloc(4);
      head.writeUInt16LE(type, 0);
      head.writeUInt16LE(value.length, 2);
      return Buffer.concat([head, value]);
    });
    // Token-2022 pads the mint to the token account size, then the account type (1 = mint).
    data = Buffer.concat([base, Buffer.alloc(165 - MintLayout.span), Buffer.from([1]), ...tlv]);
  }
  return { data, owner: opts.program ?? TOKEN_PROGRAM_ID, lamports: 1, executable: false };
}

describe('mintRisks', () => {
  it('finds nothing on a plain coin', () => {
    expect(mintRisks(mint, mintAccount({}))).toEqual([]);
    expect(mintRisks(mint, mintAccount({ program: TOKEN_2022_PROGRAM_ID, extensions: [] }))).toEqual([]);
  });

  it('flags a freeze authority, on either token program', () => {
    expect(mintRisks(mint, mintAccount({ freeze: someone }))).toEqual(['freeze']);
    expect(mintRisks(mint, mintAccount({ freeze: someone, program: TOKEN_2022_PROGRAM_ID, extensions: [] }))).toEqual(['freeze']);
  });

  it('flags a permanent delegate and a transfer hook', () => {
    const acct = mintAccount({
      program: TOKEN_2022_PROGRAM_ID,
      extensions: [
        [ExtensionType.PermanentDelegate, someone.toBuffer()],
        [ExtensionType.TransferHook, Buffer.concat([someone.toBuffer(), Keypair.generate().publicKey.toBuffer()])],
      ],
    });
    expect(mintRisks(mint, acct)).toEqual(['delegate', 'hook']);
    expect(decodeMint(mint, acct).risks).toEqual(['delegate', 'hook']);
  });

  it('ignores the extensions when they are switched off', () => {
    const acct = mintAccount({
      program: TOKEN_2022_PROGRAM_ID,
      extensions: [
        [ExtensionType.PermanentDelegate, PublicKey.default.toBuffer()],
        [ExtensionType.TransferHook, Buffer.concat([someone.toBuffer(), PublicKey.default.toBuffer()])],
      ],
    });
    expect(mintRisks(mint, acct)).toEqual([]);
  });
});
