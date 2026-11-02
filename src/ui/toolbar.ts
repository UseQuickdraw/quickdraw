// A toggle button injected into the host site's own toolbar (e.g. next to
// Axiom's "Instant Trade" buttons). It lives in its own closed shadow root so
// the site's CSS can't restyle it, and re-inserts itself when the SPA
// re-renders the toolbar.

export interface ToolbarBridge {
  /** Whether the button is currently on the page (the panel hides its floating pill then). */
  subscribePresence(cb: (present: boolean) => void): () => void;
  /** Fires when the button is clicked. */
  onToggle(cb: () => void): () => void;
  /** The panel reports open/closed so the button can show it. */
  setOpen(open: boolean): void;
  /** Off: remove the button and stop re-inserting it (e.g. away from chart pages). */
  setEnabled(enabled: boolean): void;
  destroy(): void;
}

const RETRY_MS = 600;
/** How often a placed toggle checks it is still next to the right control. */
const RECHECK_MS = 2_000;

/** Quickdraw's brand green: the button keeps its own look, whatever accent the panel uses. */
const GREEN = '#44a257';

const CSS = `
:host { all: initial; display: inline-flex; align-self: center; margin-left: 8px; }
button {
  all: unset; box-sizing: border-box; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 12px; border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.06); color: #fff;
  font: 600 13px/1 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  white-space: nowrap; transition: background .12s, border-color .12s;
}
button:hover { background: rgba(255, 255, 255, 0.1); }
button[aria-pressed="true"] { border-color: ${GREEN}; background: color-mix(in srgb, ${GREEN} 22%, transparent); }
svg { width: 14px; height: 14px; fill: ${GREEN}; }
`;

export function mountToolbarButton(findAnchor: () => Element | null): ToolbarBridge {
  const host = document.createElement('instant-trench-toggle');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${CSS}</style><button type="button" aria-pressed="false" title="Open the Quickdraw panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>Quickdraw</button>`;
  const button = root.querySelector('button')!;

  const presence = new Set<(p: boolean) => void>();
  const toggles = new Set<() => void>();
  let present = false;
  const setPresent = (p: boolean) => {
    if (p === present) return;
    present = p;
    presence.forEach((cb) => cb(p));
  };

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggles.forEach((cb) => cb());
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let enabled = true;
  let anchored: Element | null = null;
  const ensure = () => {
    timer = null;
    if (!enabled) return setPresent(false);
    if (host.isConnected) return setPresent(true);
    const anchor = findAnchor();
    anchored = anchor;
    if (anchor) anchor.after(host);
    setPresent(host.isConnected);
  };
  // Sites re-render and move things: every so often, check the toggle still sits after the right
  // control, and follow it (or step aside for the panel's own pill when there is none).
  const recheck = setInterval(() => {
    if (!enabled || !host.isConnected) return;
    const anchor = findAnchor();
    if (anchor === anchored && host.previousElementSibling === anchor) return;
    host.remove();
    ensure();
  }, RECHECK_MS);
  // Cheap when mounted (one isConnected check); searches only while missing, throttled.
  const observer = new MutationObserver(() => {
    if (!enabled || host.isConnected) return;
    setPresent(false);
    timer ??= setTimeout(ensure, RETRY_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  ensure();

  return {
    subscribePresence(cb) {
      presence.add(cb);
      cb(present);
      return () => presence.delete(cb);
    },
    onToggle(cb) {
      toggles.add(cb);
      return () => toggles.delete(cb);
    },
    setOpen(open) {
      button.setAttribute('aria-pressed', String(open));
      button.title = open ? 'Hide the Quickdraw panel' : 'Open the Quickdraw panel';
    },
    setEnabled(v) {
      if (v === enabled) return;
      enabled = v;
      if (!v) host.remove();
      ensure();
    },
    destroy() {
      observer.disconnect();
      clearInterval(recheck);
      if (timer) clearTimeout(timer);
      host.remove();
    },
  };
}
