// Shared by the promo videos (fees.html, keys.html): canvas setup, easing, text
// lines, glows, the cursor, toasts, the logo outro and the in-browser encoder.
// A classic script (not a module) so it loads from file:// pages.
//
// Each page defines `draw(t)` and `DURATION`, then calls `promo.start({ draw, duration, images })`.
(() => {
  const W = 1920, H = 1080, FPS = 30;
  const GREEN = '#44a257';
  const BUY_C = '#26d6a1';
  const SELL_C = '#ef4f7c';
  const c = document.getElementById('c');
  const g = c.getContext('2d');

  const img = (src) => {
    const i = new Image();
    i.src = src;
    return i;
  };
  const logo = img('../../docs/logo-rounded.png');

  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const easeInOut = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const back = (x) => { x = clamp(x); const s = 1.70158; return 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); };
  /** 0→1 over [a, a+fin], 1 until b, 1→0 over [b, b+fout]. */
  const window_ = (t, a, b, fin = 0.45, fout = 0.4) => (t < a || t > b + fout ? 0 : t < a + fin ? ease((t - a) / fin) : t <= b ? 1 : 1 - ease((t - b) / fout));
  const lerp = (a, b, x) => a + (b - a) * x;

  const SANS = (px, w = 500) => `${w} ${px}px Inter, system-ui, sans-serif`;
  const SERIF = (px) => `italic 400 ${px}px "Instrument Serif", Georgia, serif`;

  function clear() {
    g.save();
    g.filter = 'none';
    g.globalAlpha = 1;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  /** A line of mixed runs, centred on cx. Each run: { text, font, color, strike? } or { diamond: true }. */
  function line(runs, cx, cy, alpha, blur = 0, rise = 0) {
    if (alpha <= 0) return;
    g.save();
    g.globalAlpha = alpha;
    g.filter = blur > 0.05 ? `blur(${blur}px)` : 'none';
    g.textBaseline = 'alphabetic';
    const gap = 14;
    const widths = runs.map((r) => {
      if (r.diamond) return 18;
      g.font = r.font;
      return g.measureText(r.text).width;
    });
    const total = widths.reduce((a, b) => a + b, 0) + gap * (runs.length - 1);
    let x = cx - total / 2;
    const y = cy + 14 + rise;
    runs.forEach((r, i) => {
      if (r.diamond) {
        g.save();
        g.translate(x + 9, y - 12);
        g.rotate(Math.PI / 4);
        g.fillStyle = GREEN;
        g.fillRect(-5.5, -5.5, 11, 11);
        g.restore();
      } else {
        g.font = r.font;
        g.fillStyle = r.color;
        g.fillText(r.text, x, y);
      }
      x += widths[i] + gap;
    });
    g.restore();
  }

  /** Soft glows rising along the bottom edge: white-ish left, green right. */
  function aurora(t, strength) {
    if (strength <= 0) return;
    g.save();
    g.globalAlpha = strength;
    g.filter = 'blur(90px)';
    const drift = Math.sin(t * 0.6) * 40;
    const blobs = [
      { x: 380 + drift, y: 1130, rx: 560, ry: 170, color: 'rgba(225, 240, 232, 0.55)' },
      { x: 980 - drift * 0.5, y: 1170, rx: 380, ry: 120, color: 'rgba(68, 162, 87, 0.35)' },
      { x: 1560 - drift, y: 1110, rx: 620, ry: 200, color: 'rgba(68, 162, 87, 0.95)' },
    ];
    for (const b of blobs) {
      g.fillStyle = b.color;
      g.beginPath();
      g.ellipse(b.x, b.y, b.rx, b.ry, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /** The pointer at (x, y), pressed by 0..1. */
  function cursor(x, y, alpha, press = 0) {
    if (alpha <= 0) return;
    const s = 1.55 * (1 - 0.12 * press);
    g.save();
    g.globalAlpha = alpha;
    g.translate(x, y);
    g.scale(s, s);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, 22);
    g.lineTo(5.5, 16.8);
    g.lineTo(9.6, 25.6);
    g.lineTo(13.2, 24);
    g.lineTo(9.2, 15.4);
    g.lineTo(16.6, 15.4);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#000000';
    g.lineWidth = 1.4;
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = 8;
    g.fill();
    g.shadowBlur = 0;
    g.stroke();
    g.restore();
  }

  /** A ring spreading from a click at `at`. */
  function clickRing(t, at, x, y, color) {
    const dt = t - at;
    if (dt < 0 || dt > 0.6) return;
    g.save();
    g.globalAlpha = 1 - dt / 0.6;
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 14 + dt * 120, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  /** A pop-up like the panel's own (its current style): a title, a small second line, Solscan. */
  function toast(x, y, w, alpha, { title, sub, color = BUY_C, link = true }) {
    if (alpha <= 0) return;
    const h = 96;
    g.save();
    g.globalAlpha = alpha;
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = 30;
    roundRect(x, y, w, h, 14);
    g.fillStyle = '#1c1c1c';
    g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = '#333333';
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = color;
    g.fillRect(x, y + 14, 6, h - 28);
    g.textBaseline = 'alphabetic';
    g.font = SANS(28, 600);
    g.fillStyle = '#ffffff';
    g.fillText(title, x + 34, y + 42);
    g.font = SANS(22, 500);
    g.fillStyle = '#8a8a8a';
    g.fillText(sub, x + 34, y + 75);
    if (link) {
      g.textAlign = 'right';
      g.fillStyle = SELL_C;
      g.fillText('Solscan ↗', x + w - 30, y + 42);
    }
    g.restore();
    return h;
  }

  /**
   * The outro from T0: the hand pops in, slides left as "Quickdraw" reveals,
   * then the tagline runs (and an optional second line) appear under it; all fade by `end`.
   */
  function logoOutro(t, T0, end, tagRuns, second) {
    if (t < T0 || !logo.complete) return;
    const cx = W / 2, cy = H / 2 - 20;
    const pop = back((t - T0) / 0.55);
    const out = 1 - ease((t - end) / 0.9);
    const size = 128 * pop;
    const slide = easeInOut((t - (T0 + 0.9)) / 0.75);
    g.save();
    g.font = SANS(108, 700);
    const word = 'Quickdraw';
    const wordW = g.measureText(word).width;
    const gap = 34;
    const groupW = 128 + gap + wordW;
    const iconX = cx + slide * (64 - groupW / 2);
    g.globalAlpha = clamp(pop) * out;
    g.translate(iconX, cy - 6);
    g.rotate((1 - pop) * -0.6);
    g.drawImage(logo, -size / 2, -size / 2, size, size);
    g.restore();

    const reveal = ease((t - (T0 + 1.1)) / 0.8);
    if (reveal > 0) {
      const textX = iconX + 64 + gap;
      g.save();
      g.beginPath();
      g.rect(textX - 8, cy - 120, (wordW + 16) * reveal, 240);
      g.clip();
      g.globalAlpha = out;
      g.font = SANS(108, 700);
      g.fillStyle = '#ffffff';
      g.textBaseline = 'middle';
      g.fillText(word, textX + (1 - reveal) * -30, cy + 2);
      g.restore();
    }

    const tag = window_(t, T0 + 1.9, end - 0.15, 0.6, 0.6);
    line(tagRuns, cx, cy + 118, tag, (1 - tag) * 8, (1 - tag) * 8);
    if (second) {
      const s = window_(t, T0 + 2.4, end - 0.15, 0.6, 0.6);
      line(second, cx, cy + 186, s, (1 - s) * 8, (1 - s) * 8);
    }
  }

  /** The panel's background colour, read from the capture (to patch text over it). */
  function sampleColor(image, x, y) {
    const probe = document.createElement('canvas');
    probe.width = image.width;
    probe.height = image.height;
    const pg = probe.getContext('2d');
    pg.drawImage(image, 0, 0);
    const [r, gr, b] = pg.getImageData(x, y, 1, 1).data;
    return `rgb(${r}, ${gr}, ${b})`;
  }

  function start({ draw, duration, images = [], onReady }) {
    window.ready = (async () => {
      await document.fonts.load(SANS(46));
      await document.fonts.load(SANS(108, 700));
      await document.fonts.load(SERIF(54));
      await document.fonts.ready;
      for (const i of [logo, ...images]) if (!i.complete) await new Promise((r) => (i.onload = r));
      onReady?.();
      return true;
    })();

    /** One still, as a JPEG data URL. */
    window.still = (t) => { draw(t); return c.toDataURL('image/jpeg', 0.85); };

    /** The whole clip, encoded in the browser (WebCodecs H.264 + mp4-muxer), as base64. */
    window.encode = async () => {
      const { Muxer, ArrayBufferTarget } = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm');
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({ target, video: { codec: 'avc', width: W, height: H, frameRate: FPS }, fastStart: 'in-memory' });
      let error = null;
      const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (error = e) });
      enc.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 10_000_000, framerate: FPS, latencyMode: 'quality' });
      const frames = Math.round(duration * FPS);
      for (let i = 0; i < frames; i++) {
        draw(i / FPS);
        const frame = new VideoFrame(c, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
        enc.encode(frame, { keyFrame: i % 60 === 0 });
        frame.close();
        if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
        if (error) throw error;
      }
      await enc.flush();
      muxer.finalize();
      const bytes = new Uint8Array(target.buffer);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { frames, size: bytes.length, b64: btoa(s) };
    };
  }

  window.promo = {
    W, H, FPS, GREEN, BUY_C, SELL_C, g, img, logo,
    clamp, ease, easeInOut, back, window_, lerp, SANS, SERIF,
    clear, line, aurora, roundRect, cursor, clickRing, toast, logoOutro, sampleColor, start,
  };
})();
