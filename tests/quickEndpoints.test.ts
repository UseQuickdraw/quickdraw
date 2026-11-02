import { describe, expect, it } from 'vitest';
import { parseQuickEndpoint } from '../src/ui/options/quickEndpoints';
import { EndpointsSchema } from '../src/messages';

const KEY = '1a2b3c4d-1111-2222-3333-444455556666';
const ok = (s: string) => {
  const r = parseQuickEndpoint(s);
  if (!r || !r.ok) throw new Error(`expected ok for ${s}`);
  return r.endpoints;
};

describe('quick endpoint paste', () => {
  it('a Helius API key fills all three fields', () => {
    const e = ok(` ${KEY} `);
    expect(e).toEqual({
      rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${KEY}`,
      wsUrl: `wss://mainnet.helius-rpc.com/?api-key=${KEY}`,
      senderApiKey: KEY,
    });
    expect(EndpointsSchema.safeParse({ ...e, customSendUrl: null }).success).toBe(true);
  });

  it('a Helius URL also yields the Sender key', () => {
    expect(ok(`https://mainnet.helius-rpc.com/?api-key=${KEY}`)).toMatchObject({ wsUrl: `wss://mainnet.helius-rpc.com/?api-key=${KEY}`, senderApiKey: KEY });
  });

  it('other providers get the same address over wss', () => {
    expect(ok('https://abc.solana-mainnet.quiknode.pro/tok123/')).toEqual({
      rpcUrl: 'https://abc.solana-mainnet.quiknode.pro/tok123/',
      wsUrl: 'wss://abc.solana-mainnet.quiknode.pro/tok123/',
    });
    expect(ok('wss://solana-rpc.publicnode.com')).toEqual({ rpcUrl: 'https://solana-rpc.publicnode.com/', wsUrl: 'wss://solana-rpc.publicnode.com/' });
  });

  it('rejects things that are neither', () => {
    expect(parseQuickEndpoint('')).toBeNull();
    expect(parseQuickEndpoint('hello')).toMatchObject({ ok: false });
    expect(parseQuickEndpoint('http://insecure.example')).toMatchObject({ ok: false });
  });
});
