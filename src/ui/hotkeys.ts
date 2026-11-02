// Keyboard shortcuts: canonical combo strings like "Alt+Shift+1".
// Keys are matched by physical key (event.code), so Shift+1 is "Shift+1",
// not "!", and layouts don't change what a digit means.

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function keyName(e: Pick<KeyLike, 'key' | 'code'>): string | null {
  const c = e.code;
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return `Num${c.slice(6)}`;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^F\d{1,2}$/.test(c)) return c;
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (e.key === ' ') return 'Space';
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** The canonical combo for a key event, or null for a bare modifier press. */
export function comboFromEvent(e: KeyLike): string | null {
  const key = keyName(e);
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
  return [...mods, key].join('+');
}

/** "shift+alt+1" -> "Alt+Shift+1" */
export function normalizeCombo(s: string): string {
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  const mods = MODIFIERS.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase() || (m === 'Ctrl' && p.toLowerCase() === 'control')));
  const key = parts.find((p) => !MODIFIERS.some((m) => m.toLowerCase() === p.toLowerCase()) && p.toLowerCase() !== 'control');
  if (!key) return mods.join('+');
  const k = key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1);
  return [...mods, k].join('+');
}

export function matches(combo: string | null | undefined, e: KeyLike): boolean {
  if (!combo) return false;
  const got = comboFromEvent(e);
  return got !== null && got === normalizeCombo(combo);
}

/** Typing into the page (search boxes, chat) must never trigger a trade. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as Element).closest !== 'function') return false;
  const el = t as HTMLElement;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || el.isContentEditable === true;
}

/** Combos used more than once, for a settings warning. */
export function duplicateCombos(combos: (string | null | undefined)[]): string[] {
  const seen = new Map<string, number>();
  for (const c of combos) if (c) seen.set(normalizeCombo(c), (seen.get(normalizeCombo(c)) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([c]) => c);
}
