// What the brand's test files share: a formatter that runs in the test's own process, so the tests of what is
// generated, written and compared never start Biome, and this checkout's copies, for the one test per generated
// kind that keeps the real Biome and compares the source's rendering with what is checked in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync, type ZlibOptions } from "node:zlib";
import type { Formatter } from "./index.ts";

/** The text as the generator wrote it: the drift logic is the same whatever shape the formatter gives. */
export const asWritten: Formatter = async (_path, text) => text;

/** The file at `path` (from this checkout's root), as an absolute path. */
export const inCheckout = (path: string) => join(import.meta.dir, "..", "..", "..", path);

/**
 * `png` with its one IDAT chunk's rows (each led by its filter's byte) replaced by what `change` makes of them,
 * compressed again with `options`. Its CRC is left wrong: the reader doesn't check it.
 */
export function withPixels(
  png: Uint8Array,
  change: (rows: Uint8Array) => Uint8Array,
  options: ZlibOptions = {},
): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    if (new TextDecoder().decode(png.subarray(at + 4, at + 8)) === "IDAT") {
      const data = deflateSync(change(inflateSync(png.subarray(at + 8, at + 8 + length))), options);
      const head = new Uint8Array(8);
      new DataView(head.buffer).setUint32(0, data.length);
      head.set(png.subarray(at + 4, at + 8), 4);
      return Uint8Array.from([
        ...png.subarray(0, at),
        ...head,
        ...data,
        0,
        0,
        0,
        0,
        ...png.subarray(at + 12 + length),
      ]);
    }
    at += 12 + length;
  }
  throw new Error("no IDAT");
}

/** This checkout's copy at `path` (from its root), CRLF read as LF. */
export const checkedIn = (path: string) => readFileSync(inCheckout(path), "utf8").replaceAll("\r\n", "\n");
