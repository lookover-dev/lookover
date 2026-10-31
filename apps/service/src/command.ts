// The one `lookover` command (ADR 0054, "One `lookover` command"): reads its first word and hands the rest on.
// `serve` runs the service in the foreground, as its other arguments describe (`readConfig`), printing nothing with
// `--background`; `start`, `open`, `status` and `stop` run it in the background and reach it (`background.ts`); `wait`, `feedback`
// and `reply` are the agent's (`agent-cli`'s `run`, ADR 0043), given `--app` with the slug of the App kept in the
// data folder when neither `--app` nor `LOOKOVER_APP` names one (none kept: `agent-cli` takes the shared App's),
// so `agent-cli` never reads the data folder; plus
// `--version` and `help`; and `--skill`, in no help, the skill it installs, for the build's check. `main.ts` runs it on this machine; a test, with its own.
import { USAGE as AGENT_USAGE } from "@lookover/agent-cli";
import { keptSlug } from "./app-store.ts";
import {
  BACKGROUND_HELP,
  BACKGROUND_LINES,
  type BackgroundPorts,
  open,
  start,
  status,
  stop,
} from "./background.ts";
import {
  type Config,
  dataFolder,
  HOME_IN_ONE_WORD,
  isHomeOption,
  readConfig,
  refusalExit,
  SERVE_USAGE,
  type System,
  skillFor,
} from "./config.ts";
import type { Printer } from "./run-service.ts";
import { said } from "./said.ts";
import type { Self } from "./self.ts";
import { renderSkill } from "./skill.ts";
import { SKILL_NAME } from "./skill-folders.ts";
import { VERSION } from "./version.ts";

/** What the command runs on: the real ones in `main.ts`. */
export interface LookoverDeps {
  print: Printer;
  /** The machine: its environment, the user's profile (the default data folder) and its programs. */
  system: System;
  /** How `lookover` runs here: a clone's `main.ts` on Bun, or the compiled binary (ADR 0054). */
  self: Self;
  /** The agent's command (`agent-cli`'s `run` on this checkout), given its arguments; its exit code. */
  agent(argv: string[]): Promise<number>;
  /**
   * Runs the service `config` describes, printing on `print`; resolves once it serves, and it serves on until it is
   * stopped.
   */
  serve(config: Config, print: Printer): Promise<unknown>;
  /** What `start`, `open`, `status` and `stop` run on: the background start, the browser, the kill, the clock. */
  background: BackgroundPorts;
}

const AGENT_VERBS = new Set(["wait", "feedback", "reply"]);
const HELP = new Set(["help", "--help", "-h"]);

const LOOKOVER_USAGE = `${SERVE_USAGE} [--background]
${BACKGROUND_LINES}
       lookover --version
       lookover help

serve      Runs the service in this terminal until Ctrl+C: the program with neither --demo nor --live, on the
           data folder --home, LOOKOVER_HOME or your profile names. --background prints nothing: its lines
           go to the log only (lookover start passes it).
${BACKGROUND_HELP}
--version  Prints Lookover's version.
help       This list.

--home=<dir> may also come before the command: lookover --home=<dir> open.

Exit (all but wait, feedback and reply): 0 done or running, 1 error, 2 usage, 3 not running (status
and open; stop exits 0 then: nothing is left running).

${AGENT_USAGE}

wait, feedback and reply take the App's slug from the data folder (--home=<dir>, LOOKOVER_HOME, else your
profile's) when neither --app nor LOOKOVER_APP names it, else the shared App's.`;

/**
 * Runs `lookover` with `argv`: its exit code, or null once `serve` serves (the process then runs on until a signal
 * stops it). Never throws for arguments it can't read: it says why and answers 2.
 */
export async function lookover(argv: string[], deps: LookoverDeps): Promise<number | null> {
  const [verb, ...rest] = verbFirst(argv);
  if (verb === undefined || HELP.has(verb)) {
    deps.print.out(LOOKOVER_USAGE);
    return 0;
  }
  if (verb === "--version") {
    deps.print.out(VERSION);
    return 0;
  }
  if (verb === "--skill") return skill(rest, deps);
  if (verb === "serve") return serve(rest, deps);
  if (verb === "start") return start(rest, deps);
  if (verb === "open") return open(rest, deps);
  if (verb === "status") return status(rest, deps);
  if (verb === "stop") return stop(rest, deps);
  if (AGENT_VERBS.has(verb)) {
    // `--home <dir>` would hand the folder on as the agent's argument and read the slug from another data folder.
    if (rest.includes("--home")) {
      deps.print.err(HOME_IN_ONE_WORD);
      return 2;
    }
    return deps.agent([verb, ...(await withApp(rest, deps.system))]);
  }
  deps.print.err(`lookover has no command "${verb}".`);
  deps.print.err(LOOKOVER_USAGE);
  return 2;
}

/**
 * `argv` with its verb first: Lookover's command names the data folder before the verb (`lookover --home=<dir> open`,
 * ADR 0058), which every verb reads after it.
 */
function verbFirst(argv: string[]): string[] {
  const [first, verb, ...rest] = argv;
  if (first === undefined || verb === undefined || !isHomeOption(first)) return argv;
  return [verb, first, ...rest];
}

/** What a service run in the background prints: nothing, its log keeps every line (ADR 0054). */
const SILENT: Printer = { out: () => {}, err: () => {} };

async function serve(argv: string[], deps: LookoverDeps): Promise<number | null> {
  const background = argv.includes("--background");
  let config: Config;
  try {
    config = readConfig(
      argv.filter((arg) => arg !== "--background"),
      deps.system,
      deps.self,
    );
  } catch (error) {
    deps.print.err(said(error));
    return refusalExit(error);
  }
  await deps.serve(config, background ? SILENT : deps.print);
  return null;
}

/**
 * `--skill`, in no help: the skill this Lookover installs, as `serve` with the same arguments would write it, under
 * the user's name; 1 with why when none can be. The build's check runs it on the compiled binary, which must carry
 * the template and render it as the clone does (ADR 0054, 0058).
 */
function skill(argv: string[], deps: LookoverDeps): number {
  try {
    const { agent } = readConfig(argv, deps.system, deps.self);
    deps.print.out(renderSkill(skillFor(agent, SKILL_NAME)));
    return 0;
  } catch (error) {
    deps.print.err(said(error));
    return refusalExit(error);
  }
}

/**
 * The agent's arguments without `--home=`, and `--app` with the data folder's App when neither they nor
 * `LOOKOVER_APP` name one; as they are when the data folder keeps none, for the agent's command to take the shared
 * App's.
 */
async function withApp(argv: string[], system: System): Promise<string[]> {
  const handed = argv.filter((arg) => !isHomeOption(arg));
  const named = argv.some((arg) => arg === "--app" || arg.startsWith("--app=")) || !!system.env.LOOKOVER_APP;
  if (named) return handed;
  const slug = await keptSlug(dataFolder(argv, system));
  return slug === null ? handed : [...handed, "--app", slug];
}
