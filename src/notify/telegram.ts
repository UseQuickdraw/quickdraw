// Trade alerts through the user's own Telegram bot. The worker calls Telegram's
// Bot API directly (no server of ours): the user makes a bot with @BotFather,
// pastes its token, and messages it once so we can find their chat.
import type { Notify } from '../messages';

export const TELEGRAM_API = 'https://api.telegram.org';
/** The host permission the options page asks for when connecting. */
export const TELEGRAM_ORIGIN = `${TELEGRAM_API}/*`;

/** What an alert is about; `notify.events` turns each kind on or off. */
export interface TradeNotice {
  kind: 'landed' | 'failed' | 'expired' | 'outside';
  /** One line, e.g. "Bought 9.7K FRIC for 0.05 SOL". */
  text: string;
  signature: string | null;
}

type ApiResult<T> = { ok: true; result: T } | { ok: false; description?: string; error_code?: number };

async function api<T>(token: string, method: string, body?: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error("Couldn't reach Telegram. Check your connection, and that Quickdraw may reach api.telegram.org.");
  }
  const json = (await res.json().catch(() => null)) as ApiResult<T> | null;
  if (json?.ok) return json.result;
  // Never echo the URL: it carries the token.
  if (res.status === 401 || res.status === 404) throw new Error('Telegram rejected that bot token. Copy it again from @BotFather.');
  throw new Error(`Telegram: ${json && !json.ok && json.description ? json.description : `HTTP ${res.status}`}`);
}

interface Update {
  message?: { chat: { id: number; type: string; first_name?: string; username?: string; title?: string } };
}

/**
 * The bot's name and the chat to message: whoever most recently messaged the
 * bot privately. The user sends their bot any message first.
 */
export async function findChat(token: string, fetchImpl: typeof fetch = fetch): Promise<{ chatId: number; chatName: string; botName: string }> {
  const me = await api<{ username: string }>(token, 'getMe', undefined, fetchImpl);
  const updates = await api<Update[]>(token, 'getUpdates', { allowed_updates: ['message'] }, fetchImpl);
  const chat = [...updates].reverse().find((u) => u.message?.chat.type === 'private')?.message?.chat;
  if (!chat) throw new Error(`Open @${me.username} in Telegram and send it any message (like "hi"), then press Connect again.`);
  return { chatId: chat.id, chatName: chat.username ? `@${chat.username}` : (chat.first_name ?? 'you'), botName: `@${me.username}` };
}

export async function sendTelegram(token: string, chatId: number, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await api(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }, fetchImpl);
}

const ICON: Record<TradeNotice['kind'], string> = { landed: '✅', failed: '❌', expired: '⌛', outside: '🔔' };

/** The message for one notice: the line, which wallet, and the transaction. */
export function formatNotice(n: TradeNotice, walletName: string | null): string {
  return [`${ICON[n.kind]} ${n.text}`, walletName ? `Wallet: ${walletName}` : null, n.signature ? `https://solscan.io/tx/${n.signature}` : null]
    .filter(Boolean)
    .join('\n');
}

/** Whether `notify` wants this kind of notice. */
export function wants(notify: Notify | null, kind: TradeNotice['kind']): boolean {
  if (!notify?.enabled) return false;
  if (kind === 'landed') return notify.events.trades;
  if (kind === 'outside') return notify.events.outside;
  return notify.events.failures;
}
