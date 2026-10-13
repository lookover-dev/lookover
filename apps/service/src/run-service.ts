// The service run as a program, once its configuration is read (ADR 0039, ADR 0054): the one place that chooses what
// the service is wired with. Demo mode plays a scenario on the scripted fakes (ADR 0046); live mode wires the real
// GitHub App and the real `claude` and `codex` on every repository the live config lists (the sandboxes and Lookover's
// own, ADR 0041, ADR 0053; the organisation's App on its repositories when the file lists them, said once at start,
// ADR 0060), under the machine-wide live lock. The program (ADR 0054) wires the same real ones, under
// the same lock, on every repository the App is installed on, or, guarded by a live config, on its repositories only
// with no App ever created; it makes no one-time link at start and serves this clone's web app when the program's build
// made it. The compiled binary (`bun run build`) serves the web app it carries, in every mode. It opens the log first
// (ADR 0054), which every line it prints, the service's log and an uncaught error go through; then it takes the data
// folder's instance lock (one service per data folder, ADR 0054), then the live lock; the program unguarded registers
// start at login on the machine (`osLoginItem`, ADR 0054), and reads and writes `lookover` on the machine's PATH for
// the binary (`osCommandPath`, ADR 0058); every other wiring keeps both in memory; the program and live mode read the
// person's own `gh` (`osGh`, ADR 0059, read only), demo mode the scenario's on testkit's fake; it starts the service
// on the port it served last when it can, says who serves the folder in `instance.json`, announces it to the dev
// launcher when asked, prints the URL to open the app with (the program: the command that opens it, ADR 0058), and
// stops it on SIGINT, SIGTERM or `lookover stop` (`API.stop`), then exits. `lookover serve` (`main.ts`) calls it with
// the real process; a test, with its own.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Clock, Gh } from "@lookover/contracts";
import type { WebBuild } from "./background.ts";
import { type AgentPorts, commandNow } from "./coding-agent.ts";
import { type CommandPath, memoryCommandPath, osCommandPath } from "./command-path.ts";
import { type Config, realSystem, skillFor } from "./config.ts";
import { scenarioOf } from "./demo/scenarios.ts";
import { osGh } from "./gh.ts";
import { InstanceHeld, keptPort, takeInstance } from "./instance.ts";
import { guarded, liveAdapters } from "./live.ts";
import { type LiveConfig, WATCH_IGNORED } from "./live-config.ts";
import { acquireLiveLock, LiveLockHeld } from "./live-lock.ts";
import { type FileLogSink, openLogSink } from "./log-sink.ts";
import { type LoginItem, osLoginItem } from "./login-item.ts";
import { said } from "./said.ts";
import { type RunningService, startDemoService, startService } from "./service.ts";
import {
  DEV_SKILL_NAME,
  memorySkillFolders,
  SKILL_NAME,
  type SkillFolders,
  userSkillFolders,
} from "./skill-folders.ts";
import { makeUserOnly } from "./user-only.ts";
import { VERSION } from "./version.ts";
import { diskWebFiles, type WebFiles } from "./web-files.ts";
import { writeWhole } from "./whole-file.ts";

/** What the program's build (`build:program`, `apps/web/vite.config.ts`) leaves beside `index.html`. */
const PROGRAM_MARKER = "lookover-program.json";

/** Where the program prints: `out` what the owner reads (the URL to open), `err` what went wrong or is ignored. */
export interface Printer {
  out(line: string): void;
  err(line: string): void;
}

/** What the program needs of its process: its signals, its exit, its uncaught errors, asking to exit, and its id. */
export interface ProgramProcess {
  /** An uncaught error's handler is given the error; the others, nothing the program reads. */
  on(
    event: "SIGINT" | "SIGTERM" | "exit" | "uncaughtException" | "unhandledRejection",
    handler: (error?: unknown) => void,
  ): void;
  exit(code: number): void;
  /** Said in `instance.json`, and names the announce file's temporary copy, so two programs never share it. */
  readonly pid: number;
}

/** What the program runs with, beside its configuration: the real ones in `main.ts`. */
export interface ProgramDeps {
  /** The service's `now` in live mode, and when `instance.json` says it started (demo mode runs on its own clock). */
  clock: Clock;
  print: Printer;
  /** The user's home, where the machine-wide live lock lives; `os.homedir()` by default. A test gives a scratch one. */
  lockHome?: string;
  /** Live mode's real adapters, `liveAdapters` by default. A test gives one that throws, so no test can reach `claude`. */
  liveAdapters?: typeof liveAdapters;
  /**
   * The folder of the built web app the program serves, when the program's build made it: by default this clone's
   * `apps/web/dist`. Unused elsewhere.
   */
  webDist?: string;
  /**
   * The web app the compiled binary carries (`bun run build`, ADR 0054): served in every mode, demo mode included,
   * in place of any clone's; none from a clone.
   */
  webFiles?: WebFiles;
  /** Leaves `instance.json`, the data folder and its logs to the user alone; `makeUserOnly` by default (`icacls`). */
  userOnly?: (path: string) => Promise<void>;
  /**
   * The machine's start at login for `command`, which only the program without a live config uses (ADR 0054):
   * `osLoginItem` on this machine by default, which refuses to run under `bun test`. A test gives a fake.
   */
  loginItem?: (command: string[]) => LoginItem;
  /**
   * The machine's `lookover` on the PATH for the binary at `executable`, installed by npm when `launcher` names its
   * launcher (ADR 0061), which only the unguarded program uses (ADR 0058): `osCommandPath` on this machine by
   * default, which refuses to run under `bun test`. A test gives a fake.
   */
  commandPath?: (executable: string, launcher: string | null) => CommandPath;
  /**
   * The coding agents' skill folders for the skill `name` (ADR 0058), which the program and live mode use:
   * `userSkillFolders` in the user's home by default, which refuses to run under `bun test`. A test gives a fake.
   */
  skillFolders?: (name: string) => SkillFolders;
  /**
   * The person's own `gh` (ADR 0059), read only, which the program (guarded or not) and live mode use: `osGh` on this
   * machine by default, which refuses to run under `bun test`. Demo mode never asks: it runs on testkit's fake. A test
   * gives a fake.
   */
  gh?: () => Gh;
  process: ProgramProcess;
}

/**
 * Starts the service `config` describes and keeps it running until a signal or `API.stop` stops it, then exits 0. A
 * data folder another service serves, or a live lock another run holds, is printed, and the program exits 1 without
 * starting (rejecting with `InstanceHeld` or `LiveLockHeld`, for a process that didn't exit). Resolves to the running
 * service, whose `stop` lets both locks go.
 */
export async function runService(config: Config, given: ProgramDeps): Promise<RunningService> {
  const { home } = config;
  const userOnly = given.userOnly ?? makeUserOnly;
  // Every line the program writes goes to the log file, through the filter that removes secrets (ADR 0054), and is
  // printed as the file keeps it; but for the program's own lines to the owner (the URL to open), printed as they are.
  // Demo mode with its clock standing still (`bun run proof`) stamps every line at that instant: the Logs page it
  // shoots is the same from one run to the next (ADR 0055).
  const frozen = config.mode === "demo" ? config.frozen : undefined;
  const sink = await openLogSink({
    home,
    clock: frozen === undefined ? given.clock : { now: () => frozen },
    userOnly,
    print: (line) => given.print.err(line),
  });
  const deps: ProgramDeps = {
    ...given,
    print: {
      out: (line) => {
        sink.keep(line);
        given.print.out(line);
      },
      err: (line) => sink.write(line),
    },
  };
  const uncaught = (error: unknown) => {
    sink.write(
      `Lookover stopped on an error nothing caught: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    deps.process.exit(1);
  };
  deps.process.on("uncaughtException", uncaught);
  deps.process.on("unhandledRejection", uncaught);
  // Before anything else but the log: a second start on this data folder runs nothing, not even the live lock's take.
  const instance = refusedUnless(deps, InstanceHeld, () => takeInstance(home, userOnly));
  let liveLock: { release(): void } | null = null;
  const release = () => {
    liveLock?.release();
    instance.release();
  };
  // A start that fails past this point (an unreadable key file, no `claude`, a refused lock) leaves no lock behind;
  // nor does an exit the program didn't ask for.
  deps.process.on("exit", release);
  /**
   * Ctrl+C, SIGTERM and `lookover stop` (`API.stop`, ADR 0054) alike: the service stopped gracefully, its locks let go,
   * then the process ends. Bound once the program has said it serves: a stop asked before is kept, and done then. The
   * log says what asked for it, and again once stopped (ADR 0055); a log the disk can't take stops neither the stop
   * nor the exit, nor the uncaught error's (the sink's `write` never throws).
   */
  let stopAsked: StopAsker | null = null;
  let stopAndExit = (by: StopAsker) => {
    stopAsked = by;
  };
  let service: RunningService | undefined;
  let agent: AgentPorts | undefined;
  try {
    if (config.mode !== "demo" && config.live?.ignored?.includes("watch")) deps.print.err(WATCH_IGNORED);
    // A copied live.json that runs it as the organisation's App (ADR 0060) says so, so it can't surprise.
    if (config.mode !== "demo" && config.asOrganisation !== undefined) deps.print.out(config.asOrganisation);
    // One real review at a time on this machine (ADR 0039, ADR 0054): a second live service, or the program beside
    // one, refuses with who holds the lock.
    if (config.mode !== "demo")
      liveLock = refusedUnless(deps, LiveLockHeld, () =>
        acquireLiveLock({
          folder: home,
          ...(deps.lockHome === undefined ? {} : { home: deps.lockHome }),
        }),
      );
    agent = agentOn(config, deps);
    service = await start(config, deps, sink, agent, () => stopAndExit("lookover stop"));
    await instance.announce({
      pid: deps.process.pid,
      port: service.port,
      address: service.origin,
      version: VERSION,
      since: deps.clock.now(),
    });
  } catch (error) {
    // A service that started, then failed to say so, stops before its locks go: none serves the folder unlocked.
    await service?.stop();
    release();
    throw error;
  }

  if (config.announce)
    announce(config.announce, {
      origin: service.origin,
      port: service.port,
      openUrl: service.openUrl,
    });
  deps.print.out(
    startLine(config, service, agent === undefined ? "" : await commandNow(agent, (line) => sink.keep(line))),
  );

  const running: RunningService = {
    ...service,
    stop: async () => {
      await service.stop();
      release();
    },
  };
  stopAndExit = (by) => {
    sink.write(`Lookover is stopping (${by})`);
    void running.stop().then(
      () => {
        sink.write("Lookover stopped");
        deps.process.exit(0);
      },
      (error: unknown) => {
        deps.print.err(`Lookover didn't stop cleanly: ${said(error)}`);
        deps.process.exit(1);
      },
    );
  };
  deps.process.on("SIGINT", () => stopAndExit("Ctrl+C"));
  deps.process.on("SIGTERM", () => stopAndExit("SIGTERM"));
  if (stopAsked !== null) stopAndExit(stopAsked);
  return running;
}

/** What asked the program to stop, as its log line says it. */
type StopAsker = "Ctrl+C" | "SIGTERM" | "lookover stop";

/** The line with the link to open the app with; none when the start made no link (the program, ADR 0054). */
const opening = (service: RunningService): string =>
  service.openUrl === null ? "" : `  Open the app: ${service.openUrl}\n`;

/**
 * What the start prints: development, its mode, address and link; the program (ADR 0058), that it runs, whether its
 * live config guards it, and the command that opens it, never the bare address, which opens nothing without a session.
 */
function startLine(config: Config, service: RunningService, command: string): string {
  if (config.mode === "program") {
    const guarded = config.live === undefined ? "" : " Its live config guards it.";
    return `\n  Lookover runs.${guarded} Run \`${command} open\` to open it.\n${opening(service)}`;
  }
  const mode = config.mode === "demo" ? `demo mode, ${config.scenario}` : "live mode";
  return `\n  Lookover service (${mode}) · ${service.origin}\n${opening(service)}`;
}

/** This clone's built web app's folder. */
const CLONE_DIST = join(import.meta.dir, "..", "..", "web", "dist");

/**
 * The web app the program serves (ADR 0054): the one in `dist` when the program's build made it, its marker beside
 * `index.html`; none otherwise, so a demo or live build (with the drawer, or none of the program's client) never is.
 */
function builtWebApp(dist: string): WebFiles | undefined {
  return cloneWebBuild(dist) === "program" ? diskWebFiles(dist) : undefined;
}

/** The web app this clone would serve as the program (`lookover start` refuses to start without it, ADR 0054). */
export function cloneWebBuild(dist: string = CLONE_DIST): WebBuild {
  if (existsSync(join(dist, PROGRAM_MARKER))) return "program";
  return existsSync(join(dist, "index.html")) ? "other" : "missing";
}

/** The service itself, on the port it served last when `config.port` leaves the choice (0). */
async function start(
  config: Config,
  deps: ProgramDeps,
  logSink: FileLogSink,
  agent: AgentPorts,
  stopAsked: () => void,
): Promise<RunningService> {
  const { home, env, git } = config;
  const preferredPort = keptPort(home);
  const server = {
    port: config.port,
    stopAsked,
    ...(preferredPort === undefined ? {} : { preferredPort }),
    ...(config.origin === undefined ? {} : { origin: config.origin }),
    ...(config.eventsKept === undefined ? {} : { eventsKept: config.eventsKept }),
    logSink,
  };
  /**
   * The service on the real GitHub and engines: live mode's, or the program's (ADR 0054), guarded by its live config
   * when it has one, whatever the adapters say. GitHub refusing it at start (down, the key refused, the App not
   * installed) never stops it (ADR 0053): it starts, the connection shows why, and "Reconnect" or the next listing
   * brings it back. The program makes no link at start, and serves the built web app.
   */
  const real = async (
    liveConfig: LiveConfig | undefined,
    processes: string,
    atLogin: string[] | null,
  ): Promise<RunningService> => {
    const program = atLogin !== null;
    // Start at login on the machine for the program alone, and only unguarded (ADR 0054): the loop's runs, guarded by
    // their live config, never register anything on the owner's machine (ADR 0045). Every other wiring: the room's fake.
    const loginItem =
      atLogin !== null && liveConfig === undefined
        ? (deps.loginItem ?? ((command) => osLoginItem(command, realSystem())))(atLogin)
        : undefined;
    const gh = ghOf(deps);
    const adapters = await (deps.liveAdapters ?? liveAdapters)({
      home,
      processes,
      env,
      git,
      config: liveConfig,
      secret: (value) => logSink.secret(value),
      // `live.json`'s organisation App works for the person `gh` names (ADR 0059).
      gh,
    });
    const webFiles = deps.webFiles ?? (program ? builtWebApp(deps.webDist ?? CLONE_DIST) : undefined);
    return await startService({
      ...adapters,
      // Guarded again here, whatever the adapters did: `liveAdapters` guards for `bun run live`, a test's may not.
      github: guarded(adapters.github, liveConfig),
      ...server,
      ...(program ? { startLink: false, namesOpen: true } : {}),
      agent,
      gh,
      ...(webFiles === undefined ? {} : { webFiles }),
      ...(loginItem === undefined ? {} : { loginItem: { item: loginItem, kind: "os" as const } }),
      // One data folder for every repository (ADR 0053): the store at its root, the settings files in it (ADR 0049).
      home,
      clock: deps.clock,
      version: VERSION,
    });
  };
  if (config.mode === "live") return await real(config.live, config.processes, null);
  if (config.mode === "program") return await real(config.live, config.processes, config.atLogin);
  // Demo mode (ADR 0046): the scenario's seed is played on the demo clock before the first request is answered;
  // then the clock flows with the real time, or with `--frozen` (`bun run proof`) stands still at that instant,
  // so two runs serve the same facts. The developer drawer's verbs move the clock and the fake world.
  return await startDemoService({
    ...server,
    home,
    scenario: scenarioOf(config.scenario),
    ...(config.frozen === undefined ? {} : { frozen: config.frozen }),
    ...(deps.webFiles === undefined ? {} : { webFiles: deps.webFiles }),
    version: VERSION,
  });
}

/** The person's `gh` on the real GitHub and engines, read only: the real one under a live config too (ADR 0059). */
const ghOf = (deps: ProgramDeps): Gh => (deps.gh ?? (() => osGh(realSystem())))();

/** The coding agents' skill folders on the real GitHub and engines, and the skill's name in them. */
interface SkillsOn {
  folders: SkillFolders;
  name: string;
}

/**
 * The agents' skill folders for real (ADR 0058): the user's skill for the program unguarded; under a live config
 * (live mode, a guarded program) the dev one beside it, so development never writes over the user's own.
 */
function skillFoldersOf(deps: ProgramDeps, guarded: boolean): SkillsOn {
  const name = guarded ? DEV_SKILL_NAME : SKILL_NAME;
  return { folders: (deps.skillFolders ?? ((n) => userSkillFolders(realSystem(), n)))(name), name };
}

/**
 * Your coding agent as the configuration read it (ADR 0058): the PATH on the machine (`osCommandPath`, or the deps'
 * own) for the unguarded program's binary alone; a fake off the PATH for every other wiring (demo mode, live mode, a
 * live config's guard, a clone), which never writes the user's PATH. The skill in the agents' real folders, the dev
 * one under a live config; demo mode's on the fake. Lookover's command follows the PATH; the skill calls the absolute
 * command.
 */
function agentOn(config: Config, deps: ProgramDeps): AgentPorts {
  const { agent } = config;
  const executable = config.mode === "program" && config.live === undefined ? agent.executable : null;
  const osPath =
    deps.commandPath ??
    ((binary: string, launcher: string | null) => osCommandPath(binary, realSystem(), launcher));
  const skills: SkillsOn =
    config.mode === "demo"
      ? { folders: memorySkillFolders(), name: SKILL_NAME }
      : skillFoldersOf(deps, config.live !== undefined);
  return {
    path:
      executable === null
        ? memoryCommandPath({ folder: agent.folder })
        : osPath(executable, agent.launcher ?? null),
    skills: skills.folders,
    offer: agent.offer,
    command: agent.command,
    skill: skillFor(agent, skills.name),
  };
}

/** What `take` returns; a `Held` it throws is printed, and the program asked to exit 1, before it is thrown on. */
function refusedUnless<T>(deps: ProgramDeps, Held: new (...args: never[]) => Error, take: () => T): T {
  try {
    return take();
  } catch (error) {
    if (!(error instanceof Held)) throw error;
    deps.print.err(error.message);
    deps.process.exit(1);
    // Never reached on the real process, which has exited; a held one is told the start failed.
    throw error;
  }
}

/** Written beside, then put in place whole: whoever waits for the file to exist never reads it half written. */
function announce(file: string, announced: { origin: string; port: number; openUrl: string | null }): void {
  writeWhole(file, JSON.stringify(announced, null, 2));
}
