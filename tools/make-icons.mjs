// Generates extension/icons/icon{16,32,48,128}.png with zero dependencies.
// Usage: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const BG = [22, 101, 82];     // deep teal
const FG = [255, 214, 10];    // amber robot

// Shapes in unit coordinates (0..1).
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const inRoundedSquare = (x, y, r) => inRoundRect(x, y, 0, 0, 1, 1, r);

// The robot (🤖): head, antenna, ears in amber; eyes and mouth cut out to the background.
function inRobot(x, y) {
  const body =
    inRoundRect(x, y, 0.24, 0.34, 0.76, 0.80, 0.12) || // head
    inRoundRect(x, y, 0.465, 0.20, 0.535, 0.36, 0.02) || // antenna stem
    inCircle(x, y, 0.5, 0.17, 0.065) ||                 // antenna tip
    inRoundRect(x, y, 0.15, 0.48, 0.25, 0.66, 0.03) ||  // left ear
    inRoundRect(x, y, 0.75, 0.48, 0.85, 0.66, 0.03);    // right ear
  if (!body) return false;
  const cutout =
    inCircle(x, y, 0.39, 0.53, 0.075) ||                // left eye
    inCircle(x, y, 0.61, 0.53, 0.075) ||                // right eye
    inRoundRect(x, y, 0.37, 0.66, 0.63, 0.72, 0.025);   // mouth
  return !cutout;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function render(size) {
  const SS = 4; // supersampling for anti-aliasing
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundedSquare(x, y, 0.22)) continue;
          if (inRobot(x, y)) fg++;
          else bg++;
        }
      }
      const total = SS * SS;
      const cov = (bg + fg) / total;
      const mix = bg + fg ? fg / (bg + fg) : 0;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - mix) + FG[c] * mix);
      raw[o + 3] = Math.round(cov * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), render(size));
}
console.log(`Icons written to ${OUT}`);
