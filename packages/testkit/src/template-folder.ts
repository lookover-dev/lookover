// A folder a test file makes once and copies for each test that stands on it (a store every migration already
// brought up to date): the costly making happens once per file, a copy costs little (ADR 0071).
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A folder made once, copied for each test that stands on it. */
export interface TemplateFolder {
  /** Copies the template's content into `into`, a folder that exists. Each copy is its own. */
  copy(into: string): void;
  /** Removes the template: its test file calls it once its last test ran. */
  remove(): void;
}

/**
 * A scratch folder named `<prefix><random>` under the temp folder's long form (Bun fails under 8.3 names), filled now
 * by `make`.
 */
export function templateFolder(prefix: string, make: (folder: string) => void): TemplateFolder {
  const folder = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  make(folder);
  return {
    copy: (into) => cpSync(folder, into, { recursive: true }),
    remove: () => rmSync(folder, { recursive: true, force: true }),
  };
}
