// Claude: the hardened invocation (ADR 0012), its stream, health. See `index.ts`.
import type { EngineHealth, ProcessRunner } from "@lookover/contracts";
import { z } from "zod";
import { claudeActivitiesOf } from "./activity.ts";
import { OUTSIDE_FILE, PLANTED } from "./bait.ts";
import { allowedEnv, homeOf } from "./env.ts";
import { claudeNpmLauncher, type Host, locateClaude } from "./locate.ts";
import { ask, type Engine, type Program, runProgram } from "./run.ts";
import { selfTest } from "./self-test.ts";
import {
  callsOf,
  claudeLimitOf,
  customisedOf,
  denialsOf,
  deniesAbove,
  outcomeOf,
  readStream,
  saidOf,
  structuredOf,
  usageOf,
} from "./stream.ts";

export interface ClaudeOptions {
  runner: ProcessRunner;
  env: Record<string, string>;
  /** The program given at creation, or null to locate `claude` on each use. */
  program: Program | null;
  model: string;
  host: Host;
  /** The time a limit's reset is read at: one past it or more than 8 days on is none. */
  now: () => number;
}

/** The flags of every run (ADR 0012, exploration 02): read-only tools, nothing of the user's or the repository's setup. */
const HARDENED = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--restricted",
  // No settings source (ADR 0048): the project's and the local settings, already ignored under `--restricted`,
  // and the user's. One argument: an empty value on its own would read as no value at all.
  "--setting-sources=",
  // Every customisation off (CLAUDE.md, skills, plugins, hooks, MCP servers, commands, agents, output styles,
  // auto memory); the sign-in, the model and the built-in tools work as before (2.1.283).
  "--safe-mode",
  "--settings",
  '{"disableAllHooks":true}',
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--disable-slash-commands",
  "--tools",
  "Read,Grep,Glob",
  // `dontAsk` denies every tool that isn't allowed outright, so the three are allowed as a whole: `--restricted`
  // is what confines them to the working directory (a read outside it is refused, proven in `bun run live`).
  // The scoped rule forms (`Read(//<cwd>/**)`, `Read(/**)`) are refused under `dontAsk` on 2.1.283 (I-156).
  "--allowedTools",
  "Read",
  "Grep",
  "Glob",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
];

/** The self-test's model: the cheapest (ADR 0044). */
const SELF_TEST_MODEL = "haiku";

const authStatus = z.object({ loggedIn: z.boolean().default(false) });

export function claude(options: ClaudeOptions): Engine {
  const env = allowedEnv("claude", options.env, options.host);
  const home = homeOf(env, options.host);
  const caseless = options.host.platform === "win32";
  const program = (): Program | null => {
    if (options.program) return options.program;
    const executable = locateClaude(options.env, options.host);
    return executable === null ? null : { executable, args: [] };
  };
  const args = (model: string) => [...HARDENED, "--model", model];
  const runOn =
    (model: string): Engine["run"] =>
    (spec, signal) =>
      runProgram(
        {
          runner: options.runner,
          program: program(),
          args: args(model),
          env,
          describe: { model },
          notInstalled: "claude is not installed",
          read: (result) => {
            const stream = readStream(result.stdout);
            const outcome = outcomeOf(result, stream);
            return {
              outcome,
              ...claudeLimitOf(result, stream, outcome, options.now()),
              text: stream.result?.result ?? "",
              json: structuredOf(stream),
              usage: usageOf(stream),
            };
          },
          activities: (line, cwd) => claudeActivitiesOf(line, { cwd, home, caseless }),
        },
        spec,
        signal,
      );
  return {
    run: runOn(options.model),
    program,
    // `claude auth login` (2.1.283: "Sign in to your Anthropic account"; the subscription is its default).
    signInCommand: () => {
      const found = program();
      return found === null
        ? null
        : { executable: found.executable, args: [...found.args, "auth", "login"], env };
    },
    selfTest: (dir, signal) =>
      selfTest(
        {
          engine: "claude",
          runner: options.runner,
          program: program(),
          env,
          help: ["--help"],
          args: args(SELF_TEST_MODEL),
          run: runOn(SELF_TEST_MODEL),
          denials: (stdout) => denialsOf(stdout).filter((denial) => !deniesAbove(denial)),
          said: saidOf,
          calls: callsOf,
          customised: (stdout) => customisedOf(stdout, PLANTED),
          tried: (stdout) => denialsOf(stdout).some((denial) => denial.includes(OUTSIDE_FILE)),
          wall: "read",
        },
        dir,
        signal,
      ),
    async health(): Promise<EngineHealth> {
      const found = program();
      if (found === null) {
        const npmOnly = options.program === null && claudeNpmLauncher(options.env, options.host) !== null;
        return {
          installed: false,
          version: null,
          signedIn: false,
          ...(npmOnly ? { why: { kind: "npm-launcher" } } : {}),
        };
      }
      const [version, auth] = await Promise.all([
        ask(options.runner, found, ["--version"], env),
        ask(options.runner, found, ["auth", "status"], env),
      ]);
      const printed = version.end === "exited" ? /\d+\.\d+\.\d+/.exec(version.stdout) : null;
      const status =
        auth.end === "exited" && auth.exitCode === 0 ? authStatus.safeParse(parseJson(auth.stdout)) : null;
      return {
        installed: true,
        version: printed?.[0] ?? null,
        signedIn: status?.success === true && status.data.loggedIn,
      };
    },
  };
}

/** The text as JSON, or null when it is none: `auth status` prints JSON, but a broken install may not. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
