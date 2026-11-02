import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryingFetch } from '../src/solana/retryFetch';

const reply = (status: number) => new Response(JSON.stringify({ ok: status === 200 }), { status });

describe('retryingFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps retrying 429s until the RPC answers', async () => {
    const statuses = [429, 429, 503, 200];
    const fake = vi.fn(async () => reply(statuses.shift()!));
    vi.stubGlobal('fetch', fake);
    const res = await retryingFetch(10_000)('https://rpc.example', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(4);
  });

  it('retries a dropped connection', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (n++ === 0 ? Promise.reject(new TypeError('fetch failed')) : reply(200))));
    expect((await retryingFetch(10_000)('https://rpc.example')).status).toBe(200);
  });

  it('passes other errors straight through, without retrying', async () => {
    const fake = vi.fn(async () => reply(400));
    vi.stubGlobal('fetch', fake);
    expect((await retryingFetch(10_000)('https://rpc.example')).status).toBe(400);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('gives the last 429 back once its time is up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(429)));
    const t = Date.now();
    expect((await retryingFetch(300)('https://rpc.example')).status).toBe(429);
    expect(Date.now() - t).toBeLessThan(2_000);
  });
});
