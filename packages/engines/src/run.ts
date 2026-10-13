// What every engine's run and health check share (see `index.ts`): the run folder, the order of its writes, the
// limits and the signal. Each engine gives its program, its arguments, its environment and its stream reader.
import { tmpdir } from "node:os";
import type {
  EngineActivity,
  EngineHealth,
  EngineRunResult,
  EngineRunSpec,
  ProcessLimits,
  ProcessResult,
  ProcessRunner,
} from "@lookover/contracts";
import { lineSplitter } from "./activity.ts";
import { keep } from "./run-folder.ts";
import type { SelfTestReport } from "./self-test.ts";

/** A program to run: an absolute executable and the arguments that come before the engine's own. */
export interface Program {
  executable: string;
  args: string[];
}

/** The vendor's own login: the program, its arguments and the whole environment it gets (ADR 0048). */
export interface SignInProgram extends Program {
  env: Record<string, string>;
}

/** One engine as `createEngines` dispatches to it. */
export interface Engine {
  run(spec: EngineRunSpec, signal: AbortSignal): Promise<EngineRunResult>;
  health(): Promise<EngineHealth>;
  /** The program a run would start now; null when it isn't installed. */
  program(): Program | null;
  /** The vendor's own login, for a terminal the user signs in at (ADR 0047); null when it isn't installed. */
  signInCommand(): SignInProgram | null;
  /** Lookover's self-test of that program, in `dir` (`self-test.ts`). */
  selfTest(dir: string, signal: AbortSignal): Promise<SelfTestReport>;
}

/** What one engine's run reads from how its program ended. */
type Reading = Pick<EngineRunResult, "outcome" | "text" | "json" | "usage" | "limitUntil" | "limitSaid">;

/** How one engine runs: everything `runProgram` needs from it. */
export interface RunSetup {
  runner: ProcessRunner;
  /** The program, located when the run starts; null when it isn't installed. */
  program: Program | null;
  /** The engine's own arguments for this run, after the program's. */
  args: string[];
  /** The environment the program gets: the service's, through the engine's allow-list (`env.ts`). */
  env: Record<string, string>;
  /** What `run.json` says of the engine beside the invocation: its model, its effort. */
  describe: Record<string, unknown>;
  /** Why the run never started when there is no program: "<engine> is not installed". */
  notInstalled: string;
  /** The outcome, the answer, the tokens and a limit's reset, from how the program ended and what it wrote. */
  read(result: ProcessResult): Reading;
  /** What one whole line of the program's stdout says the engine did, for a run in `cwd` (`activity.ts`). */
  activities(line: string, cwd: string): EngineActivity[];
}

/** What `--version` and the sign-in check may take. */
const HEALTH_LIMITS: ProcessLimits = { wallClockMs: 15_000, idleMs: 15_000 };

/**
 * Runs the program on `spec`: the folder first (a run whose material can't be kept doesn't start), the program
 * held to the spec's limit and killed when `signal` aborts, then the streams and `run.json`. Never throws.
 */
export async function runProgram(
  setup: RunSetup,
  spec: EngineRunSpec,
  signal: AbortSignal,
): Promise<EngineRunResult> {
  const base = { text: "", json: null, usage: null, tookMs: 0, artefactsDir: spec.artefactsDir };
  const crashed: EngineRunResult = { ...base, outcome: "crashed" };
  const { program } = setup;
  const args = program === null ? [] : [...program.args, ...setup.args];
  /** Writes the run folder; false when it can't be, which makes the run `crashed`. */
  const record = (extra: Record<string, unknown>, files: Record<string, string> = {}) =>
    keep(spec.artefactsDir, {
      "prompt.md": spec.prompt,
      ...files,
      "run.json": `${JSON.stringify(
        {
          engine: spec.engine,
          ...setup.describe,
          executable: program?.executable ?? null,
          args,
          cwd: spec.cwd,
          timeoutMs: spec.timeoutMs,
          ...extra,
        },
        null,
        2,
      )}\n`,
    });
  if (signal.aborted) {
    return record({ outcome: "cancelled", end: null }) ? { ...base, outcome: "cancelled" } : crashed;
  }
  if (program === null) {
    record({ outcome: "crashed", end: null, reason: setup.notInstalled });
    return crashed;
  }
  if (!keep(spec.artefactsDir, { "prompt.md": spec.prompt })) return crashed;
  const listen = spec.onActivity;
  /** Whether activities are still handed over: not once `run` resolves, nor once the listener has thrown. */
  let listening = listen !== undefined;
  /** The first error a reader threw: its line gives nothing, `run.json` says why, and the run goes on. */
  let unread: string | null = null;
  const lines = lineSplitter((line) => {
    if (!listening) return;
    let activities: EngineActivity[];
    try {
      activities = setup.activities(line, spec.cwd);
    } catch (error) {
      // This runs in the process's data handler: a throw here would be the service's uncaught exception.
      unread ??= error instanceof Error ? error.message : String(error);
      return;
    }
    for (const activity of activities) {
      if (!listening) return;
      try {
        listen?.(activity);
      } catch {
        // A listener that throws is dropped: the run goes on without it, and `run` never throws.
        listening = false;
      }
    }
  });
  const started = setup.runner.start(
    { executable: program.executable, args, cwd: spec.cwd, env: setup.env, stdin: spec.prompt },
    { wallClockMs: spec.timeoutMs, idleMs: spec.timeoutMs },
    listen === undefined ? undefined : (chunk) => lines.push(chunk),
  );
  const onAbort = () => started.kill();
  signal.addEventListener("abort", onAbort, { once: true });
  const result = await started.result;
  signal.removeEventListener("abort", onAbort);
  // A last line with no newline is read too, and nothing is told once `run` resolves.
  lines.end();
  listening = false;
  const reading = setup.read(result);
  const tookMs = Math.round(result.tookMs);
  const kept = record(
    {
      outcome: reading.outcome,
      end: result.end,
      exitCode: result.exitCode,
      tookMs,
      ...(unread === null ? {} : { unreadActivity: unread }),
    },
    { "stdout.jsonl": result.stdout, "stderr.txt": result.stderr },
  );
  return kept ? { ...reading, tookMs, artefactsDir: spec.artefactsDir } : crashed;
}

/** A health command, run in the temp folder: never in a folder the CLI trusts (ADR 0012). */
export function ask(
  runner: ProcessRunner,
  program: Program,
  args: string[],
  env: Record<string, string>,
): Promise<ProcessResult> {
  return runner.start(
    { executable: program.executable, args: [...program.args, ...args], cwd: tmpdir(), env, stdin: "" },
    HEALTH_LIMITS,
  ).result;
}
