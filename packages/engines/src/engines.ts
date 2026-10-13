// The port: each engine's adapter, dispatched by engine. See `index.ts`.
import type { EngineId, Engines, ProcessRunner } from "@lookover/contracts";
import { claude } from "./claude.ts";
import { CODEX_MODEL, type CodexEffort, codex } from "./codex.ts";
import { codexSaidOf } from "./codex-stream.ts";
import { allowedEnv } from "./env.ts";
import type { Host } from "./locate.ts";
import type { Engine, Program, SignInProgram } from "./run.ts";
import type { SelfTestReport } from "./self-test.ts";
import { saidOf } from "./stream.ts";

export type { CodexEffort } from "./codex.ts";
export type { Program, SignInProgram } from "./run.ts";
export type { SelfTestFailure, SelfTestReport } from "./self-test.ts";

/** Lookover's self-test of each engine's program (ADR 0044): what the service gates a version on. See `index.ts`. */
export interface SelfTests {
  /**
   * The program `engine` would run now, as one line (its executable and the arguments before the engine's own):
   * what a self-test's result is kept under, with the version. Null when it isn't installed.
   */
  program(engine: EngineId): string | null;
  /** Runs the self-test of `engine`'s program in `dir`, a folder of its own (made if missing). Never throws. */
  selfTest(engine: EngineId, dir: string, signal: AbortSignal): Promise<SelfTestReport>;
}

/** The vendor's own sign-in of each engine (ADR 0047): what the service opens a terminal on. See `index.ts`. */
export interface SignIn {
  /**
   * The program and arguments that sign `engine` in, run by the user in a terminal, with the environment a run
   * gets (`engineEnv`): the terminal must give it nothing else. Null when it isn't installed.
   */
  signInCommand(engine: EngineId): SignInProgram | null;
}

export interface EnginesOptions {
  runner: ProcessRunner;
  /**
   * The environment the service received. Each program gets only the variables on its allow-list, then
   * Lookover's own (ADR 0048): never a GitHub token, an API key or anything of Lookover's.
   */
  env: Record<string, string>;
  /** The `claude` program. Located on PATH and in the known install folders when omitted. */
  claude?: Program;
  /** What `claude --model` gets: an alias or a full model name (ADR 0012's default is the latest Opus). */
  model?: string;
  /** The `codex` program: its native executable. Located on PATH and in the known install folders when omitted. */
  codex?: Program;
  /** What `codex exec --model` gets (ADR 0044 as amended: `gpt-6.1-sol`, which a ChatGPT plan serves from codex-cli 0.162). */
  codexModel?: string;
  /**
   * Codex's reasoning effort, passed on every run since `--ignore-user-config` drops the user's own (ADR 0044:
   * `high` for finding, the default; `medium` for confirming).
   */
  codexEffort?: CodexEffort;
  /** The machine the programs run on: what may be run, and where they are installed. This one by default. */
  host?: Host;
  /**
   * The time a limit's reset is read at (ADR 0055): a bare time is the next one after it, and one past it or more
   * than 8 days on is none. The machine's clock by default.
   */
  now?: () => number;
}

/**
 * The environment `engine`'s program gets from `env` on `host` (this machine by default): what `run` and `health`
 * pass it, for whoever runs the program with its own arguments (the recorders).
 */
export function engineEnv(
  engine: EngineId,
  env: Record<string, string>,
  host: Host = process,
): Record<string, string> {
  return allowedEnv(engine, env, host);
}

/** Each engine's reading of a run's `stdout.jsonl` for what its model said and did. */
const SAID = { claude: saidOf, codex: codexSaidOf } satisfies Record<EngineId, (stdout: string) => string[]>;

/**
 * What the model said and did in a run of `engine`, from its `stdout.jsonl`: its text and its tool calls or shell
 * commands, never what a tool or command showed it. For whoever checks a run obeyed nothing it read (`bun run
 * live`'s hostile pull request).
 */
export function saidIn(engine: EngineId, stdout: string): string[] {
  return SAID[engine](stdout);
}

/**
 * How many characters of prompt each engine is sent at most (PR #100's live review): `review` cuts a longer
 * prompt's diff. Codex: codex-cli 0.154.0 refuses an input over 1,048,576 characters; 600,000 keeps a wide margin
 * under it, and leaves the model's context room for the files it reads. Claude: no length refusal is known, but a
 * prompt has to fit its context window with the files it reads; 300,000 characters is about 100,000 tokens.
 */
export const INPUT_LIMITS = { claude: 300_000, codex: 600_000 } as const satisfies Record<EngineId, number>;

export function createEngines(options: EnginesOptions): Engines & SelfTests & SignIn {
  const host = options.host ?? process;
  const now = options.now ?? Date.now;
  const engines = {
    claude: claude({
      runner: options.runner,
      env: options.env,
      program: options.claude ?? null,
      model: options.model ?? "opus",
      host,
      now,
    }),
    codex: codex({
      runner: options.runner,
      env: options.env,
      program: options.codex ?? null,
      model: options.codexModel ?? CODEX_MODEL,
      effort: options.codexEffort ?? "high",
      host,
      now,
    }),
  } satisfies Record<EngineId, Engine>;
  return {
    run: (spec, signal) => engines[spec.engine].run(spec, signal),
    health: (engine) => engines[engine].health(),
    program: (engine) => {
      const found = engines[engine].program();
      return found === null ? null : [found.executable, ...found.args].join(" ");
    },
    selfTest: (engine, dir, signal) => engines[engine].selfTest(dir, signal),
    signInCommand: (engine) => engines[engine].signInCommand(),
  };
}
