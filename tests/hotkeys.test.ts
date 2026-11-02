import { describe, expect, it } from 'vitest';
import { comboFromEvent, duplicateCombos, isTypingTarget, matches, normalizeCombo } from '../src/ui/hotkeys';

const ev = (code: string, key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code,
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('hotkeys', () => {
  it('builds canonical combos from physical keys', () => {
    expect(comboFromEvent(ev('Digit1', '1', { altKey: true }))).toBe('Alt+1');
    expect(comboFromEvent(ev('Digit1', '!', { altKey: true, shiftKey: true }))).toBe('Alt+Shift+1');
    expect(comboFromEvent(ev('KeyQ', 'q', { ctrlKey: true }))).toBe('Ctrl+Q');
    expect(comboFromEvent(ev('Numpad3', '3'))).toBe('Num3');
    expect(comboFromEvent(ev('F2', 'F2'))).toBe('F2');
    expect(comboFromEvent(ev('AltLeft', 'Alt', { altKey: true }))).toBeNull();
  });

  it('normalizes typed combos and matches events', () => {
    expect(normalizeCombo('shift+alt+1')).toBe('Alt+Shift+1');
    expect(normalizeCombo('control+q')).toBe('Ctrl+Q');
    expect(matches('Alt+Shift+1', ev('Digit1', '!', { altKey: true, shiftKey: true }))).toBe(true);
    expect(matches('Alt+1', ev('Digit1', '!', { altKey: true, shiftKey: true }))).toBe(false); // extra modifier
    expect(matches(null, ev('Digit1', '1'))).toBe(false);
  });

  it('flags duplicates', () => {
    expect(duplicateCombos(['Alt+1', 'alt+1', 'Alt+2', null])).toEqual(['Alt+1']);
  });

  it('treats inputs as typing targets', () => {
    const fake = (match: boolean) => ({ closest: () => (match ? {} : null), isContentEditable: false }) as unknown as EventTarget;
    expect(isTypingTarget(fake(true))).toBe(true);
    expect(isTypingTarget(fake(false))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
