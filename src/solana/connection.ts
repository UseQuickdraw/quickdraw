// User-configured RPC + WebSocket clients. One Connection per endpoint pair.
import { Connection } from '@solana/web3.js';
import type { Endpoints } from '../messages';
import { rpcFetch } from './retryFetch';

let current: { key: string; conn: Connection } | null = null;

export function connectionFor(ep: Pick<Endpoints, 'rpcUrl' | 'wsUrl'>): Connection {
  const key = `${ep.rpcUrl}\n${ep.wsUrl}`;
  if (current?.key !== key) {
    current = {
      key,
      conn: new Connection(ep.rpcUrl, {
        commitment: 'confirmed',
        wsEndpoint: ep.wsUrl,
        // Rate limits and dropped connections are retried at once by rpcFetch (web3.js's own retry waits 500 ms+).
        disableRetryOnRateLimit: true,
        fetch: rpcFetch,
      }),
    };
  }
  return current.conn;
}

export function dropConnection(): void {
  current = null;
}
