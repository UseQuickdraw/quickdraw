// Content-script side of the messaging contract. No key material ever comes
// back over these calls; the worker only returns state and results.
import { browser } from 'wxt/browser';
import type { ContentRequest, Result } from '../messages';

export async function send<T>(req: ContentRequest): Promise<Result<T>> {
  try {
    return (await browser.runtime.sendMessage(req)) as Result<T>;
  } catch {
    // Extension reloaded/updated while the page stayed open.
    return { ok: false, error: 'Extension was reloaded. Refresh the page.', code: 'DISCONNECTED' };
  }
}
