// A picture as a PNG file: 8-bit RGBA, one IDAT, no filter, written and read back without a dependency. A copy
// that is a picture is compared by its pixels, so the check never depends on how a platform's zlib compresses.
// Only what `encodePng` writes is read: a file whose rows another tool filtered (an optimiser) reads as nothing,
// so the check says to run `bun run brand` again rather than carry the four filters' decoder.
import { deflateSync, inflateSync } from "node:zlib";

/** A picture: its size in pixels and its pixels, row by row, four bytes each (red, green, blue, alpha). */
export type Image = { width: number; height: number; rgba: Uint8Array };

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const BPP = 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The picture as a PNG file's bytes. */
export function encodePng({ width, height, rgba }: Image): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, adaptive filters, no interlace.
  const stride = width * BPP;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The pixels from the rows as stored, each led by its filter's byte; nothing when they don't fit the size or a
 * row is filtered (only `encodePng`'s files are read). */
function unfilter(raw: Uint8Array, width: number, height: number): Uint8Array | undefined {
  const stride = width * BPP;
  if (raw.length !== height * (stride + 1)) return undefined;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    if (raw[start] !== 0) return undefined;
    out.set(raw.subarray(start + 1, start + 1 + stride), y * stride);
  }
  return out;
}

/** A PNG's chunks up to its end, in order; nothing when one runs past the bytes or there is no end. */
function chunks(bytes: Uint8Array): { type: string; body: Uint8Array }[] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: { type: string; body: Uint8Array }[] = [];
  for (let at = 8; at + 12 <= bytes.length; at += 12 + view.getUint32(at)) {
    const length = view.getUint32(at);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (body.length !== length) return undefined;
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    if (type === "IEND") return found;
    found.push({ type, body });
  }
  return undefined;
}

/** The picture in a PNG file's bytes, or nothing when they are not an 8-bit RGBA PNG without interlace or filter. */
export function decodePng(bytes: Uint8Array): Image | undefined {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) return undefined;
  const all = chunks(bytes);
  const header = all?.find((c) => c.type === "IHDR")?.body;
  if (!all || header?.length !== 13) return undefined;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const [width, height] = [view.getUint32(0), view.getUint32(4)];
  const [depth, colour, , , interlace] = header.subarray(8);
  if (depth !== 8 || colour !== 6 || interlace !== 0) return undefined;
  try {
    const data = Buffer.concat(all.filter((c) => c.type === "IDAT").map((c) => c.body));
    const rgba = unfilter(inflateSync(data), width, height);
    return rgba && { width, height, rgba };
  } catch {
    return undefined;
  }
}
