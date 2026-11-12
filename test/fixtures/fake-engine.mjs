#!/usr/bin/env node
/**
 * Fake engine fixture (TEST-PLAN §2 L2): stands in for generate_h3_image.py.
 * Understands only the plugin's argv contract: -o, --metrics, --seed, --width,
 * --height, plus a magic prompt prefix to select behavior:
 *   "FAIL:<stderr text>"  -> write stderr, exit 1
 *   "SLEEP"               -> hang forever (deadline test)
 *   "NOIMAGE"             -> write metrics, exit 0, no PNG
 *   "BADPNG"              -> write a truncated non-PNG
 *   anything else         -> write a valid 64x32 PNG + fixed metrics, exit 0
 */
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Minimal valid PNG (64x32, single IDAT of a zero-filled scanline set) built
// with stored deflate blocks — deterministic bytes, decodable by any reader.
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function tinyPng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc(h * (1 + w)); // filter byte + gray pixels
  // stored (uncompressed) deflate over the raw scanlines
  const blocks = [];
  for (let off = 0; off < raw.length; off += 65535) {
    const part = raw.subarray(off, off + 65535);
    const head = Buffer.alloc(5);
    head[0] = off + 65535 >= raw.length ? 1 : 0;
    head.writeUInt16LE(part.length, 1);
    head.writeUInt16LE(~part.length & 0xffff, 3);
    blocks.push(head, part);
  }
  blocks.push(Buffer.from([0x00, 0x00, 0xff, 0xff])); // adler32 of zeros
  const idat = Buffer.concat(blocks);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const prompt = argv[0] ?? "";
const out = get("-o");
const metricsPath = get("--metrics");
const seed = get("--seed");
const width = get("--width");
const height = get("--height");

if (prompt.startsWith("FAIL:")) {
  process.stderr.write(prompt.slice(5));
  process.exit(1);
}
if (prompt === "SLEEP") {
  // Keep the event loop alive forever; the runner's deadline must kill us.
  setInterval(() => {}, 1000);
} else {
  const w = width === undefined ? 64 : Number(width);
  const h = height === undefined ? 32 : Number(height);
  if (metricsPath !== undefined) {
    writeFileSync(metricsPath, JSON.stringify({
      width: w, height: h, seed: seed === undefined ? 0 : Number(seed),
      prompt, total_seconds: 1.5, peak_gb: 27.59, step_seconds: [0.5, 0.5, 0.5],
      output: out,
    }, null, 2));
  }
  if (prompt === "NOIMAGE") process.exit(0);
  if (out !== undefined) {
    if (prompt === "BADPNG") writeFileSync(out, Buffer.from([0x89, 0x50, 0x4e]));
    else writeFileSync(out, tinyPng(w, h));
  }
  process.exit(0);
}
