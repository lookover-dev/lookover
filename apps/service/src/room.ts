// The engine room (ADR 0046): the part of the service a scenario load replaces. The store, the snapshot, the
// queue, the poller, the runs, the checks, the reactions, the outbox, the owner's dismissals, the event log, and the
// room's own clock and timers: every wait of the room goes through them, so in demo mode one `DemoClock` as both moves the whole room.
// The server (`Bun.serve`, the session, the API, the event streams, on real timers) is `service.ts`'s and stays
// up while a room is built, swapped in and the old one stopped: the API reaches the current room through one
// accessor. Here every port is a parameter; what a room is wired with is `run-service.ts`'s choice.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Gh, LimitMet, SignIn } from "@lookover/contracts";
import {
  type AskToInstallRefusal,
  accountOf,
  apply,
  type ChangeId,
  type Clock,
  type Connection,
  type ConnectionAccount,
  changeIdOf,
  changePrefixOf,
  DISCOVERY_RETRY_MS,
  type EngineHealth,
  type EngineId,
  type EngineState,
  type Engines,
  type EventBody,
  type Finding,
  GITHUB_WEB,
  type IdGen,
  type LoginItemKind,
  type LookRefusal,
  type NoiseChoice,
  type PauseFor,
  type RepositoryId,
  type RepositoryRef,
  type ResolvedSettings,
  type Rule,
  reposChosen,
  repositoryRefOf,
  type SettingKey,
  type SettingValues,
  type Setup,
  type SignInStartRefusal,
  type State,
  sameRepository,
} from "@lookover/contracts";
import { lookoversReply } from "@lookover/core";
import type { SelfTests } from "@lookover/engines";
import { INPUT_LIMITS } from "@lookover/engines";
import { createPublisher } from "@lookover/publish";
import type { Retrieval } from "@lookover/retrieval";
import { createConfirm, createReview } from "@lookover/review";
import type { SettingsFiles } from "@lookover/settings";
import { openStore, type Store } from "@lookover/store";
import { createChecks } from "./checks.ts";
import { chooseAgain, endedSent } from "./choice-again.ts";
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
import { createDeviceFlow } from "./device-flow.ts";
import { createDismissals, type Dismissing, type DismissRefusal } from "./dismiss.ts";
import { EventLog } from "./events.ts";
import { checkItems, freeGbOf } from "./health-checks.ts";
import { createInstallation, type GitHubSide, type Installation } from "./installation.ts";
import { differsLine, droppedLine, logLineOf, skippedLine } from "./log-lines.ts";
import { secretShapesRemoved } from "./log-sink.ts";
import { type LoginItem, nowhereLoginItem } from "./login-item.ts";
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
  changeFactsOf,
  numberOf,
  ownershipMoved,
  repoIdOf,
  repositoryOf,
  reposLeft,
  rulesOf,
  SET_UP,
  type Started,
  settingsOf,
  signedInAtSetup,
  startOf,
} from "./snapshot.ts";
import { atLoginLeft, createStartAtLogin, matchedAtStart } from "./start-at-login.ts";
import { statusNow } from "./status-block.ts";
import { REAL_TIMERS, type Timers } from "./timers.ts";
import { createUnreached } from "./unreached.ts";

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
   * GitHub through the shared App (ADR 0066, ADR 0073): the room watches what the person's installations list,
   * reviews through the repository ports as the person signed in, and takes the owner from their sign-in.
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
   * demo scenario's world, or the first step on a fresh data folder nobody signed in to (ADR 0047, ADR 0053). Later
   * starts read what the store kept, unless `setUpAtOnce`.
   */
  setup?: Setup;
  /**
   * Live mode's sign-in is kept (ADR 0073): the data folder is set up at once, whatever setup it kept. With nobody
   * signed in, the setup's GitHub step shows again whatever it kept.
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
   * config (`runService` chooses); by default, the stand-in that registers nothing (ADR 0070).
   */
  loginItem?: AtLoginItem;
  /**
   * The person's own `gh` (ADR 0059), read only: the real one for the program and live mode, testkit's fake in demo
   * mode (`runService` chooses); none in a test that doesn't ask, read as `gh` not installed. Read for the person's
   * organisations and their role in each (ADR 0067), at start, once a sign-in is kept and after each "Ask to
   * install", never waited for by discovery.
   */
  gh?: Gh;
  /**
   * The machine the commands the app gives are for (an AI's install command, ADR 0070), as Node names it: the
   * configuration's, demo mode's machine, or a test's.
   */
  platform: NodeJS.Platform;
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

/** Where each part logs: where the options say, else (nothing given) to the console. */
const loggedOf = (o: Pick<RoomOptions, "log">): { log?: (line: string) => void } =>
  o.log === undefined ? {} : { log: o.log };

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
   * Repositories said departed (ADR 0059) dismissed by the person, one or many at once (ADR 0082): `repo.dismissed`
   * sent for each named one said departed, in the order they are said, no longer said, back or not; one not said is
   * passed over. Refused when none of them is said departed.
   */
  dismissDeparted(repoIds: readonly RepositoryId[]): "ok" | "no_such_repository";
  /** "Unlock" (ADR 0047): the session unlocked, sent once; nothing when it is already. */
  unlock(): void;
  /**
   * The first-run setup and each watched repository's switch (ADR 0047); its finish registers start at login as the
   * owner chose (ADR 0054), and settles once it has. The choice made again is the room's own (ADR 0090).
   */
  setup: Omit<SetupFlow, "finish" | "again" | "heldAtStart"> & { finish(): Promise<void> };
  /** The person on GitHub (ADR 0066): their sign-in to the shared App, and their asks to install it. */
  github: {
    /**
     * "Sign in with GitHub", or Sign in again (ADR 0066): a device code asked of GitHub and shown on the connection,
     * polled until entered (the sign-in kept, replacing the last), refused, expired or cancelled. Refused while one
     * waits; throws GitHub's refusal of the code.
     */
    signIn(): Promise<"ok" | { refused: SignInStartRefusal }>;
    /** The sign-in waiting given up, its code no longer shown; nothing when none waits. */
    cancelSignIn(): void;
    /**
     * "Ask to install on <org>" (ADR 0067): the ask on `account` (a login) kept with its time, until that account is
     * reached or another person signs in, the person's `gh` read again; refused before a sign-in, for an account
     * `Connection.unreached` doesn't name, or one the person owns.
     */
    askToInstall(account: string): Promise<"ok" | { refused: AskToInstallRefusal }>;
    /**
     * An install look (ADR 0088), asked by a link to GitHub's install page or settings or "Check again", and begun
     * by an ask kept too: the installations listed now, then every 4 s for 3 minutes or until something new arrives;
     * asked while one runs, its end moved on. Refused before a sign-in.
     */
    look(): Promise<"ok" | { refused: LookRefusal }>;
    /**
     * The tab coming back (ADR 0091): while a look runs, the installations listed now, its end unmoved; else, or
     * nobody signed in, nothing.
     */
    returned(): void;
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
   * "Start at login" (ADR 0054, ADR 0068): once the setup is done, the registration on the machine changed first
   * (another install's replaced only with `takeOver`); then the owner's choice kept and sent as `service.changed`.
   * Refused with the machine's reason, the choice as it was.
   */
  startAtLogin(on: boolean, takeOver?: boolean): Promise<"ok" | { refused: string }>;
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
 * `stand-in` for the rest, which registers nothing.
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

/** Start at login's registration: the one the options give, else the stand-in that registers nothing (ADR 0070). */
const loginItemOf = (o: RoomOptions): AtLoginItem =>
  o.loginItem ?? { item: nowhereLoginItem(), kind: "stand-in" };

/** GitHub's web address the room's links are built on: GitHub's own unless the options name another. */
const webOf = (o: RoomOptions): string => o.web ?? GITHUB_WEB;

/** A reconnect after an adopt that GitHub refused: the connection's cause says why, the App stays kept. */
const keptAnyway = (): void => {};

/**
 * Builds a room: opens the store (or takes the open one it is given) and, when it keeps no setup yet, writes
 * the setup it starts at; reads the sign-in to the shared App and, once the setup says it is installed, the
 * repositories its installations list (ADR 0053, ADR 0066); asks both engines' health, records its start as the next
 * event, forgets the repositories the installations no longer list, lists the changes and the comments (not while
 * nothing is installed: the setup lists once it is), puts back in the queue or fails the jobs a stopped service left
 * running, takes the next job and starts the poll's loop and the installation's. Rejects when the store won't open, or
 * the sign-in store can't be read; GitHub refusing the installations or the changes at start is no rejection (ADR
 * 0053): the room is built, the connection shows the cause, and the installations are listed again a minute on (a
 * rate limit only waits). Nor is a sign-in that no longer opens: the connection shows it signed out.
 */
export async function buildRoom(o: RoomOptions): Promise<Room> {
  const store = o.store ?? openStore({ home: o.home });
  setUp(store, o);
  const startedAt = o.clock.now();
  /** Logs where the options say, else to the console. */
  const logLine = o.log ?? ((line: string) => console.error(line));
  // Start at login made to match the owner's choice, once the setup is done (ADR 0054).
  const loginItem = loginItemOf(o);
  const heldAtStart = await matchedAtStart(loginItem.item, store, logLine);
  const timers = o.timers ?? REAL_TIMERS;
  /** What the room watches: the store's last listing until the start's listing makes it the room's own. */
  const watching = { all: (): readonly RepositoryRef[] => store.repos.listed() };
  // The person signed in, the installations they reach and what those list (ADR 0066). Its moves reach parts made
  // below, once the room runs.
  const github = createInstallation({
    side: o.github,
    timers,
    now: () => o.clock.now(),
    emit: (body) => emit(body),
    watched: () => watching.all(),
    added: (repos) => moves.added(repos),
    removed: (repo) => moves.leave(repo),
    installed: (granted) => setup.installed(granted),
    reached: (cause) => poller.reached(cause),
    accountBack: () => queue.take(),
    limitUntil: () => shown.connection.limitUntil,
    limited: (until) => poller.limited(until),
    asked: () => shown.connection.unreached.filter((u) => u.askedAt !== null).map((u) => u.account.login),
    log: logLine,
  });
  const { listed: listedAtStart, again: againAtStart } = await opened(store, github);
  // What the installations list now; what the store listed last when they weren't listed (nobody signed in yet).
  const watched = watchedOf(listedAtStart ?? store.repos.listed());
  watching.all = () => watched.all;
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
   * what tells whether the UI's rules are behind the store's. Read, not trusted (ADR 0085): what the replay can't
   * apply or this version can't read is gone, and the start's own facts are on it, before anything reads it.
   */
  const setupAtStart = store.setup.read();
  const started = startOf(
    {
      now: startedAt,
      startedAt,
      version: o.version,
      command: commandAtStart,
      agent: agentAtStart,
      connectionId: github.connectionId(),
      person: github.person(),
      accounts: github.accounts(),
      listed: github.listed(),
      listingCause: github.listingCause(),
      web: webOf(o),
      engines,
      setup: setupAtStart,
      startAtLogin: store.setup.startAtLogin(),
      atLogin: heldAtStart,
      loginItem: loginItem.kind,
      platform: o.platform,
      paused: store.pause.current(),
      ...(o.remote === undefined ? {} : { remote: o.remote }),
    },
    store.events.all(),
  );
  let shown = started.state;
  saidAtStart(started, logLine);
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
  // The person's accounts on the shared App (ADR 0067): whose they are, and those the App doesn't reach.
  const unreached = createUnreached({
    gh: o.gh,
    asks: store.installAsks,
    now: () => o.clock.now(),
    shown: () => shown.connection,
    emit: (body) => emit(body),
    log: logLine,
  });
  /** A read of the person's `gh` that failed past its answer (the store refusing): logged, nothing else. */
  const unshown = (error: unknown) => logLine(`your organisations could not be shown again: ${said(error)}`);
  const emit = (sent: EventBody) => {
    // What a connection's move moves too: its accounts' owners, and those not reached.
    const body: EventBody =
      sent.type === "connection.changed"
        ? { ...sent, patch: unreached.completed(sent.patch, shown.connection) }
        : sent;
    const event = store.events.append(body);
    // The asks the connection it moved makes stale, forgotten once the event is kept.
    if (body.type === "connection.changed") unreached.held(body.patch, shown.connection);
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
  // The service's own facts (its version, its command and your coding agent with it, its login item), where the
  // replayed log says an earlier start's (another version, another executable, another PATH, a skill changed while
  // stopped); or, when the start dropped or renamed anything of the replay (ADR 0085, ADR 0066), the whole state it
  // read, as one `state.replaced`, before the events below compare against it and before anything is served.
  emit(started.first);
  // A watched repository with its switch, the store's (ADR 0047), and its settings, the files' as last read (ADR 0049).
  const repository = (repo: RepositoryRef) =>
    repositoryOf(repo, store.repos.enabled(repo), settingsNow(repoIdOf(repo)).settings);
  const listedBefore = store.repos.listed();
  // What a stop left behind is sent now: the sign-ins it left pending, and a start at login or rules the store kept
  // but the stop kept from the UI (between the write and its event), where the replayed log says the older ones.
  const left = [
    // The setup as the store keeps it, where the replayed log says the one before this start's (`setUp`, `opened`).
    ...setupLeft(shown, store.setup.read(), startedAt),
    ...signInsLeft(shown, startedAt),
    ...deviceCodeLeft(shown, startedAt),
    ...startAtLoginLeft(shown, store.setup.startAtLogin(), startedAt),
    ...atLoginLeft(shown.service.atLogin, heldAtStart, startedAt),
    // The person and their installations as read now, where the log says those of before the stop (a reinstall
    // meanwhile).
    ...identityLeft(shown, github, startedAt),
    // Whose changes are whose for the person held now, where the log says it for another (a sign-in replaced while
    // stopped, by another process on the folder).
    ...ownershipMoved(
      shown,
      changeFactsOf(
        watched.all.flatMap((repo) => store.inbox.open(repo)),
        github.owner,
      ),
      startedAt,
    ),
    // What the store watches and the state lacks (ADR 0085): a repository an older version wrote, dropped. The open
    // changes come back with the start's listing (`changesLeft`): the store keeps no title.
    ...reposLeft(
      shown,
      watched.all
        .filter((repo) => listedBefore.some((listed) => sameRepository(listed, repo)))
        .map((repo) => ({ ...repository(repo), noise: noise(repo) })),
      startedAt,
    ),
    // The settings files are their truth (ADR 0049), and a hand edit while stopped counts from now.
    ...settingsMoved(shown, kept.now(), startedAt),
  ];
  for (const body of left) emit(body);
  // The owners and the accounts not reached as the start holds them, then the person's `gh` read, never waited for.
  unreached.settle();
  void unreached.read().catch(unshown);
  const everyRulesMoved = () => watched.all.map((repo) => rulesMoved(repoIdOf(repo)));
  everyRulesMoved();

  const ids = o.ids ?? { next: () => randomUUID() };
  // The decisions' reads: the store's, never the snapshot (#64). The switch is the store's (ADR 0047); the settings
  // are the files', as last read (ADR 0049).
  const settings = (repoId: RepositoryId) => settingsOf(repository(watched.byId(repoId)));
  const openChanges = () =>
    changeFactsOf(
      watched.all.flatMap((repo) => store.inbox.open(repo)),
      github.owner,
    );
  // The repository ports as the person now held (ADR 0066).
  const { intake, writer } = github.ports;
  // The block's time and the resets of the engines' limits, as the UI is told them (ADR 0055).
  const statusFacts = {
    now: () => o.clock.now(),
    limitUntil: (engine: EngineId) => shown.engines[engine].limitUntil,
  };
  // A post GitHub refuses for a moment is tried again on the room's own clock and timers (ADR 0044).
  const publisher = createPublisher({
    writer,
    // Each check's external id names the person Lookover works for, read at each post (ADR 0066): the one signed in
    // to the shared App. With nobody signed in the post fails, said in the log, rather than write a check its reader
    // can't find again.
    person: () => personPosting(github),
    // The result names each finding's thread, from one read as the round's check is completed (ADR 0052).
    threads: (change) => intake.threads(change),
    // A reply already sent is Lookover's (ADR 0066): its id kept for the change, else by who posts with its marker.
    lookovers: async (change) =>
      lookoversReply(
        store.posts.replies(changeIdOf(change.repo, change.number)),
        await intake.poster(change.repo),
      ),
    time: { now: () => o.clock.now(), after: timers.after },
    // A comment GitHub wouldn't minimize never fails the round: it is said in the log.
    log: (line) => (o.log ?? console.error)(line),
    // What an engine or a person wrote is posted without the secrets the log sink knows (ADR 0056).
    secretsRemoved: secretsRemovedOf(o),
    // The status block says where the change stands as it is written, read from the store then (ADR 0074).
    status: (change, threads) =>
      statusNow(store, changeIdOf(change.repo, change.number), threads, statusFacts),
  });
  /** Each part logs where the options say, else to the console. */
  const logged = loggedOf(o);
  // The check follows every job from the moment it is recorded (ADR 0043); `publish` writes it.
  const checks = createChecks({
    store,
    publisher,
    clock: o.clock,
    host: "github",
    changeRef: (changeId) => ({ repo: watched.ofChange(changeId), number: numberOf(changeId) }),
    onlyCodex: (changeId) => settings(repoIdOf(watched.ofChange(changeId))).values.reviewers === "codex",
    authorOf: (changeId) => openChanges().get(changeId)?.author ?? null,
    limitUntil: statusFacts.limitUntil,
    status: (changeId) => statusNow(store, changeId, [], statusFacts),
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
    platform: o.platform,
    gate,
    engineStates: () => shown.engines,
    connection: (repoId) => connectionFor(shown.connection, repoId),
    openChanges,
    settings,
    // The store's setup at each decision (ADR 0079): nothing asks by itself before the repositories are chosen.
    reposChosen: () => reposChosen(store.setup.read()),
    // Nothing taken and nothing owed written from the choice made again until another person's sign-in is held (ADR
    // 0090): what would be taken then would post as the last person.
    mayTake: () => switching === null,
    // An ask from the app is the sign-in's it began under: none past another person's (ADR 0090).
    signInTurn: () => (switching === null ? signInTurn : null),
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
    setupShowsList: () => {
      const setup = store.setup.read();
      return !setup.done && (setup.step === "repos" || setup.step === "first-review");
    },
    emit,
    connection: () => shown.connection,
    shown: () => shown,
    rebuilt: (changeId) => queue.rebuilt(changeId),
    opened: (changeId) => queue.opened(changeId),
    pushed: (changeId, sha) => queue.pushed(changeId, sha),
    requested: (changeId, request, full) => queue.requested(changeId, request, full),
    resend: () => {
      reactions.send();
      checks.resend();
    },
    take: () => queue.take(),
    discover: (why) => rediscover(why),
    // While another person's sign-in is on its way to be held (ADR 0090) nothing is: every poll ends at its next wait,
    // nothing of it applied or handed over, and what it read is read again under the new one.
    holding: () => (switching === null ? github.holding() : null),
    accountRefused: (repo, cause, at) => github.refused(repo, cause, at),
    accountAnswered: (repo, at) => github.answered(repo, at),
    log: logLine,
  });
  /** Lists the open changes now (after any listing under way), then takes. */
  const listed = async () => {
    await poller.poll();
    queue.take();
  };
  /** Whether `stop` began: a read that answers late sends nothing then. */
  let stopping = false;
  /**
   * While another person's sign-in is on its way to be held (ADR 0090), from the choice of repositories made again
   * until it is, what settles then; null otherwise. Meanwhile the poller hands nothing over, the queue takes nothing
   * and writes nothing owed, and "Review now" waits for it, so nothing read, taken or asked under the last person runs
   * or posts as the new one.
   */
  let switching: Promise<void> | null = null;
  /** Which person's sign-in the app's asks are made under: moves as another person's begins to be held (ADR 0090). */
  let signInTurn = 0;
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
  const setupFlow = createSetup({
    store,
    clock: o.clock,
    emit,
    repos: () => watched.all,
    github,
    review: queue.firstReview,
    chosen: () => queue.chosen(),
  });
  /**
   * The sign-in changed (ADR 0090): the choice of repositories made again with the room's parts (`chooseAgain`), every
   * run under way stopped, every review not finished cancelled, nothing written to GitHub, and the setup back at the
   * GitHub step's start, all in this turn. Settles once the stopped runs have ended; whoever then signs in is held,
   * and their install waited for.
   */
  const signInChanged = (): Promise<void> =>
    chooseAgain({
      store,
      stopRuns: () => queue.leave(""),
      checks,
      shown: () => shown,
      emit,
      now: () => o.clock.now(),
      setup: setupFlow,
    });
  await sinceLastStart({
    store,
    github,
    listed: listedAtStart,
    leave: moves.leave,
    signInChanged: againAtStart
      ? () => signInChangedAtStart({ store, github, signInChanged, setup: setupFlow })
      : null,
    emit,
    at: startedAt,
  });
  const waitsAtStart = holdPollsForStartLimit(github, poller, o.clock.now());
  // The first listing: what changed while the service was stopped. A job the last service left running never
  // finished: it runs again, once, or fails, "the service stopped"; then the jobs left waiting are taken (#62).
  // Then the poll goes on by itself.
  // A rate limit at start is only a wait: the poller keeps GitHub's reset time, and lists then; a refusal is logged,
  // the connection showing it (`Poller.first`), and the service starts all the same (ADR 0053). With no bot installed
  // yet (the setup's GitHub step) there is nothing to list: the setup lists once it is (ADR 0047). With the App or its
  // installation refused at start, the loop lists, and shows the connection back once GitHub answers; asked to wait
  // there, it lists at the wait's end.
  if (shown.connection.state !== "not-connected" && github.down() === null && !waitsAtStart)
    await poller.first();
  queue.recover();
  // The repositories chosen already: the coding agent's requests kept before are answered now (ADR 0090), those a
  // stopped service left kept, or kept until a start set up at once (`setUpAtOnce`) chose without the setup's write.
  queue.chosen();
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
    shown: () => shown.service.atLogin,
    log: logLine,
  });
  // The setup done: start at login registered as the owner chose (ADR 0054).
  const setup: Room["setup"] = {
    ...setupFlow,
    finish: async () => {
      setupFlow.finish();
      await atLogin.match();
    },
  };
  // The installation's own loop: its repositories every 2 minutes (ADR 0088), or the install waited for (ADR 0053).
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
        checks: { at, running: false, items: checkItems(shown, kept.now().invalid, freeGb) },
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

  // "Sign in with GitHub" (ADR 0066): the device flow, its code on the connection, the sign-in kept once entered.
  const deviceFlow = createDeviceFlow({
    host: o.github.shared.signIn,
    timers,
    clock: o.clock,
    emit,
    signedIn: (made) => signedIn(made),
    log: logLine,
  });

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
   * "Reconnect" (ADR 0053): the installations' repositories listed again, then every repository's changes; what the listing of the changes throws
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

  /**
   * Another person's sign-in held in place of the setup's (ADR 0090): the sign-in changed first (`signInChanged`),
   * then the last person's dismissal sends cut, and their check, block, reaction and dismissal writes under way
   * landed, all before it is held, nothing handed
   * over, taken or asked meanwhile (`switching`), so nothing of the last person's posts as them; the connection names
   * nobody's installation until theirs is found. Then what waited (a "Review now" asked meanwhile) is taken, as them.
   */
  const switchedTo = async (made: SignIn): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    switching = promise;
    signInTurn++;
    try {
      await signInChanged();
      await dismissals.cut();
      await checks.idle();
      await reactions.idle();
      // No installation of theirs found yet: the connection names nobody's, as a fresh setup's does.
      if (shown.connection.id !== null)
        emit({ type: "connection.changed", at: o.clock.now(), patch: { id: null } });
      await github.signedIn(made);
    } finally {
      switching = null;
      resolve();
    }
    queue.take();
  };
  /**
   * A sign-in to the shared App made (ADR 0066): kept and held, the ports posting as its person; then its install
   * waited for, or, installed already (Sign in again once signed out), the connection named for the person and its
   * repositories and changes listed again. Another person than the setup's (ADR 0090): `switchedTo` first.
   */
  const signedIn = async (made: SignIn): Promise<void> => {
    if (anotherThanSetups(store.setup.person(), made.person)) await switchedTo(made);
    else await github.signedIn(made);
    store.setup.keepPerson(made.person.id);
    // Their organisations, as their `gh` names them: read once per sign-in, never waited for.
    void unreached.read().catch(unshown);
    // Another person signed in: their changes and the others' are told apart for them now.
    for (const body of ownershipMoved(shown, openChanges(), o.clock.now())) emit(body);
    setup.signedIn();
    const installed = appInstalled(store.setup.read());
    for (const body of renamedFor(github, shown, o.clock.now(), installed)) emit(body);
    // Not waited for: the code leaves once the sign-in is kept, the listing goes on behind it.
    if (installed) void reconnect().catch(keptAnyway);
  };

  return {
    snapshot,
    events: log,
    clock: o.clock,
    refresh: listed,
    reconnect,
    github: {
      signIn: deviceFlow.start,
      cancelSignIn: deviceFlow.cancel,
      // An ask kept opens GitHub's install page: Lookover looks for what an owner does there (ADR 0088).
      askToInstall: async (account) => {
        const answer = await unreached.ask(account);
        if (answer === "ok") await github.look();
        return answer;
      },
      look: github.look,
      returned: github.returned,
    },
    // Asked while another person's sign-in is on its way to be held (ADR 0090): asked once it is, as them.
    review: async (changeId) => {
      await switching;
      // Asked by the last person while its listing was under way: answered by the choice made again, nothing asked.
      const answer = await queue.request(changeId);
      return answer === "signed-in-since" ? "ok" : answer;
    },
    checkEngines: queue.checkEngines,
    signIn: signIn.start,
    reroute: queue.reroute,
    runChecks,
    dismissDeparted: (repoIds) => {
      const named = shown.departed.filter((d) => repoIds.includes(d.id)).map((d) => d.id);
      if (named.length === 0) return "no_such_repository";
      const at = o.clock.now();
      for (const repoId of named) emit({ type: "repo.dismissed", at, repoId });
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
      // Asked while another person's sign-in is on its way to be held (ADR 0090): the earlier person's round is no
      // longer theirs to post on, and the setup is being made again; refused once it is held, nothing saved or posted.
      async (changeId, findingId) => {
        if (switching === null) return dismissals.dismiss(changeId, findingId);
        await switching;
        return "settled";
      },
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
      unreached.stop();
      signIn.stop();
      deviceFlow.stop();
      github.stop();
      runFolders.stop();
      await poller.stop();
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

/** The repositories watched: a change id names its repository's owner and name, so two of one name are two. */
function watchedOf(repos: readonly RepositoryRef[]): Watched {
  let all: readonly RepositoryRef[] = [];
  const add = (repo: RepositoryRef) => {
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
 * kept, set up at once when live mode's sign-in is kept.
 */
function setUp(store: Store, o: Pick<RoomOptions, "setup" | "setUpAtOnce">): void {
  if (!store.setup.kept()) store.setup.write(o.setup ?? SET_UP);
  else if (o.setUpAtOnce && !store.setup.read().done) store.setup.write(SET_UP);
}

/**
 * The sign-in read at start, and what its installations list when the setup says the App is installed; null when
 * nothing was listed. With nobody signed in, the setup's GitHub step shows again, whatever the setup kept and whatever
 * else the data folder holds (ADR 0073: an App of its own from an earlier version is read no more). A sign-in kept
 * while the setup still asks for one (the service stopped before the setup heard of it) has its install waited for,
 * as `signedIn` would. `again`: nobody is signed in while the setup said someone was, or another person than the
 * setup's is (ADR 0090), so the start makes the choice of repositories again (ADR 0079, ADR 0090), once its events
 * can be sent. A setup that names nobody (set up at once, or before its person was kept) is the person's signed in
 * now, nothing else changed.
 */
async function opened(
  store: Store,
  github: Installation,
): Promise<{ listed: RepositoryRef[] | null; again: boolean }> {
  const listed = await github.open(appInstalled(store.setup.read()));
  const person = github.person();
  const asked = signedInAtSetup(store.setup.read());
  if (person !== null && !asked) store.setup.write({ github: "waiting-for-install" });
  const kept = store.setup.person();
  if (person !== null && kept === null) store.setup.keepPerson(person.id);
  return { listed, again: (person === null && asked) || anotherThanSetups(kept, person) };
}

/** Whether `person`, signed in, is another than the one the setup belongs to (ADR 0090): never when it names nobody. */
const anotherThanSetups = (kept: number | null, person: { id: number } | null): boolean =>
  kept !== null && person !== null && person.id !== kept;

/**
 * The sign-in changed while the service was stopped (ADR 0090): the choice of repositories made again, then the setup
 * kept as the person's signed in now, or nobody's; with someone signed in, the GitHub step waits for their install
 * (`SetupFlow.heldAtStart`).
 */
async function signInChangedAtStart(d: {
  store: Store;
  github: Pick<Installation, "person">;
  signInChanged(): Promise<void>;
  setup: Pick<SetupFlow, "heldAtStart">;
}): Promise<void> {
  await d.signInChanged();
  const person = d.github.person();
  d.store.setup.keepPerson(person?.id ?? null);
  if (person !== null) d.setup.heldAtStart();
}

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
      const { setup, changes: open } = d.shown();
      // Each review the UI shows waiting or running is sent its job as it ended: cancelled, its run gone.
      endedSent(d, changes);
      const first = setup.firstReviewChange;
      if (first !== null && open[first]?.repoId === repoId) d.store.setup.write({ firstReviewChange: null });
      d.watched.remove(repo);
      d.emit({ type: "repo.removed", at: d.now(), repoId });
      await stopped;
    },
  };
}

/**
 * What the start skipped of its replay and dropped of the state it read, one line each, in the log (ADR 0085), and
 * where the state read differs from the replay when nothing was dropped.
 */
function saidAtStart({ skipped, dropped, differs }: Started, logLine: (line: string) => void): void {
  for (const event of skipped) logLine(skippedLine(event));
  for (const piece of dropped) logLine(droppedLine(piece));
  if (differs !== null) logLine(differsLine(differs));
}

/**
 * What changed while the service was stopped (ADR 0053), sent before anything is listed: each repository the store
 * listed and the installation no longer lists leaves; a key that no longer opens, or GitHub refusing the App, its
 * installation or its repositories, is shown at once as the connection's cause. The sign-in changed since (from
 * `opened`, ADR 0090): `signInChanged`, so nothing of the earlier session resumes, runs or posts; null when it didn't.
 */
async function sinceLastStart(d: {
  store: Store;
  github: Installation;
  listed: readonly RepositoryRef[] | null;
  leave(repo: RepositoryRef): Promise<void>;
  signInChanged: (() => Promise<void>) | null;
  emit(body: EventBody): void;
  at: number;
}): Promise<void> {
  const { listed } = d;
  if (listed !== null)
    for (const repo of d.store.repos.listed())
      if (!listed.some((r) => sameRepository(r, repo))) await d.leave(repo);
  if (d.signInChanged !== null) await d.signInChanged();
  const down = d.github.down();
  if (down !== null)
    d.emit({
      type: "connection.changed",
      at: d.at,
      patch: { state: "disconnected", cause: down, since: d.at },
    });
}

/**
 * GitHub asked the start's listing of the installations to wait (ADR 0088): the poller keeps it, and asks nothing
 * before its end. Whether that end is still to come at `now`.
 */
function holdPollsForStartLimit(github: Installation, poller: Poller, now: number): boolean {
  const until = github.limitedAtStart();
  if (until === null) return false;
  poller.limited(until);
  return until > now;
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
  dismiss: (...args: Parameters<Dismissing["dismiss"]>) => Promise<ReturnType<Dismissing["dismiss"]>>,
): Room["settings"] {
  return {
    ...commands,
    quiet: async (choice) => {
      const repo = repoOf(choice.changeId);
      if (repo === null) return "no_such_change";
      const findings = ledger(choice.changeId);
      if (choice.kind === "wrong") return await dismiss(choice.changeId, choice.findingId);
      if (choice.kind === "blocking-only") return commands.set(repoIdOf(repo), "strictness", "blocking");
      const finding = findings.find((f) => f.id === choice.findingId);
      if (finding === undefined) return "no_such_finding";
      if (finding.rule === null) return "no_rule";
      return commands.setRule(finding.rule.id, false);
    },
  };
}

/**
 * The connection as it stands for one repository (ADR 0066): disconnected while its account has a cause of its own,
 * whatever the connection's; the connection's otherwise, and for no repository.
 */
function connectionFor(connection: Connection, repoId: RepositoryId | null): Pick<Connection, "state"> {
  if (repoId === null || connection.state !== "connected") return connection;
  const repo = repositoryRefOf(repoId);
  const account = repo === null ? undefined : accountOf(connection.accounts, repo.owner);
  return account?.cause == null ? connection : { state: "disconnected" };
}

/**
 * The person signed in and their installations as `open` read them at start (ADR 0053, ADR 0066), when the replayed
 * log says others: uninstalled and installed again while the service was stopped, the log's last `connection.changed`
 * names the old installation, whose links ("Add a repository", "Unsuspend") lead nowhere, and discovery, finding its
 * own id current, would never say the new one; another sign-in kept while stopped, by another process on the folder,
 * where the log names the last one. One `connection.changed` with what moved; nothing for what `open` didn't read
 * (GitHub refusing at start: the log's are the last known), unless the log's are another person's: their id and
 * accounts are then never this one's, and those read (none, maybe) stand.
 */
function identityLeft(shown: State, github: Installation, at: number): EventBody[] {
  const was = shown.connection;
  const person = github.person();
  const id = github.connectionId();
  const accounts = github.accounts();
  // Another holds now than the log says: what the log knows of the connection is that other's.
  const another = !isDeepStrictEqual(person, was.person);
  const patch: Partial<Connection> = {
    ...(another ? { person } : {}),
    ...((another || (was.id !== null && id !== null)) && id !== was.id ? { id } : {}),
    ...((another || accounts.length > 0) && !sameReach(accounts, was.accounts) ? { accounts } : {}),
    // Listed or not as this start's listing says (ADR 0086), whatever the log said of an earlier one.
    ...(github.listed() === was.listed ? {} : { listed: github.listed() }),
    ...(isDeepStrictEqual(github.listingCause(), was.listingCause)
      ? {}
      : { listingCause: github.listingCause() }),
    // A look doesn't outlive the service (ADR 0088): one the log ran is over.
    ...(was.look === null ? {} : { look: null }),
  };
  return Object.keys(patch).length === 0 ? [] : [{ type: "connection.changed", at, patch }];
}

/**
 * Whether two lists name the same accounts reached, each with its installation and cause: whose they are is the
 * person's `gh`'s to say (`createUnreached`), never the installation's.
 */
const sameReach = (a: readonly ConnectionAccount[], b: readonly ConnectionAccount[]): boolean =>
  isDeepStrictEqual(
    a.map((x) => ({ ...x, owner: null })),
    b.map((x) => ({ ...x, owner: null })),
  );

/**
 * The setup as the store keeps it (ADR 0047), when the replayed log says another: the start set it up at once
 * (live mode's sign-in) or showed it again (nobody signed in) after the events of an earlier setup. One
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

/** The connection named for the person signed in now, once `installed`, when the UI names it for another (ADR 0066). */
function renamedFor(github: Installation, shown: State, at: number, installed: boolean): EventBody[] {
  const id = github.connectionId();
  return !installed || id === null || id === shown.connection.id
    ? []
    : [{ type: "connection.changed", at, patch: { id } }];
}

/** The id of the person Lookover works for and posts the checks for; throws with nobody signed in. */
function personPosting(github: Installation): number {
  const { id } = github.owner;
  if (id === 0) throw new Error("Nobody is signed in: there is nobody to post the check for");
  return id;
}

/**
 * A device code a stopped service left on the connection (ADR 0066) is over at the next start: nothing polls it now.
 * One `signIn: null`, or nothing.
 */
function deviceCodeLeft(shown: State, at: number): EventBody[] {
  return shown.connection.signIn === null
    ? []
    : [{ type: "connection.changed", at, patch: { signIn: null } }];
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
