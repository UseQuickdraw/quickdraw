// web3.js / anchor expect Node's Buffer. Import this first in any entrypoint
// that loads Solana code.
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: typeof Buffer; window?: unknown };
g.Buffer ??= Buffer;

// web3.js's WebSocket client (rpc-websockets, browser build) calls
// `new window.WebSocket(...)`, and an MV3 service worker has no `window`.
// Alias it to the worker global there only. The other `typeof window` checks
// in the worker bundle (bn.js Buffer lookup, a globalThis fallback) behave
// correctly with this alias.
if (typeof g.window === 'undefined' && 'ServiceWorkerGlobalScope' in globalThis) {
  g.window = globalThis;
}
