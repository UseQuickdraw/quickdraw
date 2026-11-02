// Manual-mint mode for any page the user grants. No page scraping at all.
import { watchUrl, type SiteAdapter } from './types';

export const generic: SiteAdapter = {
  id: 'generic',
  matches: () => true,
  extractAddress: () => null,
  onNavigate: (cb) => watchUrl(cb),
};
