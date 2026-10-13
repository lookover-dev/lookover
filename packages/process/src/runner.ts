// The runner: one `start` per program, the result settled when its tree is gone. See `index.ts`.
import { spawn } from "node:child_process";
import type {
  Invocation,
  ProcessEnd,
  ProcessLimits,
  ProcessResult,
  ProcessRunner,
  StartedProcess,
} from "@lookover/contracts";
import { openRegistry, type Registry } from "./registry.ts";
import { pickSupervisor, type Supervisor, type Tree } from "./supervisor.ts";

export interface ProcessRunnerOptions {
  /** Where the pids of running programs are kept for `sweepOrphans`, created on first use. */
  registryFile: string;
  /** What the limits, the grace after exit and `tookMs` count on: the real clock unless given. */
  timers?: Timers;
}

/** Time as the runner reads it: a test moves it by hand, so a limit fires when the test says. */
export interface Timers {
  /** Milliseconds, from any fixed point: only differences are read. */
  now(): number;
  /** Calls `fire` once `ms` have passed; the function returned cancels it. */
  after(ms: number, fire: () => void): () => void;
}

const REAL_TIMERS: Timers = {
  now: () => performance.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

/** What every start and sweep of one runner shares. */
interface Runner {
  supervisor: Supervisor;
  registry: Registry;
  timers: Timers;
  /** The pids this runner is running right now: never orphans, whatever the registry says. */
  own: Set<number>;
}

export function createProcessRunner(options: ProcessRunnerOptions): ProcessRunner {
  const runner: Runner = {
    supervisor: pickSupervisor(),
    registry: openRegistry(options.registryFile),
    timers: options.timers ?? REAL_TIMERS,
    own: new Set(),
  };
  return {
    start: (invocation, limits, onStdout) => start(runner, invocation, limits, onStdout),
    sweepOrphans: async () => sweepOrphans(runner),
  };
}

function sweepOrphans({ supervisor, registry, own }: Runner): number {
  let found = 0;
  for (const entry of registry.list()) {
    if (own.has(entry.pid)) continue;
    // The same pid with another creation time is another program: left alone.
    if (entry.created !== null && supervisor.creationTime(entry.pid) === entry.created) {
      supervisor.killTree(entry.pid);
      found++;
    }
    registry.remove(entry.pid);
  }
  return found;
}

/** How long after the program's exit the pipes may stay open before the result settles without `close`. */
const CLOSE_GRACE_MS = 1000;

/** A tree for a program that never ran: nothing to kill. */
const NO_TREE: Tree = { kill: () => {}, release: () => {} };

function start(
  { supervisor, registry, timers, own }: Runner,
  invocation: Invocation,
  limits: ProcessLimits,
  onStdout?: (chunk: string) => void,
): StartedProcess {
  const startedAt = timers.now();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: supervisor.detached,
      windowsHide: true,
    });
  } catch (error) {
    // A file that is no program (on Windows, `EFTYPE`) throws here instead of emitting `error`: the same end.
    const stderr = error instanceof Error ? error.message : String(error);
    const result = Promise.resolve<ProcessResult>({
      end: "failed_to_start",
      exitCode: null,
      stdout: "",
      stderr,
      tookMs: timers.now() - startedAt,
    });
    return { pid: 0, result, kill: () => {} };
  }
  const pid = child.pid ?? 0;
  const tree = pid === 0 ? NO_TREE : supervisor.contain(pid);
  let stdout = "";
  let stderr = "";
  // A program the registry can't record would outlive a crash unseen: it is killed and counts as never started.
  let registered = pid !== 0;
  if (pid !== 0) {
    try {
      registry.add({ pid, created: supervisor.creationTime(pid) });
      own.add(pid);
    } catch (error) {
      registered = false;
      stderr = `the process registry can't be written: ${error instanceof Error ? error.message : String(error)}\n`;
    }
  }
  let exitCode: number | null = null;
  let end: ProcessEnd = "exited";
  let exited = false;
  /** Ends the run for `reason`, unless the program already exited by itself. */
  const stop = (reason: ProcessEnd) => {
    if (exited) return;
    exited = true;
    end = reason;
    tree.kill();
  };
  const cancelWallClock = timers.after(limits.wallClockMs, () => stop("wall_clock"));
  let cancelIdle = timers.after(limits.idleMs, () => stop("idle"));
  /** The program wrote something: the idle count starts over. */
  const wrote = () => {
    cancelIdle();
    cancelIdle = timers.after(limits.idleMs, () => stop("idle"));
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    wrote();
    onStdout?.(chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    wrote();
  });
  // A program that stops reading (exited, hung, killed) breaks the pipe: that is its end, not a failure here.
  child.stdin?.on("error", () => {});
  child.stdin?.end(invocation.stdin);
  const result = new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let cancelGrace = () => {};
    const settle = (reason: ProcessEnd) => {
      if (settled) return;
      settled = true;
      cancelWallClock();
      cancelIdle();
      cancelGrace();
      tree.release();
      if (registered) {
        own.delete(pid);
        registry.ended(pid);
      }
      resolve({
        end: reason,
        exitCode: reason === "exited" ? exitCode : null,
        stdout,
        stderr,
        tookMs: timers.now() - startedAt,
      });
    };
    child.on("error", (error) => {
      stderr += error.message;
      // No pid: the program never ran, and Node doesn't promise a `close` after that.
      if (pid === 0) settle("failed_to_start");
    });
    child.on("exit", (code) => {
      exitCode = code;
      exited = true;
      // Whatever the program left behind goes with it; `close` waits for the pipes they hold. A process the
      // kill can't reach (on POSIX, one that left the group with setsid) would hold them forever: after the
      // grace the pipes are dropped and the result settles with what was read.
      tree.kill();
      cancelGrace = timers.after(CLOSE_GRACE_MS, () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(end);
      });
    });
    child.on("close", () => settle(pid === 0 ? "failed_to_start" : end));
  });
  if (pid !== 0 && !registered) {
    stop("failed_to_start");
    return { pid: 0, result, kill: () => {} };
  }
  return { pid, result, kill: () => stop("killed") };
}
