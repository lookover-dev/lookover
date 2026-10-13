// The key scanner (ADR 0053, spec #187 story 33): finds private-key text, for the checks that no key sits in the
// data folder outside where the App store keeps it, nor in the event log, the snapshot or the logs. Key text is a
// private key's armour (`-----BEGIN … PRIVATE KEY-----`, any kind), or, for a key the caller knows, any one line of
// its body, which a log or a JSON string can hold without the armour. Files are read as bytes, so a SQLite file or a
// binary is scanned too; symbolic links are not followed. It answers where, never the text it found. Tests' only: the
// service itself never scans.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { PRIVATE_KEY_ARMOUR as ARMOUR } from "@lookover/contracts";

/** A body line shorter than this could be found by chance; a PEM's full lines are 64 characters. */
const LINE = 32;

/** The lines of each known key's body long enough to name it alone. */
const linesOf = (known: readonly string[]) =>
  known.flatMap((key) =>
    key
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length >= LINE && !line.startsWith("-----")),
  );

const holds = (text: string, lines: readonly string[]) =>
  ARMOUR.test(text) || lines.some((line) => text.includes(line));

/** Whether `text` holds a private key's armour, or a line of one of the `known` keys' bodies. */
export function hasKeyText(text: string, known: readonly string[] = []): boolean {
  return holds(text, linesOf(known));
}

/**
 * The files under `root` holding key text, as paths from the root with `/`, sorted; the files `except` names
 * (the same form, such as the App store's `github/app.<id>.pem`) are not read.
 */
export async function filesWithKeyText(
  root: string,
  o: { known?: readonly string[]; except?: readonly string[] } = {},
): Promise<string[]> {
  const lines = linesOf(o.known ?? []);
  const except = new Set(o.except ?? []);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(root, path).split(sep).join("/");
    if (except.has(name)) continue;
    if (holds((await readFile(path)).toString("latin1"), lines)) found.push(name);
  }
  return found.sort();
}
