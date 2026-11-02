// fetch that rides out RPC rate limits and dropped connections: a 429 (or a
// 502/503/504, or a network error) is retried at once and then with a short,
// growing pause, until it works or `budgetMs` runs out. Nothing a user does
// should need a page refresh because their RPC briefly said "too many requests".

/** Retried statuses: rate limited, or a gateway that briefly lost its upstream. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const FIRST_PAUSE_MS = 100;
const MAX_PAUSE_MS = 1_500;

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/** A Retry-After header, when it asks for a short wait we can honour (seconds or a date). */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function retryingFetch(budgetMs: number): typeof fetch {
  return async (input, init) => {
    const deadline = Date.now() + budgetMs;
    let pause = FIRST_PAUSE_MS;
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(input, init);
        if (!RETRY_STATUS.has(res.status)) return res;
      } catch (e) {
        // Aborted on purpose: stop. Otherwise a dropped connection: retry.
        if (init?.signal?.aborted) throw e;
        if (Date.now() >= deadline) throw e;
      }
      if (res && Date.now() >= deadline) return res;
      // The first retry goes straight out (most 429s are a momentary burst), then backs off.
      const wait = attempt === 0 ? 0 : Math.min(MAX_PAUSE_MS, Math.max(pause, (res && retryAfterMs(res)) ?? 0));
      await sleep(Math.min(wait, Math.max(0, deadline - Date.now())), init?.signal);
      if (attempt > 0) pause = Math.min(MAX_PAUSE_MS, pause * 1.6);
    }
  };
}

/** Reads: keep trying for half a minute (a click waiting on a quote gets it as soon as the RPC answers). */
export const rpcFetch = retryingFetch(30_000);
/** Sends: a 429 means the transaction wasn't forwarded, so resending is safe; stop well within a blockhash's life. */
export const sendFetch = retryingFetch(20_000);
