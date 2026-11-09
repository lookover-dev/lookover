// Other spellings of one folder, for the tests of #658 (ADR 0084): a test made with `realpathSync.native` spells its
// folders one way only, which hid the bug; these spell them another way on purpose.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/**
 * A new folder with a space in its name, in its real path's spelling: the volume gives it a short 8.3 name when it
 * makes them (a name with a space has one). `made` is told, to remove it.
 */
export function spacedFolder(made: (folder: string) => void): string {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover spelt ")));
  made(folder);
  mkdirSync(join(folder, "Inner Folder"));
  return folder;
}

/** `folder` with a trailing separator. */
export const trailing = (folder: string): string => `${folder}${sep}`;

/** `folder` in another case: every letter swapped. */
export const otherCase = (folder: string): string =>
  [...folder].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join("");

/**
 * Windows: `folder`'s short 8.3 form, as `cmd` says it (`%~sI`); null when the volume makes no short names (the form
 * comes back as it went).
 */
export function shortForm(folder: string): string | null {
  const said = Bun.spawnSync(["cmd", "/d", "/s", "/c", `"for %I in ("${folder}") do @echo %~sI"`], {
    windowsVerbatimArguments: true,
  });
  const short = said.stdout.toString().trim();
  if (said.exitCode !== 0 || short === "")
    throw new Error(`cmd gave no short form of ${folder}: ${said.stderr}`);
  return short.toLowerCase() === folder.toLowerCase() ? null : short;
}

/** Said when a test of the short form has none to test: the volume makes no 8.3 names. */
export const noShortNames = (folder: string): string =>
  `skipped: the volume of ${folder} makes no 8.3 short names, so there is no short form to test`;
