// The panel's background image: uploaded on the Display tab, shrunk in the
// browser, and kept in local extension storage under its own key (never sent
// anywhere, and not part of the settings object, so a large image isn't
// re-sent to every tab with each settings update).
import { browser } from 'wxt/browser';

const KEY = 'panelBackgroundImage';
/** Longest side the stored image keeps: plenty for a panel a few hundred pixels across. */
const MAX_SIDE = 1000;

export async function loadPanelImage(): Promise<string | null> {
  const v = (await browser.storage.local.get(KEY))[KEY];
  return typeof v === 'string' && v.startsWith('data:image/') ? v : null;
}

export async function savePanelImage(dataUrl: string | null): Promise<void> {
  if (dataUrl === null) await browser.storage.local.remove(KEY);
  else await browser.storage.local.set({ [KEY]: dataUrl });
}

/** Calls `cb` with the image now and whenever it changes; returns the unsubscribe. */
export function watchPanelImage(cb: (dataUrl: string | null) => void): () => void {
  void loadPanelImage().then(cb).catch(() => cb(null));
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local' || !(KEY in changes)) return;
    const v = changes[KEY]!.newValue;
    cb(typeof v === 'string' && v.startsWith('data:image/') ? v : null);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Decodes an uploaded image and re-encodes it at most MAX_SIDE across, as WebP (GIFs keep their first frame). */
export async function shrinkImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That image couldn't be read");
  });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.85);
}
