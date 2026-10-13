// The run folder: what a run was given and what it left, for inspection, recording and replay. See `index.ts`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes `files` into `dir`, made if missing. Whether all of them were written: a folder that can't be made or
 * written is the run's failure to report (`crashed`), never an error thrown out of `run`.
 */
export function keep(dir: string, files: Record<string, string>): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return true;
  } catch {
    return false;
  }
}
