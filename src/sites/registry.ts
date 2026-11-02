import type { SiteAdapter } from './types';
import { axiom } from './axiom';
import { gmgn } from './gmgn';
import { padre } from './padre';
import { generic } from './generic';

/** Resolved in order; `generic` must stay last. */
export const SITE_ADAPTERS: SiteAdapter[] = [axiom, gmgn, padre, generic];

export function adapterFor(url: URL): SiteAdapter {
  return SITE_ADAPTERS.find((a) => a.matches(url)) ?? generic;
}
