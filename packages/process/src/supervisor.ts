// The internal seam between the runner and the OS (ADR 0033: `ProcessSupervisor` is internal to this leaf).
// One implementation per platform, chosen once from `process.platform`; the runner never asks which.
import { posixSupervisor } from "./posix.ts";
import { windowsSupervisor } from "./windows.ts";

/** A started program and everything it spawns, killable as one. */
export interface Tree {
  /** Kills every process of the tree that still runs. Idempotent. */
  kill(): void;
  /** Lets go of the OS handles once the tree is gone. Nothing may be called after it. */
  release(): void;
}

export interface Supervisor {
  /** Whether the program is spawned detached: on POSIX that is its own session, hence its own process group. */
  readonly detached: boolean;
  /** Takes a just-started process in hand, so that `kill` reaches what it spawns too. */
  contain(pid: number): Tree;
  /** The OS's own creation time of the process with this pid, as an opaque string, or null when none runs. */
  creationTime(pid: number): string | null;
  /** Kills the tree rooted at a process this run never contained: a previous run's. */
  killTree(pid: number): void;
}

export function pickSupervisor(): Supervisor {
  return process.platform === "win32" ? windowsSupervisor() : posixSupervisor();
}
