// The program's configuration, read here and nowhere else (the `process.env` lint rule): the mode, the data
// folder, the port, the app's origin, where to announce the URL to open, and the live config file (ADR 0039, ADR
// 0053: the repositories the run may use, the App's id and its key's path; ADR 0060: the organisation's App on its
// repositories when the file lists them, for live mode and the guarded program alike). With neither `--demo` nor `--live` it is
// the program (ADR 0054): its data folder the user profile's unless `LOOKOVER_HOME` or `--home` names another, and
// guarded by a live config when the data folder has one or `--live-config` names one.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import type { PathOffer } from "@lookover/contracts";
import type { LookoverCommands } from "./coding-agent.ts";
import { type LiveConfig, liveConfigPath, readLiveConfig, servedLiveConfig } from "./live-config.ts";
import { said } from "./said.ts";
import type { Self } from "./self.ts";
import { commandLine, quoted, skillCommandLine } from "./shell-line.ts";
import type { SkillFor } from "./skill.ts";
import { VERSION } from "./version.ts";

interface Common {
  /**
   * Your coding agent's facts as this start reads them (ADR 0058, `agentConfig`), Lookover's command among them: which
   * of its two forms applies is the PATH's to say, read by the `CommandPath` port once the service runs.
   */
  agent: AgentConfig;
  /** `--home=`, else `LOOKOVER_HOME`, else (the program only) the profile's: the data folder, one for every repository (ADR 0053). */
  home: string;
  /** `--port=`; 0 takes any free port. */
  port: number;
  /** `--origin=`: the app's origin when a dev server proxies `/api` here; otherwise the service's own. */
  origin: string | undefined;
  /** `--announce=<file>`: a JSON file with the origin, the port and the URL to open, for the dev launcher. */
  announce: string | undefined;
  /** `--events-kept=<n>`: how many events a reconnecting UI can have replayed (ADR 0038); the service's default otherwise. */
  eventsKept: number | undefined;
  /** The whole environment, for the programs the service runs (git, the engines). */
  env: Record<string, string>;
  /** The git program, by absolute path, from the PATH. */
  git: string;
}

/**
 * What Your coding agent starts from (ADR 0058): whether the PATH offer applies (the binary's alone), the folder of
 * Lookover's own it puts on the PATH, the binary's path the launcher or link leads to (null from a clone), an npm
 * install's launcher (ADR 0061), Lookover's
 * command whether the PATH reaches it or not, and the absolute command line the installed skill calls
 * (`skillCommand`).
 */
interface AgentConfig {
  offer: PathOffer;
  folder: string;
  executable: string | null;
  /** An npm install's launcher (ADR 0061), whose shim first on the PATH is this Lookover; absent otherwise. */
  launcher?: string;
  command: LookoverCommands;
  /** Empty when no one line holds Lookover's command (`skillRefused` says why). */
  skillCommand: string;
  /** Why no skill can be written here: what installing it refuses with. */
  skillRefused?: string;
}

/** What a run on the real GitHub and engines adds: the process registry, in the data folder. */
interface Real {
  /** The process registry, in the data folder: a start sweeps every orphan a crashed one left. */
  processes: string;
  /**
   * The line the start prints when its live config runs it as the organisation's App (`servedLiveConfig`, ADR
   * 0060); absent otherwise.
   */
  asOrganisation?: string;
}

/**
 * Demo mode wires the fakes; live mode the real GitHub App and `claude` on the repositories its live config lists
 * (ADR 0041); the program the real ones on every repository the App is installed on, cut to its live config's when
 * it has one (ADR 0054).
 */
export type Config =
  | (Common & {
      mode: "demo";
      /**
       * `--frozen=<ms>`: the clock stands at that instant once the scenario is loaded, so two runs serve the same
       * facts (`bun run proof` shoots the app on the service with it). Demo mode only.
       */
      frozen: number | undefined;
      /** `--scenario=<id>`: the scenario the service starts on (ADR 0046); S10, a quiet day, by default. Demo mode only. */
      scenario: string;
    })
  | (Common & Real & { mode: "live"; live: LiveConfig })
  | (Common &
      Real & {
        mode: "program";
        /** The live config guarding it (the allow-list, no App created); none, nothing is cut and an App may be created. */
        live: LiveConfig | undefined;
        /** What start at login registers for this data folder (`loginCommand`, ADR 0054). */
        atLogin: string[];
      });

/** The machine the configuration is read on: the real one in `main.ts`, another in a test. */
export interface System {
  platform: NodeJS.Platform;
  /** The user's home folder. */
  homedir: string;
  env: Record<string, string | undefined>;
  /** A program's absolute path from the PATH, or null when it isn't there. */
  which(program: string, path: string): string | null;
}

/** How `lookover serve` is called: every flag it reads. */
export const SERVE_USAGE =
  "Usage: lookover serve [--demo [--scenario=<id>] [--frozen=<ms>] | --live] [--live-config=<file>] [--home=<dir>] [--port=<n>] [--origin=<url>] [--announce=<file>] [--events-kept=<n>]";

/**
 * Arguments `lookover` can't read: an option unknown, misspelt or in two words, two modes, a value of the wrong
 * kind. The command says the sentence with its usage and exits 2; any other refusal of the configuration (git not
 * on the PATH, a live config missing or of another shape) is an error, exit 1.
 */
class UsageError extends Error {
  override readonly name = "UsageError";
}

/** The exit code `lookover` ends with when `readConfig` throws `error`: 2 for arguments it can't read, else 1. */
export const refusalExit = (error: unknown): 1 | 2 => (error instanceof UsageError ? 2 : 1);

/** This machine. */
export const realSystem = (): System => ({
  platform: process.platform,
  homedir: homedir(),
  env: process.env,
  which: (program, path) => Bun.which(program, { PATH: path }),
});

/**
 * The program's data folder in the user's profile (ADR 0054, exploration 07): `%LOCALAPPDATA%\Lookover` on Windows,
 * `~/Library/Application Support/Lookover` on macOS, `$XDG_DATA_HOME/lookover` (else `~/.local/share/lookover`)
 * elsewhere; in the OS's own path form, whatever OS reads it.
 */
function profileHome({ platform, homedir: user, env }: System): string {
  if (platform === "win32")
    return win32.join(env.LOCALAPPDATA || win32.join(user, "AppData", "Local"), "Lookover");
  if (platform === "darwin") return posix.join(user, "Library", "Application Support", "Lookover");
  return posix.join(env.XDG_DATA_HOME || posix.join(user, ".local", "share"), "lookover");
}

/** `--<name>=<n>` as a number; undefined when absent. Throws on anything but a whole number. */
function wholeNumber(value: string | undefined, name: string, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} takes ${what}, not "${value}". ${SERVE_USAGE}`);
  return Number(value);
}

/** The environment's variables that are set: what a program the service runs is given. */
export function setVariables(env: System["env"]): Record<string, string> {
  const set: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) set[name] = value;
  return set;
}

/** The environment's PATH, whatever its name's case on Windows, where names ignore it (PowerShell's is `Path`). */
function pathOf(system: System): string {
  const env = setVariables(system.env);
  const path =
    system.platform === "win32"
      ? Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1]
      : env.PATH;
  return path ?? "";
}

/** The whole environment, and git in it. */
function programs(system: System): Pick<Common, "env" | "git"> {
  const env = setVariables(system.env);
  const git = system.which("git", pathOf(system));
  if (!git) throw new Error("git is not on the PATH: the service copies repositories with it.");
  return { env, git };
}

type Mode = Config["mode"];

/** `--demo`, `--live`, or neither: the program. */
function modeOf(argv: string[]): Mode {
  const demo = argv.includes("--demo");
  const live = argv.includes("--live");
  if (demo && live) throw new UsageError(`Pass --demo, --live or neither. ${SERVE_USAGE}`);
  if (demo) return "demo";
  return live ? "live" : "program";
}

/** `--frozen` and `--scenario`, refused outside demo mode. */
function demoOnly(mode: Mode, frozen: number | undefined, scenario: string | undefined): void {
  if (mode === "demo") return;
  const real = mode === "live" ? "live mode" : "the program";
  if (frozen !== undefined)
    throw new UsageError(`--frozen is for demo mode: ${real} runs on the real clock. ${SERVE_USAGE}`);
  if (scenario !== undefined)
    throw new UsageError(`--scenario is for demo mode: ${real} plays no scenario. ${SERVE_USAGE}`);
}

/**
 * Whether there is a live config at `path` to guard the program with. Only a file known to be missing leaves it
 * unguarded: one that can't be looked at (no access, a name too long) refuses it.
 */
function guardIn(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if ("code" in error && error.code === "ENOENT") return false;
    throw new Error(`Can't tell whether there is a live config at ${path}: ${error.message}`);
  }
}

/** `--<name>=<value>`'s value in `argv`; undefined when absent. */
const optionIn = (argv: string[], name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/**
 * Whether this process is `bun test`'s: the marker `LOOKOVER_UNDER_TEST` the test runner's own preload sets
 * (`scripts/test-preload.ts`, named by bunfig.toml), or `NODE_ENV` at `test`, which `bun test` sets only when it is
 * unset. The real start at login refuses to run there (ADR 0045, ADR 0054). Read from this process, never from a
 * `System` a test could hand in.
 */
export const underTest = (): boolean =>
  process.env.LOOKOVER_UNDER_TEST === "1" || process.env.NODE_ENV === "test";

/**
 * What start at login runs (ADR 0054): `lookover start --no-open` by absolute paths, with `--home=` when the data
 * folder isn't the profile's (`LOOKOVER_HOME` is not set at login). `self` is how `lookover` is run (`selfCommand`):
 * Bun and a clone's `main.ts`, or the compiled binary alone.
 */
export function loginCommand(home: string, system: System, self: string[]): string[] {
  return [...self, "start", "--no-open", ...homeOption(home, system)];
}

/** `--home=<home>` when `home` isn't the profile's data folder; nothing when it is. */
function homeOption(home: string, system: System): string[] {
  const profile = profileHome(system);
  // Windows' paths ignore case: `%LOCALAPPDATA%` and a `--home` typed by hand may spell it differently.
  const same = system.platform === "win32" ? home.toLowerCase() === profile.toLowerCase() : home === profile;
  return same ? [] : [`--home=${home}`];
}

/**
 * `lookover` as `self` runs it, by absolute paths: Bun and the clone's `main.ts`, or the binary alone (the source
 * files inside it have a path only it can read). What start at login registers begins with it.
 */
export function selfCommand(self: Self): string[] {
  return self.kind === "clone" ? [self.bun, self.main] : [self.path];
}

/**
 * Lookover's command (ADR 0058): the command line that reaches this Lookover from a terminal, which the screens and
 * the CLI name. `lookover` when the PATH finds this executable (`onPath`: `CommandPath.reachable`); else the binary's absolute
 * path; else, from a clone, `bun run lookover` (it works from the clone's folder). An npm install's is `lookover`
 * whatever the PATH as saved says: npm put it there (ADR 0061). Then `--home=<folder>` when the data folder isn't the
 * profile's, as start at login's command names it. Each word is quoted when the shell needs it (`shell-line.ts`); on
 * Windows the line is PowerShell's.
 */
export function lookoverCommand(self: Self, home: string, system: System, onPath: boolean): string {
  const words = homeOption(home, system).map((word) => quoted(word, system.platform));
  if (self.kind === "clone") return ["bun run lookover", ...words].join(" ");
  if (onPath || self.kind === "npm") return ["lookover", ...words].join(" ");
  return commandLine([self.path, ...homeOption(home, system)], system.platform);
}

/**
 * The command line the installed skill calls (ADR 0058): `lookover` as `self` runs it by absolute paths (the binary,
 * or the clone's Bun and `main.ts`), then `--home=<folder>` when the data folder isn't the profile's, so the agent
 * never depends on its PATH. Written for both a POSIX shell and PowerShell (`skillCommandLine`): on Windows with
 * forward slashes, which Git Bash, PowerShell and Lookover all read, where `\` would be Git Bash's escape.
 */
function skillCommand(
  self: Self,
  home: string,
  system: System,
): Pick<AgentConfig, "skillCommand" | "skillRefused"> {
  const words = [...selfCommand(self), ...homeOption(home, system)];
  try {
    return {
      skillCommand: skillCommandLine(
        system.platform === "win32" ? words.map((w) => w.replaceAll("\\", "/")) : words,
      ),
    };
  } catch (error) {
    // Lookover runs all the same: only the skill is refused, saying why, when it is asked for.
    return { skillCommand: "", skillRefused: said(error) };
  }
}

/** The folder of Lookover's own that "Add to my PATH" puts on it (ADR 0058): never the executable's own folder. */
export function launcherFolder({ platform, homedir: user, env }: System): string {
  if (platform === "win32")
    return win32.join(env.LOCALAPPDATA || win32.join(user, "AppData", "Local"), "Lookover", "bin");
  return posix.join(user, ".local", "bin");
}

/** Your coding agent's facts for `self` on `home` (ADR 0058). */
function agentConfig(self: Self, home: string, system: System): AgentConfig {
  return {
    offer: self.kind,
    folder: launcherFolder(system),
    executable: self.kind === "clone" ? null : self.path,
    ...(self.kind === "npm" ? { launcher: self.launcher } : {}),
    command: {
      onPath: lookoverCommand(self, home, system, true),
      offPath: lookoverCommand(self, home, system, false),
    },
    ...skillCommand(self, home, system),
  };
}

/** What the skill is written for, from the configuration's facts, under `name` (the user's, or the dev one). */
export const skillFor = (agent: AgentConfig, name: string): SkillFor => ({
  name,
  command: agent.skillCommand,
  version: VERSION,
  ...(agent.skillRefused === undefined ? {} : { refused: agent.skillRefused }),
});

/**
 * Whether a live config guards the program on `home` (ADR 0054): `LOOKOVER_LIVE_CONFIG` names one, or the data folder
 * has its `live.json`. `lookover status` asks it, to know which start at login the program there would use.
 */
export const guardedHome = (home: string, system: System): boolean =>
  system.env.LOOKOVER_LIVE_CONFIG !== undefined || guardIn(liveConfigPath(home));

/** Whether `arg` names the data folder, `--home=<dir>`: the one form every verb reads. */
export const isHomeOption = (arg: string): boolean => arg.startsWith("--home=");

/** The data folder `--home=` names, else `LOOKOVER_HOME`, made absolute; undefined when neither does. */
function givenHome(argv: string[], system: System): string | undefined {
  const given = optionIn(argv, "home") ?? system.env.LOOKOVER_HOME;
  return given ? resolve(given) : undefined;
}

/** The program's data folder: `--home=`, else `LOOKOVER_HOME`, else the profile's (ADR 0054). */
export const dataFolder = (argv: string[], system: System): string =>
  givenHome(argv, system) ?? profileHome(system);

/** Said when `--home` comes with its folder as the next word: every verb reads only `--home=<dir>`. */
export const HOME_IN_ONE_WORD = "Pass the data folder as --home=<dir>, in one word.";

/** The flags `serve` reads alone, and those it reads with a value, each with what its value is. */
const SWITCHES = new Set(["--demo", "--live"]);
const VALUED: Record<string, string> = {
  home: "<dir>",
  "live-config": "<file>",
  port: "<n>",
  origin: "<url>",
  announce: "<file>",
  "events-kept": "<n>",
  frozen: "<ms>",
  scenario: "<id>",
};

/**
 * Refuses every argument `serve` doesn't read: one left aside could be a guard the user meant (`--live-config <file>`
 * in two words would run the program unguarded).
 */
function onlyKnown(argv: string[]): void {
  for (const arg of argv) {
    if (SWITCHES.has(arg)) continue;
    const [, name, equals] = /^--([a-z-]+)(=?)/.exec(arg) ?? [];
    const value = name === undefined ? undefined : VALUED[name];
    if (value !== undefined && equals === "=") continue;
    if (arg === "--home") throw new UsageError(`${HOME_IN_ONE_WORD} ${SERVE_USAGE}`);
    if (value !== undefined && arg === `--${name}`)
      throw new UsageError(`Pass ${arg} as ${arg}=${value}, in one word. ${SERVE_USAGE}`);
    throw new UsageError(`lookover serve has no option "${arg}". ${SERVE_USAGE}`);
  }
}

/**
 * The configuration `argv` describes on `system`, for `lookover` run as `self`; throws why not, a `UsageError` for
 * arguments it can't read.
 */
export function readConfig(argv: string[], system: System, self: Self): Config {
  onlyKnown(argv);
  const option = (name: string) => optionIn(argv, name);
  const mode = modeOf(argv);
  const given = givenHome(argv, system);
  // Development keeps its own folders: only the program falls back on the profile's.
  if (!given && mode !== "program")
    throw new UsageError(`Set LOOKOVER_HOME or pass --home=<dir>. ${SERVE_USAGE}`);
  const eventsKept = wholeNumber(option("events-kept"), "events-kept", "a whole number");
  const frozen = wholeNumber(option("frozen"), "frozen", "milliseconds since the epoch");
  const scenario = option("scenario");
  demoOnly(mode, frozen, scenario);
  const home = given ?? profileHome(system);
  const agent = agentConfig(self, home, system);
  const common: Common = {
    home,
    agent,
    port: Number(option("port") ?? 0),
    origin: option("origin"),
    announce: option("announce"),
    eventsKept,
    ...programs(system),
  };
  if (mode === "demo") return { ...common, mode, frozen, scenario: scenario ?? "S10" };
  // One data folder for every repository (ADR 0053): one store, one event log, one process registry at its root.
  const processes = join(common.home, "processes.json");
  // The live config lives in the data folder by default; the dev launcher names another one. One named must exist.
  const named = option("live-config") ?? system.env.LOOKOVER_LIVE_CONFIG;
  const path = resolve(named ?? liveConfigPath(common.home));
  // Live mode needs one. With no "app", the App is the data folder's, or the setup's to give.
  if (mode === "live") return { ...common, mode, ...served(path), processes };
  // The program: guarded when there is one, never run unguarded in its place when one named is missing.
  const guard = named !== undefined || guardIn(path) ? served(path) : { live: undefined };
  return { ...common, mode, ...guard, processes, atLogin: loginCommand(home, system, selfCommand(self)) };
}

/**
 * The live config at `path` as a live service runs on it (ADR 0060): the organisation's App on its repositories when
 * it lists them, the guard's allow-list and the App given alike, and the line the start says it with.
 */
function served(path: string): Pick<Real, "asOrganisation"> & { live: LiveConfig } {
  const { live, said } = servedLiveConfig(readLiveConfig(path), path);
  return { live, ...(said === undefined ? {} : { asOrganisation: said }) };
}
