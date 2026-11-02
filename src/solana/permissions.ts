// Runtime host permissions for user-supplied endpoints. Requests must come from
// a user gesture in an extension page (options/popup), never from the worker.
import { browser } from 'wxt/browser';
import { SENDER } from '../constants';
import type { Endpoints } from '../messages';

/** `https://host/*` style origin patterns for exactly the endpoints the user entered. */
export function originsFor(endpoints: Endpoints, sendMode: 'sender' | 'rpc' | 'custom'): string[] {
  const urls = [endpoints.rpcUrl, endpoints.wsUrl];
  if (sendMode === 'sender') urls.push(SENDER.globalUrl);
  if (sendMode === 'custom' && endpoints.customSendUrl) urls.push(endpoints.customSendUrl);
  const origins = new Set<string>();
  for (const raw of urls) {
    const u = new URL(raw);
    origins.add(`${u.protocol}//${u.hostname}/*`);
  }
  return [...origins];
}

export async function hasOrigins(origins: string[]): Promise<boolean> {
  return browser.permissions.contains({ origins });
}

export async function requestOrigins(origins: string[]): Promise<boolean> {
  return browser.permissions.request({ origins });
}
