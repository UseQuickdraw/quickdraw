export interface SiteAdapter {
  id: string;
  matches(url: URL): boolean;
  /** Any on-page address (mint, pair, curve or pool); the worker resolves it to a mint. */
  extractAddress(doc: Document, url: URL): string | null;
  /** Calls back whenever the page navigates (SPA-aware). Returns an unsubscribe fn. */
  onNavigate(cb: (url: URL) => void): () => void;
  /** Optional element to anchor the panel to; default is a floating overlay on <body>. */
  mountPoint?(): Element | null;
  /** Optional element in the site's toolbar to put the panel's toggle button after. */
  toolbarAnchor?(doc: Document): Element | null;
  /** Whether this URL is a single token's trading page. The panel is hidden elsewhere. Omitted = always. */
  isTradingPage?(url: URL): boolean;
}

export const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_IN_TEXT = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

export function firstAddressInPath(url: URL): string | null {
  for (const seg of url.pathname.split('/')) {
    if (BASE58_ADDRESS.test(seg)) return seg;
  }
  return null;
}

export function addressInText(text: string | null | undefined): string | null {
  return text?.match(BASE58_IN_TEXT)?.[0] ?? null;
}

/**
 * SPA navigation watcher. The Navigation API reports the page's own
 * pushState/replaceState the moment the URL changes (history events don't,
 * and content scripts can't patch the page's history); popstate covers
 * back/forward, and a cheap href poll is the backstop where neither fires.
 */
export function watchUrl(cb: (url: URL) => void, intervalMs = 100): () => void {
  let last = location.href;
  const check = () => {
    if (location.href !== last) {
      last = location.href;
      cb(new URL(last));
    }
  };
  const nav = (window as { navigation?: EventTarget }).navigation;
  const timer = setInterval(check, intervalMs);
  window.addEventListener('popstate', check);
  nav?.addEventListener('currententrychange', check);
  return () => {
    clearInterval(timer);
    window.removeEventListener('popstate', check);
    nav?.removeEventListener('currententrychange', check);
  };
}
