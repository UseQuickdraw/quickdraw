import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

import { SITE_MATCHES } from './src/sites/matches';

// Supported trading sites are the only *required* host permissions. Every
// RPC / WebSocket / Sender origin is user-supplied and granted at runtime
// from the options page (see src/solana/permissions.ts).

export default defineConfig({
  srcDir: '.',
  entrypointsDir: 'entrypoints',
  outDir: '.output',
  imports: false,
  manifest: {
    name: 'Quickdraw',
    description:
      'Self-custody one-click trading panel for Solana memecoins. Client-side, no platform fee, bring your own RPC.',
    // storage.session (102) and WebSockets keeping the service worker alive (116).
    minimum_chrome_version: '116',
    permissions: ['storage'],
    host_permissions: SITE_MATCHES,
    optional_host_permissions: ['https://*/*', 'wss://*/*'],
    // MV3 default CSP, restated so a careless edit can't loosen it.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
  vite: () => ({
    plugins: [preact()],
    define: { 'process.env.NODE_DEBUG': 'false' },
    resolve: { alias: { buffer: 'buffer/' } },
  }),
});
