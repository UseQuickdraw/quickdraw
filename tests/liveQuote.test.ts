import { describe, expect, it } from 'vitest';
import { LiveQuote } from '../src/ui/liveQuote';
import type { Result } from '../src/messages';

/** A worker whose replies we release by hand, in order. */
function worker() {
  const pending: { key: string; resolve: (r: Result<unknown>) => void }[] = [];
  let key: string | null = 'buy-1';
  const shown: [string, number][] = [];
  let n = 0;
  const live = new LiveQuote<number>(
    () => key,
    () => new Promise((resolve) => pending.push({ key: key!, resolve })),
    (k, v) => shown.push([k, v]),
  );
  const answer = async (r: Result<unknown> = { ok: true, data: ++n }) => {
    pending.shift()!.resolve(r);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { live, pending, shown, answer, setKey: (k: string | null) => (key = k) };
}

describe('LiveQuote', () => {
  it('shows a quote on a coin that ticks faster than the worker answers', async () => {
    const w = worker();
    w.live.refresh();
    // Five ticks before the first answer: no extra requests pile up...
    for (let i = 0; i < 5; i++) w.live.refresh();
    expect(w.pending).toHaveLength(1);
    // ...the answer is shown rather than dropped as stale, and one follow-up goes out for the newer state.
    await w.answer();
    expect(w.shown).toEqual([['buy-1', 1]]);
    expect(w.pending).toHaveLength(1);
    await w.answer();
    expect(w.shown).toEqual([['buy-1', 1], ['buy-1', 2]]);
    expect(w.pending).toHaveLength(0);
  });

  it("drops a reply for a button that's no longer hovered and asks for the new one", async () => {
    const w = worker();
    w.live.refresh();
    w.setKey('buy-2');
    w.live.refresh();
    await w.answer(); // buy-1's reply
    expect(w.shown).toEqual([]);
    expect(w.pending.map((p) => p.key)).toEqual(['buy-2']);
    await w.answer();
    expect(w.shown).toEqual([['buy-2', 2]]);
  });

  it('keeps the last good quote when a request fails, and asks nothing with no button hovered', async () => {
    const w = worker();
    w.live.refresh();
    await w.answer();
    w.live.refresh();
    await w.answer({ ok: false, error: 'busy' });
    expect(w.shown).toEqual([['buy-1', 1]]);
    w.setKey(null);
    w.live.refresh();
    expect(w.pending).toHaveLength(0);
  });
});
