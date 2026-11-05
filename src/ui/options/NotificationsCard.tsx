import { useEffect, useState } from 'preact/hooks';
import { NotifySchema, type Notify } from '../../messages';
import { TELEGRAM_ORIGIN } from '../../notify/telegram';
import { requestOrigins } from '../../solana/permissions';
import { call } from '../pageClient';

/** Telegram trade alerts: the user's own bot, connected with its token. Saved on its own, apart from the settings draft. */
export function NotificationsCard() {
  const [notify, setNotify] = useState<Notify | null | undefined>(undefined);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    call<Notify | null>({ type: 'GET_NOTIFY' })
      .then(setNotify)
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);

  const run = async (what: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const done = await what();
      if (done) setMsg({ ok: true, text: done });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = async (next: Notify | null) => {
    await call({ type: 'SET_NOTIFY', notify: next });
    setNotify(next);
  };

  // The permission prompt must open straight from the click, before anything is awaited.
  const allowTelegram = () => requestOrigins([TELEGRAM_ORIGIN]);

  const connect = () => {
    const parsed = NotifySchema.shape.botToken.safeParse(token.trim());
    if (!parsed.success) return setMsg({ ok: false, text: "That doesn't look like a bot token. It looks like 123456789:AAE…, from @BotFather." });
    const allowed = allowTelegram();
    void run(async () => {
      if (!(await allowed)) throw new Error('Quickdraw needs permission to reach api.telegram.org to send alerts.');
      const found = await call<{ chatId: number; chatName: string; botName: string }>({ type: 'NOTIFY_CONNECT', botToken: parsed.data });
      await save({ botToken: parsed.data, ...found, enabled: true, events: { trades: true, failures: true, outside: true } });
      setToken('');
      await call({ type: 'NOTIFY_TEST' });
      return `Connected. ${found.botName} just sent ${found.chatName} a test message.`;
    });
  };

  if (notify === undefined) return msg ? <p class="err">{msg.text}</p> : null;

  const status = msg && <p class={msg.ok ? 'ok' : 'err'}>{msg.text}</p>;

  if (!notify) {
    return (
      <div class="card">
        <p>Get a Telegram message when your trades land or fail, and when a trade made elsewhere (like an Axiom take-profit) shows up in your wallet.</p>
        <ol>
          <li>
            In Telegram, open <b>@BotFather</b>, send <code>/newbot</code> and follow the prompts. It replies with your bot's token.
          </li>
          <li>Open your new bot and send it any message, like "hi", so it knows where to reach you.</li>
          <li>Paste the token here and press Connect.</li>
        </ol>
        <div class="row">
          <input
            type="password"
            autoComplete="off"
            placeholder="123456789:AAE…"
            value={token}
            style={{ flex: 1 }}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && connect()}
          />
          <button class="primary" disabled={busy || !token.trim()} onClick={connect}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        <p class="muted">
          Alerts go through Telegram's servers, and only arrive while your browser is open. The token is stored encrypted, like your RPC key, and
          never exported with your settings.
        </p>
        {status}
      </div>
    );
  }

  const set = (patch: Partial<Notify>) => void run(() => save({ ...notify, ...patch }));
  const event = (key: keyof Notify['events'], label: string) => (
    <label class="inline">
      <input type="checkbox" checked={notify.events[key]} disabled={busy || !notify.enabled} onChange={(e) => set({ events: { ...notify.events, [key]: (e.target as HTMLInputElement).checked } })} />
      {label}
    </label>
  );

  return (
    <div class="card">
      <p>
        Sending to <b>{notify.chatName}</b> through <b>{notify.botName}</b>.
      </p>
      <label class="inline">
        <input type="checkbox" checked={notify.enabled} disabled={busy} onChange={(e) => set({ enabled: (e.target as HTMLInputElement).checked })} />
        Send Telegram alerts
      </label>
      {event('trades', 'Trades made here that land')}
      {event('failures', 'Trades made here that fail or expire')}
      {event('outside', "Trades made elsewhere (an Axiom take-profit, another bot) on coins you've opened here")}
      <div class="row" style={{ marginTop: 10 }}>
        <button
          disabled={busy}
          onClick={() => {
            const allowed = allowTelegram();
            void run(async () => {
              if (!(await allowed)) throw new Error('Quickdraw needs permission to reach api.telegram.org to send alerts.');
              await call({ type: 'NOTIFY_TEST' });
              return 'Test message sent.';
            });
          }}
        >
          Send test
        </button>
        <button disabled={busy} onClick={() => void run(async () => (await save(null), 'Disconnected. No more alerts will be sent.'))}>
          Disconnect
        </button>
      </div>
      <p class="muted">Alerts only arrive while your browser is open.</p>
      {status}
    </div>
  );
}
