// Codex: the hardened invocation (ADR 0012 as ADR 0044 amends it), its stream, health. See `index.ts`.
import type { EngineHealth, EngineUnusable, ProcessRunner } from "@lookover/contracts";
import { codexActivitiesOf } from "./activity.ts";
import { WRITTEN } from "./bait.ts";
import {
  codexCallsOf,
  codexDenialsOf,
  codexLimitOf,
  codexOutcomeOf,
  codexSaidOf,
  codexUsageOf,
  codexWriteRefused,
  readCodexStream,
  refusedInput,
} from "./codex-stream.ts";
import { allowedEnv } from "./env.ts";
import { type Host, locateCodex } from "./locate.ts";
import { ask, type Engine, type Program, runProgram } from "./run.ts";
import { selfTest } from "./self-test.ts";

/** How hard the model thinks: what `model_reasoning_effort` takes. */
export type CodexEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CodexOptions {
  runner: ProcessRunner;
  env: Record<string, string>;
  /** The program given at creation, or null to locate `codex` on each use. */
  program: Program | null;
  model: string;
  effort: CodexEffort;
  host: Host;
  /** The time a limit's reset is read at: a bare time is the next one after it. */
  now: () => number;
}

/**
 * The flags of every run (ADR 0044, the survey of spec #87): events as JSON, no session kept, nothing of the
 * user's setup (config, rules, AGENTS.md, apps, plugins, hooks, tools beyond the shell), the read-only sandbox
 * with no approvals and no web search, and the model's shell given a bare environment.
 */
const HARDENED = [
  "exec",
  "--json",
  "--ephemeral",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "--sandbox",
  "read-only",
  "-c",
  'approval_policy="never"',
  "-c",
  "project_doc_max_bytes=0",
  // No other name read as AGENTS.md either: every default named (ADR 0012, ADR 0048).
  "-c",
  "project_doc_fallback_filenames=[]",
  "-c",
  'web_search="disabled"',
  "-c",
  'shell_environment_policy.inherit="core"',
  // No skills: `--ignore-user-config` leaves them on, the user's and the repository's (`.agents/skills`) listed
  // to the model, which the self-test's live run caught reading a planted one (#91).
  "-c",
  "skills.include_instructions=false",
  // Nor Codex's own bundled skills: no skill at all reaches a review (#235, ADR 0056).
  "-c",
  "skills.bundled.enabled=false",
  ...[
    "apps",
    "plugins",
    "browser_use",
    "computer_use",
    "image_generation",
    "multi_agent",
    "hooks",
    "skill_search",
  ].flatMap((feature) => ["--disable", feature]),
];

/** The self-test's model and effort: the cheapest a ChatGPT plan serves (codex-cli 0.154.0's catalog). */
const SELF_TEST = { model: "gpt-5.6-luna", effort: "low" } as const satisfies {
  model: string;
  effort: CodexEffort;
};

/** On Windows the sandbox runs unelevated: without it every shell command is "blocked by policy" (exploration 02). */
const WINDOWS = ["-c", 'windows.sandbox="unelevated"'];

/** The one sign-in Lookover runs on: the ChatGPT plan's (ADR 0001). An API key or a token is not one. */
const SIGNED_IN = /^Logged in using ChatGPT\s*$/m;
/** Any sign-in `login status` reports: how, before the masked key it may add (`an API key - sk-***`). */
const SIGNED_IN_USING = /^Logged in using (.+?)(?: - .*)?\s*$/m;

/**
 * The oldest codex-cli that serves each model Lookover may review on with a ChatGPT plan: older ones refuse it
 * ("model is not supported"). Its pre-releases count (the desktop app ships `0.162.0-alpha.2`), so a version is
 * compared with the minimum's first pre-release, `-0`. A model not listed has no minimum known.
 */
export const MINIMUM = { "gpt-6.1-sol": "0.162.0" } as const satisfies Record<string, string>;

/** The model Codex reviews on unless the caller names another (ADR 0044 as amended). */
export const CODEX_MODEL: keyof typeof MINIMUM = "gpt-6.1-sol";

/** Why `version` can't review on `model`: too old for it; null when new enough, unread, or no minimum is known. */
function tooOld(version: string | null, model: string): EngineUnusable | null {
  const minimum: Readonly<Record<string, string>> = MINIMUM;
  const needs = minimum[model];
  if (version === null || needs === undefined) return null;
  return Bun.semver.order(version, `${needs}-0`) < 0 ? { kind: "too-old", version, model, needs } : null;
}

/** The version `--version` printed: its first `x.y.z`, a pre-release kept (`0.162.0-alpha.2`). */
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;

export function codex(options: CodexOptions): Engine {
  const env = allowedEnv("codex", options.env, options.host);
  const program = (): Program | null => {
    if (options.program) return options.program;
    const executable = locateCodex(options.env, options.host);
    return executable === null ? null : { executable, args: [] };
  };
  const args = (model: string, effort: CodexEffort, cwd: string) => [
    ...HARDENED,
    ...(options.host.platform === "win32" ? WINDOWS : []),
    "--model",
    model,
    "-c",
    `model_reasoning_effort="${effort}"`,
    "--cd",
    cwd,
    // The prompt is read from stdin.
    "-",
  ];
  const runOn =
    (model: string, effort: CodexEffort): Engine["run"] =>
    (spec, signal) =>
      runProgram(
        {
          runner: options.runner,
          program: program(),
          args: args(model, effort, spec.cwd),
          env,
          describe: { model, effort },
          notInstalled: "codex is not installed",
          read: (result) => {
            const stream = readCodexStream(result.stdout);
            const outcome = codexOutcomeOf(result, stream);
            return {
              outcome,
              ...codexLimitOf(result, stream, outcome, options.now()),
              // No answer, the prompt refused for its length: the refusal is what the run has to say.
              text: stream.answer ?? refusedInput(result.stderr) ?? "",
              json: null,
              usage: codexUsageOf(stream),
            };
          },
          activities: codexActivitiesOf,
        },
        spec,
        signal,
      );
  return {
    run: runOn(options.model, options.effort),
    program,
    // `codex login`: the browser flow on the ChatGPT plan (ADR 0001); `--with-api-key` is the path refused.
    signInCommand: () => {
      const found = program();
      return found === null ? null : { executable: found.executable, args: [...found.args, "login"], env };
    },
    selfTest: (dir, signal) =>
      selfTest(
        {
          engine: "codex",
          runner: options.runner,
          program: program(),
          env,
          help: ["exec", "--help"],
          args: args(SELF_TEST.model, SELF_TEST.effort, dir),
          run: runOn(SELF_TEST.model, SELF_TEST.effort),
          denials: codexDenialsOf,
          said: codexSaidOf,
          calls: codexCallsOf,
          // Codex's stream says nothing of what it loaded: the instructions probe is all there is.
          customised: () => [],
          tried: (stdout) => codexWriteRefused(stdout, WRITTEN),
          wall: "write",
        },
        dir,
        signal,
      ),
    async health(): Promise<EngineHealth> {
      const found = program();
      if (found === null) return { installed: false, version: null, signedIn: false };
      const [version, login] = await Promise.all([
        ask(options.runner, found, ["--version"], env),
        ask(options.runner, found, ["login", "status"], env),
      ]);
      const printed = version.end === "exited" ? VERSION.exec(version.stdout) : null;
      // `login status` answers on stderr (0.154.0); stdout is read too, should a later version move it.
      const said = `${login.stderr}\n${login.stdout}`;
      const answered = login.end === "exited" && login.exitCode === 0;
      const signedIn = answered && SIGNED_IN.test(said);
      // Signed in another way: signed out for Lookover, and the status menu says how (ADR 0044).
      const other = answered && !signedIn ? SIGNED_IN_USING.exec(said)?.[1] : undefined;
      const shown = printed?.[0] ?? null;
      // Too old for its model: not usable, the way npm's launcher isn't, so no review starts on it.
      const old = tooOld(shown, options.model);
      if (old !== null) return { installed: false, version: shown, signedIn, why: old };
      return {
        installed: true,
        version: shown,
        signedIn,
        ...(other === undefined ? {} : { why: { kind: "signed-in-otherwise", how: other } }),
      };
    },
  };
}
