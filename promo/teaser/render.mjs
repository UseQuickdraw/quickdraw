// Renders promo/teaser/teaser.html to docs/quickdraw-teaser.mp4 (1920x1080, 30 fps, H.264).
//
//   npm run teaser                     -> the MP4
//   npm run teaser -- --stills 1.5,8   -> JPEG stills at those seconds, next to this file
//
// It opens the page in headless Edge (or Chrome: set BROWSER to its path), lets
// the page draw every frame on a canvas and encode it with WebCodecs, and saves
// the result. The page needs the network once, for its two Google Fonts and the
// mp4-muxer module.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(join(here, 'teaser.html')).href;
const out = resolve(here, '../../docs/quickdraw-teaser.mp4');
const port = 9339;
const browser = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const stillsArg = process.argv.indexOf('--stills');
const stills = stillsArg > 0 ? process.argv[stillsArg + 1].split(',').map(Number) : null;

// A throwaway profile: a reused one can keep extensions or state that change rendering.
const profile = mkdtempSync(join(tmpdir(), 'qd-teaser-'));
const proc = spawn(browser, [`--headless=new`, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--allow-file-access-from-files', '--window-size=1920,1080', page], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((t) => t.type === 'page' && t.url.includes('teaser.html'));
      if (t) return t;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error('The browser did not open the page (is BROWSER right?)');
}

try {
  const ws = new WebSocket((await target()).webSocketDebuggerUrl);
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

  for (let i = 0; i < 60 && (await evaluate('typeof window.still')) !== 'function'; i++) await sleep(500);
  await evaluate('window.ready');

  if (stills) {
    for (const t of stills) {
      const url = await evaluate(`window.still(${t})`);
      const file = join(here, `still-${String(t).replace('.', '_')}.jpg`);
      writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      console.log(file);
    }
  } else {
    const r = await evaluate('window.encode()');
    writeFileSync(out, Buffer.from(r.b64, 'base64'));
    console.log(`${out}: ${r.frames} frames, ${(r.size / 1e6).toFixed(1)} MB`);
  }
  ws.close();
} finally {
  proc.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
