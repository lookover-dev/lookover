// `lookover start`, `open`, `status` and `stop` (ADR 0054, "One service per data folder", "Links, stop and the
// background"): the service run in the background, and reached while it runs. `start` starts `lookover serve` with
// its own arguments (every file and folder they or `LOOKOVER_HOME` and `LOOKOVER_LIVE_CONFIG` name made absolute: the
// service runs in the user's home) through the `startServe` port (the real one detached from the terminal, `@lookover/process/
// background`; a test's, its child), told to print nothing (`--background`: its lines go to the log only), unless a
// service already holds the data folder, which it reuses (waiting for one still starting to say where it serves);
// then it does what `open` does, and says the terminal can be closed. The program's start refuses a clone whose web
// app is missing or wasn't built for the program. `open` mints a one-time link (`API.link`) and opens the browser on it
// through the `openBrowser` port (`--no-open` prints it only). Neither prints the bare address, which opens nothing
// without a session (ADR 0058): once the browser has the link they say it is opening, and how Lookover's command
// (`lookoverCommand`) gets a link to paste; the link itself only with `--no-open` or a browser that didn't open.
// `status` says running or stopped, where, which data folder, version and process, exit 0 running and 3 stopped. `stop` asks the service to stop (`API.stop`) and waits
// for its lock to be free; one that hasn't let it go 30 s after the ask is killed, only while its lock is held and its
// process is the one `instance.json` named when it was asked. Each reaches the service as the UI does: the data
// folder's session cookie (`<home>/session`) and the exact Origin, `instance.json`'s address. They only probe the
// instance lock, never take it, and trust `instance.json` only while it is held. Each refuses an argument it doesn't
// read (`--home <dir>` in two words among them) before it resolves a data folder, exit 2: `start` as `serve` does, the
// others with their usage. Their exits are the command's (its help, `command.ts`).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { API, type MintedLink } from "@lookover/contracts";
import type { CommandPath } from "./command-path.ts";
import {
  type Config,
  dataFolder,
  guardedHome,
  HOME_IN_ONE_WORD,
  isHomeOption,
  loginCommand,
  lookoverCommand,
  readConfig,
  refusalExit,
  type System,
  selfCommand,
} from "./config.ts";
import { probeInstance, type Serving, servingOf } from "./instance.ts";
import type { LoginItem } from "./login-item.ts";
import type { Printer } from "./run-service.ts";
import { said } from "./said.ts";
import type { Self } from "./self.ts";
import { sessionCookie } from "./service.ts";

/** The background service's start, from the `startServe` port: running while `running()` says so; or why not. */
export type ServeStarted =
  | { started: true; pid: number; inTerminalJob: boolean; running(): boolean }
  | { started: false; reason: string };

/** The web app this clone would serve: built for the program, built otherwise (a demo or live build), or none. */
export type WebBuild = "program" | "other" | "missing";

/** What the four verbs run on, beside the printer and the machine: the real ones in `main.ts`. */
export interface BackgroundPorts {
  /** Starts `lookover serve <args>` out of this terminal: the service, whose own output goes nowhere. */
  startServe(args: string[]): Promise<ServeStarted>;
  /** Opens `url` in the user's browser; false when it couldn't. */
  openBrowser(url: string): Promise<boolean>;
  /** Ends the process `pid` at once, never asking it: a service that didn't answer `stop`. */
  kill(pid: number): void;
  /** The web app the program would serve from this clone. */
  webBuild(): WebBuild;
  /** Now, in ms, and waiting: the real clock, or a test's that jumps. */
  time: { now(): number; sleep(ms: number): Promise<void> };
  /** The machine's start at login for `command` (ADR 0054): `osLoginItem`, only asked, never changed here. */
  loginItem(command: string[]): LoginItem;
  /** The machine's `lookover` on the PATH for the binary at `executable` (ADR 0058): `osCommandPath`, only read here. */
  commandPath(executable: string): CommandPath;
}

interface VerbDeps {
  print: Printer;
  system: System;
  self: Self;
  background: BackgroundPorts;
}

/** How long a start may take to say where it serves; a demo start takes about a second. */
const START_LIMIT_MS = 60_000;
/** How long a stopping service has to let its lock go before it is killed (ADR 0054). */
const STOP_LIMIT_MS = 30_000;
/** How long one request to the service may take before it counts as no answer. */
const ANSWER_LIMIT_MS = 5_000;
const POLL_MS = 50;

/** Said by `open` and `stop` when nothing serves the data folder. */
const NOT_RUNNING = "Lookover isn't running.";

/** `start [serve's arguments] [--no-open]`. */
export async function start(argv: string[], deps: VerbDeps): Promise<number> {
  const args = argv.filter((arg) => arg !== "--no-open");
  let config: Config;
  try {
    config = readConfig(args, deps.system, deps.self);
  } catch (error) {
    deps.print.err(said(error));
    return refusalExit(error);
  }
  if (config.mode === "program" && !builtForTheProgram(deps)) return 1;
  const found = await runningOrStarted(config.home, args, deps);
  if (found === null) return 1;
  const command = await commandOn(config.home, deps);
  const code = await openOn(config.home, command, found.serving, argv.includes("--no-open"), deps);
  if (code !== 0) return code;
  if (found.inTerminalJob)
    deps.print.err(
      "Windows keeps Lookover tied to this terminal: closing it may stop Lookover. Keep it open.",
    );
  else deps.print.out("You can close this terminal.");
  return 0;
}

/** Whether this clone's web app was built for the program; says what to do when it wasn't. */
function builtForTheProgram(deps: VerbDeps): boolean {
  const build = deps.background.webBuild();
  if (build === "program") return true;
  const what =
    build === "missing"
      ? "This clone has no web app built"
      : "This clone's web app wasn't built for the program";
  deps.print.err(`${what} (apps/web/dist). Run \`bun run build\` first, then lookover start again.`);
  return false;
}

/**
 * The service serving `home`: the one running (waited for while it starts), else one started in the background
 * with `args`; null, said, when none came to serve.
 */
async function runningOrStarted(
  home: string,
  args: string[],
  deps: VerbDeps,
): Promise<{ serving: Serving; inTerminalJob: boolean } | null> {
  if (holds(home)) {
    const serving = await servingWhenSaid(home, deps, () => holds(home));
    if (!isServing(serving)) return failedStart(home, serving, deps, null);
    // The data folder only finds it: any other option would have made another service.
    const unused = args.filter((arg) => !isHomeOption(arg));
    const kept =
      unused.length === 0
        ? ""
        : ` It keeps the options it was started with: ${unused.join(" ")} ${unused.length === 1 ? "wasn't" : "weren't"} used.`;
    deps.print.out(`Lookover already runs.${kept}`);
    return { serving, inTerminalJob: false };
  }
  const started = await deps.background.startServe([...absolutePaths(args, deps.system), "--background"]);
  if (!started.started) {
    deps.print.err(`Lookover didn't start: ${started.reason}`);
    return null;
  }
  // Another start may have won the folder meanwhile: then its service is the one waited for.
  const serving = await servingWhenSaid(home, deps, () => started.running() || holds(home));
  if (!isServing(serving)) return failedStart(home, serving, deps, null);
  deps.print.out(`Lookover runs in the background.`);
  return { serving, inTerminalJob: started.inTerminalJob };
}

/** The options of `serve` that name a file or a folder. */
const PATH_OPTIONS = ["home", "live-config", "announce"];

/**
 * `serve`'s arguments with every file and folder made absolute against this terminal's folder, and those
 * `LOOKOVER_HOME` and `LOOKOVER_LIVE_CONFIG` name added as options when no option names them: the background service
 * runs in the user's home, where a relative path names another folder.
 */
function absolutePaths(args: string[], system: System): string[] {
  const made = args.map((arg) => {
    const name = PATH_OPTIONS.find((option) => arg.startsWith(`--${option}=`));
    const value = name === undefined ? "" : arg.slice(name.length + 3);
    return value === "" ? arg : `--${name}=${resolve(value)}`;
  });
  const named = (name: string) => made.some((arg) => arg.startsWith(`--${name}=`));
  const { LOOKOVER_HOME: home, LOOKOVER_LIVE_CONFIG: liveConfig } = system.env;
  if (home && !named("home")) made.push(`--home=${resolve(home)}`);
  if (liveConfig && !named("live-config")) made.push(`--live-config=${resolve(liveConfig)}`);
  return made;
}

/** `open [--home=<dir>] [--no-open]`: exit 3 when nothing serves the data folder, 2 for an argument it doesn't read. */
export async function open(argv: string[], deps: VerbDeps): Promise<number> {
  if (!readsAll("open", argv, deps)) return 2;
  const home = dataFolder(argv, deps.system);
  if (!holds(home)) {
    deps.print.err(`${NOT_RUNNING} Start it with \`${await commandOn(home, deps)} start\`.`);
    return 3;
  }
  const serving = await servingWhenSaid(home, deps, () => holds(home));
  if (!isServing(serving)) return failedStart(home, serving, deps, 1);
  return await openOn(home, await commandOn(home, deps), serving, argv.includes("--no-open"), deps);
}

/** `status [--home=<dir>] [--json]`: exit 0 running, 3 stopped, 2 for an argument it doesn't read. */
export async function status(argv: string[], deps: VerbDeps): Promise<number> {
  if (!readsAll("status", argv, deps)) return 2;
  const home = dataFolder(argv, deps.system);
  const now = statusOf(home, await startsAtLogin(home, deps));
  const atLogin = now.startsAtLogin ? "It starts at login." : "It doesn't start at login.";
  if (argv.includes("--json")) deps.print.out(JSON.stringify(now, null, 2));
  else if (!now.running) deps.print.out(`Lookover is stopped. Data folder: ${home}\n${atLogin}`);
  else if (now.address === null) deps.print.out(`Lookover is starting. Data folder: ${home}\n${atLogin}`);
  else
    deps.print.out(
      [
        `Lookover runs at ${now.address}`,
        `  Data folder  ${home}`,
        `  Version      ${now.version}`,
        `  Process      ${now.pid}`,
        `  Since        ${new Date(now.since).toISOString()}`,
        atLogin,
      ].join("\n"),
    );
  return now.running ? 0 : 3;
}

/**
 * What `status` says, and `--json` prints as it is: stopped, starting (its lock held, `instance.json` not written yet)
 * or running; in all three, whether Lookover starts at login on this data folder.
 */
type Status = { startsAtLogin: boolean } & (
  | { running: false; home: string }
  | { running: true; home: string; address: null }
  | { running: true; home: string; address: string; version: string; pid: number; since: number }
);

function statusOf(home: string, startsAtLogin: boolean): Status {
  if (!holds(home)) return { running: false, home, startsAtLogin };
  const serving = servingOf(home);
  if (serving === null) return { running: true, home, address: null, startsAtLogin };
  const { address, version, pid, since } = serving;
  return { running: true, address, home, version, pid, since, startsAtLogin };
}

/**
 * Whether the program on `home` starts at login (ADR 0054): registered on the machine with the command it registers.
 * A program guarded by a live config registers nothing there, so it doesn't; nor does one the machine can't say of.
 */
async function startsAtLogin(home: string, deps: VerbDeps): Promise<boolean> {
  if (guardedHome(home, deps.system)) return false;
  try {
    return await deps.background
      .loginItem(loginCommand(home, deps.system, selfCommand(deps.self)))
      .registered();
  } catch {
    return false;
  }
}

/**
 * `stop [--home=<dir>]`: exit 0 once nothing serves the data folder, 1 when it couldn't be stopped, 2 for an argument
 * it doesn't read.
 */
export async function stop(argv: string[], deps: VerbDeps): Promise<number> {
  if (!readsAll("stop", argv, deps)) return 2;
  const home = dataFolder(argv, deps.system);
  const { time } = deps.background;
  if (!holds(home)) {
    deps.print.out(NOT_RUNNING);
    return 0;
  }
  const deadline = time.now() + STOP_LIMIT_MS;
  // A service still starting is asked once it says where it serves.
  const said = await servingWhenSaid(home, deps, () => holds(home), deadline);
  const asked = isServing(said) ? said : null;
  if (asked !== null) await post(home, asked, API.stop);
  if (await lockFreeBy(home, deadline, deps)) {
    deps.print.out("Lookover stopped.");
    return 0;
  }
  // Only the process asked, while it still holds the folder: never one that took it since, whatever its id.
  if (asked === null || !holds(home) || servingOf(home)?.pid !== asked.pid) {
    deps.print.err(
      `Lookover didn't stop: the data folder ${home} is held by a process it can't tell is its own.`,
    );
    return 1;
  }
  deps.background.kill(asked.pid);
  if (await lockFreeBy(home, time.now() + ANSWER_LIMIT_MS, deps)) {
    deps.print.out(`Lookover didn't answer in 30 s: process ${asked.pid} was ended.`);
    return 0;
  }
  deps.print.err(`Lookover didn't stop: process ${asked.pid} still holds the data folder ${home}.`);
  return 1;
}

/**
 * Lookover's command for the data folder `home`, as this `lookover` runs (ADR 0058): `lookover` when the PATH as
 * saved reaches this binary (`commandPath`), as the program's service on `home` says it; the absolute command from a
 * clone, under a live config (whose service keeps the PATH in memory) or when the machine can't say.
 */
async function commandOn(home: string, deps: VerbDeps): Promise<string> {
  const { self, system } = deps;
  const read = self.kind === "binary" && !guardedHome(home, system);
  const path = read
    ? await deps.background
        .commandPath(self.path)
        .reachable()
        .catch(() => null)
    : null;
  return lookoverCommand(self, home, system, path?.reach === "yes");
}

/**
 * A link minted on the running service, opened in the browser, or printed with `noOpen` or when it can't be. Never
 * the bare address, which opens nothing without a session (ADR 0058): once the browser was handed the link, what it
 * knows, and `command`'s way to a link to paste.
 */
async function openOn(
  home: string,
  command: string,
  serving: Serving,
  noOpen: boolean,
  deps: VerbDeps,
): Promise<number> {
  const answer = await post(home, serving, API.link);
  if (answer === null || !answer.ok) {
    deps.print.err(
      `Lookover didn't give a link${answer === null ? "" : ` (${answer.status})`}. Its log is in ${join(home, "logs")}.`,
    );
    return 1;
  }
  const { url }: MintedLink = await answer.json();
  if (noOpen) {
    deps.print.out(`Open Lookover (the link works once, within 2 minutes):\n  ${url}`);
    return 0;
  }
  if (await deps.background.openBrowser(url)) {
    deps.print.out("Lookover is opening in your browser.");
    deps.print.out(
      `Don't see it? \`${command} open --no-open\` prints a link to paste (it works once, within 2 minutes).`,
    );
    return 0;
  }
  deps.print.out(
    `The browser didn't open. Open Lookover with this link (it works once, within 2 minutes):\n  ${url}`,
  );
  return 0;
}

/** A POST to the service as the UI makes one: the data folder's cookie and the exact Origin. Null with no answer. */
async function post(home: string, serving: Serving, path: string): Promise<Response | null> {
  let secret: string;
  try {
    secret = readFileSync(join(home, "session"), "utf8");
  } catch {
    return null;
  }
  try {
    return await fetch(`${serving.address}${path}`, {
      method: "POST",
      headers: { cookie: `${sessionCookie(home)}=${secret}`, origin: serving.address },
      signal: AbortSignal.timeout(ANSWER_LIMIT_MS),
    });
  } catch {
    return null;
  }
}

/** Whether a service holds the data folder's lock. */
const holds = (home: string) => probeInstance(home) === "held";

/** Why no service said where it serves: it stopped first, or it was still starting at the deadline. */
type NotServing = "stopped" | "late";

const isServing = (found: Serving | NotServing): found is Serving => typeof found !== "string";

/**
 * What `instance.json` says once the folder's service says where it serves; `stopped` once `alive` says false
 * (callers pass whether the lock is held, so a service that dies starting is seen at once), `late` at `deadline`.
 */
async function servingWhenSaid(
  home: string,
  deps: VerbDeps,
  alive: () => boolean,
  deadline = deps.background.time.now() + START_LIMIT_MS,
): Promise<Serving | NotServing> {
  const { time } = deps.background;
  for (;;) {
    const serving = holds(home) ? servingOf(home) : null;
    if (serving !== null) return serving;
    if (!alive()) return "stopped";
    if (time.now() >= deadline) return "late";
    await time.sleep(POLL_MS);
  }
}

/** Whether the data folder's lock is free by `deadline`. */
async function lockFreeBy(home: string, deadline: number, deps: VerbDeps): Promise<boolean> {
  const { time } = deps.background;
  for (;;) {
    if (!holds(home)) return true;
    if (time.now() >= deadline) return false;
    await time.sleep(POLL_MS);
  }
}

/** A start that never said where it serves, and why: where to look; then `answer`, what the caller returns. */
function failedStart<T>(home: string, why: NotServing, deps: VerbDeps, answer: T): T {
  const log = join(home, "logs");
  deps.print.err(
    why === "stopped"
      ? `Lookover didn't start: its log is in ${log}.`
      : `Lookover is still starting after ${START_LIMIT_MS / 1000} s: its log is in ${log}.`,
  );
  return answer;
}

/** How `open`, `status` and `stop` are called, and the one option each reads beside `--home=<dir>`, if any. */
const READS = {
  open: { usage: "lookover open [--home=<dir>] [--no-open]", option: "--no-open" },
  status: { usage: "lookover status [--home=<dir>] [--json]", option: "--json" },
  stop: { usage: "lookover stop [--home=<dir>]", option: undefined },
} as const;

/**
 * Whether `verb` reads every argument of `argv`; else says which it doesn't, with the usage, before any data folder
 * is resolved or service reached: `--home <dir>` in two words would act on another data folder.
 */
function readsAll(verb: keyof typeof READS, argv: string[], deps: VerbDeps): boolean {
  const { usage, option } = READS[verb];
  const unread = argv.find((arg) => !isHomeOption(arg) && arg !== option);
  if (unread === undefined) return true;
  deps.print.err(
    unread === "--home"
      ? `${HOME_IN_ONE_WORD} Usage: ${usage}`
      : `lookover ${verb} has no option "${unread}". Usage: ${usage}`,
  );
  return false;
}

/** How the four verbs are called, after `serve`'s line in the command's usage. */
export const BACKGROUND_LINES = `       lookover start [serve's options] [--no-open]
       ${READS.open.usage}
       ${READS.status.usage}
       ${READS.stop.usage}`;

/** What each of the four does, in the command's help. */
export const BACKGROUND_HELP = `start      Runs the service in the background (as serve would, with the same options), or finds the one
           running on the data folder, then opens it in your browser. The terminal can then be closed.
open       Opens the running service in your browser: a link that works once, within 2 minutes. --no-open
           prints it instead.
status     Says whether the service runs, where, on which data folder, its version and process, and whether
           it starts at login. Exits 0 running, 3 stopped. --json for a program.
stop       Stops the service, as Ctrl+C would; one that doesn't answer within 30 s is ended.`;
