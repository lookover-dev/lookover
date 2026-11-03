// The key scanner (ADR 0053, spec #187 story 33): finds secret text, for the checks that no secret sits in the data
// folder outside the sign-in store's sealed files (`sign-in-store.ts`, ADR 0066), nor in the event log, the snapshot or
// the logs. Secret text is a private key's armour (`-----BEGIN … PRIVATE KEY-----`, any kind), or, for a secret the
// caller knows (a key, the sign-in's token or refresh token), any one line of it long enough to name it alone, which a
// log or a JSON string can hold without the armour. Files are read as bytes, so a SQLite file or a binary is scanned
// too; symbolic links are not followed. It answers where, never the text it found. Tests' only: the service itself
// never scans.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** A private key's armour, of any kind (`-----BEGIN RSA PRIVATE KEY-----`, PKCS#8's `-----BEGIN PRIVATE KEY-----`). */
const ARMOUR = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

/** A line shorter than this could be found by chance; a PEM's full lines are 64 characters, a GitHub token 40. */
const LINE = 32;

/** The lines of each known secret long enough to name it alone, a key's armour left out. */
const linesOf = (known: readonly string[]) =>
  known.flatMap((key) =>
    key
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length >= LINE && !line.startsWith("-----")),
  );

const holds = (text: string, lines: readonly string[]) =>
  ARMOUR.test(text) || lines.some((line) => text.includes(line));

/** Whether `text` holds a private key's armour, or a line of one of the `known` secrets. */
export function hasKeyText(text: string, known: readonly string[] = []): boolean {
  return holds(text, linesOf(known));
}

/** The files under `root` holding secret text, as paths from the root with `/`, sorted. */
export async function filesWithKeyText(
  root: string,
  o: { known?: readonly string[] } = {},
): Promise<string[]> {
  const lines = linesOf(o.known ?? []);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (holds((await readFile(path)).toString("latin1"), lines))
      found.push(relative(root, path).split(sep).join("/"));
  }
  return found.sort();
}
