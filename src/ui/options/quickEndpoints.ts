// One paste -> RPC + WebSocket (+ Sender key). Providers serve WebSockets at
// the same address as HTTPS, so wss:// is derived from https://.
import type { Endpoints } from '../../messages';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type QuickResult = { ok: true; endpoints: Partial<Endpoints>; summary: string } | { ok: false; error: string };

export function parseQuickEndpoint(input: string): QuickResult | null {
  const text = input.trim();
  if (!text) return null;

  // A bare Helius API key.
  if (UUID.test(text)) {
    return {
      ok: true,
      endpoints: {
        rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${text}`,
        wsUrl: `wss://mainnet.helius-rpc.com/?api-key=${text}`,
        senderApiKey: text,
      },
      summary: 'Helius key: filled RPC, WebSocket and Sender key.',
    };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'Paste a Helius API key or a full https:// RPC URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') {
    return { ok: false, error: 'The URL must start with https:// (or wss://).' };
  }

  const https = new URL(url.href);
  https.protocol = 'https:';
  const wss = new URL(url.href);
  wss.protocol = 'wss:';
  const heliusKey = /(^|\.)helius-rpc\.com$/.test(url.hostname) ? url.searchParams.get('api-key') : null;

  return {
    ok: true,
    endpoints: { rpcUrl: https.href, wsUrl: wss.href, ...(heliusKey ? { senderApiKey: heliusKey } : {}) },
    summary: heliusKey ? 'Helius URL: filled RPC, WebSocket and Sender key.' : 'Filled RPC and WebSocket (same address, wss://).',
  };
}
