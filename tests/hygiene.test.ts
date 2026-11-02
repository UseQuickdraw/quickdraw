// Source-level invariants that runtime tests can't observe.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}
const SRC = [...files('src'), ...files('entrypoints')].map((p) => [p, readFileSync(p, 'utf8')] as const);
const EVAL_LIKE = /\beval\s*\(|new Function\s*\(|import\(\s*["'`]https?:/;

describe('hygiene', () => {
  it('never widens storage.session access (content scripts must not read the key)', () => {
    for (const [p, s] of SRC) expect(/setAccessLevel\s*\(/.test(s), p).toBe(false);
  });
  it('no eval, Function constructor, or remote dynamic imports', () => {
    for (const [p, s] of SRC) expect(EVAL_LIKE.test(s), p).toBe(false);
  });
  it('content script, UI and site adapters never touch the keystore or storage.session', () => {
    for (const [p, s] of SRC.filter(([p]) => /content|[\\/]ui[\\/]|[\\/]sites[\\/]/.test(p))) {
      expect(/keystore|storage\.session/.test(s), p).toBe(false);
    }
  });
  it('no console logging inside the keystore', () => {
    for (const [p, s] of SRC.filter(([p]) => p.includes('keystore'))) expect(/console\./.test(s), p).toBe(false);
  });
});
