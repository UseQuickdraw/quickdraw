// Renders promo/banner/banner.html to docs/x-banner.png (1500x500, X's header size).
//   npm run banner              -> the PNG
//   npm run banner -- --guides  -> also banner-guides.jpg here, with X's avatar and phone crop outlined
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(join(here, 'banner.html')).href;
const out = resolve(here, '../../docs/x-banner.png');
const port = 9338;
const browser = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = mkdtempSync(join(tmpdir(), 'qd-banner-'));
const proc = spawn(browser, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--allow-file-access-from-files', page], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('banner.html')) ?? null;
    } catch {
      // not listening yet
    }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('The browser did not open the page (is BROWSER right?)');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
  };
  await new Promise((r) => (ws.onopen = r));
  const evaluate = (expression) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    }).then((d) => {
      if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description ?? 'page error');
      return d.result?.result?.value;
    });
  for (let i = 0; i < 60 && (await evaluate('typeof window.png')) !== 'function'; i++) await sleep(500);
  await evaluate('window.ready');
  if (process.argv.includes('--guides')) {
    const g = await evaluate('window.guides()');
    writeFileSync(join(here, 'banner-guides.jpg'), Buffer.from(g.split(',')[1], 'base64'));
    console.log(join(here, 'banner-guides.jpg'));
  }
  const url = await evaluate('window.png()');
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log(out);
  ws.close();
} finally {
  proc.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
