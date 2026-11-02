// Messaging for extension pages (options / popup). These may send privileged
// PageRequests; the worker checks the sender origin before honouring them.
import { browser } from 'wxt/browser';
import type { ContentRequest, PageRequest, Result } from '../messages';

export async function call<T>(req: PageRequest | ContentRequest): Promise<T> {
  const r = (await browser.runtime.sendMessage(req)) as Result<T>;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export function download(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
