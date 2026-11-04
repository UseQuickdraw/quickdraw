// Keeps a hover quote current without starving it. The panel asks the worker
// again whenever the market ticks; on a busy coin it ticks faster than the
// worker answers, so dropping every reply that a newer tick has overtaken would
// never show anything. Instead one request is out at a time: a tick while one
// is out asks again once it's back, so the quote is at most one answer behind.
import type { Result } from '../messages';

export class LiveQuote<T> {
  private out = false;
  private again = false;

  /**
   * @param key the button currently hovered (null for none): a reply only counts for the key it was asked for
   * @param ask sends the request for the current key
   * @param got receives each good reply; a failed one is ignored, so the last good quote stays
   */
  constructor(
    private readonly key: () => string | null,
    private readonly ask: () => Promise<Result<unknown>>,
    private readonly got: (key: string, value: T) => void,
  ) {}

  /** The market ticked or the key changed: ask now, or once the request that's out is back. */
  refresh(): void {
    const asked = this.key();
    if (!asked) return;
    if (this.out) {
      this.again = true;
      return;
    }
    this.out = true;
    void this.ask()
      .catch((e: unknown) => ({ ok: false, error: String(e) }) as Result<unknown>)
      .then((res) => {
        this.out = false;
        const r = res as Result<T | null>;
        if (r.ok && r.data && this.key() === asked) this.got(asked, r.data);
        if (this.again) {
          this.again = false;
          this.refresh();
        }
      });
  }
}
