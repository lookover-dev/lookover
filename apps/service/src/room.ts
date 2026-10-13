// The engine room (ADR 0046): the part of the service a scenario load replaces. The store, the snapshot, the
// queue, the poller, the runs, the checks, the reactions, the outbox, the owner's dismissals, the event log, and the
// room's own clock and timers: every wait of the room goes through them, so in demo mode one `DemoClock` as both moves the whole room.
// The server (`Bun.serve`, the session, the API, the event streams, on real timers) is `service.ts`'s and stays
// up while a room is built, swapped in and the old one stopped: the API reaches the current room through one
// accessor. Here every port is a parameter; what a room is wired with is `run-service.ts`'s choice.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Gh, GhChoices, GhNoAnswer, GhUnanswered, LimitMet } from "@lookover/contracts";
import {
  apply,
  type ChangeId,
  type Clock,
  type Connection,
  changeId,
  type EngineHealth,
  type EngineId,
  type EngineState,
  type Engines,
  type EventBody,
  type Finding,
  GITHUB_WEB,
  type HostInstallations,
  type IdGen,
  type JobState,
  type LoginItemKind,
  type NoiseChoice,
  type PauseFor,
  type RepositoryId,
  type RepositoryRef,
  type ResolvedSettings,
  type Rule,
  type SettingKey,
  type SettingValues,
  type Setup,
  type State,
  sameRepository,
} from "@lookover/contracts";
import type { SelfTests } from "@lookover/engines";
import { INPUT_LIMITS } from "@lookover/engines";
import { createPublisher } from "@lookover/publish";
import type { Retrieval } from "@lookover/retrieval";
import { createConfirm, createReview } from "@lookover/review";
import type { SettingsFiles } from "@lookover/settings";
import { openStore, type Store } from "@lookover/store";
import { type AppFlow, createAppFlow, type GhRead } from "./app-flow.ts";
import type { Membership, StoredApp } from "./app-store.ts";
import { createChecks } from "./checks.ts";
import {
  type AgentPorts,
  type CodingAgentFlow,
  commandFor,
  createCodingAgent,
  foundOf,
  readAgent,
  refreshSkills,
} from "./coding-agent.ts";
import { memoryCommandPath } from "./command-path.ts";
import { createDismissals, type Dismissing, type DismissRefusal } from "./dismiss.ts";
import { EventLog } from "./events.ts";
import { checkItems, freeGbOf } from "./health-checks.ts";
import {
  createInstallation,
  DISCOVERY_RETRY_MS,
  type GitHubSide,
  type Installation,
} from "./installation.ts";
import { flowLines, logLineOf } from "./log-lines.ts";
import { secretShapesRemoved } from "./log-sink.ts";
import { type LoginItem, memoryLoginItem } from "./login-item.ts";
import { type GhMember, memberOf } from "./membership.ts";
import { createPoller, type Poller } from "./poller.ts";
import { createQueue } from "./queue.ts";
import { createReactions } from "./reactions.ts";
import { createRun } from "./run.ts";
import { createRunFolders } from "./run-folders.ts";
import { said } from "./said.ts";
import { createGate, type Gate, type GateDeps, type RanInto, UNGATED } from "./self-tests.ts";
import { diskSettingsFiles } from "./settings-files.ts";
import {
  openSettings,
  type RepositorySettingsNow,
  type SettingsChanged,
  type SettingsNow,
  type SettingsRefusal,
  type SettingsWriter,
} from "./settings-writer.ts";
import { createSetup, type SetupFlow } from "./setup.ts";
import { createSignIn, type SignInOpener, type SignInRefusal } from "./sign-in.ts";
import { memorySkillFolders, SKILL_NAME } from "./skill-folders.ts";
import {
  appInstalled,
  appMade,
  changeFactsOf,
  changePrefixOf,
  numberOf,
  repoIdOf,
  repositoryOf,
  rulesOf,
  SET_UP,
  settingsOf,
  snapshotOf,
} from "./snapshot.ts";
import { createStartAtLogin, matchedAtStart, startsAtLoginLeft } from "./start-at-login.ts";
import { REAL_TIMERS, type Timers } from "./timers.ts";

/** One find pass may take this long (ADR 0012's wall clock) before the engine is killed. */
const REVIEW_TIMEOUT_MS = 20 * 60_000;

/**
 * The demo clock's controls (ADR 0046): what the developer drawer's clock verbs move. Structurally testkit's
 * `DemoClock`, which demo mode passes as the room's `clock`, `timers` and `demoClock` at once. The room offers
 * the same verbs as its `demo`, each advance or step sent as one `clock` event.
 */
interface DemoClockControls extends DemoClockVerbs {
  /** Drops every armed timer: nothing of a stopped room fires later. The time, and the flow, stay. */
  stop(): void;
}

/** The clock verbs the room offers as its `demo`: how the clock flows, and the developer drawer's moves. */
interface DemoClockVerbs {
  /** Whether the clock flows with the real time. */
  readonly running: boolean;
  /** Its milliseconds per real one while it flows. */
  readonly speed: number;
  /** Flows with the real time at `speed` (its milliseconds per real one), or stands still. */
  set(running: boolean, speed: number): void;
  /** Moves time on by `ms`, firing every timer that falls due, in order. */
  advance(ms: number): Promise<void>;
  /** Advances to the next timer and fires it. False when none is armed. */
  step(): Promise<boolean>;
}

export interface RoomOptions {
  /** The data folder (`LOOKOVER_HOME`): the database, the repository copies and the runs' raw output live there. */
  home: string;
  /**
   * A test seam, which `runService` never passes: the store, already open on `home` (a test's: one whose writes fail,
   * or one for data thrown away, not durable). Without it, the room opens the store itself, durable.
   */
  store?: Store;
  clock: Clock;
  /** New job and run ids. Random by default; a test seeds its own. */
  ids?: IdGen;
  /**
   * GitHub at the App level and where the App comes from (ADR 0053): the room watches what its installation lists,
   * reviews through the repository ports its key signs, and takes the owner and the bot from it.
   */
  github: GitHubSide;
  engines: Engines;
  /**
   * The engines the confirm pass runs on (ADR 0044): the same programs, built with the confirm pass's own effort
   * (Codex at `medium`, the find pass at `high`). `engines` when absent.
   */
  confirmEngines?: Engines;
  /**
   * Lookover's self-test of each engine's program (ADR 0044): a version reviews only once it passed. Null runs no
   * self-test, every version counting as passed: only for the tests of other concerns; demo and live mode pass the
   * `engines` module's.
   */
  selfTests: SelfTests | null;
  /**
   * What "Sign in" opens (ADR 0047): the vendor's login in a terminal in live mode, the scripted engine's own
   * sign-in in demo mode. The room then watches the engine's health until it is ready.
   */
  signIn: SignInOpener;
  retrieval: Retrieval;
  /** The engine's wall-clock limit for one find pass. */
  reviewTimeoutMs?: number;
  /**
   * How the room reaches the settings files (ADR 0049): the disk under `home` unless given, the owner's
   * `settings.yaml` at its root and each repository's in `<owner>/<name>/` (a test's, or the demo
   * driver's whose writes fail on the drawer's fault).
   */
  settingsFiles?: SettingsFiles;
  /**
   * The first-run setup a data folder starts at, written when the store keeps none yet: set up by default; a
   * demo scenario's world, or the first step in live mode with no App named (ADR 0047, ADR 0053). Later starts read
   * what the store kept, unless `setUpAtOnce`.
   */
  setup?: Setup;
  /**
   * `live.json` names the App (ADR 0053): the data folder is set up at once, whatever setup it kept. With no App at
   * all, the setup shows again whatever it kept.
   */
  setUpAtOnce?: boolean;
  /**
   * Demo mode only (S11): the service shows as reached from another device, each session view-only until
   * "Unlock". Absent, as in live mode: no service is reached from elsewhere until a server mode exists.
   */
  remote?: boolean;
  /**
   * GitHub's web address the app's links are built on (`Connection.web`, ADR 0053): `GITHUB_WEB` unless given, as
   * demo mode gives its fake's (`DEMO_API.github`).
   */
  web?: string;
  version: string;
  /**
   * Your coding agent (ADR 0058): the PATH and the agents' skill folders, whether the PATH offer applies, Lookover's
   * command (`lookover` once the PATH reaches this executable), and what the skill is written for. Each part not
   * given: a fake in memory (`memoryCommandPath`, `memorySkillFolders`), the offer the binary's, the command
   * `lookover` (demo mode and the tests), the skill named `lookover-review-loop` calling the command off the PATH.
   * `runService` passes the command its configuration read, and the machine's PATH for the unguarded program's binary.
   */
  agent?: Partial<AgentPorts>;
  /** How many events are kept for a UI that reconnects (ADR 0038). Default 1,000. */
  eventsKept?: number;
  /**
   * The room's waits on the clock (the queue's tick, a pause's end, the poll's wake, a refused post's retry): the
   * real timers unless demo mode or a test moves time by hand.
   */
  timers?: Timers;
  /**
   * Demo mode's clock controls (ADR 0046): the same `DemoClock` as `clock` and `timers`, so the developer drawer's
   * `demo.clock`, `demo.advance` and `demo.step` move the room's time. Absent in live mode, where they answer 501.
   */
  demoClock?: DemoClockControls;
  /** Where what no request hears of goes (a refused check, a take that threw): the console unless a test reads it. */
  log?(line: string): void;
  /**
   * The log sink's `secretsRemoved` (ADR 0054, ADR 0055): an engine's activity passes it before it leaves the
   * service. Without a sink, `secretShapesRemoved`: anything shaped like a secret is removed.
   */
  secretsRemoved?(text: string): string;
  /**
   * Start at login's registration on the machine (ADR 0054): the real one only for the program without a live
   * config (`runService` chooses); a fake in memory by default.
   */
  loginItem?: AtLoginItem;
  /**
   * The person's own `gh` (ADR 0059), read only: the real one for the program and live mode, testkit's fake in demo
   * mode (`runService` chooses); none in a test that doesn't ask, read as `gh` not installed. Read when the setup's
   * GitHub step asks (`gh.check`) and when "Create it on GitHub" names an organisation, never for your own account;
   * on an organisation's App, for the person's membership at start, every hour and on `gh.check`.
   */
  gh?: Gh;
}

/** A settings change's answer: written and sent, or refused with why. */
export type SettingsAnswer = "ok" | SettingsRefusal;

/**
 * Why "Too noisy?"'s choice names nothing to quiet: no such change here, no such finding, no rule cited; or, for "This
 * finding is wrong", one settled or kept off the pull request, or a round of the change running.
 */
type NoiseRefusal = "no_such_change" | "no_rule" | "no_such_repository" | DismissRefusal;

/** What an engine's activity passes before it leaves the room (ADR 0055): the sink's, else the shapes'. */
const secretsRemovedOf = (o: Pick<RoomOptions, "secretsRemoved">) => o.secretsRemoved ?? secretShapesRemoved;

/** The running room, as the API reaches it. */
export interface Room {
  /** The UI's state now: what the events made it, as of this moment. */
  snapshot(): State;
  events: EventLog;
  /** The room's clock: the service's `now`, which a quiet stream's keepalive carries. */
  clock: Clock;
  /** Lists the open changes now (after any listing under way), then takes. Throws `HostError` when the host won't. */
  refresh(): Promise<void>;
  /**
   * "Reconnect" (ADR 0047): a listing now, as `refresh`; the poller shows the connection back when it answers, and
   * what waited on it starts. Throws `HostError` when the host still won't, the connection shown disconnected.
   */
  reconnect(): Promise<void>;
  /** "Review now" on a change: the queue's answer. */
  review(changeId: ChangeId): Promise<"ok" | "no_such_change">;
  /** "Check again": the engines' health read again, what changed sent (ADR 0044). */
  checkEngines(): Promise<void>;
  /**
   * "Sign in" (ADR 0047): the engine's login opened and the engine shown signing in, its health then watched every
   * 5 s for up to 10 min, ready clearing it and starting what waited. Refused while one is pending for that
   * engine, or when the login didn't open (the engine not installed, no terminal), with why.
   */
  signIn(engine: EngineId): Promise<"ok" | SignInRefusal>;
  /**
   * "Send the waiting reviews to the other AI" (ADR 0047): every job deferred on `from` that the other engine may
   * review is sent to it and taken; it starts on that engine or waits for it. The next job of each change plans
   * as usual.
   */
  reroute(from: EngineId): void;
  /**
   * "Run all checks" (ADR 0047): `service.changed` with the checks running, both engines' health read again as
   * "Check again" does, then the items: each engine, the connection as of the last listing, the service, the data
   * folder's free space and the version. Refused while the checks run.
   */
  runChecks(): Promise<"ok" | "running">;
  /**
   * A repository said departed (ADR 0059) dismissed by the person: `repo.dismissed` sent, no longer said, back or not.
   * Refused for one not said departed.
   */
  dismissDeparted(repoId: RepositoryId): "ok" | "no_such_repository";
  /** "Unlock" (ADR 0047): the session unlocked, sent once; nothing when it is already. */
  unlock(): void;
  /**
   * The first-run setup and each watched repository's switch (ADR 0047); its finish registers start at login as the
   * owner chose (ADR 0054), and settles once it has.
   */
  setup: Omit<SetupFlow, "finish"> & { finish(): Promise<void> };
  /** The owner's App (ADR 0053): what onboarding's two paths, the manifest flow and "Use an existing App", end with. */
  github: {
    /** The App kept now, never its key; null with none: "Use an existing App" refuses another id while one is kept. */
    app(): StoredApp | null;
    /** Whether the data folder keeps the App (an App store): false when `live.json` names it, which nothing replaces. */
    keepsApps: boolean;
    /** GitHub at the App level: a manifest converted, an App described, its installation. */
    installations: HostInstallations;
    /**
     * An App created or given, adopted without a restart: kept in the App store (its key in the keychain, or the
     * user-only file), the repository ports signing with it from now on, the connection showing it; then its install
     * waited for, or, installed already (a new key for the App kept), its repositories and changes listed again.
     * Rejects when `live.json` names the App (Lookover keeps no other) or the App store can't keep it, nothing kept
     * then. Once kept, it resolves: a listing GitHub refuses is said by the connection's cause. `membership`: what the
     * person's `gh` just answered for an organisation's App, kept with it in place of any answer before (ADR 0059).
     */
    adopt(app: StoredApp, key: string, membership?: Membership): Promise<void>;
    /**
     * `work` after the App's other checks and adoptions, one at a time (one App per data folder): "Use an existing
     * App" and GitHub's redirect back each check which App is kept and adopt theirs inside it, so two tabs giving two
     * Apps at once never both find none kept. `adopt` itself doesn't wait: called inside `work`, it would never run.
     */
    oneAtATime<T>(work: () => Promise<T>): Promise<T>;
    /** The manifest flow (ADR 0053): "Create it on GitHub", its page's flow, and GitHub's redirect back. */
    flow: AppFlow;
    /**
     * The person's own `gh` read again (ADR 0059): who it is signed in as and the organisations they admin, sent as
     * `connection.changed { gh }` when it differs from what the UI holds (without `gh`'s own words, which it answers).
     */
    checkGh(): Promise<GhRead>;
    /**
     * The person's own `gh` asked for its account's membership of `organisation` (ADR 0059): "Use an existing App"
     * on an organisation's App. No `gh`: not installed. When it couldn't answer, its own words go to the log.
     */
    membership(organisation: string): Promise<GhMember>;
    /**
     * The person's membership of the App's organisation asked of their `gh` now (ADR 0059), as the hour's check does:
     * "Check again" (`gh.check`) and the drawer's faults. A member again, GitHub is listed again at once. Nothing for
     * a personal App. Never rejects.
     */
    checkMembership(): Promise<void>;
  };
  /**
   * The settings in their files (ADR 0049): the owner's defaults (`settings.set`), a watched repository's own
   * values (`repo.setSetting`, `repo.resetSetting`; another repository is not one the service watches). Each
   * change is written, then sent as `settings.changed` naming each repository what applies to moved, or
   * refused with why. It counts from the next round.
   */
  settings: {
    setDefault<K extends SettingKey>(key: K, value: SettingValues[K]): Promise<SettingsAnswer>;
    set<K extends SettingKey>(
      repoId: RepositoryId,
      key: K,
      value: SettingValues[K],
    ): Promise<SettingsAnswer | "no_such_repository">;
    reset(repoId: RepositoryId, key: SettingKey): Promise<SettingsAnswer | "no_such_repository">;
    /**
     * `rule.setEnabled` (ADR 0049): a rule switched in the settings file of the watched repository whose rules hold
     * it, then sent as `rule.changed`; neither pass is given it from the next round while it is off. A rule none
     * holds is no such rule.
     */
    setRule(ruleId: string, enabled: boolean): Promise<SettingsAnswer>;
    /**
     * `noise.apply`, "Too noisy?" (ADR 0049, ADR 0052): a finding of the change dismissed as wrong (`dismiss.ts`),
     * the rule it cites switched off, or the repository's strictness set to blocking, each as its own command does
     * it. Refused for a change of no watched repository, a finding the change hasn't, one that cites no rule,
     * or, dismissed, one settled or kept off the pull request, or while a round of the change runs.
     */
    quiet(choice: NoiseChoice): Promise<SettingsAnswer | NoiseRefusal>;
  };
  /**
   * "Start at login" (ADR 0054): once the setup is done, the registration on the machine changed first; then the
   * owner's choice kept and sent as `service.changed`. Refused with the machine's reason, the choice as it was.
   */
  startAtLogin(on: boolean): Promise<"ok" | { refused: string }>;
  /**
   * Your coding agent (ADR 0058): `agent.check` reads the PATH and the skills again; `agent.path` puts Lookover's
   * folder on the PATH or takes it off (the binary alone: refused elsewhere), Lookover's command following;
   * `agent.skill` writes the skill in a found agent's folder, over whatever is there, or removes one a Lookover
   * stamped. Each sends what the machine then says; a write it refuses is refused with its reason.
   */
  agent: Omit<CodingAgentFlow, "idle">;
  /** The pause control: pauses reviews for the duration asked (ADR 0040). */
  pause(duration: PauseFor): void;
  /** Resumes reviews. */
  resume(): void;
  /**
   * The engine ran into this state (signed out, at its limit), as a run tells the queue (ADR 0044): shown at
   * once and held over a health that says ready. The demo driver's lever for "Codex reaches its limit" when no
   * run is there to find it out; `met` what the run said of its limit (its reset, ADR 0055).
   */
  ranInto(engine: EngineId, state: RanInto, met?: LimitMet): void;
  /**
   * The clock verbs on the room's demo clock, each advance or step sent as one `clock` event so the UI's `now`
   * follows; null in live mode, where the clock is the real one.
   */
  demo: DemoClockVerbs | null;
  /**
   * Stops the room: the poll, the queue, the checks' last writes, the reactions; then closes the store and drops
   * the demo clock's timers, so nothing of it fires into a closed store.
   */
  stop(): Promise<void>;
}

/**
 * Start at login's registration (ADR 0054), `item`, and where it registers as the UI says it, `kind`: `os` for the
 * machine's, which `runService` gives the program unguarded, and demo mode, which plays the program on its fake;
 * `memory` for the rest.
 */
interface AtLoginItem {
  item: LoginItem;
  kind: LoginItemKind;
}

/** Where the fake PATH puts Lookover's link when the options name no folder. */
const FAKE_PATH_FOLDER = "~/.local/bin";

/** Your coding agent's ports and facts: those the options give, the fakes and defaults for the rest. */
function agentPortsOf(o: RoomOptions): AgentPorts {
  const given = o.agent ?? {};
  const command = given.command ?? { onPath: "lookover", offPath: "lookover" };
  return {
    path: given.path ?? memoryCommandPath({ folder: FAKE_PATH_FOLDER }),
    skills: given.skills ?? memorySkillFolders(),
    offer: given.offer ?? "binary",
    command,
    skill: given.skill ?? { name: SKILL_NAME, command: command.offPath, version: o.version },
  };
}

/**
 * Calls made before what they call exists: held, then made in their order once it is `ready`, and made at once
 * from then on.
 */
function heldUntilReady<A extends unknown[]>(): {
  call: (...args: A) => void;
  ready: (target: (...args: A) => void) => void;
} {
  const held: A[] = [];
  let target: ((...args: A) => void) | null = null;
  return {
    call: (...args) => {
      if (target) target(...args);
      else held.push(args);
    },
    ready: (ready) => {
      target = ready;
      for (const args of held.splice(0)) ready(...args);
    },
  };
}

/** Start at login's registration: the one the options give, else a fake in memory. */
const loginItemOf = (o: RoomOptions): AtLoginItem =>
  o.loginItem ?? { item: memoryLoginItem(), kind: "memory" };

/** GitHub's web address the room's links are built on: GitHub's own unless the options name another. */
const webOf = (o: RoomOptions): string => o.web ?? GITHUB_WEB;

/** A reconnect after an adopt that GitHub refused: the connection's cause says why, the App stays kept. */
const keptAnyway = (): void => {};

/**
 * Builds a room: opens the store (or takes the open one it is given) and, when it keeps no setup yet, writes
 * the setup it starts at; reads the App and, once the setup says it is installed, the repositories its installation
 * lists (ADR 0053); asks both engines' health, records its start as the next event, forgets the repositories the
 * installation no longer lists, lists the changes and the comments (not while no bot is installed: the setup lists
 * once it is), puts back in the queue or fails the jobs a stopped service left running, takes the next job and starts
 * the poll's loop and the installation's. Rejects when the store won't open, or the App store can't be read; GitHub
 * refusing the App, its installation or the changes at start is no rejection (ADR 0053): the room is built, the
 * connection shows the cause, and the installation is listed again a minute on (a rate limit only waits). Nor is a key
 * that no longer opens: the connection shows it.
 */
export async function buildRoom(o: RoomOptions): Promise<Room> {
  const store = o.store ?? openStore({ home: o.home });
  setUp(store, o);
  const startedAt = o.clock.now();
  /** Logs where the options say, else to the console. */
  const logLine = o.log ?? ((line: string) => console.error(line));
  // Start at login made to match the owner's choice, once the setup is done (ADR 0054).
  const loginItem = loginItemOf(o);
  const registeredAtStart = await matchedAtStart(loginItem.item, store, logLine);
  const timers = o.timers ?? REAL_TIMERS;
  // The App, its installation and what it lists (ADR 0053). Its moves reach parts made below, once the room runs.
  const github = createInstallation({
    side: o.github,
    timers,
    now: () => o.clock.now(),
    emit: (body) => emit(body),
    watched: () => watched.all,
    added: (repos) => moves.added(repos),
    removed: (repo) => moves.leave(repo),
    installed: (granted) => setup.installed(granted),
    reached: (cause) => poller.reached(cause),
    member: (organisation) => memberOf(o.gh, organisation),
    memberAgain: () => void reconnect().catch(keptAnyway),
    log: logLine,
  });
  const listedAtStart = await opened(store, github, o.github);
  // What the installation lists now; what the store listed last when it wasn't listed (a lost key, no App yet).
  const watched = watchedOf(listedAtStart ?? store.repos.listed());
  // The settings as their files say them (ADR 0049): read once now, before the self-tests start, then again after
  // each change. One writer for every repository: the owner's file is theirs in common.
  const kept = await openSettings({
    files: settingsFilesOf(o),
    repos: () => watched.all,
    rules: (repoId) => store.rules.of(repoId),
  });
  const settingsNow = (repoId: RepositoryId) => settingsNowOf(kept, repoId);
  // The self-tests (ADR 0044): at start, an engine whose version never passed is tested now, in the background;
  // when one ends, the queue shows its result and takes. A self-test can end while the room still starts (the
  // scripted engines' at once): its result waits until the queue and what it takes with are made.
  const tested = heldUntilReady<Parameters<GateDeps["ended"]>>();
  const gate: Gate =
    o.selfTests === null
      ? UNGATED
      : createGate({
          tester: o.selfTests,
          store,
          clock: o.clock,
          dir: join(o.home, "self-tests"),
          ended: tested.call,
          log: logLine,
        });
  const healths: Record<EngineId, EngineHealth> = {
    claude: await o.engines.health("claude"),
    codex: await o.engines.health("codex"),
  };
  const atStart = (id: EngineId): { health: EngineHealth; state: EngineState } => ({
    health: healths[id],
    state: gate.stateOf(id, healths[id], { shown: "ready", reviewing: false, again: false }),
  });
  const engines = { claude: atStart("claude"), codex: atStart("codex") };
  // Your coding agent as the machine says it now (ADR 0058), and Lookover's command with it.
  const agentPorts = agentPortsOf(o);
  await refreshSkills(agentPorts, logLine);
  const agentAtStart = await readAgent(
    agentPorts,
    foundOf({ claude: engines.claude.state, codex: engines.codex.state }),
    logLine,
  );
  const commandAtStart = commandFor(agentPorts, agentAtStart.path);
  const log = new EventLog(o.eventsKept ?? 1_000, store.events.last());
  /**
   * The UI's state, as a UI that followed every event holds it: the log replayed once, here, then each event
   * applied as it is sent (AGENTS.md rule 3). Nothing decides from it: it is what the snapshot shows, and
   * what tells whether the UI's rules are behind the store's.
   */
  const setupAtStart = store.setup.read();
  let shown = snapshotOf(
    {
      now: startedAt,
      startedAt,
      version: o.version,
      command: commandAtStart,
      agent: agentAtStart,
      bot: github.bot(),
      app: github.app(),
      installationId: github.installationId(),
      web: webOf(o),
      engines,
      setup: setupAtStart,
      startAtLogin: store.setup.startAtLogin(),
      startsAtLogin: registeredAtStart,
      loginItem: loginItem.kind,
      ...(o.remote === undefined ? {} : { remote: o.remote }),
    },
    store.events.all(),
  );
  /** The coding agents Lookover found, by the engines the UI shows. */
  const found = () => foundOf({ claude: shown.engines.claude.state, codex: shown.engines.codex.state });
  const codingAgent = createCodingAgent({
    ...agentPorts,
    found,
    clock: o.clock,
    // Called only by a command or an engine change, once `emit` is defined below.
    emit: (body) => emit(body),
    shown: () => shown.service,
    log: logLine,
  });
  /**
   * The truth changes in the store, and the UI hears of it: the same event, numbered by the store. The log file says
   * it too, in the line the state before it words (ADR 0055), once it is published: the log is a record, not the
   * truth, so a line that can't be written (a full disk) stops no event: the sink prints it filtered, with why, and a
   * `log` that throws gets only why on the standard error, never the line, which no filter has seen.
   */
  const emit = (body: EventBody) => {
    const event = store.events.append(body);
    const line = logLineOf(body, shown);
    const foundBefore = found();
    shown = apply(shown, event);
    log.publish(event);
    // An agent found or gone: its skill offered or not, read from its folder.
    if (body.type === "engine.changed" && !isDeepStrictEqual(found(), foundBefore))
      void codingAgent
        .check()
        .catch((error) => logLine(`Can't read your coding agent again: ${said(error)}`));
    if (line === null) return;
    try {
      logLine(line);
    } catch (error) {
      // Never the line itself: unfiltered, it may carry a title or a failure echoing a token.
      process.stderr.write(`A line was not logged: ${said(error)}\n`);
    }
  };

  /** The UI's state now: what the events made it, as of this moment. */
  const snapshot = (): State => ({ ...shown, now: Math.max(shown.now, o.clock.now()) });

  /**
   * "Too noisy?"'s counts (ADR 0049): the repository's last 30 reviewed changes, as the store reads them.
   * They move only with a round, so they are sent only with one (`round.finished`) and with the repository
   * (`repo.added`); a settings change doesn't move them.
   */
  const noise = (repo: RepositoryRef) => store.rounds.noise(repoIdOf(repo), changePrefixOf(repo));
  /** A round's end with the counts it moved: its change's repository's. */
  const withCounts = (body: Extract<EventBody, { type: "round.finished" }>): EventBody => {
    const repo = watched.ofChange(body.changeId);
    return { ...body, noise: { repoId: repoIdOf(repo), counts: noise(repo) } };
  };
  /**
   * The repository's rules (`rulesOf`), each switched as the settings file said it last, sent when the UI's differ
   * (ADR 0048); the rules given.
   */
  const rulesMoved = (repoId: RepositoryId): Rule[] => {
    const rules = rulesOf(store, repoId, settingsNow(repoId).switchedOff);
    const sent = shown.rules.filter((rule) => rule.repoId === repoId);
    if (!isDeepStrictEqual(rules, sent)) emit({ type: "rules.changed", at: o.clock.now(), repoId, rules });
    return rules;
  };

  // The first event of every start records it (the service runs since now) and gives this start its own first
  // number, so a tab from before it is told to reload rather than replayed (`EventLog.since`, ADR 0038). The
  // engines' health taken at start is still only in the snapshot's base, not in an event: a tab that reloads
  // sees it, one that replays would not, which is the other reason the stale tab reloads. The health check
  // that emits `engine.changed` is the queue's.
  // Lookover's command and your coding agent with it, where the replayed log says an earlier start's (another
  // executable, another PATH, a skill changed while stopped).
  emit({
    type: "service.changed",
    at: startedAt,
    patch: { state: "running", since: startedAt, command: commandAtStart, agent: agentAtStart },
  });
  // What a stop left behind is sent now: the sign-ins it left pending, and a start at login or rules the store kept
  // but the stop kept from the UI (between the write and its event), where the replayed log says the older ones.
  const left = [
    // The setup as the store keeps it, where the replayed log says the one before this start's (`setUp`, `opened`).
    ...setupLeft(shown, store.setup.read(), startedAt),
    ...signInsLeft(shown, startedAt),
    ...startAtLoginLeft(shown, store.setup.startAtLogin(), startedAt),
    ...startsAtLoginLeft(shown.service.startsAtLogin, registeredAtStart, startedAt),
    // The App and its installation as read now, where the log says those of before the stop (a reinstall meanwhile).
    ...identityLeft(shown, github, startedAt),
    // The settings files are their truth (ADR 0049), and a hand edit while stopped counts from now.
    ...settingsMoved(shown, kept.now(), startedAt),
  ];
  for (const body of left) emit(body);
  const everyRulesMoved = () => watched.all.map((repo) => rulesMoved(repoIdOf(repo)));
  everyRulesMoved();

  const ids = o.ids ?? { next: () => randomUUID() };
  // The decisions' reads: the store's, never the snapshot (#64). The switch is the store's (ADR 0047); the settings
  // are the files', as last read (ADR 0049).
  const repository = (repo: RepositoryRef) =>
    repositoryOf(repo, store.repos.enabled(repo), settingsNow(repoIdOf(repo)).settings);
  const settings = (repoId: RepositoryId) => settingsOf(repository(watched.byId(repoId)));
  const openChanges = () =>
    changeFactsOf(
      watched.all.flatMap((repo) => store.inbox.open(repo)),
      github.owner,
    );
  // The repository ports as the App now held signs (ADR 0053).
  const { intake, writer } = github.ports;
  // A post GitHub refuses for a moment is tried again on the room's own clock and timers (ADR 0044).
  const publisher = createPublisher({
    writer,
    // The result names each finding's thread, from one read as the round's check is completed (ADR 0052).
    threads: (change) => intake.threads(change),
    time: { now: () => o.clock.now(), after: timers.after },
    // A comment GitHub wouldn't minimize never fails the round: it is said in the log.
    log: (line) => (o.log ?? console.error)(line),
    // What an engine or a person wrote is posted without the secrets the log sink knows (ADR 0056).
    secretsRemoved: secretsRemovedOf(o),
  });
  /** Each part logs where the options say, else to the console. */
  const logged = o.log === undefined ? {} : { log: o.log };
  // The check follows every job from the moment it is recorded (ADR 0043); `publish` writes it.
  const checks = createChecks({
    store,
    publisher,
    clock: o.clock,
    host: "github",
    changeRef: (changeId) => ({ repo: watched.ofChange(changeId), number: numberOf(changeId) }),
    onlyCodex: (changeId) => settings(repoIdOf(watched.ofChange(changeId))).values.reviewers === "codex",
    limitUntil: (engine) => shown.engines[engine].limitUntil,
    ...logged,
  });
  const runs = createRun({
    store,
    clock: o.clock,
    ids,
    intake,
    retrieval: o.retrieval,
    // Each engine is sent at most what it can read at once: a longer prompt has its diff cut (`review`).
    review: createReview({ engines: o.engines, inputLimits: INPUT_LIMITS }),
    // The confirm prompt too: each claim shows a window of its hunk, and over the limit the last claims leave their
    // code to the worktree. On its own engines, at the confirm pass's effort.
    confirm: createConfirm({ engines: o.confirmEngines ?? o.engines, inputLimits: INPUT_LIMITS }),
    publisher,
    repoOf: watched.byId,
    owner: github.owner,
    runsDir: join(o.home, "runs"),
    reviewTimeoutMs: o.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS,
    // A round carries the counts it moved (ADR 0049): no event of their own after every round.
    emit: (body) => emit(body.type === "round.finished" ? withCounts(body) : body),
    settings,
    checks,
    // The queue is made below; a run starts only once it is.
    ranInto: (engine, state, met) => queue.ranInto(engine, state, met),
    withStepIn: (stored) => queue.withStepIn(stored),
    rulesMoved,
    switchedOff: (repoId) => settingsNow(repoId).switchedOff,
    timers,
    secretsRemoved: secretsRemovedOf(o),
    ...logged,
  });
  // 👀 and 🚀 on review requests (ADR 0043), as the store says they are owed.
  const reactions = createReactions({
    store,
    writer,
    log: logLine,
  });
  const queue = createQueue({
    store,
    clock: o.clock,
    ids,
    engines: o.engines,
    gate,
    engineStates: () => shown.engines,
    connection: () => shown.connection,
    openChanges,
    settings,
    // An engine's limit given a new end (the queue sends every one): the checks waiting on it say the new reset.
    emit: (body) => {
      emit(body);
      if (body.type === "engine.changed" && typeof body.patch.limitUntil === "number")
        checks.limitMoved(body.id);
    },
    // "Review now" lists only its change's repository: the others are as fresh as their own cadence keeps them.
    list: (changeId) => listedOf(poller, watched.find(changeId)),
    runs,
    checks,
    reactions,
    timers,
    ...logged,
  });
  // "This finding is wrong" (ADR 0052): posted outside any round, the change busy for the take until it is.
  const dismissals = createDismissals({
    store,
    clock: o.clock,
    ids,
    publisher,
    emit,
    head: (changeId) => openChanges().get(changeId)?.headSha ?? null,
    take: () => queue.take(),
    log: logLine,
  });
  // The watched repositories, polled by the service itself (ADR 0043, ADR 0053): what it sees is sent and handed to
  // the queue.
  const poller = createPoller({
    store,
    clock: o.clock,
    timers,
    intake,
    repos: () => watched.all,
    // As the UI is told of it: with its noise counts.
    repository: (repo) => ({ ...repository(repo), noise: noise(repo) }),
    owner: github.owner,
    emit,
    connection: () => shown.connection,
    opened: (changeId) => queue.opened(changeId),
    pushed: (changeId, sha) => queue.pushed(changeId, sha),
    requested: (changeId, request, full) => queue.requested(changeId, request, full),
    resend: () => {
      reactions.send();
      checks.resend();
    },
    take: () => queue.take(),
    discover: (why) => rediscover(why),
    log: logLine,
  });
  /** Lists the open changes now (after any listing under way), then takes. */
  const listed = async () => {
    await poller.poll();
    queue.take();
  };
  /** Whether `stop` began: a read that answers late sends nothing then. */
  let stopping = false;
  /** Whether "Reconnect" runs: it lists the installation's repositories itself, first. */
  let reconnecting = false;
  /** The installation's repositories listed at the poller's asking, while they are: one listing at a time. */
  let discovering: Promise<void> | null = null;
  /** When a repository's refusal last had them listed: one the installation still lists is refused at every poll. */
  let refusedDiscoveryAt: number | null = null;
  /**
   * The installation's repositories listed again, not waited for (ADR 0053): a repository's token refused (once a
   * minute at most), or the connection back. Once at a time, and not while "Reconnect" lists them; what it throws is
   * logged.
   */
  function rediscover(why: "refused" | "regained"): void {
    if (reconnecting || stopping || discovering !== null) return;
    if (why === "refused") {
      const at = o.clock.now();
      if (refusedDiscoveryAt !== null && at - refusedDiscoveryAt < DISCOVERY_RETRY_MS) return;
      refusedDiscoveryAt = at;
    }
    discovering = github
      .discover()
      .catch((error: unknown) =>
        logLine(`the installation's repositories could not be listed: ${said(error)}`),
      )
      .finally(() => {
        discovering = null;
      });
  }
  // The repositories the installation adds or removes while the room runs (ADR 0053).
  const moves = repositoryMoves({
    watched,
    // A hand edit's settings or rules are sent as a start sends them (ADR 0049); nothing once the room stops.
    reread: () =>
      kept
        .reread()
        .then((now) => {
          if (stopping) return;
          for (const body of settingsMoved(shown, now, o.clock.now())) emit(body);
          everyRulesMoved();
        })
        .catch((error: unknown) => logLine(`the settings files could not be read again: ${said(error)}`)),
    store,
    poll: (repo) => poller.poll(repo),
    take: () => queue.take(),
    stopRuns: (changes) => queue.leave(changes),
    shown: () => shown,
    emit,
    now: () => o.clock.now(),
    rulesMoved,
  });
  // Everything the queue takes with is made: the self-tests that ended meanwhile are told it now.
  tested.ready(queue.tested);
  await sinceLastStart({ store, github, listed: listedAtStart, leave: moves.leave, emit, at: startedAt });
  // The first listing: what changed while the service was stopped. A job the last service left running never
  // finished: it runs again, once, or fails, "the service stopped"; then the jobs left waiting are taken (#62).
  // Then the poll goes on by itself.
  // A rate limit at start is only a wait: the poller keeps GitHub's reset time, and lists then; a refusal is logged,
  // the connection showing it (`Poller.first`), and the service starts all the same (ADR 0053). With no bot installed
  // yet (the setup's GitHub step) there is nothing to list: the setup lists once it is (ADR 0047). With the App or its
  // installation refused at start, the loop lists, and shows the connection back once GitHub answers.
  if (shown.connection.state !== "not-connected" && github.down() === null) await poller.first();
  queue.recover();
  // The run folders older than 30 days go, now that the recovery said which runs go on, then once a day (ADR 0056).
  const runFolders = createRunFolders({
    runsDir: join(o.home, "runs"),
    runAge: store.jobs.runAge,
    timers,
    log: logLine,
  });
  runFolders.start();
  // The owner's dismissals a stopped service left owing posts go on (ADR 0052).
  dismissals.resume();
  poller.start();
  const atLogin = createStartAtLogin({
    item: loginItem.item,
    store,
    clock: o.clock,
    emit,
    shown: () => shown.service.startsAtLogin,
    log: logLine,
  });
  const setupFlow = createSetup({
    store,
    clock: o.clock,
    emit,
    repos: () => watched.all,
    github,
    review: queue.firstReview,
  });
  // The setup done: start at login registered as the owner chose (ADR 0054).
  const setup: Room["setup"] = {
    ...setupFlow,
    finish: async () => {
      setupFlow.finish();
      await atLogin.match();
    },
  };
  // The installation's own loop: its repositories every 5 minutes, or the install waited for (ADR 0053).
  github.begin(store.setup.read());

  /** Settles once `stop` began: what waits on the engines or the disk then ends at once. */
  let letStop = () => {};
  const stopAsked = new Promise<void>((resolve) => {
    letStop = resolve;
  });
  /** The checks under way, in memory: the guard of "Run all checks", and what `stop` waits for. Null when none. */
  let checking: Promise<void> | null = null;

  /**
   * "Run all checks": the checks running sent, both healths read again, then the items. The ending is always sent,
   * whatever the disk said and even when the room stops meanwhile (the health read is then left behind, and the
   * items are as the UI shows them): `stop` waits for it before the store closes, so a "running" is never left in
   * the event log for a later start to replay.
   */
  const healthChecks = async (): Promise<void> => {
    const began = o.clock.now();
    emit({ type: "service.changed", at: began, patch: { checks: { at: began, running: true, items: [] } } });
    await Promise.race([queue.checkEngines(), stopAsked]);
    const freeGb = await freeGbOf(o.home).catch((error: unknown) => {
      logLine(`the data folder's free space could not be read: ${said(error)}`);
      return null;
    });
    const at = o.clock.now();
    emit({
      type: "service.changed",
      at,
      patch: {
        checks: { at, running: false, items: checkItems(shown, kept.now().invalid, freeGb, github.key()) },
      },
    });
  };
  const runChecks = async (): Promise<"ok" | "running"> => {
    if (checking !== null) return "running";
    checking = healthChecks();
    try {
      await checking;
    } finally {
      checking = null;
    }
    return "ok";
  };

  const signIn = createSignIn({
    opener: o.signIn,
    timers,
    clock: o.clock,
    emit,
    look: queue.checkEngine,
    take: queue.take,
  });

  const demoClock = o.demoClock;
  /** The clock verbs, one at a time: a second advance waits for the first to settle. */
  let moving: Promise<unknown> = Promise.resolve();
  const moved = <T>(work: () => Promise<T>): Promise<T> => {
    const done = moving.then(work, work);
    moving = done.catch(() => {});
    return done;
  };
  const demo: DemoClockVerbs | null =
    demoClock === undefined
      ? null
      : {
          get running() {
            return demoClock.running;
          },
          get speed() {
            return demoClock.speed;
          },
          set: (running, speed) => demoClock.set(running, speed),
          advance: (ms) =>
            moved(async () => {
              await demoClock.advance(ms);
              emit({ type: "clock", at: o.clock.now() });
            }),
          step: () =>
            moved(async () => {
              const stepped = await demoClock.step();
              emit({ type: "clock", at: o.clock.now() });
              return stepped;
            }),
        };

  /**
   * "Reconnect" (ADR 0053): the App read again (a lost key from the App store, `live.json`'s described), its
   * installation's repositories listed again, then every repository's changes; what the listing of the changes throws
   * first, else what the installation's did. The connection shows the cause the listing met, or none once it answers.
   */
  const reconnect = async (): Promise<void> => {
    reconnecting = true;
    try {
      const discovered = await github.discover().then(
        () => null,
        (error: unknown) => ({ error }),
      );
      await listed();
      if (discovered !== null) throw discovered.error;
    } finally {
      reconnecting = false;
    }
  };

  /** An App created or given, adopted: kept, then its install waited for, or, installed already, listed again. */
  const adopt = async (app: StoredApp, key: string, membership?: Membership): Promise<void> => {
    await github.adopt(app, key, membership);
    setup.appGiven();
    // The connection keeps why the listing failed; the App is kept all the same.
    if (appInstalled(store.setup.read())) await reconnect().catch(keptAnyway);
  };
  /** The App's checks and adoptions, one after the other; never rejects. */
  let adopting: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const next = adopting.then(work);
    adopting = next.catch(() => {});
    return next;
  };
  /** The person's own `gh` read now (none: not installed), sent when the UI holds another answer. */
  const checkGh = async (): Promise<GhRead> => {
    const read = await ghReadOf(o.gh);
    const choices: GhChoices = {
      person: withoutWords(read.person),
      organisations: withoutWords(read.organisations),
    };
    if (!isDeepStrictEqual(shown.connection.gh, choices))
      emit({ type: "connection.changed", at: o.clock.now(), patch: { gh: choices } });
    return read;
  };
  /** The person's own `gh` asked for its membership of `organisation` (none: not installed); its words logged. */
  const membership = async (organisation: string): Promise<GhMember> => {
    const answer = await memberOf(o.gh, organisation);
    if (answer.kind === "unanswered") logLine(flowLines.ghUnanswered(answer.why, answer.detail));
    return answer;
  };
  const flow = createAppFlow({
    store,
    clock: o.clock,
    github: { app: github.stored, installations: o.github.installations, adopt, oneAtATime },
    gh: { read: checkGh },
    setup,
    liveConfig: o.github.liveConfig === true,
    log: logLine,
  });

  return {
    snapshot,
    events: log,
    clock: o.clock,
    refresh: listed,
    reconnect,
    github: {
      app: github.stored,
      keepsApps: o.github.apps !== undefined,
      installations: o.github.installations,
      adopt,
      oneAtATime,
      flow,
      checkGh,
      membership,
      checkMembership: async () => {
        if (await github.checkMembership()) await reconnect().catch(keptAnyway);
      },
    },
    review: queue.request,
    checkEngines: queue.checkEngines,
    signIn: signIn.start,
    reroute: queue.reroute,
    runChecks,
    dismissDeparted: (repoId) => {
      if (!shown.departed.some((d) => d.id === repoId)) return "no_such_repository";
      emit({ type: "repo.dismissed", at: o.clock.now(), repoId });
      return "ok";
    },
    unlock: () => {
      if (shown.service.unlocked) return;
      emit({ type: "service.changed", at: o.clock.now(), patch: { unlocked: true } });
    },
    setup,
    settings: withNoise(
      settingsCommands({
        kept,
        repoOf: watched.known,
        ruleRepo: (ruleId) => ruleRepoOf(store, watched, ruleId),
        emit,
        clock: o.clock,
        rulesMoved: everyRulesMoved,
        replan: queue.settingsMoved,
      }),
      watched.find,
      (id) => store.rounds.ledger(id),
      dismissals.dismiss,
    ),
    startAtLogin: atLogin.choose,
    agent: { check: codingAgent.check, path: codingAgent.path, skill: codingAgent.skill },
    pause: queue.pause,
    resume: queue.resume,
    ranInto: queue.ranInto,
    demo,
    stop: async () => {
      letStop();
      stopping = true;
      signIn.stop();
      const githubStopped = github.stop();
      runFolders.stop();
      await poller.stop();
      await githubStopped;
      await queue.stop();
      // A dismissal's post under way is cut: the next start resumes it.
      await dismissals.stop();
      // "Run all checks" under way sends its ending now; the checks' last writes are sent before the store closes;
      // a reaction under way is waited for.
      await checking?.catch(() => {});
      await checks.idle();
      await reactions.stop();
      await atLogin.idle();
      await codingAgent.idle();
      store.close();
      // Last: a retry or a pause's end armed on a flowing clock would fire into the closed store.
      demoClock?.stop();
    },
  };
}

/**
 * The settings as their files say them (ADR 0049), when the replayed log says otherwise: a hand edit while the service
 * was stopped, or a stop between a write and its event. One `settings.changed`, naming each repository whose settings
 * moved (and the UI shows it); nothing when they agree.
 */
function settingsMoved(shown: State, now: SettingsNow, at: number): EventBody[] {
  const moved = movedSettings((repoId) => shown.repos.find((r) => r.id === repoId)?.settings, now);
  if (moved.size === 0 && isDeepStrictEqual(shown.settings, now.defaults)) return [];
  return [{ type: "settings.changed", at, settings: now.defaults, repos: Object.fromEntries(moved) }];
}

/** Each repository whose settings `now` differ from what `was` gave it; one `was` gives nothing is left out. */
function movedSettings(
  was: (repoId: RepositoryId) => ResolvedSettings | undefined,
  now: SettingsNow,
): Map<RepositoryId, ResolvedSettings> {
  const moved = new Map<RepositoryId, ResolvedSettings>();
  for (const [repoId, own] of now.repos) {
    const before = was(repoId);
    if (before !== undefined && !isDeepStrictEqual(before, own.settings)) moved.set(repoId, own.settings);
  }
  return moved;
}

/** What applies to a watched repository, as the files said last: the owner's defaults alone for one not read yet. */
const settingsNowOf = (kept: SettingsWriter, repoId: RepositoryId): RepositorySettingsNow =>
  kept.now().repos.get(repoId) ?? { settings: kept.now().defaults, switchedOff: () => false };

/**
 * The repositories a room watches, as the installation lists them (ADR 0053), and the lookups of one: by id, or by a
 * change id, which starts with its name.
 */
interface Watched {
  /** The repositories watched now, in the order they were added. */
  readonly all: readonly RepositoryRef[];
  /** Watched from now on; two of one name are refused: a change id names its repository by its name alone. */
  add(repo: RepositoryRef): void;
  /** No longer watched. */
  remove(repo: RepositoryRef): void;
  /** The repository of that id; null for one not watched. */
  known(repoId: RepositoryId): RepositoryRef | null;
  /** The repository of that id, which the caller knows is watched: one not watched is a programming error. */
  byId(repoId: RepositoryId): RepositoryRef;
  /** The repository a change id names; null for one not watched. */
  find(changeId: ChangeId): RepositoryRef | null;
  /** The repository of a change the caller knows is in a watched one: one not watched is a programming error. */
  ofChange(changeId: ChangeId): RepositoryRef;
}

/** The repositories watched; two of one name are refused, since a change id names its repository by name alone. */
function watchedOf(repos: readonly RepositoryRef[]): Watched {
  let all: readonly RepositoryRef[] = [];
  const add = (repo: RepositoryRef) => {
    if (all.some((r) => r.name.toLowerCase() === repo.name.toLowerCase()))
      throw new Error(`two watched repositories are named ${repo.name}`);
    all = [...all, repo];
  };
  for (const repo of repos) add(repo);
  const known = (repoId: RepositoryId) => all.find((repo) => repoIdOf(repo) === repoId) ?? null;
  const find = (changeId: ChangeId) => all.find((repo) => changeId.startsWith(changePrefixOf(repo))) ?? null;
  return {
    get all() {
      return all;
    },
    add,
    remove: (repo) => {
      all = all.filter((r) => !sameRepository(r, repo));
    },
    known,
    byId: (repoId) => {
      const repo = known(repoId);
      if (repo === null) throw new Error(`${repoId} is not a repository the service watches`);
      return repo;
    },
    find,
    ofChange: (changeId) => {
      const repo = find(changeId);
      if (repo === null) throw new Error(`${changeId} is not a change of a repository the service watches`);
      return repo;
    },
  };
}

/**
 * The setup a start goes on from (ADR 0047, ADR 0053): the one given when the store keeps none yet, else the one it
 * kept, set up at once when `live.json` names the App.
 */
function setUp(store: Store, o: Pick<RoomOptions, "setup" | "setUpAtOnce">): void {
  if (!store.setup.kept()) store.setup.write(o.setup ?? SET_UP);
  else if (o.setUpAtOnce && !store.setup.read().done) store.setup.write(SET_UP);
}

/**
 * The App read at start, and what its installation lists when the setup says it is installed; null when nothing was
 * listed. With no App at all, the setup shows again, whatever it kept (ADR 0053); `live.json`'s is an App, even
 * while GitHub won't describe it. An App the store keeps while the setup still asks for one (a stop between `adopt`'s
 * two writes, "Create it on GitHub" or "Use an existing App") has its install waited for, as `appGiven` would.
 */
async function opened(store: Store, github: Installation, side: GitHubSide): Promise<RepositoryRef[] | null> {
  const listed = await github.open(appInstalled(store.setup.read()));
  if (side.given !== undefined) return listed;
  const made = appMade(store.setup.read());
  if (github.stored() === null && made) store.setup.write({ done: false, step: "github", github: "start" });
  // Kept by the App store, and the service stopped before the setup heard of it (`adopt`): its install waited for.
  else if (github.stored() !== null && !made)
    store.setup.write({ github: "waiting-for-install", githubRefused: null });
  return listed;
}

/** The job states that haven't ended: a repository that leaves cancels its jobs in them. */
const PENDING = {
  queued: true,
  deferred: true,
  running: true,
  done: false,
  skipped: false,
  cancelled: false,
  failed: false,
} as const satisfies Record<JobState, boolean>;

/** What the repositories the installation adds or removes while the room runs reach (ADR 0053). */
interface MovesDeps {
  watched: Watched;
  /** The settings files read again, what moved sent: a repository added may have its own file. Never rejects. */
  reread(): Promise<void>;
  store: Store;
  /** The poller's listing of one repository. */
  poll(repo: RepositoryRef): Promise<boolean>;
  take(): void;
  /** The queue's: the runs of the changes whose ids start so are stopped; settles once they are. */
  stopRuns(changes: string): Promise<void>;
  /** The UI's state, as the room last sent it. */
  shown(): State;
  emit(body: EventBody): void;
  now(): number;
  rulesMoved(repoId: RepositoryId): Rule[];
}

/**
 * A repository the installation lists, or no longer lists (ADR 0053). `added`: watched, each polled at once (its
 * first listing sends `repo.added`, switched on, with the owner's defaults until its own file is read) and its rules
 * sent, the queue takes; the first poll refused is thrown once each was polled. The settings files are read again
 * meanwhile, not waited for (their reads are the disk's, not the room's clock), and what they move is sent once read.
 * `leave`: its runs stopped, its jobs cancelled and
 * what it owes GitHub dropped (`store.repos.removed`), the setup's first review forgotten as `apply` forgets it, no
 * longer watched, and `repo.removed` sent; then the stopped runs are waited for.
 */
function repositoryMoves(d: MovesDeps) {
  return {
    added: async (repos: readonly RepositoryRef[]): Promise<void> => {
      for (const repo of repos) d.watched.add(repo);
      void d.reread();
      const refused: unknown[] = [];
      for (const repo of repos) {
        await d.poll(repo).catch((error: unknown) => {
          refused.push(error);
        });
        d.rulesMoved(repoIdOf(repo));
      }
      d.take();
      if (refused.length > 0) throw refused[0];
    },
    leave: async (repo: RepositoryRef): Promise<void> => {
      const changes = changePrefixOf(repo);
      const repoId = repoIdOf(repo);
      const stopped = d.stopRuns(changes);
      d.store.repos.removed(repo, changes, d.now());
      const { setup, changes: open, reviews } = d.shown();
      // Each review the UI shows waiting or running is sent its job as it ended: cancelled, its run gone.
      for (const [id, review] of Object.entries(reviews)) {
        if (!id.startsWith(changes) || review.job === null || !PENDING[review.job.state]) continue;
        const ended = d.store.jobs.latest(changeId(id));
        if (ended !== null)
          d.emit({ type: "job.changed", at: d.now(), changeId: ended.changeId, job: ended.job });
      }
      const first = setup.firstReviewChange;
      if (first !== null && open[first]?.repoId === repoId) d.store.setup.write({ firstReviewChange: null });
      d.watched.remove(repo);
      d.emit({ type: "repo.removed", at: d.now(), repoId });
      await stopped;
    },
  };
}

/**
 * What changed while the service was stopped (ADR 0053), sent before anything is listed: each repository the store
 * listed and the installation no longer lists leaves; a key that no longer opens, or GitHub refusing the App, its
 * installation or its repositories, is shown at once as the connection's cause.
 */
async function sinceLastStart(d: {
  store: Store;
  github: Installation;
  listed: readonly RepositoryRef[] | null;
  leave(repo: RepositoryRef): Promise<void>;
  emit(body: EventBody): void;
  at: number;
}): Promise<void> {
  const { listed } = d;
  if (listed !== null)
    for (const repo of d.store.repos.listed())
      if (!listed.some((r) => sameRepository(r, repo))) await d.leave(repo);
  const down = d.github.down();
  if (down !== null)
    d.emit({
      type: "connection.changed",
      at: d.at,
      patch: { state: "disconnected", cause: down, since: d.at },
    });
}

/** A poll of one repository; nothing for none (a change of no repository watched: no such change). */
const listedOf = async (poller: Poller, repo: RepositoryRef | null): Promise<void> => {
  if (repo !== null) await poller.poll(repo);
};

/** The watched repository whose rules hold `ruleId`: a rule's command names no repository. Null when none does. */
const ruleRepoOf = (store: Store, watched: Watched, ruleId: string): RepositoryRef | null =>
  watched.all.find((repo) => store.rules.of(repoIdOf(repo)).some((rule) => rule.id === ruleId)) ?? null;

/** The settings files the room reads and writes: the given port, or the disk under the settings' root. */
const settingsFilesOf = (o: RoomOptions): SettingsFiles => o.settingsFiles ?? diskSettingsFiles(o.home);

/** What the settings commands work with: the one writer, the repositories watched, and what a save sends. */
interface SettingsCommandsDeps {
  kept: SettingsWriter;
  /** A watched repository by id; null for one not watched. */
  repoOf(repoId: RepositoryId): RepositoryRef | null;
  /** The watched repository whose rules hold the rule; null when none does. */
  ruleRepo(ruleId: string): RepositoryRef | null;
  emit(body: EventBody): void;
  clock: Clock;
  /** Every watched repository's rules sent again where their switches moved. */
  rulesMoved(): void;
  /** What waits planned again; `reviewersMoved` when a repository's reviewers moved. */
  replan(reviewersMoved: boolean): void;
}

/**
 * The settings commands over the writer: each change written, then sent as `settings.changed` with the owner's
 * defaults and each repository whose settings moved; a rule's switch as `rule.changed`, then whatever else its write
 * moved by `rulesMoved`. A refusal sends nothing. Another repository is not one the service watches.
 */
function settingsCommands(d: SettingsCommandsDeps): Omit<Room["settings"], "quiet"> {
  /**
   * Every save's one path. A write reads every file again, so a file repaired since a refusal can move anything they
   * hold: the settings (sent always for a settings save, for a rule's switch only when they moved), the switch saved,
   * then any other rule switch the files now give, and what waits planned again when a repository's settings moved.
   */
  const saved = (answer: SettingsChanged, rule?: { ruleId: string; enabled: boolean }): SettingsAnswer => {
    if ("refused" in answer) return answer;
    const { before, now } = answer;
    const moved = movedSettings((repoId) => before.repos.get(repoId)?.settings, now);
    if (rule === undefined || moved.size > 0 || !isDeepStrictEqual(before.defaults, now.defaults))
      d.emit({
        type: "settings.changed",
        at: d.clock.now(),
        settings: now.defaults,
        repos: Object.fromEntries(moved),
      });
    if (rule !== undefined) d.emit({ type: "rule.changed", at: d.clock.now(), ...rule });
    d.rulesMoved();
    // What waits is planned again with what applies now; a round under way keeps what it started with.
    const reviewersMoved = [...moved].some(
      ([repoId, settings]) => before.repos.get(repoId)?.settings.reviewers.value !== settings.reviewers.value,
    );
    if (moved.size > 0) d.replan(reviewersMoved);
    return "ok";
  };
  /** A change to a watched repository's own file; another is no such repository. */
  const own = async (
    repoId: RepositoryId,
    write: (repo: RepositoryRef) => Promise<SettingsChanged>,
  ): Promise<SettingsAnswer | "no_such_repository"> => {
    const repo = d.repoOf(repoId);
    return repo === null ? "no_such_repository" : saved(await write(repo));
  };
  return {
    setDefault: async (key, value) => saved(await d.kept.setDefault(key, value)),
    set: (id, key, value) => own(id, (repo) => d.kept.set(repo, key, value)),
    reset: (id, key) => own(id, (repo) => d.kept.reset(repo, key)),
    setRule: async (ruleId, enabled) => {
      const repo = d.ruleRepo(ruleId);
      if (repo === null) return { refused: "no_such_rule" };
      return saved(await d.kept.setRule(repo, ruleId, enabled), { ruleId, enabled });
    },
  };
}

/**
 * "Too noisy?" (ADR 0049, ADR 0052) over the settings commands: `wrong` dismisses the finding (`dismiss`);
 * `rule-off` switches off the rule the finding cites, as the rules page does; `blocking-only` sets the change's
 * repository's strictness to blocking, as its settings page does. `repoOf` gives the watched repository a change is
 * in, null for none (no such change); `ledger` a change's findings as its last round left them.
 */
function withNoise(
  commands: Omit<Room["settings"], "quiet">,
  repoOf: (changeId: ChangeId) => RepositoryRef | null,
  ledger: (changeId: ChangeId) => Finding[],
  dismiss: Dismissing["dismiss"],
): Room["settings"] {
  return {
    ...commands,
    quiet: async (choice) => {
      const repo = repoOf(choice.changeId);
      if (repo === null) return "no_such_change";
      const findings = ledger(choice.changeId);
      if (choice.kind === "wrong") return dismiss(choice.changeId, choice.findingId);
      if (choice.kind === "blocking-only") return commands.set(repoIdOf(repo), "strictness", "blocking");
      const finding = findings.find((f) => f.id === choice.findingId);
      if (finding === undefined) return "no_such_finding";
      if (finding.rule === null) return "no_rule";
      return commands.setRule(finding.rule.id, false);
    },
  };
}

/**
 * The App, its bot and its installation as `open` read them at start (ADR 0053), when the replayed log says others:
 * uninstalled and installed again while the service was stopped, the log's last `connection.changed` names the old
 * installation, whose links ("Add a repository", "Unsuspend") lead nowhere, and discovery, finding its own id current,
 * would never say the new one. One `connection.changed` with what moved; nothing for what `open` didn't read (GitHub
 * refusing at start: the log's are the last known).
 */
function identityLeft(shown: State, github: Installation, at: number): EventBody[] {
  const was = shown.connection;
  const app = github.app();
  const bot = github.bot();
  const installationId = github.installationId();
  const patch: Partial<Connection> = {
    ...(app !== null && !isDeepStrictEqual(app, was.app) ? { app } : {}),
    ...(bot !== null && bot !== was.bot ? { bot } : {}),
    ...(installationId !== null && installationId !== was.installationId ? { installationId } : {}),
  };
  return Object.keys(patch).length === 0 ? [] : [{ type: "connection.changed", at, patch }];
}

/**
 * What the person's own `gh` says now (ADR 0059): who it is signed in as, then the organisations they admin. A `gh`
 * that can't say who it is is asked nothing more: its organisations are that same answer. No `gh`: not installed.
 */
async function ghReadOf(gh: Gh | undefined): Promise<GhRead> {
  if (gh === undefined) return { person: { kind: "missing" }, organisations: { kind: "missing" } };
  const person = await gh.person();
  if (person.kind !== "signed-in") return { person, organisations: person };
  return { person, organisations: await gh.adminOrganisations() };
}

/** An answer of `gh` as the setup shows it: `gh`'s own words, which only the log keeps, left out. */
function withoutWords<T extends { kind: string }>(answer: T | GhUnanswered): T | GhNoAnswer {
  if (answer.kind !== "unanswered" || !("detail" in answer)) return answer;
  return { kind: "unanswered", why: answer.why };
}

/**
 * The setup as the store keeps it (ADR 0047), when the replayed log says another: the start set it up at once
 * (`live.json` names the App) or showed it again (no App at all) after the events of an earlier setup. One
 * `setup.changed` with the whole kept setup, or nothing when they agree.
 */
function setupLeft(shown: State, kept: Setup, at: number): EventBody[] {
  return isDeepStrictEqual(shown.setup, kept) ? [] : [{ type: "setup.changed", at, setup: kept }];
}

/**
 * Start at login as the store keeps it (ADR 0049), when the log says otherwise: a stop came between the store's write
 * and its event. One `service.changed` with the kept choice, or nothing when they agree.
 */
function startAtLoginLeft(shown: State, kept: boolean, at: number): EventBody[] {
  return shown.service.startAtLogin === kept
    ? []
    : [{ type: "service.changed", at, patch: { startAtLogin: kept } }];
}

/**
 * A sign-in a stopped service left pending (ADR 0047) is over at the next start: nothing watches it now, and the
 * log would otherwise show the engine signing in for good. One `signingIn: false` per engine the log shows so.
 */
function signInsLeft(shown: State, at: number): EventBody[] {
  return Object.values(shown.engines)
    .filter((engine) => engine.signingIn)
    .map((engine) => ({ type: "engine.changed", at, id: engine.id, patch: { signingIn: false } }));
}
