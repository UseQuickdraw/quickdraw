// Isolated-world content script. Detects the token via the site adapter and
// mounts the panel in a Shadow DOM. It never sees key material: it can only
// ask the worker to trade with parameters, and the worker validates them.
import { render } from 'preact';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import '../src/ui/panel.css';
import { Panel } from '../src/ui/Panel';
import { mountToolbarButton } from '../src/ui/toolbar';
import { preloadPanelImage } from '../src/ui/panelImage';
import { adapterFor } from '../src/sites/registry';
import { SITE_MATCHES } from '../src/sites/matches';
import { PANEL_PORT, type PanelEvent } from '../src/messages';

export default defineContentScript({
  matches: SITE_MATCHES,
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    // Read and decode the background image now, while the page is still settling, so the panel shows it at once.
    void preloadPanelImage();
    const adapter = adapterFor(new URL(location.href));
    const site = location.hostname;

    let address: string | null = null;
    const addrListeners = new Set<(a: string | null) => void>();
    // Off a token's chart page the panel, pill and toolbar button all hide.
    const isTrading = () => adapter.isTradingPage?.(new URL(location.href)) ?? true;
    let trading = isTrading();
    const pageListeners = new Set<(t: boolean) => void>();
    const refresh = () => {
      const url = new URL(location.href);
      const next = adapter.extractAddress(document, url);
      if (next !== address) {
        address = next;
        for (const cb of addrListeners) cb(address);
      }
      const t = isTrading();
      if (t !== trading) {
        trading = t;
        toolbar?.setEnabled(t);
        for (const cb of pageListeners) cb(t);
      }
    };
    const stopNav = adapter.onNavigate(() => {
      refresh();
      // SPA pages often render the token header after the URL changes.
      setTimeout(refresh, 800);
    });
    ctx.onInvalidated(stopNav);

    const evListeners = new Set<(ev: PanelEvent) => void>();
    // Replayed to late subscribers: the first STATE usually arrives before the panel mounts.
    let lastState: PanelEvent | null = null;
    let port: ReturnType<typeof browser.runtime.connect> | null = null;
    const connect = () => {
      port = browser.runtime.connect({ name: PANEL_PORT });
      port.onMessage.addListener((ev: PanelEvent) => {
        if (ev.type === 'STATE') lastState = ev;
        evListeners.forEach((cb) => cb(ev));
      });
      // The worker may be stopped by the browser; reconnect so state keeps flowing.
      port.onDisconnect.addListener(() => {
        port = null;
        if (!ctx.isInvalid) setTimeout(connect, 1000);
      });
    };
    connect();
    ctx.onInvalidated(() => port?.disconnect());

    // A toggle next to the site's own trade buttons, when the adapter knows where they are.
    const toolbar = adapter.toolbarAnchor ? mountToolbarButton(() => adapter.toolbarAnchor!(document)) : undefined;
    if (toolbar) {
      toolbar.setEnabled(trading);
      ctx.onInvalidated(() => toolbar.destroy());
    }

    const ui = await createShadowRootUi(ctx, {
      name: 'instant-trench',
      position: 'inline',
      anchor: 'body',
      mode: 'closed',
      isolateEvents: ['keydown', 'keyup', 'keypress', 'paste', 'input'],
      onMount(container) {
        render(
          <Panel
            site={site}
            toolbar={toolbar}
            subscribeAddress={(cb) => {
              addrListeners.add(cb);
              cb(address);
              return () => addrListeners.delete(cb);
            }}
            subscribeTradingPage={(cb) => {
              pageListeners.add(cb);
              cb(trading);
              return () => pageListeners.delete(cb);
            }}
            subscribeEvents={(cb) => {
              evListeners.add(cb);
              if (lastState) cb(lastState);
              return () => evListeners.delete(cb);
            }}
          />,
          container,
        );
        return container;
      },
      onRemove(container) {
        if (container) render(null, container);
      },
    });
    ui.mount();
    refresh();
  },
});
