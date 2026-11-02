// gmgn.ai integration. Unofficial and will break when GMGN changes its URLs;
// keep every GMGN-specific assumption in this one file.
//
// Solana token pages look like /sol/token/<mint>, sometimes with a referral
// prefix joined by an underscore (/sol/token/<ref>_<mint>). Whatever address
// we find goes to the worker's resolver, which also accepts pools and curves.
import { BASE58_ADDRESS, watchUrl, type SiteAdapter } from './types';

const TRADING_PATH = /^\/sol\/token\//;

/** The address in a /sol/token/ path segment, without any referral prefix. */
function tokenFromPath(url: URL): string | null {
  const seg = url.pathname.split('/')[3];
  if (!seg) return null;
  const last = seg.split('_').pop()!;
  return BASE58_ADDRESS.test(last) ? last : null;
}

export const gmgn: SiteAdapter = {
  id: 'gmgn',
  matches: (url) => url.hostname === 'gmgn.ai' || url.hostname.endsWith('.gmgn.ai'),
  extractAddress: (_doc, url) => (TRADING_PATH.test(url.pathname) ? tokenFromPath(url) : null),
  onNavigate: (cb) => watchUrl(cb),
  isTradingPage: (url) => TRADING_PATH.test(url.pathname),
};
