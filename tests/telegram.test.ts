import { describe, expect, it, vi } from 'vitest';
import { findChat, formatNotice, sendTelegram, wants } from '../src/notify/telegram';
import { NotifySchema, type Notify } from '../src/messages';

const TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxyz012345';

/** A fake Bot API: answers each method with `results[method]`, recording what was asked. */
function bot(results: Record<string, unknown>, status = 200) {
  const calls: { method: string; body: unknown; url: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: { body: string }) => {
    const method = url.split('/').pop()!;
    calls.push({ method, body: JSON.parse(init.body), url });
    const ok = status === 200;
    return new Response(JSON.stringify(ok ? { ok, result: results[method] } : { ok, error_code: status, description: 'Unauthorized' }), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const notify = (over: Partial<Notify> = {}): Notify => ({
  botToken: TOKEN, chatId: 42, botName: '@qd_bot', chatName: '@me', enabled: true,
  events: { trades: true, failures: true, outside: true }, ...over,
});

describe('Telegram alerts', () => {
  it('accepts a BotFather token and refuses anything else', () => {
    expect(NotifySchema.shape.botToken.safeParse(TOKEN).success).toBe(true);
    for (const bad of ['', 'hello', '123:short', `${TOKEN}/sendMessage`]) expect(NotifySchema.shape.botToken.safeParse(bad).success, bad).toBe(false);
  });

  it("finds the chat that last messaged the bot privately, and the bot's name", async () => {
    const { fetchImpl } = bot({
      getMe: { username: 'qd_bot' },
      getUpdates: [
        { message: { chat: { id: 1, type: 'private', first_name: 'Old' } } },
        { message: { chat: { id: -5, type: 'group', title: 'Some group' } } },
        { message: { chat: { id: 42, type: 'private', username: 'me' } } },
      ],
    });
    expect(await findChat(TOKEN, fetchImpl)).toEqual({ chatId: 42, chatName: '@me', botName: '@qd_bot' });
  });

  it('asks the user to message the bot when nobody has yet', async () => {
    const { fetchImpl } = bot({ getMe: { username: 'qd_bot' }, getUpdates: [] });
    await expect(findChat(TOKEN, fetchImpl)).rejects.toThrow(/@qd_bot.*send it any message/);
  });

  it('says a token was rejected without ever repeating it', async () => {
    const { fetchImpl } = bot({}, 401);
    const err = await findChat(TOKEN, fetchImpl).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/rejected that bot token/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('sends plain text to the chat, without link previews', async () => {
    const { fetchImpl, calls } = bot({ sendMessage: {} });
    await sendTelegram(TOKEN, 42, 'hi', fetchImpl);
    expect(calls).toEqual([{ method: 'sendMessage', url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, body: { chat_id: 42, text: 'hi', disable_web_page_preview: true } }]);
  });

  it('formats a notice with its wallet and a Solscan link', () => {
    expect(formatNotice({ kind: 'landed', text: 'Bought 9.7K FRIC for 0.05 SOL', signature: 'abc' }, 'Main')).toBe(
      '✅ Bought 9.7K FRIC for 0.05 SOL\nWallet: Main\nhttps://solscan.io/tx/abc',
    );
    expect(formatNotice({ kind: 'expired', text: 'Buy 0.1 SOL of FRIC expired', signature: null }, null)).toBe('⌛ Buy 0.1 SOL of FRIC expired');
  });

  it('only sends the kinds the user turned on, and nothing when off', () => {
    expect(wants(null, 'landed')).toBe(false);
    expect(wants(notify({ enabled: false }), 'landed')).toBe(false);
    const some = notify({ events: { trades: false, failures: true, outside: false } });
    expect(['landed', 'failed', 'expired', 'outside'].map((k) => wants(some, k as never))).toEqual([false, true, true, false]);
  });
});
