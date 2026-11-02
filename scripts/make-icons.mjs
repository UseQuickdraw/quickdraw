// Renders the extension icon (a bolt on a rounded square) to public/icon/*.png.
// Zero dependencies: a tiny rasterizer + PNG encoder, so the icons are
// reproducible from source.   node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const BG = [17, 18, 20]; // panel background
const FG = [124, 92, 255]; // default accent
const SS = 4; // supersampling per axis

// Bolt in a 24x24 box (same path as the panel/toolbar icon).
const BOLT = [
  [13, 2],
  [4, 14],
  [10, 14],
  [9, 22],
  [18, 10],
  [12, 10],
];

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size) {
  const pad = size * 0.16;
  const scale = (size - 2 * pad) / 20; // bolt spans x 4..18, y 2..22
  const bolt = BOLT.map(([x, y]) => [pad + (x - 1) * scale, pad + (y - 2) * scale]);
  const radius = size * 0.22;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!inRoundedSquare(fx, fy, size, radius)) continue;
          if (inPolygon(fx, fy, bolt)) fg++;
          else bg++;
        }
      }
      const n = SS * SS;
      const a = (bg + fg) / n;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = a ? Math.round((BG[c] * bg + FG[c] * fg) / (bg + fg)) : 0;
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icon', { recursive: true });
for (const s of SIZES) writeFileSync(`public/icon/${s}.png`, render(s));
console.log(`wrote public/icon/{${SIZES.join(',')}}.png`);
