/**
 * Generates the PWA icon PNGs.
 *
 *   npm run icons
 *
 * Writes public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png
 *
 * Why hand-roll a PNG encoder instead of adding sharp or canvas: those are native
 * dependencies that need a compiler toolchain, and the icons are three flat shapes. A
 * ~90-line encoder using only node:zlib keeps `npm install` fast and portable, which
 * matters when the whole team is setting up on different laptops the night before.
 *
 * The art is drawn by evaluating shape predicates per pixel — no drawing library, and
 * antialiasing done by supersampling 3x3 per pixel.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'public', 'icons');

const TEAL = [15, 118, 110]; // #0f766e — matches the app's theme_color
const TEAL_DARK = [12, 94, 88];
const WHITE = [255, 255, 255];

/* PNG encoding ------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba raw pixels, 4 bytes each, row-major
 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 = None.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* Drawing ----------------------------------------------------------------- */

/** Signed-distance-ish test for a rounded rectangle. */
function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Renders the icon.
 *
 * A medical cross with a downward "pulse" notch through the middle: reads as health at
 * 48px, which is the size that actually matters on a launcher.
 *
 * @param {number} size
 * @param {{maskable?: boolean, fullBleed?: boolean}} options
 */
function renderIcon(size, { maskable = false, fullBleed = false } = {}) {
  const samples = 3; // 3x3 supersampling
  const rgba = Buffer.alloc(size * size * 4);

  // Maskable icons get cropped to a circle by the launcher, so the artwork must sit
  // inside the middle 80%. Non-maskable icons use a rounded square with a small margin.
  const contentScale = maskable ? 0.56 : 0.66;
  const bgMargin = maskable || fullBleed ? 0 : size * 0.055;
  const bgRadius = maskable || fullBleed ? 0 : size * 0.22;

  const centre = size / 2;
  const armThickness = size * contentScale * 0.3;
  const armLength = size * contentScale;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = px + (sx + 0.5) / samples;
          const y = py + (sy + 0.5) / samples;

          let colour = null;
          let alpha = 0;

          const inBackground =
            maskable || fullBleed
              ? true
              : insideRoundedRect(x, y, bgMargin, bgMargin, size - bgMargin, size - bgMargin, bgRadius);

          if (inBackground) {
            // Subtle vertical gradient so the icon does not look flat on light launchers.
            const t = y / size;
            colour = [
              Math.round(TEAL[0] + (TEAL_DARK[0] - TEAL[0]) * t),
              Math.round(TEAL[1] + (TEAL_DARK[1] - TEAL[1]) * t),
              Math.round(TEAL[2] + (TEAL_DARK[2] - TEAL[2]) * t),
            ];
            alpha = 255;

            const inVerticalArm =
              Math.abs(x - centre) <= armThickness / 2 && Math.abs(y - centre) <= armLength / 2;
            const inHorizontalArm =
              Math.abs(y - centre) <= armThickness / 2 && Math.abs(x - centre) <= armLength / 2;

            if (inVerticalArm || inHorizontalArm) {
              colour = WHITE;
            }

            // Pulse notch: a thin teal line across the horizontal arm, stepping down on
            // the right, so the cross also reads as a heartbeat trace.
            const notchThickness = size * 0.028;
            const step = x > centre ? size * 0.045 : 0;
            if (
              inHorizontalArm &&
              Math.abs(y - (centre + step)) <= notchThickness &&
              Math.abs(x - centre) <= armLength / 2 - notchThickness
            ) {
              colour = [TEAL[0], TEAL[1], TEAL[2]];
            }
          }

          if (colour) {
            rSum += colour[0];
            gSum += colour[1];
            bSum += colour[2];
            aSum += alpha;
          }
        }
      }

      const total = samples * samples;
      const offset = (py * size + px) * 4;
      const a = aSum / total;
      // Premultiply-free straight alpha: average colour over covered samples only.
      const covered = aSum > 0 ? aSum / 255 : 1;
      rgba[offset] = Math.round(rSum / covered);
      rgba[offset + 1] = Math.round(gSum / covered);
      rgba[offset + 2] = Math.round(bSum / covered);
      rgba[offset + 3] = Math.round(a);
    }
  }

  return encodePng(size, size, rgba);
}

/* Output ------------------------------------------------------------------ */

fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', renderIcon(192)],
  ['icon-512.png', renderIcon(512)],
  ['icon-maskable-512.png', renderIcon(512, { maskable: true })],
  ['apple-touch-icon.png', renderIcon(180, { fullBleed: true })],
];

for (const [name, buffer] of targets) {
  const target = path.join(OUT_DIR, name);
  fs.writeFileSync(target, buffer);
  console.log(`wrote ${path.relative(path.resolve(HERE, '..'), target)} (${buffer.length} bytes)`);
}

console.log('\nIcons regenerated. Commit them — the build expects them to exist.');
