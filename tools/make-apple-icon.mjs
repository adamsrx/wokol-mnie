// Generates apple-touch-icon.png (180x180) without any dependencies or network:
// rasterizes the compass from icon.svg with 4x4 supersampling and encodes a PNG by hand.
// Run: node tools/make-apple-icon.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 180;
const SS = 4; // supersampling factor per axis
const BG = [11, 15, 14];
const BRASS = [233, 180, 76];
const PAPER = [243, 239, 230];

// Geometry in the 64x64 coordinate space of icon.svg, scaled to SIZE.
const S = SIZE / 64;
const cx = 32 * S, cy = 32 * S;
const rot = (34 * Math.PI) / 180;

function inRoundedRect(x, y, w, h, r) {
  const dx = Math.max(r - x, 0, x - (w - r));
  const dy = Math.max(r - y, 0, y - (h - r));
  return dx * dx + dy * dy <= r * r;
}
function ringCoverage(x, y, r, width) {
  const d = Math.hypot(x - cx, y - cy);
  return Math.abs(d - r) <= width / 2;
}
// Point in triangle via barycentric sign test.
function inTri(px, py, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s([px, py], a, b), d2 = s([px, py], b, c), d3 = s([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
function rotPt(x, y) {
  const X = x * S - cx, Y = y * S - cy;
  return [cx + X * Math.cos(rot) - Y * Math.sin(rot), cy + X * Math.sin(rot) + Y * Math.cos(rot)];
}
const northTri = [rotPt(32, 13), rotPt(37.2, 32), rotPt(26.8, 32)];
const southTri = [rotPt(32, 51), rotPt(26.8, 32), rotPt(37.2, 32)];

function sampleColor(x, y) {
  // Returns [r,g,b,a] for a sub-pixel sample. Order mirrors the SVG paint order.
  if (!inRoundedRect(x, y, SIZE, SIZE, 14 * S)) return [0, 0, 0, 0];
  let col = BG.slice();
  const mix = (c, a) => { col = col.map((v, i) => Math.round(v + (c[i] - v) * a)); };
  if (ringCoverage(x, y, 22 * S, 1.5 * S)) mix(BRASS, 0.45);
  if (ringCoverage(x, y, 14 * S, 1 * S)) mix(BRASS, 0.2);
  // Tick marks (N, S, W, E).
  const tw = 1 * S;
  const inTick = (Math.abs(x - cx) <= tw && ((y >= 7 * S && y <= 11 * S) || (y >= 53 * S && y <= 57 * S)))
    || (Math.abs(y - cy) <= tw && ((x >= 7 * S && x <= 11 * S) || (x >= 53 * S && x <= 57 * S)));
  if (inTick) mix(PAPER, 0.8);
  if (inTri(x, y, ...northTri)) col = BRASS.slice();
  if (inTri(x, y, ...southTri)) col = PAPER.slice();
  const dc = Math.hypot(x - cx, y - cy);
  if (dc <= 3.2 * S + 0.75 * S) col = PAPER.slice();
  if (dc <= 3.2 * S - 0.75 * S) col = BG.slice();
  return [...col, 255];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter type: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const [cr, cg, cb, ca] = sampleColor(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    if (a > 0) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); }
    raw[o + 3] = Math.round(a / (SS * SS));
  }
}

// --- minimal PNG encoder ---
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'apple-touch-icon.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
