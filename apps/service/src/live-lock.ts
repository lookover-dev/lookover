// The machine-wide live lock (ADR 0039, ADR 0054): at most one real review runs at a time on this machine,
// across worktrees and the program, against the ban risk of automated loops on the owner's plan. It is an OS-held
// lock (`os-lock.ts`) in the user's home (`~/.lookover/live-run.lock`), never in a data folder: the system releases
// it however its holder ends, so neither a crash nor a process id reused since blocks the next run. Beside it,
// `live-run.json` names the holder (its process, the data folder it serves, since when) for the message a refused
// run reads; it is only ever read while the lock is held, so a file a crash left behind misleads nobody.
import { homedir } from "node:os";
import { join } from "node:path";
import { takeLockNamed } from "./os-lock.ts";
import { writeWhole } from "./whole-file.ts";

export interface LiveLockOptions {
  /** The user's home; `os.homedir()` by default. A test gives a scratch one. */
  home?: string;
  /** The data folder the run serves, for the message a refused run reads. */
  folder: string;
  now?: () => number;
}

export interface LiveLock {
  /** The file naming the holder while it holds the lock. */
  holderFile: string;
  release(): void;
}

/** Another live run holds the lock; the message says who, and what to do. */
export class LiveLockHeld extends Error {
  override readonly name = "LiveLockHeld";
}

interface Holder {
  pid: number;
  folder: string;
  since: number;
}

const isHolder = (value: unknown): value is Holder =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "pid") === "number" &&
  typeof Reflect.get(value, "folder") === "string" &&
  typeof Reflect.get(value, "since") === "number";

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min ago`;

/** Takes the lock, or throws `LiveLockHeld` naming the live run that holds it. */
export function acquireLiveLock(o: LiveLockOptions): LiveLock {
  const now = o.now ?? (() => Date.now());
  const dir = join(o.home ?? homedir(), ".lookover");
  const holderFile = join(dir, "live-run.json");
  const taken = takeLockNamed(join(dir, "live-run.lock"), holderFile, isHolder);
  if (taken.lock === null) {
    const { holder } = taken;
    const who =
      holder === null
        ? "Another live run holds the lock"
        : `Another live run holds the lock: process ${holder.pid} on the data folder ${holder.folder} since ` +
          `${new Date(holder.since).toISOString()} (${minutes(now() - holder.since)})`;
    throw new LiveLockHeld(
      `${who}. One real review at a time on this machine (ADR 0039): wait for it to stop.`,
    );
  }
  // Put in place whole: a refused run never reads it half written.
  const holder: Holder = { pid: process.pid, folder: o.folder, since: now() };
  writeWhole(holderFile, JSON.stringify(holder));
  const { lock } = taken;
  return { holderFile, release: () => lock.release() };
}
