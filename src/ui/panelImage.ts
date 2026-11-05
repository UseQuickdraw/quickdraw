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

// Loaded and decoded once per page, as early as the content script starts, so
// the panel draws it the moment it appears (and again on every chart after).
let loaded: string | null | undefined;
let loading: Promise<string | null> | null = null;
let decoded: { src: string; bitmap: Promise<ImageBitmap>; ready: ImageBitmap | null } | null = null;

/** Starts reading (and decoding) the image now; the panel picks it up when it mounts. */
export function preloadPanelImage(): Promise<string | null> {
  loading ??= loadPanelImage()
    .catch(() => null)
    .then((v) => {
      loaded = v;
      if (v) void decodePanelImage(v).catch(() => {});
      return v;
    });
  return loading;
}

/** The image if it's already been read: undefined while it hasn't. */
export function peekPanelImage(): string | null | undefined {
  return loaded;
}

/** Decodes a data: URL without fetching it (a page's CSP may forbid fetching or showing data: images). */
function dataUrlBlob(url: string): Blob {
  const [head, b64 = ''] = url.split(',', 2);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: /data:([^;,]+)/.exec(head ?? '')?.[1] ?? 'image/png' });
}

/** The decoded image, kept for the page's life (only the latest one). */
export function decodePanelImage(src: string): Promise<ImageBitmap> {
  if (decoded?.src === src) return decoded.bitmap;
  const old = decoded;
  const entry: NonNullable<typeof decoded> = { src, ready: null, bitmap: createImageBitmap(dataUrlBlob(src)) };
  entry.bitmap.then((b) => (entry.ready = b)).catch(() => {});
  decoded = entry;
  void old?.bitmap.then((b) => b.close()).catch(() => {});
  return entry.bitmap;
}

/** The decoded image right now, if it's ready. */
export function decodedPanelImage(src: string): ImageBitmap | null {
  return decoded?.src === src ? decoded.ready : null;
}

export async function savePanelImage(dataUrl: string | null): Promise<void> {
  if (dataUrl === null) await browser.storage.local.remove(KEY);
  else await browser.storage.local.set({ [KEY]: dataUrl });
}

/** Calls `cb` with the image now and whenever it changes; returns the unsubscribe. */
export function watchPanelImage(cb: (dataUrl: string | null) => void): () => void {
  void preloadPanelImage().then(cb);
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local' || !(KEY in changes)) return;
    const v = changes[KEY]!.newValue;
    loaded = typeof v === 'string' && v.startsWith('data:image/') ? v : null;
    cb(loaded);
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
