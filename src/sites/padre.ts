// trade.padre.gg integration. Unofficial and will break when Padre changes its
// URLs; keep every Padre-specific assumption in this one file.
//
// Solana token pages look like /trade/solana/<address>. The address may be a
// pair, pool or bonding curve rather than the mint, so we hand it to the
// worker's resolver instead of assuming.
import { firstAddressInPath, watchUrl, type SiteAdapter } from './types';

const TRADING_PATH = /^\/trade\/solana\//;

export const padre: SiteAdapter = {
  id: 'padre',
  matches: (url) => url.hostname === 'trade.padre.gg',
  extractAddress: (_doc, url) => (TRADING_PATH.test(url.pathname) ? firstAddressInPath(url) : null),
  onNavigate: (cb) => watchUrl(cb),
  isTradingPage: (url) => TRADING_PATH.test(url.pathname),
};
