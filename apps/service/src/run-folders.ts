// Run folders kept 30 days (ADR 0056, exploration 09 SR-13): each run keeps its raw material (prompts, the engines'
// output) in `<home>/runs/<job>/<run>`, private code included, so the service deletes it once it is old: at start,
// after the restart's recovery, and once a day. A run's age is the store's: when it ended, on the service's clock; a
// run still open (running, posting, resumed) or whose job runs is never touched. A folder the store doesn't know goes
// by its last modification. A job folder left empty goes too. Only `runs/` is read: the repository mirrors and the
// self-tests' folders are elsewhere, and stay. A folder that can't be read or removed is logged, and tried again at
// the next prune.
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunAge } from "@lookover/store";
import { DAY_MS, KEPT_DAYS } from "./retention.ts";
import { said } from "./said.ts";
import type { Timers } from "./timers.ts";

export interface RunFoldersOptions {
  /** `<home>/runs`. */
  runsDir: string;
  /** The store's age of a run, by its folder's name. */
  runAge(id: string): RunAge;
  /** What waits the day between two prunes, and what time it is. */
  timers: Timers;
  log(line: string): void;
}

/** The run folders' retention: `start` prunes, then once a day until `stop`. */
export interface RunFolders {
  start(): void;
  stop(): void;
}

export function createRunFolders(o: RunFoldersOptions): RunFolders {
  let cancel: (() => void) | null = null;
  const tick = () => {
    prune(o);
    cancel = o.timers.after(DAY_MS, tick);
  };
  return {
    start: tick,
    stop: () => {
      cancel?.();
      cancel = null;
    },
  };
}

/** Whether the run in `folder`, named `id`, ended before `before`: by the store's record, else by the disk. */
function old(o: RunFoldersOptions, id: string, folder: string, before: number): boolean {
  const age = o.runAge(id);
  switch (age.kind) {
    case "open":
      return false;
    case "ended":
      return age.at < before;
    case "unknown":
      return statSync(folder).mtimeMs < before;
  }
}

/** Every run folder older than 30 days deleted, and every job folder then empty. */
function prune(o: RunFoldersOptions): void {
  // No run yet.
  if (!existsSync(o.runsDir)) return;
  const before = o.timers.now() - KEPT_DAYS * DAY_MS;
  for (const job of folders(o, o.runsDir)) {
    const jobDir = join(o.runsDir, job);
    for (const run of folders(o, jobDir)) {
      const folder = join(jobDir, run);
      try {
        if (old(o, run, folder, before)) rmSync(folder, { recursive: true, force: true });
      } catch (error) {
        o.log(`the run folder ${folder} could not be removed: ${said(error)}`);
      }
    }
    try {
      if (readdirSync(jobDir).length === 0) rmdirSync(jobDir);
    } catch (error) {
      o.log(`the job folder ${jobDir}, empty, could not be removed: ${said(error)}`);
    }
  }
}

/** The folders `dir` holds (a file there is no run's); none, said, when it can't be read. */
function folders(o: RunFoldersOptions, dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    o.log(`the run folder ${dir} could not be read: ${said(error)}`);
    return [];
  }
}
