// POSIX: a process group per started program (ADR 0012). The program is spawned detached, which is setsid:
// a new session whose process group id is the program's pid, so `kill(-pid, SIGKILL)` reaches everything it
// spawned that didn't leave the group itself. The creation time comes from `/proc/<pid>/stat` on Linux
// (the start tick since boot, exact) and from `ps -o lstart=` elsewhere (to the second).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Supervisor, Tree } from "./supervisor.ts";

const PS = "/bin/ps";
// In `/proc/<pid>/stat`, after the parenthesised command name, the start time is the 20th field.
const START_TIME_FIELD = 19;

/** Whether an error from `process.kill` or `readFileSync` says the process (or group) is gone. */
function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "ENOENT");
}

/** Sends SIGKILL to the whole group of `pid`; false when the group is already gone. */
function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch (error) {
    if (isGone(error)) return false;
    throw error;
  }
}

function linuxCreationTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
  const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return afterName[START_TIME_FIELD] ?? null;
}

function psCreationTime(pid: number): string | null {
  const ps = spawnSync(PS, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const started = (ps.stdout ?? "").trim();
  return ps.status === 0 && started !== "" ? started : null;
}

function contain(pid: number): Tree {
  return { kill: () => void killGroup(pid), release: () => {} };
}

export function posixSupervisor(): Supervisor {
  return {
    detached: true,
    contain,
    creationTime: process.platform === "linux" ? linuxCreationTime : psCreationTime,
    killTree: (pid) => void killGroup(pid),
  };
}
