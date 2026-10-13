// The `process` leaf's interface (ADR 0012, ADR 0033): start a program contained, feed it on stdin, hold it to
// a wall-clock and an idle limit, kill its whole tree, and sweep what a crash left behind. `engines` runs the
// CLIs through it and `retrieval` runs git. How a tree is contained (a Job Object on Windows, a process group
// elsewhere) stays inside the leaf.

export interface Invocation {
  /** The program, by absolute path. Never a shell, never a `.cmd` shim (ADR 0012). */
  executable: string;
  args: string[];
  cwd: string;
  /** The whole environment the program sees: nothing is inherited that isn't here. */
  env: Record<string, string>;
  /** Written to the program's stdin, then stdin is closed. */
  stdin: string;
}

export interface ProcessLimits {
  /** From start to end, whatever the program does. */
  wallClockMs: number;
  /** The longest the program may go without writing to stdout or stderr. */
  idleMs: number;
}

/**
 * How the program ended. `exited`: on its own, with `exitCode`. `wall_clock`, `idle`: killed by a limit.
 * `killed`: by the caller. `failed_to_start`: the program never ran (not found, not executable…), or it
 * was killed as it started because it couldn't be contained (the runner couldn't record it to sweep after a
 * crash); `stderr` holds the reason.
 */
export type ProcessEnd = "exited" | "wall_clock" | "idle" | "killed" | "failed_to_start";

export interface ProcessResult {
  end: ProcessEnd;
  /** Null unless `end` is `exited`. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** From start to end, in milliseconds. */
  tookMs: number;
}

export interface StartedProcess {
  pid: number;
  /** Settles when the whole tree is gone, never rejects. */
  result: Promise<ProcessResult>;
  /** Kills the whole tree. Does nothing once the process has ended. */
  kill(): void;
}

export interface ProcessRunner {
  /**
   * Starts the program contained. Never throws: a program that can't start ends with `failed_to_start`.
   * `onStdout`, when given, gets each chunk of stdout as it arrives, in order, before `result` settles (ADR 0055):
   * the chunks joined are `result.stdout`. A chunk may end mid-line. It must not throw.
   */
  start(invocation: Invocation, limits: ProcessLimits, onStdout?: (chunk: string) => void): StartedProcess;
  /** Kills every tree a previous run of Lookover left running. Returns how many it found. Called once at start. */
  sweepOrphans(): Promise<number>;
}
