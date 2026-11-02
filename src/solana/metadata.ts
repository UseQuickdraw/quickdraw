// Token name/symbol, read straight from chain (no metadata API):
//   Token-2022 mints (newer pump coins) carry a TokenMetadata extension in the
//   mint account; SPL mints use a Metaplex metadata account.
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import type { MintInfo } from './tokens';

export interface TokenMeta {
  name: string;
  symbol: string;
}

const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TOKEN_METADATA_EXTENSION = 19; // spl-token ExtensionType.TokenMetadata
const MINT_TLV_START = 166; // 165-byte base layout + AccountType byte

function readString(data: Buffer, off: number): [string, number] {
  const len = data.readUInt32LE(off);
  if (len > 200 || off + 4 + len > data.length) throw new Error('bad string');
  return [data.subarray(off + 4, off + 4 + len).toString('utf8').replace(/\0+$/, '').trim(), off + 4 + len];
}

/** TokenMetadata extension in a Token-2022 mint: updateAuthority(32) mint(32) name symbol uri ... */
export function parseToken2022Metadata(data: Buffer): TokenMeta | null {
  let off = MINT_TLV_START;
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    if (type === TOKEN_METADATA_EXTENSION) {
      const [name, next] = readString(data, off + 4 + 64);
      const [symbol] = readString(data, next);
      return { name, symbol };
    }
    if (type === 0 && len === 0) break; // uninitialized padding
    off += 4 + len;
  }
  return null;
}

/** Metaplex metadata: key(1) updateAuthority(32) mint(32) name symbol ... */
export function parseMetaplexMetadata(data: Buffer): TokenMeta | null {
  if (data.length < 69) return null;
  const [name, next] = readString(data, 65);
  const [symbol] = readString(data, next);
  return { name, symbol };
}

export function metaplexPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()], METAPLEX_PROGRAM_ID)[0];
}

/** Best effort: null when the token has no readable metadata (RPC errors are retried). */
export async function fetchTokenMeta(conn: Connection, mint: MintInfo, attempts = 3): Promise<TokenMeta | null> {
  const pda = metaplexPda(mint.mint);
  for (let i = 0; i < attempts; i++) {
    let infos: (AccountInfo<Buffer> | null)[];
    try {
      infos = await conn.getMultipleAccountsInfo([mint.mint, pda], 'confirmed');
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      continue;
    }
    const [mintInfo, metaplex] = infos;
    try {
      if (mint.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) && mintInfo) {
        const m = parseToken2022Metadata(mintInfo.data);
        if (m?.symbol) return m;
      }
      return metaplex ? parseMetaplexMetadata(metaplex.data) : null;
    } catch {
      return null;
    }
  }
  return null;
}
