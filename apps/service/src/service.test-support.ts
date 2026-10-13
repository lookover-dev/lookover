// What the service's end-to-end tests share (spec #17): the service in demo mode, in a temporary data folder,
// started in this process and used only as the app uses it, over HTTP and server-sent events. Each test file
// of a concern (`api`, `events`, `queue`, `reads`, `rounds`, `recovery`) starts its own services and stops them
// after each test. `recordedStore` is the store a test watches the service use: every call to its handles, and a
// long event log written in no time; `refusingEnds` one that can't record a run's end, as a full disk.
// By default the service runs on in-process fakes only (spec #69): `FakeGitHost`, `FakeEngines` (Claude signed
// in, every run answered as scripted, its durations on the held clock), `ScriptedRetrieval` (no git) and a
// `DemoClock` standing still at `T0` (the clock and the timers, moved by hand; one can serve two starts on one
// data folder, `start({ time })`, so a restart goes on from the time the first reached). No process is spawned and git never runs, so a test of the queue takes milliseconds. Real git
// and the fake `claude` (`realRetrieval`, `onFake`, `plantedSandbox`) are only for the tests that assert on them.
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Change,
  changeId,
  commitSha,
  type EngineHealth,
  type EngineId,
  type Engines,
  type Event,
  type Gh,
  type IdGen,
  type RepositoryRef,
  repositoryId,
  type SettingValues,
  type Setup,
  SSE,
} from "@lookover/contracts";
import { createEngines, type SelfTestReport, type SelfTests } from "@lookover/engines";
import { createProcessRunner } from "@lookover/process";
import { createRetrieval, type Retrieval } from "@lookover/retrieval";
import type { SettingsFiles } from "@lookover/settings";
import { openStore, type PostKind, type RunEnd, type Store } from "@lookover/store";
import {
  type ClaudeRecording,
  type CodexRecording,
  DemoClock,
  type FakeChange,
  FakeEngines,
  FakeGitHost,
  fakeClaude,
  fakeCodex,
  plantSandbox,
  plantSandboxRules,
  pushSandboxFix,
  SANDBOX_REPOSITORY,
  ScriptedRetrieval,
  type ScriptedRun,
} from "@lookover/testkit";
import {
  appStore,
  buildRoom,
  DAY_MS,
  type GitHubSide,
  type LoginItem,
  type LogReader,
  type LogSink,
  memoryKeychain,
  type RoomOptions,
  type RunningService,
  type SignInOpener,
  type StoredApp,
  startService,
  type Timers,
  type WebFiles,
} from "./index.ts";

/**
 * Each test file's time limit per test. A service on fakes starts and reviews in this process in a few tens of
 * milliseconds; the tests on real git and the fake `claude` chain a dozen git commands and a process: about
 * 2.5 s on an idle machine. `bun run check` runs these files beside every other one and the typecheck, where
 * Bun's 5 s was once too few.
 */
export const TEST_LIMIT_MS = 15_000;

export const T0 = Date.UTC(2026, 9, 6, 8, 52);
export const SANDBOX = SANDBOX_REPOSITORY;
export const OWNER = { id: 1234, login: "sasensi" };
export const BOT = { id: 2001, login: "lookover-spike-sasensi[bot]" };

/**
 * The App `id`, `slug` on `owner`'s personal account, as the service keeps it and the connection shows it: the person
 * is the account.
 */
export const personalApp = (id: number, slug: string, owner = OWNER): StoredApp => ({
  id,
  slug,
  account: { ...owner, type: "User" },
  person: { ...owner },
});
export const SHA1 = commitSha("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
export const SHA1_PUSHED = commitSha("c3d4e5f60718293a4b5c6d7e8f9012345678a1b2");
export const SHA2 = commitSha("b2c3d4e5f60718293a4b5c6d7e8f9012345678a1");
const BASE = commitSha("0123456789abcdef0123456789abcdef01234567");

/** The owner's pull request #1 and octocat's draft #2, as the fake host holds them at the start. */
export const pr1: FakeChange = {
  number: 1,
  title: "Add unpaid filter and rewrite total",
  url: "https://github.com/sasensi/lookover-sandbox/pull/1",
  author: OWNER,
  draft: false,
  fork: false,
  head: { ref: "planted-bugs", sha: SHA1 },
  base: { ref: "main", sha: BASE },
  diff: [{ path: "src/total.ts", side: "head", from: 1, to: 40 }],
};
export const pr2: FakeChange = {
  number: 2,
  title: "Bump the dev dependencies",
  url: "https://github.com/sasensi/lookover-sandbox/pull/2",
  author: { id: 583231, login: "octocat" },
  draft: true,
  fork: false,
  head: { ref: "deps", sha: SHA2 },
  base: { ref: "main", sha: BASE },
  diff: [],
};

const homes: string[] = [];
/** The services and rooms a test started, stopped after it. */
const running: { stop(): Promise<void> }[] = [];

/**
 * A meeting point for two calls to GitHub: each waits there until the other has come too, or `ms` of real time
 * passed (the other never comes while the first is under way), so two requests that could race are both under way.
 */
export function meeting(ms = 300) {
  let came = 0;
  let met = () => {};
  const both = new Promise<void>((resolve) => {
    met = resolve;
  });
  return async <T>(work: () => Promise<T>): Promise<T> => {
    came++;
    if (came >= 2) met();
    await Promise.race([both, new Promise((resolve) => setTimeout(resolve, ms))]);
    return work();
  };
}

export function home(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-service-"));
  homes.push(dir);
  return dir;
}

const GIT = Bun.which("git") ?? "";
// A hand-built environment: nothing of this process's `GIT_*` reaches git, and the user's config stays out.
const envOf = (dir: string) => ({ HOME: dir, USERPROFILE: dir });
const runnerOf = (dir: string) => createProcessRunner({ registryFile: join(dir, "processes.json") });

/** The real `retrieval` on a local bare repository: no network, but git runs. */
export const realRetrieval = (dir: string): Retrieval =>
  createRetrieval({ root: join(dir, "repos"), runner: runnerOf(dir), env: envOf(dir), git: GIT });

/**
 * A host that holds each review it is asked to post while `holding` is on, until `release`: GitHub slow to answer.
 * `asked` settles at the first review held. Turned off, it answers the next ones at once; one held then is never
 * answered unless released.
 */
export class HeldReviews extends FakeGitHost {
  holding = true;
  private heard = () => {};
  readonly asked = new Promise<void>((resolve) => {
    this.heard = resolve;
  });
  private let = () => {};
  private readonly released = new Promise<void>((resolve) => {
    this.let = resolve;
  });

  /** The reviews held so far are answered, as is every later one. */
  release(): void {
    this.holding = false;
    this.let();
  }

  override async publishReview(...args: Parameters<FakeGitHost["publishReview"]>): Promise<string> {
    if (this.holding) {
      this.heard();
      await this.released;
    }
    return super.publishReview(...args);
  }
}

/** A self-test's report with this verdict, as the engines give it. */
const reportOf = (
  verdict: SelfTestReport["verdict"],
  outcome: SelfTestReport["outcome"],
): SelfTestReport => ({
  verdict,
  failures: verdict === "failed" ? ["wall"] : [],
  missingFlags: [],
  outcome,
  usage: null,
  tookMs: 0,
});

/**
 * The engines' self-tests, each passed as soon as it is asked: what the scripted engines of demo mode do, a result
 * that can come back while the room is still starting.
 */
export class PassingSelfTests implements SelfTests {
  program(engine: EngineId): string | null {
    return `/fake/${engine}`;
  }

  selfTest(): Promise<SelfTestReport> {
    return Promise.resolve(reportOf("passed", "ok"));
  }
}

/**
 * The engines' self-tests, ended by hand: each one waits until the test ends it (`end`), or until it is cancelled
 * (the service stopping), which ends it inconclusive as the engines' would. It keeps every one asked for.
 */
export class HeldSelfTests implements SelfTests {
  /** Every self-test asked for, in order: the engine and the folder it was given. */
  readonly ran: { engine: EngineId; dir: string }[] = [];
  private readonly waiting: { engine: EngineId; resolve: (report: SelfTestReport) => void }[] = [];

  program(engine: EngineId): string | null {
    return `/fake/${engine}`;
  }

  selfTest(engine: EngineId, dir: string, signal: AbortSignal): Promise<SelfTestReport> {
    this.ran.push({ engine, dir });
    return new Promise((resolve) => {
      this.waiting.push({ engine, resolve });
      signal.addEventListener("abort", () => resolve(reportOf("inconclusive", "cancelled")), { once: true });
    });
  }

  /**
   * Ends the oldest self-test of `engine` still running: `passed`, `failed` (on the wall), `signed-out` (an
   * inconclusive run: the program said it is signed out), `untried` (inconclusive: the run never tried the wall), or
   * at the plan's limit (inconclusive), resetting at `limitUntil` or saying `limitSaid` (ADR 0055). Throws when none
   * runs.
   */
  end(
    engine: EngineId,
    how: "passed" | "failed" | "signed-out" | "untried" | Pick<SelfTestReport, "limitUntil" | "limitSaid">,
  ): void {
    const at = this.waiting.findIndex((w) => w.engine === engine);
    const [one] = at < 0 ? [] : this.waiting.splice(at, 1);
    if (!one) throw new Error(`no self-test of ${engine} runs`);
    if (typeof how === "object") {
      one.resolve({ ...reportOf("inconclusive", "quota_exhausted"), ...how });
      return;
    }
    const reports = {
      passed: reportOf("passed", "ok"),
      failed: reportOf("failed", "ok"),
      "signed-out": reportOf("inconclusive", "auth_required"),
      untried: reportOf("inconclusive", "ok"),
    } as const;
    one.resolve(reports[how]);
  }
}

/** Timers that never fire while the test runs: the process's timers far behind its clock. */
export const LAGGING: Timers = { after: () => () => {}, now: () => T0 };

/**
 * The held clock's timers for the waits of a day or more only: a month passes in a few dozen fires, the polls and
 * the review's 20-minute limit never firing (a run held across the day's prunes).
 */
export function daysOnly(time: DemoClock): Timers {
  return { after: (ms, fire) => (ms >= DAY_MS ? time.after(ms, fire) : () => {}), now: time.now };
}

/** No terminal in a test: "Sign in" is refused with why, unless the test gives its own opener. */
const NO_TERMINAL: SignInOpener = {
  open: (engine) => Promise.resolve({ opened: false, reason: `nothing opens a terminal for ${engine} here` }),
};

/** A find pass that answers and finds nothing: what `FakeEngines` is scripted with for a round to post. */
const NO_FINDINGS: ScriptedRun = { outcome: "ok", text: '```json\n{"findings": []}\n```' };

/**
 * `FakeEngines` with Claude installed, signed in unless said, and `reviews` find passes scripted, each taking
 * `tookMs` (none: at once) on `time`, the clock the test gives `start` too, so `advance` moves a run's time.
 */
export function fakeEngines(
  options: { signedIn?: boolean; reviews?: number; tookMs?: number; time?: DemoClock } = {},
): FakeEngines {
  const engines = new FakeEngines(options.time === undefined ? {} : { timers: options.time });
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: options.signedIn ?? true });
  const run = options.tookMs === undefined ? NO_FINDINGS : { ...NO_FINDINGS, tookMs: options.tookMs };
  for (let i = 0; i < (options.reviews ?? 0); i++) engines.answer(run);
  return engines;
}

/**
 * Engines whose runs wait until `release` (a review that takes its time, under the test's control) or until
 * the run is cut, which ends it `cancelled` as the real engine would.
 */
export function heldRuns(engines: Engines) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    engines: {
      run: async (spec, signal) => {
        const cut = new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await Promise.race([released, cut]);
        return engines.run(spec, signal);
      },
      health: (engine) => engines.health(engine),
    } satisfies Engines,
    release: () => release(),
  };
}

/**
 * Engines whose runs go through the real `engines` module on the fake `claude` replaying `recording` (and the fake
 * `codex` replaying `codex`, when given: Codex is then installed and signed in), and whose health is answered in
 * memory (two spawns saved per start and per run), Claude signed in unless said.
 */
export function onFake(
  dir: string,
  recordings: [ClaudeRecording, ...ClaudeRecording[]],
  { signedIn = true, codex }: { signedIn?: boolean; codex?: [CodexRecording, ...CodexRecording[]] } = {},
): Engines {
  const real = createEngines({
    runner: runnerOf(dir),
    env: envOf(dir),
    claude: fakeClaude(...recordings),
    ...(codex ? { codex: fakeCodex(...codex) } : {}),
  });
  const health = new FakeEngines();
  health.setHealth("claude", { installed: true, version: "2.1.283", signedIn });
  if (codex) health.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  return { run: (spec, signal) => real.run(spec, signal), health: (e) => health.health(e) };
}

/**
 * The real `engines` module on the fake `claude` replaying `recordings` (Codex not installed): its health, its runs
 * and its self-test (ADR 0044) all through the fake program.
 */
export function onFakeClaude(dir: string, ...recordings: [ClaudeRecording, ...ClaudeRecording[]]) {
  return createEngines({ runner: runnerOf(dir), env: envOf(dir), claude: fakeClaude(...recordings) });
}

/** Ids a test can write by hand: `id-1`, `id-2`…; `from` sets where a service restarted on one home goes on. */
const counter = (from = 0): IdGen => {
  let n = from;
  return { next: () => `id-${++n}` };
};

/**
 * The fake GitHub holding the sandbox's pull requests (`pr1` and `pr2` unless given). Its clock is the service's:
 * a comment is stamped at the time the test has moved to.
 */
const fakeHost = (
  clock: DemoClock,
  changes = [pr1, pr2],
  cloneUrl?: string,
  [repo, ...repositories]: RepositoryRef[] = [SANDBOX],
) =>
  new FakeGitHost({
    repo: repo ?? SANDBOX,
    repositories,
    bot: BOT,
    changes,
    clock,
    ...(cloneUrl === undefined ? {} : { cloneUrl }),
  });

/** The fix commit lands in the planted sandbox, and the fake host shows the new head and the lines its diff has now. */
export function pushFix(host: FakeGitHost, sandboxDir: string): void {
  const { sha, diff } = pushSandboxFix(sandboxDir, GIT);
  host.push({ repo: SANDBOX, number: 1 }, sha, diff);
}

/**
 * GitHub as the fake plays it (ADR 0053): its App, the one the service runs as (as `live.json`'s would be), owned by
 * `owner` (the test's world names the owner), its installation and its repositories, cut to `allowed`; the repository
 * ports the fake itself, signing with the key the service gives it.
 */
export function onFakeGitHub(
  host: FakeGitHost,
  { owner = OWNER, allowed }: { owner?: { id: number; login: string }; allowed?: RepositoryRef[] } = {},
): GitHubSide {
  return {
    installations: {
      convertManifest: (code) => host.convertManifest(code),
      app: async (credentials) => ({ ...(await host.app(credentials)), owner: { ...owner, type: "User" } }),
      installation: (credentials) => host.installation(credentials),
      repositories: (credentials, id) => host.repositories(credentials, id),
    },
    connect: ({ key }) => {
      host.useKey(key);
      return { intake: host, writer: host };
    },
    given: host.credentials(),
    ...(allowed === undefined ? {} : { allowed }),
  };
}

/** An organisation on GitHub: the account of an organisation's App, never the person it works for (ADR 0059). */
export const ACME = { id: 9000, login: "acme", type: "Organization" } as const;

/** ACME's repositories, where its App is installed (`organisationHost`): `web` first. */
export const ACME_WEB: RepositoryRef = { owner: ACME.login, name: "web" };
const ACME_API: RepositoryRef = { owner: ACME.login, name: "api" };

/** `change` (one of the sandbox's, such as `pr1`) as a pull request of ACME's `web`, its number kept. */
export const onAcmeWeb = (change: FakeChange): FakeChange => ({
  ...change,
  repo: ACME_WEB,
  url: change.url.replace("sasensi/lookover-sandbox", "acme/web"),
});

/** GitHub as the fake plays it for ACME: its App, installed on its repositories `web` and `api`, holding `changes`. */
export const organisationHost = (clock: DemoClock, changes: FakeChange[] = []) =>
  new FakeGitHost({
    repo: ACME_WEB,
    repositories: [ACME_API],
    bot: BOT,
    changes,
    clock,
    app: { owner: ACME },
  });

/**
 * The fake's App, which must be ACME's on the fake (`app: { owner: ACME }`), put straight into `dir`'s App store,
 * working for `person` (the owner unless given), and the GitHub side a test's service runs on with it: `start({
 * home: dir, github })`. GitHub describes the App, its installation and its repositories as the fake holds them.
 */
export async function onOrganisationApp(host: FakeGitHost, dir: string, person = OWNER): Promise<GitHubSide> {
  const made = host.onGitHub().app;
  if (made?.owner.id !== ACME.id) throw new Error("The fake's App must be ACME's: `app: { owner: ACME }`");
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  await apps.write({ id: made.id, slug: made.slug, account: ACME, person }, host.credentials().key);
  const { given: _, ...side } = onFakeGitHub(host);
  // The fake's own description of the App: ACME's, never made a person's account.
  return { ...side, installations: host, apps };
}

/**
 * The App a test's service runs as and the setup it starts at: the fake's App, as `live.json`'s would be, owned by
 * the test's owner and cut to its repositories, unless the test brings its own GitHub; set up unless it says.
 */
const appOf = (
  o: { github?: GitHubSide; owner?: { id: number; login: string }; setup?: Setup; setUpAtOnce?: boolean },
  host: FakeGitHost,
  repos: RepositoryRef[],
) => ({
  github: o.github ?? onFakeGitHub(host, { owner: o.owner ?? OWNER, allowed: repos }),
  ...(o.setup === undefined ? {} : { setup: o.setup }),
  ...(o.setUpAtOnce === undefined ? {} : { setUpAtOnce: o.setUpAtOnce }),
});

/** The repositories a test's service watches: those given, else the one given, else the sandbox. */
const watchedOf = (o: { repo?: RepositoryRef; repos?: RepositoryRef[] }): RepositoryRef[] =>
  o.repos ?? [o.repo ?? SANDBOX];

/** What a test's service, or its room alone, starts with. */
export interface StartOptions {
  home?: string;
  eventsKept?: number;
  /** `fakeEngines()` by default. */
  engines?: Engines;
  /** The engines' self-tests (`HeldSelfTests`); none by default, every version counting as passed. */
  selfTests?: SelfTests;
  /** What "Sign in" opens, a stand-in for the terminal; by default nothing opens, and the sign-in is refused. */
  signIn?: SignInOpener;
  /** A `ScriptedRetrieval` by default; `realRetrieval` for a test that asserts on git. */
  retrieval?: Retrieval;
  host?: FakeGitHost;
  /** The repository the service watches: the sandbox unless given (one whose name is no path, say). */
  repo?: RepositoryRef;
  /** The repositories the service watches, in place of `repo`: the default host holds them all, the first first. */
  repos?: RepositoryRef[];
  changes?: FakeChange[];
  cloneUrl?: string;
  /** Where a restart's ids go on, so they don't meet the first start's. */
  idsFrom?: number;
  /** The clock and timers of an earlier start on the same data folder: a restart goes on from its time. */
  time?: DemoClock;
  /** Who the owner is, `OWNER` by default: the planted sandbox's author makes its change the owner's. */
  owner?: { id: number; login: string };
  /**
   * The owner's own values for the sandbox (its depth, say), written to its settings file in `home` before the
   * start (ADR 0049); Lookover's defaults otherwise.
   */
  repositorySettings?: Partial<SettingValues>;
  /** The settings files' port: the disk under `home` unless given (one whose writes fail). */
  settingsFiles?: SettingsFiles;
  /** The store, opened on `home`, for a test whose store fails; one for data thrown away otherwise. */
  store?: Store;
  /**
   * Where the service logs what no request hears of (a review's lines among them, ADR 0055): by default, the start's
   * `logged`, so a test prints nothing; the sink when `logSink` is given.
   */
  log?: (line: string) => void;
  /**
   * Timers other than the held clock's: `LAGGING` for a process whose timers fall behind the clock (a machine
   * that slept), so `time.advance` moves the clock and fires nothing.
   */
  timers?: Timers;
  /** Wired as live mode is: no demo clock, so the drawer's clock verbs answer 501. Demo mode by default. */
  live?: boolean;
  /** The setup a fresh data folder starts at: set up by default. */
  setup?: Setup;
  /** `live.json` names the App: the data folder set up at once, whatever setup it kept. */
  setUpAtOnce?: boolean;
  /**
   * GitHub at the App level, in place of the fake's App given as `live.json`'s (`onFakeGitHub`): the App store's,
   * say.
   */
  github?: GitHubSide;
  /** The built web app the service serves beside its API; none by default, as in development. */
  webFiles?: WebFiles;
  /** Where the server's lines go, and the room's when `log` isn't given (ADR 0054); the console by default. */
  logSink?: LogSink & LogReader;
  /** Start at login's registration (ADR 0054): a fake of the room's own unless given. */
  loginItem?: LoginItem;
  /** Your coding agent's ports and facts (ADR 0058): the room's fakes and defaults unless given. */
  agent?: RoomOptions["agent"];
  /** The person's own `gh` (ADR 0059): none unless given, as a room without one reads it: not installed. */
  gh?: Gh;
}

/** Where the room logs: the test's `log`, else the sink when given, else `logged`. */
function logOf(options: StartOptions, logged: string[]): { log?: (line: string) => void } {
  if (options.log !== undefined) return { log: options.log };
  return options.logSink === undefined ? { log: (line) => logged.push(line) } : {};
}

/** The room's options for a test's start, its fakes and its data folder. */
function roomOf(options: StartOptions) {
  const dir = options.home ?? home();
  const time = options.time ?? new DemoClock({ at: T0 });
  const repos = watchedOf(options);
  const host = options.host ?? fakeHost(time, options.changes, options.cloneUrl, repos);
  const retrieval = options.retrieval ?? new ScriptedRetrieval();
  writeOwn(dir, options.repositorySettings);
  const logged: string[] = [];
  const room = {
    home: dir,
    clock: time,
    timers: options.timers ?? time,
    // Demo mode's clock verbs move the held clock too, through the commands endpoint.
    ...(options.live ? {} : { demoClock: time }),
    ids: counter(options.idsFrom),
    ...appOf(options, host, repos),
    engines: options.engines ?? fakeEngines({ time }),
    // No self-test unless the test is of it: the tests of other concerns run on versions that passed.
    selfTests: options.selfTests ?? null,
    signIn: options.signIn ?? NO_TERMINAL,
    retrieval,
    ...(options.settingsFiles === undefined ? {} : { settingsFiles: options.settingsFiles }),
    version: "0.1.0",
    ...(options.eventsKept === undefined ? {} : { eventsKept: options.eventsKept }),
    // A test's data is thrown away: its store's commits don't wait for the disk (about 3 ms each on Windows).
    store: options.store ?? openStore({ home: dir, durable: false }),
    ...logOf(options, logged),
    ...(options.loginItem === undefined
      ? {}
      : { loginItem: { item: options.loginItem, kind: "memory" as const } }),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.gh === undefined ? {} : { gh: options.gh }),
  } satisfies RoomOptions;
  return { room, host, retrieval, time, logged };
}

export async function start(options: StartOptions = {}) {
  const { room, host, retrieval, time, logged } = roomOf(options);
  // The server's keepalive and its minted links' ages on the same held clock: a test that moves time by a minute sees four.
  const service = await startService({
    ...room,
    serverTimers: time,
    ...(options.webFiles === undefined ? {} : { webFiles: options.webFiles }),
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
  });
  running.push(service);
  return { service, host, retrieval, time, logged };
}

/** The room alone, as `start` builds it, with no server: for a test of what the API doesn't reach yet. */
export async function startRoom(options: StartOptions = {}) {
  const { room: o, host, time, logged } = roomOf(options);
  const room = await buildRoom(o);
  running.push(room);
  return { room, host, time, logged };
}

/** The sandbox's own settings file in `dir`, as the settings writer keeps it: these values over the defaults. */
function writeOwn(dir: string, values: Partial<SettingValues> | undefined): void {
  if (values === undefined) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${String(value)}\n`);
  writeSettings(dir, SANDBOX_SETTINGS, `$schema: lookover.settings/v1\nversion: 1\n${lines.join("")}`);
}

/** Writes a settings file by hand, as an owner would: `file` is its path in the data folder `dir`. */
export function writeSettings(dir: string, file: string, text: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

/** The sandbox's own settings file, in the data folder (ADR 0049). */
export const SANDBOX_SETTINGS = "sasensi/lookover-sandbox/settings.yaml";

/**
 * A handle whose every call is written to `calls` as `<name>.<verb>`, followed, when the call gives a list, by how
 * many rows it gave: what the service read and wrote, and how much of it.
 */
function recorded<T extends object>(name: string, handle: T, calls: string[]): T {
  return new Proxy(handle, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        calls.push(`${name}.${String(key)}${Array.isArray(result) ? ` (${result.length} rows)` : ""}`);
        return result;
      };
    },
  });
}

/**
 * The store on `dir`, for `start({ store })`, with every call the service makes recorded in `calls`, and `past`
 * events in its log before the first: a long history in a test that can't spend a minute writing it (each append is
 * its own committed write, about 3 ms). The earlier events say the service ran; the store's own follow them,
 * numbered on.
 */
export function recordedStore(dir: string, past: number): { store: Store; calls: string[] } {
  const real = openStore({ home: dir, durable: false });
  const calls: string[] = [];
  const earlier: Event[] = Array.from({ length: past }, (_, i) => ({
    type: "service.changed",
    seq: i + 1,
    at: T0 - past + i,
    patch: { state: "running", since: T0 - past + i },
  }));
  const after = (event: Event): Event => ({ ...event, seq: event.seq + past });
  const events: Store["events"] = {
    append: (body) => after(real.events.append(body)),
    all: () => [...earlier, ...real.events.all().map(after)],
    last: () => real.events.last() + past,
  };
  return {
    calls,
    store: {
      migrated: real.migrated,
      inbox: recorded("inbox", real.inbox, calls),
      events: recorded("events", events, calls),
      jobs: recorded("jobs", real.jobs, calls),
      rounds: recorded("rounds", real.rounds, calls),
      rules: recorded("rules", real.rules, calls),
      posts: recorded("posts", real.posts, calls),
      dismissals: recorded("dismissals", real.dismissals, calls),
      pause: recorded("pause", real.pause, calls),
      repos: recorded("repos", real.repos, calls),
      requests: recorded("requests", real.requests, calls),
      selfTests: recorded("selfTests", real.selfTests, calls),
      setup: recorded("setup", real.setup, calls),
      appFlows: recorded("appFlows", real.appFlows, calls),
      close: () => real.close(),
    },
  };
}

/** The store on `dir`, for `start({ store })`, whose record of a run's end of `kind` fails `times` times, as a full disk would. */
export function refusingEnds(dir: string, kind: RunEnd["kind"], times: number): Store {
  const store = openStore({ home: dir, durable: false });
  let left = times;
  return {
    ...store,
    jobs: {
      ...store.jobs,
      runEnded: (id, end, at) => {
        if (end.kind === kind && left > 0) {
          left--;
          throw new Error("disk I/O error");
        }
        return store.jobs.runEnded(id, end, at);
      },
    },
  };
}

/**
 * The store on `dir`, for `start({ store })`, whose record of a post sent (of `kind` only, when given) fails
 * `times` times, as a full disk would: the host took the post, and nothing says so.
 */
export function refusingPosts(dir: string, times: number, kind?: PostKind): Store {
  const store = openStore({ home: dir, durable: false });
  let left = times;
  return {
    ...store,
    posts: {
      ...store.posts,
      sent: (id, sent, hostId) => {
        if (left > 0 && (kind === undefined || sent === kind)) {
          left--;
          throw new Error("disk I/O error");
        }
        store.posts.sent(id, sent, hostId);
      },
    },
  };
}

/**
 * The store on `dir`, for `start({ store })`, whose write of a `run.activity` event fails `times` times after the
 * first `kept` went in, as a full disk would.
 */
export function refusingActivities(dir: string, kept: number, times: number): Store {
  const store = openStore({ home: dir, durable: false });
  let passed = kept;
  let left = times;
  return {
    ...store,
    events: {
      ...store.events,
      append: (body) => {
        if (body.type === "run.activity" && passed-- <= 0 && left > 0) {
          left--;
          throw new Error("disk full");
        }
        return store.events.append(body);
      },
    },
  };
}

/** After each test: stops the services it started, then removes their data folders. */
export async function stopAll(): Promise<void> {
  for (const s of running.splice(0)) await s.stop();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
}

/** The one-time link a demo or live start made; a test of one that made none fails here. */
export function linkOf(service: RunningService): string {
  if (service.openUrl === null) throw new Error("this start made no one-time link");
  return service.openUrl;
}

/** What the app does with the opened URL: follows it once, and keeps the cookie it gets. */
export async function openApp(service: RunningService): Promise<string> {
  const res = await fetch(linkOf(service), { redirect: "manual" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  return cookie.split(";")[0] ?? "";
}

export const api = (service: RunningService, path: string) => `${service.origin}/api/v1${path}`;

export async function snapshot(service: RunningService, cookie: string) {
  const res = await fetch(api(service, "/snapshot"), { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.json();
}

export function post(service: RunningService, cookie: string, body: unknown, origin = service.origin) {
  return fetch(api(service, "/commands"), {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The events of the service's start from its first on, `last` being the stopped service's last: what the restart
 * did before the test connected is replayed (ADR 0038).
 */
export async function sinceStart(service: RunningService, cookie: string, last: number) {
  const headers = { cookie, "last-event-id": String(last + 1) };
  return messages(await fetch(api(service, "/events"), { headers }));
}

/** The number of the last event the stopped service on `dir` recorded. */
export function lastEvent(dir: string): number {
  const store = openStore({ home: dir, durable: false });
  const last = store.events.last();
  store.close();
  return last;
}

interface SseMessage {
  id: string | null;
  event: string | null;
  data: string;
}

/** Reads server-sent events as the browser would: one message per blank line. */
export async function* messages(res: Response): AsyncGenerator<SseMessage> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No body");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const lines = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      const field = (name: string) =>
        lines
          .filter((l) => l.startsWith(`${name}:`))
          .map((l) => l.slice(name.length + 1).trimStart())
          .join("\n");
      if (lines.some((l) => !l.startsWith(":"))) {
        yield { id: field("id") || null, event: field("event") || null, data: field("data") };
      }
      end = buffer.indexOf("\n\n");
    }
  }
}

export async function next(stream: AsyncGenerator<SseMessage>): Promise<SseMessage> {
  const { value, done } = await stream.next();
  if (done) throw new Error("The event stream ended");
  return value;
}

/**
 * Reads events until one of `type`, and gives every event read. A keepalive is not an event: a test that moves
 * time by a minute gets four, and they are passed over.
 */
export async function until(stream: AsyncGenerator<SseMessage>, type: Event["type"]): Promise<Event[]> {
  const seen: Event[] = [];
  for (;;) {
    const message = await next(stream);
    if (message.event === SSE.keepalive) continue;
    const event: Event = JSON.parse(message.data);
    seen.push(event);
    if (event.type === type) return seen;
  }
}

export const expectedChange1: Change = {
  id: changeId("lookover-sandbox#1"),
  repoId: repositoryId("sasensi/lookover-sandbox"),
  number: 1,
  title: "Add unpaid filter and rewrite total",
  openedBy: "sasensi",
  author: "you",
  writtenBy: null,
  headSha: SHA1,
  openedAt: T0,
  draft: false,
  fork: false,
  newCommits: 0,
};

// ---- the queue and the run: "Review now" on the planted sandbox, through the real retrieval, engines, review,
// reconcile and publish, with git on a local bare repository and the fake claude (ADR 0039). ----

/**
 * The sandbox planted in a temporary folder: a dozen git runs, so once per test file, at its load. `remove`
 * goes to the file's `afterAll`.
 */
export function plantedSandbox() {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-sandbox-"));
  const sandbox = plantSandbox(dir, GIT);
  return {
    dir,
    sandbox,
    /** The planted pull request's head. */
    head: sandbox.changes[0]?.head.sha ?? commitSha("0000000"),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * The planted sandbox's pull requests once its rules are planted in `sandboxDir` (`plantSandboxRules`, ADR 0048):
 * `main` holds the owner's `REVIEW.md`, and #1 is at the commit adding its own hostile rules files.
 */
export function withRules(sandboxDir: string, changes: FakeChange[]): FakeChange[] {
  const { sha, diff } = plantSandboxRules(sandboxDir, GIT);
  return changes.map((c) => (c.number === 1 ? { ...c, head: { ...c.head, sha }, diff } : c));
}

export const PLANTED = changeId("lookover-sandbox#1");
/** The fix commit `pushSandboxFix` pushes on pull request #1 (fixed dates: the same sha everywhere). */
export const FIXED = commitSha("4700cffcc191fa0290cc7d91340f924a74c7f803");

/** "Review now" on the planted pull request. */
export const review = (service: RunningService, cookie: string) =>
  post(service, cookie, { type: "review.request", changeId: PLANTED });

/**
 * Engines whose health, once held, answers only when released (an engine slow to say whether it is ready), or
 * throws when failed (a broken adapter: the port promises it never throws).
 */
export function slowHealth(engines: Engines) {
  let held: { asked(): void; answered: Promise<void> } | null = null;
  return {
    engines: {
      run: (spec, signal) => engines.run(spec, signal),
      health: async (engine): Promise<EngineHealth> => {
        const hold = held;
        held = null;
        if (hold) {
          hold.asked();
          await hold.answered;
        }
        return engines.health(engine);
      },
    } satisfies Engines,
    /** The next health check waits for `release` or `fail`; `asked` resolves once it has been asked. */
    hold() {
      let asked = () => {};
      let release = () => {};
      let fail = (_error: Error) => {};
      const wasAsked = new Promise<void>((resolve) => {
        asked = resolve;
      });
      const answered = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      held = { asked, answered };
      return { asked: wasAsked, release, fail };
    },
  };
}
