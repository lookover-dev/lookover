// Port: the engines (ADR 0028, ADR 0033, ADR 0039). The `engines` package runs the real `claude`; `testkit`'s
// `FakeEngines` answers from a script. Shaped by what the skeleton calls: run one prompt, ask one engine's health.
// An engine run returns the raw answer, never findings: reading the answer is `review`'s (ADR 0028), fenced
// blocks included. JSON comes back only from a structured-output run, which the program validated itself.
import type { EngineActivity } from "./activity.ts";
import type { EngineId } from "./engine.ts";

export interface EngineRunSpec {
  engine: EngineId;
  /** The whole prompt. It goes to the program on stdin, never on the command line (ADR 0012). */
  prompt: string;
  /** Where the program runs: the review worktree. */
  cwd: string;
  /** Wall-clock limit for the run. Past it the whole process tree is killed and the outcome is `timeout`. */
  timeoutMs: number;
  /**
   * The run's folder, kept for inspection and replay. Made if missing. Once `run` resolves, whatever the
   * outcome, it holds `prompt.md` (the prompt as given) and `run.json` (how the run went: `engine` and `outcome`
   * at least), besides the raw output and whatever else the engine leaves. A folder that can't be made or
   * written ends the run `crashed`: `run` still doesn't throw.
   */
  artefactsDir: string;
  /**
   * Called with each activity the engine reports while it runs (ADR 0055), in order, as its output arrives; never
   * after `run` resolves. Left out: nobody listens. A listener that throws is dropped: it is called no more, the
   * error goes no further (not to `run`, not to whoever drives the engine's output or timers), and the run goes on.
   */
  onActivity?: (activity: EngineActivity) => void;
}

/**
 * How a run ended. `ok`: the program answered and exited cleanly. `invalid_output`: it exited cleanly but the
 * answer is not what was asked (`review` decides what that means; the engine reports what it can see, such as
 * an error flag in the stream). `auth_required`: signed out. `quota_exhausted`: the plan's limit. `timeout`,
 * `cancelled`: killed by the limit or by the caller's signal. `crashed`: anything else (not installed, a non-zero
 * exit, unreadable output).
 */
export type EngineRunOutcome =
  | "ok"
  | "invalid_output"
  | "auth_required"
  | "quota_exhausted"
  | "timeout"
  | "crashed"
  | "cancelled";

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface EngineRunResult {
  outcome: EngineRunOutcome;
  /** The answer as text: everything the program wrote as its result, empty when there is none. */
  text: string;
  /**
   * A structured-output run's value, as the program validated it against the run's schema; null for a free-text
   * run, whatever its text holds. The engine never searches the text for JSON.
   */
  json: { value: unknown } | null;
  /** What the run used, in tokens, when the program reports it. */
  usage: EngineUsage | null;
  /** How long the program ran, in ms (ADR 0055): 0 when it never started. */
  tookMs: number;
  /**
   * A run that met the plan's limit (`quota_exhausted`): when the limit resets, in ms since the epoch, as the program
   * said it (ADR 0055). Absent for any other run, and when the program said no time that could be read, or one in
   * the past or more than 8 days away.
   */
  limitUntil?: number;
  /**
   * A run that met the plan's limit with no reset time read: what the program said of the limit, one line as it
   * wrote it, for the log, so the reading can be fixed. Unfiltered: whoever shows it removes its secrets first.
   * Absent otherwise, and when the program said nothing of it.
   */
  limitSaid?: string;
  /** The folder given in the spec, where the run's artefacts now are. */
  artefactsDir: string;
}

/**
 * What a session at the plan's limit said of it (ADR 0055): when the limit resets, which the service holds the engine
 * until; or, with no time read, the engine's words, which the log says once. Both absent for any other session.
 */
export type LimitMet = Pick<EngineRunResult, "limitUntil" | "limitSaid">;

/** Only the limit's own fields of a run, a report or a review's pass: those it has, nothing else carried along. */
export function limitMet(of: LimitMet): LimitMet {
  return {
    ...(of.limitUntil === undefined ? {} : { limitUntil: of.limitUntil }),
    ...(of.limitSaid === undefined ? {} : { limitSaid: of.limitSaid }),
  };
}

export interface EngineHealth {
  installed: boolean;
  /** The program's version, when installed. */
  version: string | null;
  signedIn: boolean;
  /**
   * Why the engine can't be used when the program said more than "not installed" or "signed out", as a fact: the
   * service words it (`engineHealthText`) into `Engine.detail` for the status menu. Left out when there is nothing
   * more to say.
   */
  why?: EngineUnusable;
}

/**
 * Why an engine can't be used though a program was found: signed in another way than with the plan (Codex with an
 * API key or a token, `how` as the CLI says it: "an API key"; Lookover uses the ChatGPT plan only, ADR 0044), only
 * npm's launcher found, which runs the program through Node (Claude, ADR 0012), or a program too old for the model
 * it reviews on (Codex: `version` as it printed it, `model`, and `needs`, the oldest version that serves the model
 * on a plan).
 */
export type EngineUnusable =
  | { kind: "signed-in-otherwise"; how: string }
  | { kind: "npm-launcher" }
  | { kind: "too-old"; version: string; model: string; needs: string };

export interface Engines {
  /**
   * Runs one prompt on one engine. Never throws for anything the engine does: every failure is an outcome.
   * Aborting `signal` kills the process tree and ends the run with `cancelled`.
   */
  run(spec: EngineRunSpec, signal: AbortSignal): Promise<EngineRunResult>;
  /** Whether the engine can review right now: installed, which version, signed in. Never throws. */
  health(engine: EngineId): Promise<EngineHealth>;
}
