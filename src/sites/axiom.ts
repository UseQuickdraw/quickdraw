// axiom.trade integration. Unofficial and will break when Axiom changes its
// URLs or DOM; keep every Axiom-specific assumption in this one file.
//
// Axiom token pages look like /meme/<address>. That address may be a pair /
// pool / bonding-curve account rather than the mint, so we hand whatever we
// find to the worker's resolver instead of assuming.
import { addressInText, firstAddressInPath, watchUrl, type SiteAdapter } from './types';

const LINK_PATTERNS = [
  /solscan\.io\/(?:token|account)\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
  /pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/,
  /dexscreener\.com\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
];

function fromLinks(doc: Document): string | null {
  for (const a of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    for (const re of LINK_PATTERNS) {
      const m = a.href.match(re);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

const INSTANT_TRADE_XPATH = "//*[normalize-space(text())='Instant Trade']";

/**
 * The outermost element that is just this control: climb from the element
 * holding the text while the parent adds no other text (icons, wrappers), so
 * we land on Axiom's button whether it's a <button>, a <div> or nested spans.
 */
function controlAround(el: Element): Element {
  const label = el.textContent?.trim() ?? '';
  let cur = el;
  while (cur.parentElement && cur.parentElement !== cur.ownerDocument.body && (cur.parentElement.textContent?.trim() ?? '') === label) {
    cur = cur.parentElement;
  }
  return cur.closest('button, [role="button"], a') ?? cur;
}

/**
 * Really showing: rendered (not hidden by CSS, opacity or display) and inside
 * the viewport. getClientRects alone also counts hidden menus and off-screen
 * copies, which once put the toggle under Axiom's footer.
 */
function onScreen(el: Element): boolean {
  // Tooltips and pop-overs repeat a control's label at the end of the page: never anchor to those.
  if (el.closest('[role="tooltip"], [role="dialog"], [data-radix-popper-content-wrapper], [data-tippy-root]')) return false;
  const visible = typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0;
  if (!visible) return false;
  const r = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView;
  return r.width > 0 && r.height > 0 && (!view || (r.top >= 0 && r.bottom <= view.innerHeight && r.left >= 0 && r.right <= view.innerWidth));
}

/**
 * The last visible "Instant Trade" control in Axiom's token toolbar (Axiom's
 * own, or one another extension added). Our toggle goes right after it.
 * XPath matches the text wherever it is, without walking the whole DOM in JS.
 */
function instantTradeButton(doc: Document): Element | null {
  const found = doc.evaluate(INSTANT_TRADE_XPATH, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  for (let i = found.snapshotLength - 1; i >= 0; i--) {
    const el = found.snapshotItem(i) as Element;
    if (el.closest('instant-trench-toggle, instant-trench')) continue;
    const control = controlAround(el);
    if (onScreen(control)) return control;
  }
  return null;
}

/** Axiom's single-token chart pages. */
const TRADING_PATH = /^\/(meme|t|token)\//;

export const axiom: SiteAdapter = {
  id: 'axiom',
  matches: (url) => url.hostname === 'axiom.trade' || url.hostname.endsWith('.axiom.trade'),
  extractAddress(doc, url) {
    if (!TRADING_PATH.test(url.pathname)) return null;
    return (
      firstAddressInPath(url) ??
      url.searchParams.get('address') ??
      fromLinks(doc) ??
      addressInText(doc.querySelector('[data-address]')?.getAttribute('data-address'))
    );
  },
  onNavigate: (cb) => watchUrl(cb),
  toolbarAnchor: instantTradeButton,
  isTradingPage: (url) => TRADING_PATH.test(url.pathname),
};
