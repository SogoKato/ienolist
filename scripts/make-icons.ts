// Draws the app icon (a check mark on green) as PNGs: node scripts/make-icons.ts
// The art fills the whole square and keeps the mark inside the middle 60%, so it works as a maskable icon too.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const GREEN = [47, 125, 91];
const WHITE = [255, 255, 255];
// The check mark as two segments, in 0..1 coordinates.
const SEGMENTS: [number, number, number, number][] = [
  [0.3, 0.52, 0.45, 0.67],
  [0.45, 0.67, 0.72, 0.36],
];
const HALF_WIDTH = 0.045;

const distance = (px: number, py: number, [x1, y1, x2, y2]: [number, number, number, number]) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

function png(size: number): Buffer {
  const SAMPLES = 3;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = (x + (sx + 0.5) / SAMPLES) / size;
          const py = (y + (sy + 0.5) / SAMPLES) / size;
          if (SEGMENTS.some((s) => distance(px, py, s) <= HALF_WIDTH)) covered++;
        }
      }
      const share = covered / (SAMPLES * SAMPLES);
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(GREEN[c] * (1 - share) + WHITE[c] * share);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [192, 512]) writeFileSync(new URL(`../web/public/icon-${size}.png`, import.meta.url), png(size));

const [[a, b, c, d], [, , e, f]] = SEGMENTS;
writeFileSync(
  new URL("../web/public/icon.svg", import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="rgb(${GREEN})"/>` +
    `<path d="M${a * 100} ${b * 100} L${c * 100} ${d * 100} L${e * 100} ${f * 100}" fill="none" stroke="#fff" stroke-width="${HALF_WIDTH * 200}" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`,
);
