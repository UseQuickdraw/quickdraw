import { useState } from 'preact/hooks';
import { PUBLIC_MAINNET_RPC } from '../../constants';
import { EndpointsSchema, type EndpointTestResult, type Endpoints } from '../../messages';
import type { Settings } from '../../settings/schema';
import { originsFor, requestOrigins } from '../../solana/permissions';
import { call } from '../pageClient';
import { parseQuickEndpoint } from './quickEndpoints';

interface Props {
  initial: Endpoints | null;
  sendMode: Settings['sendMode'];
  onSaved(): void;
}

const EMPTY: Endpoints = { rpcUrl: '', wsUrl: '', senderApiKey: null, customSendUrl: null };

export function EndpointsForm({ initial, sendMode, onSaved }: Props) {
  const [ep, setEp] = useState<Endpoints>(initial ?? EMPTY);
  const [test, setTest] = useState<EndpointTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quick, setQuick] = useState('');
  const [quickNote, setQuickNote] = useState<{ ok: boolean; text: string } | null>(null);

  const set = (k: keyof Endpoints) => (e: Event) => {
    const v = (e.target as HTMLInputElement).value.trim();
    // Functional update: autofill can change several fields before a re-render.
    setEp((prev) => ({ ...prev, [k]: k === 'senderApiKey' || k === 'customSendUrl' ? v || null : v }));
    setTest(null);
  };
  const isPublic = ep.rpcUrl.startsWith(PUBLIC_MAINNET_RPC);

  async function grantAndTest(): Promise<Endpoints | null> {
    setErr(null);
    const parsed = EndpointsSchema.safeParse(ep);
    if (!parsed.success) {
      setErr(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return null;
    }
    // Must run inside the click handler: permission prompts need a user gesture.
    const granted = await requestOrigins(originsFor(parsed.data, sendMode));
    if (!granted) {
      setErr('Permission to contact these endpoints was denied.');
      return null;
    }
    setBusy(true);
    try {
      setTest(await call<EndpointTestResult>({ type: 'TEST_ENDPOINTS', endpoints: parsed.data }));
      return parsed.data;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const valid = await grantAndTest();
    if (!valid) return;
    setBusy(true);
    try {
      await call({ type: 'SET_ENDPOINTS', endpoints: valid });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const status = (s: { ok: boolean; ms?: number; error?: string } | undefined) =>
    !s ? '' : s.ok ? `✓ ${s.ms ?? ''}ms` : `✗ ${s.error ?? ''}`;

  return (
    <div class="card">
      <label>
        Quick setup: paste your Helius API key or any RPC URL
        <input
          value={quick}
          placeholder="e.g. 1a2b3c4d-… or https://…"
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setQuick(v);
            const r = parseQuickEndpoint(v);
            setTest(null);
            if (!r) return setQuickNote(null);
            if (!r.ok) return setQuickNote({ ok: false, text: r.error });
            setEp((prev) => ({ ...prev, ...r.endpoints }));
            setQuickNote({ ok: true, text: `${r.summary} Check below, then Save.` });
          }}
        />
      </label>
      {quickNote && <p class={quickNote.ok ? 'ok' : 'err'}>{quickNote.text}</p>}
      <div class="grid2" style={{ marginTop: 10 }}>
        <label>
          RPC URL (HTTPS)
          <input value={ep.rpcUrl} onInput={set('rpcUrl')} placeholder="https://mainnet.helius-rpc.com/?api-key=…" />
        </label>
        <label>
          WebSocket URL (WSS)
          <input value={ep.wsUrl} onInput={set('wsUrl')} placeholder="wss://mainnet.helius-rpc.com/?api-key=…" />
        </label>
        <label>
          Helius Sender API key (optional)
          <input value={ep.senderApiKey ?? ''} onInput={set('senderApiKey')} placeholder="keyless = 1 req/s" />
        </label>
        {sendMode === 'custom' && (
          <label>
            Custom send URL
            <input value={ep.customSendUrl ?? ''} onInput={set('customSendUrl')} />
          </label>
        )}
      </div>
      <p>
        Any provider that accepts browser requests works (Helius, QuickNode, Triton, your own node…). Free tiers are fine to start.
        Stored encrypted on this device; access is granted only to the hosts you enter.
      </p>
      {isPublic && (
        <p class="err">
          The public endpoint ({PUBLIC_MAINNET_RPC}) rejects every request from a browser extension (HTTP 403). Use a provider URL instead.
        </p>
      )}
      <div class="row" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy} onClick={() => void grantAndTest()}>
          Test connection
        </button>
        <button type="button" class="primary" disabled={busy} onClick={() => void save()}>
          Save endpoints
        </button>
      </div>
      {test && (
        <p class="mono">
          RPC {status(test.rpc)} {test.rpc.slot ? `(slot ${test.rpc.slot})` : ''} · WS {status(test.ws)} · Sender {status(test.sender)}
        </p>
      )}
      {err && <p class="err">{err}</p>}
    </div>
  );
}
