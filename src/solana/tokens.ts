import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { AccountLayout, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';

export interface MintInfo {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  supply: BN;
}

export function isTokenProgram(owner: PublicKey): boolean {
  return owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID);
}

// Token-2022 stores an AccountType byte right after the 165-byte base account
// layout when extensions are present: 1 = Mint, 2 = Account.
const ACCOUNT_TYPE_OFFSET = 165;

export type TokenAccountKind = 'mint' | 'account' | null;

export function tokenAccountKind(info: AccountInfo<Buffer>): TokenAccountKind {
  if (!isTokenProgram(info.owner)) return null;
  const len = info.data.length;
  if (len === MintLayout.span) return 'mint';
  if (len === AccountLayout.span) return 'account';
  if (len > ACCOUNT_TYPE_OFFSET && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const t = info.data[ACCOUNT_TYPE_OFFSET];
    return t === 1 ? 'mint' : t === 2 ? 'account' : null;
  }
  return null;
}

export function decodeMint(mint: PublicKey, info: AccountInfo<Buffer>): MintInfo {
  if (tokenAccountKind(info) !== 'mint') throw new Error('Not a token mint');
  const m = MintLayout.decode(info.data.subarray(0, MintLayout.span));
  if (!m.isInitialized) throw new Error('Mint is not initialized');
  return { mint, tokenProgram: info.owner, decimals: m.decimals, supply: new BN(m.supply.toString()) };
}

/** Raw amount of an SPL / Token-2022 token account; 0 when it doesn't exist. */
export function tokenAmount(info: AccountInfo<Buffer> | null | undefined): BN {
  if (!info || info.data.length < AccountLayout.span) return new BN(0);
  return new BN(AccountLayout.decode(info.data.subarray(0, AccountLayout.span)).amount.toString());
}

/** The mint a token account belongs to (first 32 bytes of the layout). */
export function tokenAccountMint(info: AccountInfo<Buffer>): PublicKey {
  return new PublicKey(info.data.subarray(0, 32));
}
