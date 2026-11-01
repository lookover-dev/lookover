// What the brand's test files share: a formatter that runs in the test's own process, so the tests of what is
// generated, written and compared never start Biome, and this checkout's copies, for the one test per generated
// kind that keeps the real Biome and compares the source's rendering with what is checked in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Formatter } from "./index.ts";

/** The text as the generator wrote it: the drift logic is the same whatever shape the formatter gives. */
export const asWritten: Formatter = async (_path, text) => text;

/** The file at `path` (from this checkout's root), as an absolute path. */
export const inCheckout = (path: string) => join(import.meta.dir, "..", "..", "..", path);

/** This checkout's copy at `path` (from its root), CRLF read as LF. */
export const checkedIn = (path: string) => readFileSync(inCheckout(path), "utf8").replaceAll("\r\n", "\n");
