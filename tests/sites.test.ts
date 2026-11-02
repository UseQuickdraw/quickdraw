// Address extraction per supported site, from their token-page URL shapes.
import { describe, expect, it } from 'vitest';
import { adapterFor } from '../src/sites/registry';
import { SITE_MATCHES } from '../src/sites/matches';

const MINT = 'GF74fBfcaeLjUiUwKpRiUbvMQtTvNyzMoo6KNyyqNyk6';
const doc = { querySelectorAll: () => [], querySelector: () => null } as unknown as Document;

function read(href: string) {
  const url = new URL(href);
  const a = adapterFor(url);
  return { id: a.id, address: a.extractAddress(doc, url), trading: a.isTradingPage?.(url) ?? true };
}

describe('site adapters', () => {
  it('gmgn.ai token pages, with or without a referral prefix', () => {
    expect(read(`https://gmgn.ai/sol/token/${MINT}`)).toEqual({ id: 'gmgn', address: MINT, trading: true });
    expect(read(`https://gmgn.ai/sol/token/abcd1234_${MINT}`).address).toBe(MINT);
    expect(read(`https://gmgn.ai/sol/token/${MINT}?tab=activity`).address).toBe(MINT);
    expect(read('https://gmgn.ai/trend?chain=sol')).toEqual({ id: 'gmgn', address: null, trading: false });
  });

  it('trade.padre.gg token pages', () => {
    expect(read(`https://trade.padre.gg/trade/solana/${MINT}`)).toEqual({ id: 'padre', address: MINT, trading: true });
    expect(read('https://trade.padre.gg/trenches')).toEqual({ id: 'padre', address: null, trading: false });
  });

  it('axiom still works, and the manifest covers every site', () => {
    expect(read(`https://axiom.trade/meme/${MINT}`)).toEqual({ id: 'axiom', address: MINT, trading: true });
    expect(SITE_MATCHES).toEqual(['https://axiom.trade/*', 'https://gmgn.ai/*', 'https://trade.padre.gg/*']);
  });
});
