// A file put in place whole: written under a temporary name beside it, then renamed onto its own, so whoever reads
// it (a command waiting for `instance.json`, the dev launcher for its announce file, a run refused by the live lock,
// the next start for the session secret) finds it whole or absent, never half written. The rename keeps the folder:
// what the temporary file was made (its mode, its access list) is what the file is.
import { renameSync, writeFileSync } from "node:fs";

/** The temporary name beside `file`: this process's own, so two processes never write the same one. */
const temporaryOf = (file: string) => `${file}.${process.pid}.tmp`;

/** Writes `text` to `file` whole; `mode` (POSIX only, Windows ignores it) when given. */
export function writeWhole(file: string, text: string, mode?: number): void {
  const temporary = temporaryOf(file);
  writeFileSync(temporary, text, mode === undefined ? undefined : { mode });
  renameSync(temporary, file);
}

/**
 * Writes `text` to `file` whole, user-only before it is in place: the owner's mode on POSIX, then `userOnly` on the
 * temporary file (on Windows its access list), so no one else ever reads it.
 */
export async function writeWholeUserOnly(
  file: string,
  text: string,
  userOnly: (path: string) => Promise<void>,
): Promise<void> {
  const temporary = temporaryOf(file);
  writeFileSync(temporary, text, { mode: 0o600 });
  await userOnly(temporary);
  renameSync(temporary, file);
}
