import { afterEach, describe, expect, it, vi } from 'vitest';

// web3.js's browser WebSocket client does `new window.WebSocket(...)`. In the
// MV3 service worker there is no `window`, which silently killed every account
// subscription until polyfills.ts aliased it (caught in a real-browser run).
describe('service worker polyfill', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.ServiceWorkerGlobalScope;
    delete g.window;
    vi.resetModules();
  });

  it('aliases window to the worker global inside a service worker', async () => {
    delete g.window;
    g.ServiceWorkerGlobalScope = class {};
    vi.resetModules();
    await import('../src/polyfills');
    expect(g.window).toBe(globalThis);
    expect(typeof g.Buffer).toBe('function');
  });

  it('leaves window alone outside a service worker', async () => {
    delete g.window;
    vi.resetModules();
    await import('../src/polyfills');
    expect(g.window).toBeUndefined();
  });
});
