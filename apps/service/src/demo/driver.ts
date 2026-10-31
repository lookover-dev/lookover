// The demo driver (ADR 0046): one scenario played against the real service. It builds the fake world from the
// scenario (`world.ts`), the demo clock standing still at the room's start, and the engine room on them
// (`buildRoom`: the store on a fresh folder, numbering on from `eventsFrom`), then plays the seed: each move at
// its time, the clock advanced through them, so every round, poll and pause of the story has happened by the
// service's own rules before the room is handed over. The rest of the script is armed on the clock. Then the
// clock stands at the seed's end (`frozen`) or flows with the real time. Ids count from 1 per room, so two
// loads of a scenario at the same instant give the same events. The drawer's faults (`inject`) are moves played
// now; the listing is what the drawer shows. The room keeps its App in an App store on a keychain of its own (ADR
// 0053), written before the room starts when the setup says the App was made, so "Use an existing App" and the
// manifest flow keep theirs as they would on the owner's computer. The shared App is offered beside it (ADR 0066):
// the fake's device flow, its code entered on GitHub's fake device page or by the drawer, the sign-in kept in a
// sign-in store on the same keychain. Start at login is the fake's, kept across restarts
// as the computer keeps it (ADR 0054). Three faults restart the service (the key gone from the keychain, which a running
// service never reads again; start at login gone and refused, which a service matches only at its start; the program
// installed by npm, which a service learns only at its start): the room
// stopped and built again on the same folder,
// store and world, its own timers dropped and the world's kept; `room` is the room now. A seed whose review fails (a
// fixture missing an answer) rejects with the job's failure, and one whose move throws with that error, its room
// stopped first: a scenario never loads half told.

import { join } from "node:path";
import {
  DEMO_API,
  type DemoListing,
  type EngineId,
  FAULTS,
  type FaultId,
  HostError,
  type JobFailure,
  type PathOffer,
  type RepositoryRef,
  SHARED_APP,
  type State,
} from "@lookover/contracts";
import { openStore, type Store } from "@lookover/store";
import {
  DemoClock,
  type FakeGitHost,
  fakeGitHubPages,
  type MemoryGh,
  memoryGh,
} from "@lookover/testkit/demo";
import { appStore } from "../app-store.ts";
import { memoryCommandPath } from "../command-path.ts";
import { storedOf } from "../installation.ts";
import { memoryKeychain } from "../keychain.ts";
import { memoryLoginItem } from "../login-item.ts";
import { buildRoom, type Room, type RoomOptions } from "../room.ts";
import { said } from "../said.ts";
import { type SignInStore, signInStore } from "../sign-in-store.ts";
import { memorySkillFolders, SKILL_NAME } from "../skill-folders.ts";
import { appMade } from "../snapshot.ts";
import type { Timers } from "../timers.ts";
import type { Move, Scenario, TimedMove } from "./scenario.ts";
import { SCENARIOS } from "./scenarios.ts";
import { demoSettingsFiles, plantSettings } from "./settings.ts";
import { createWorld } from "./world.ts";

export interface DemoRoomOptions {
  scenario: Scenario;
  /** The room's folder: its store, its runs' raw output. */
  home: string;
  /**
   * The instant the seed ends at, where the clock then stands still (`bun run proof`); absent, the seed ends at
   * the real time now and the clock flows on with it.
   */
  frozen?: number;
  /** The number the room's events continue from: the last room's last (ADR 0046). */
  eventsFrom?: number;
  version: string;
  eventsKept?: number;
  log?(line: string): void;
  /** The log sink's filter, which an engine's activity passes (ADR 0055): the room's own without a sink. */
  secretsRemoved?(text: string): string;
  /** What the listing shows and a load may name: the catalogue (`SCENARIOS`) unless a test brings its own. */
  scenarios?: Scenario[];
  /**
   * What makes each file of the room's App store user-only: the App store's own (`icacls` on Windows, two programs
   * per room) unless a test injects a quicker one; the App store's tests check the real one.
   */
  userOnly?: (path: string) => Promise<void>;
  /**
   * The person's `gh` (ADR 0059): a test's own, emptied and set as each scenario's world says at its load; none, a
   * new one per room, so no load inherits another's sign-in or organisations. The drawer's "You sign in to gh" signs
   * it in as the scenario's owner.
   */
  gh?: MemoryGh;
}

/** Why a fault did nothing: the story has nothing left for it. */
export type InjectRefusal =
  | "nothing_to_open"
  | "nothing_to_push"
  | "nothing_to_close"
  | "not_installed"
  | "no_app_kept"
  | "nothing_to_add"
  | "nothing_to_remove"
  | "nothing_departed"
  | "no_organisation"
  | "no_sign_in"
  | "not_signed_in"
  | "no_organisation_reached"
  | "nothing_asked";

export interface DemoRoom {
  /** The room now: another one once a fault restarted the service. */
  readonly room: Room;
  scenario: Scenario;
  /**
   * Makes a fault happen now, or says why it can't. One that restarts the service waits for `settled` (every
   * other command under way answered, from the room it reached) before that room stops.
   */
  inject(fault: FaultId, settled?: () => Promise<void>): Promise<"ok" | InjectRefusal>;
  /** The restart under way, which commands refuse ("loading") as during a load; null when none is. */
  restarting(): Promise<void> | null;
  /**
   * GitHub's pages, faked on this world's host (ADR 0053): the answer to a request for one of them under
   * `DEMO_API.github`, null for any other. The manifest flow makes and installs the App through them.
   */
  github(request: Request): Promise<Response | null>;
  /** The name the manifest gives the App in demo mode: a fixed one, so two runs show the same App (`bun run proof`). */
  appName: string;
  /** What the developer drawer lists: every scenario, this one, the clock, the faults. */
  listing(): DemoListing;
}

/** The App the manifest flow makes in demo mode: named as Lookover names one, `lookover-` and six characters. */
const DEMO_APP_NAME = "lookover-k3x9q2";
/**
 * The demo owner's home on Windows, where demo mode plays the program: the PATH's folder and the skills are under it,
 * and the program downloaded to it, a space in its path. Its command off the PATH is the binary's, which the skill
 * calls; once on the PATH, `lookover` (ADR 0058).
 */
const DEMO_USER_HOME = String.raw`C:\Users\Your Name`;
const DEMO_PATH_FOLDER = String.raw`${DEMO_USER_HOME}\AppData\Local\Lookover\bin`;
const DEMO_COMMAND = {
  onPath: "lookover",
  offPath: String.raw`& '${DEMO_USER_HOME}\Downloads\lookover.exe'`,
};
/** The binary as the skill calls it: forward slashes, one line Git Bash and PowerShell (with `&`) both read. */
const DEMO_SKILL_COMMAND = "'C:/Users/Your Name/Downloads/lookover.exe'";
/** The home of the room the `npm-install` fault restarts as an npm install (ADR 0061): its folders are under it. */
const DEMO_NPM_HOME = String.raw`C:\Users\Your Name`;
/** npm's folder for its commands on Windows, where an npm install's `lookover` is. */
const DEMO_NPM_FOLDER = String.raw`${DEMO_NPM_HOME}\AppData\Roaming\npm`;
/** An npm install's command, on the PATH or not: npm put it there. */
const DEMO_NPM_COMMAND = { onPath: "lookover", offPath: "lookover" };
/** An npm install's executable, in its platform package under npm's folder, as the skill calls it. */
const DEMO_NPM_SKILL_COMMAND =
  "'C:/Users/Your Name/AppData/Roaming/npm/node_modules/lookover/node_modules/@lookover/win32-x64/lookover.exe'";

/** How long GitHub asks to wait when the drawer says so. */
const GITHUB_LIMIT_MS = 20 * 60_000;
/** When Codex's limit resets, as its run says, when the drawer has it reach its limit: two days on, not today. */
const CODEX_RESETS_IN_MS = 2 * 24 * 60 * 60_000;
/** How long GitHub is out of reach when the drawer says so: long enough to see, short enough to come back. */
const CONNECTION_LOST_MS = 20_000;
/** Who suspends the shared App on an organisation when the drawer says so, as GitHub names them: an owner of it. */
const SUSPENDED_BY = "mira";
/** The repositories "A repository is added to your App" makes on the owner's account, in turn. */
const ADDABLE = ["docs-site", "status-page", "billing-worker"];

/**
 * The demo clock as one room sees it: its timers, and the verbs the room offers. Stopped, it drops every timer
 * armed (the room's, the script's, the world's); stopped for a restart (`restarting`), the room's own only.
 */
function roomClock(clock: DemoClock) {
  const own = new Set<() => void>();
  let restarting = false;
  const timers: Timers = {
    after: (ms, fire) => {
      const cancel = clock.after(ms, () => {
        own.delete(cancel);
        fire();
      });
      own.add(cancel);
      return () => {
        own.delete(cancel);
        cancel();
      };
    },
    now: () => clock.now(),
  };
  return {
    timers,
    controls: {
      get running() {
        return clock.running;
      },
      get speed() {
        return clock.speed;
      },
      set: (running: boolean, speed: number) => clock.set(running, speed),
      advance: (ms: number) => clock.advance(ms),
      step: () => clock.step(),
      stop: () => {
        if (!restarting) clock.stop();
        for (const cancel of [...own]) cancel();
      },
    },
    restarting: () => {
      restarting = true;
    },
  };
}

/** The next minor version of `version` (0.162.1 → 0.163.0): what an update of the engine installs. */
function bumped(version: string | null): string {
  const [major = "0", minor = "0"] = (version ?? "0.0.0").split(".");
  return `${major}.${Number(minor) + 1}.0`;
}

/** The first job of the seed that failed, with its failure, when one did: a fixture that told the story wrong. */
function failed(state: State): { number: number; failure: JobFailure } | null {
  for (const review of Object.values(state.reviews)) {
    const failure = review.job?.failure;
    if (failure) return { number: state.changes[review.changeId]?.number ?? 0, failure };
  }
  return null;
}

/** Whether a run under way reviews on `engine`, as its finder, its second finder or its confirmer. */
const running = (state: State, engine: EngineId): boolean =>
  Object.values(state.reviews).some(
    (r) => r.run !== null && [r.run.reviewer, r.run.secondFinder, r.run.confirmer].includes(engine),
  );

export async function buildDemoRoom(o: DemoRoomOptions): Promise<DemoRoom> {
  const { scenario } = o;
  const start = (o.frozen ?? Date.now()) - scenario.seed;
  const clock = new DemoClock({ at: start });
  const world = createWorld(scenario, clock, join(o.home, "worktrees"));
  // The room's settings files: the world's planted in the room's folder before the room first reads them.
  const settings = demoSettingsFiles(o.home);
  await plantSettings(settings.files, scenario.world.repo, scenario.world.settings);
  // The fake GitHub owns the App, its installation and its repositories (ADR 0053); the room keeps its App in its
  // App store, on a keychain of its own: the fake's, once the setup says it was made, as the manifest flow would have
  // kept it. A key given later signs the fake's ports from then on.
  const keychain = memoryKeychain();
  const apps = appStore({
    home: o.home,
    keychain,
    ...(o.userOnly === undefined ? {} : { userOnly: o.userOnly }),
  });
  const signIns = signInStore({
    home: o.home,
    keychain,
    ...(o.userOnly === undefined ? {} : { userOnly: o.userOnly }),
  });
  const { setup, shared } = scenario.world;
  const onGitHub = world.host.onGitHub().app;
  if (shared !== undefined) await signedIn(world.host, signIns);
  else if (onGitHub !== null && (setup === undefined || appMade(setup))) {
    const { id, key } = world.host.credentials();
    await apps.write(storedOf({ ...onGitHub, id }), key);
  }
  // The computer's start at login, in memory: it outlives a restart, as the owner's registration would. Said as the
  // machine's (`os`): demo mode plays the program, so its screens show what the owner's would, its faults included.
  const loginItem = memoryLoginItem();
  // Your coding agent's PATH and skill folders, in memory (ADR 0058): they outlive a restart, as the machine's would.
  let commandPath = memoryCommandPath({ folder: DEMO_PATH_FOLDER });
  // How the program was installed: downloaded, until `npm-install` restarts it as an npm install (ADR 0061).
  let offer: PathOffer = "binary";
  let skillFolders = memorySkillFolders({ home: DEMO_USER_HOME });
  // The owner's own `gh`, in memory (ADR 0059), as the world says it: it outlives a restart, as the owner's sign-in
  // would.
  const gh = ghOf(scenario.world, o.gh);
  let made = 0;
  const optionsOn = (store: Store, own: ReturnType<typeof roomClock>): RoomOptions => ({
    home: o.home,
    store,
    loginItem: { item: loginItem, kind: "os" },
    agent: {
      path: commandPath,
      skills: skillFolders,
      offer,
      command: offer === "npm" ? DEMO_NPM_COMMAND : DEMO_COMMAND,
      skill: {
        name: SKILL_NAME,
        command: offer === "npm" ? DEMO_NPM_SKILL_COMMAND : DEMO_SKILL_COMMAND,
        version: o.version,
      },
    },
    clock,
    timers: own.timers,
    demoClock: own.controls,
    ids: { next: () => String(++made) },
    github: {
      installations: world.host,
      connect: ({ key }) => {
        world.host.useKey(key);
        world.host.postAs("bot");
        return { intake: world.host, writer: world.host };
      },
      apps,
      // The shared App (ADR 0066): the fake's device flow, on its device page, the sign-in kept in the room's
      // sign-in store beside the App store; signed in, the fake's ports post as the owner.
      shared: {
        signIn: world.host,
        signIns,
        accounts: () => world.host,
        connect: () => {
          world.host.postAs("person");
          return { intake: world.host, writer: world.host };
        },
      },
    },
    engines: world.engines,
    selfTests: world.engines,
    // No terminal in demo mode (ADR 0046): the scripted engine signs itself in a few seconds on.
    signIn: {
      open: (engine) => {
        try {
          world.engines.signIn(engine);
          return Promise.resolve({ opened: true });
        } catch (error) {
          return Promise.resolve({
            opened: false,
            reason: said(error),
          });
        }
      },
    },
    retrieval: world.retrieval,
    settingsFiles: settings.files,
    ...(scenario.world.setup === undefined ? {} : { setup: scenario.world.setup }),
    ...(scenario.world.remote === undefined ? {} : { remote: scenario.world.remote }),
    web: DEMO_API.github,
    version: o.version,
    ...(o.eventsKept === undefined ? {} : { eventsKept: o.eventsKept }),
    ...(o.log === undefined ? {} : { log: o.log }),
    ...(o.secretsRemoved === undefined ? {} : { secretsRemoved: o.secretsRemoved }),
    gh,
  });
  let own = roomClock(clock);
  let room = await buildRoom(
    optionsOn(openStore({ home: o.home, durable: false, eventsFrom: o.eventsFrom ?? 0 }), own),
  );
  /**
   * The service stopped and started again on the same folder, as the owner's restart would: the room's timers
   * dropped, the script's and the world's kept; the new room reads its store, its App store and GitHub as any start
   * does. One `clock` event after, so a tab told to reload follows the new room from its start. `before` runs
   * once commands are refused and the commands under way have answered (`settled`), before the room stops; a
   * round under way is cut by the stop, and the new room runs its job again.
   */
  let restarting: Promise<void> | null = null;
  const restart = async (settled: () => Promise<void>, before: () => Promise<void>): Promise<void> => {
    let restarted = () => {};
    restarting = new Promise<void>((resolve) => {
      restarted = resolve;
    });
    try {
      await settled();
      await before();
      own.restarting();
      await room.stop();
      own = roomClock(clock);
      room = await buildRoom(optionsOn(openStore({ home: o.home, durable: false }), own));
      await room.demo?.advance(0);
    } finally {
      restarting = null;
      restarted();
    }
  };
  /** The room restarted as `npm install -g lookover` installed it (ADR 0061), npm's folder on the PATH or not. */
  const asNpm = async (settled: () => Promise<void>, reach: "yes" | "no") => {
    await restart(settled, async () => {
      offer = "npm";
      commandPath = memoryCommandPath({ folder: DEMO_NPM_FOLDER, reach });
      skillFolders = memorySkillFolders({ home: DEMO_NPM_HOME });
    });
    return "ok" as const;
  };

  // The seed: the moves at or before its end, each at its time; then the clock reaches the end, so what the last
  // move started (a round, a poll) has run its course. A seed that fails, or throws midway, stops its own room
  // (its store closed, its timers dropped) before the error reaches the caller.
  const script = [...scenario.script].sort((a, b) => a.at - b.at);
  const seeded = script.filter((m) => m.at <= scenario.seed);
  try {
    for (const { at, move } of seeded) {
      await clock.advance(start + at - clock.now());
      await world.play(move, room);
    }
    await clock.advance(start + scenario.seed - clock.now());
    const broken = failed(room.snapshot());
    if (broken) {
      throw new Error(
        `The seed of ${scenario.id} failed on #${broken.number}: ${broken.failure.kind} ${broken.failure.detail}`,
      );
    }
  } catch (error) {
    await room.stop().catch((stopped: unknown) => o.log?.(`${scenario.id}: ${String(stopped)}`));
    throw error;
  }
  // The rest of the script, armed on the clock from the seed's end: dropped with the room's clock when it stops.
  const schedule = ({ at, move }: TimedMove) => {
    clock.after(at - scenario.seed, () => {
      world.play(move, room).catch((error: unknown) => o.log?.(`${scenario.id}: ${String(error)}`));
    });
  };
  for (const timed of script.filter((m) => m.at > scenario.seed)) schedule(timed);
  if (o.frozen === undefined) clock.set(true, 1);

  const played = async (move: Move): Promise<"ok"> => {
    await world.play(move, room);
    return "ok";
  };
  /** A move on GitHub the poll would see: a listing now, whose refusal the connection shows. */
  const onGitHubThen = async (move: () => void): Promise<"ok"> => {
    move();
    await room.refresh().catch(hostRefused);
    return "ok";
  };
  /**
   * A move on the installation's repositories: listed again now (the 5-minute discovery's, "Reconnect"'s) once the
   * App is installed; while the setup waits for the install, its next check (4 s) reads it.
   */
  const discovered = async (move: () => void): Promise<"ok"> => {
    move();
    if (room.snapshot().setup.github === "done") await room.reconnect().catch(hostRefused);
    return "ok";
  };
  const installed = () => world.host.onGitHub().installation;
  /** The person's move on the code the sign-in shows; nothing when none waits. */
  const onTheCode = (move: (userCode: string) => void): Promise<"ok" | InjectRefusal> => {
    const code = room.snapshot().connection.signIn;
    if (code === null) return Promise.resolve("no_sign_in");
    move(code.userCode);
    return Promise.resolve("ok");
  };
  const opens = (by: "agent" | "other"): Promise<"ok" | InjectRefusal> => {
    const change = world.unopened(by);
    return change === null ? Promise.resolve("nothing_to_open") : played({ kind: "open", change });
  };
  const faults = {
    "claude-signed-out": () => played({ kind: "sign-out", engine: "claude" }),
    "codex-signed-out": () => played({ kind: "sign-out", engine: "codex" }),
    "codex-limit": () => {
      // The engine's next run answers quota, saying it resets two days on (a weekly limit, ADR 0055); with no run
      // to find it out, the queue is told as a run would.
      const limitUntil = clock.now() + CODEX_RESETS_IN_MS;
      world.engines.nextRunAnswers("codex", "quota_exhausted", limitUntil);
      if (!running(room.snapshot(), "codex")) room.ranInto("codex", "limit", { limitUntil });
      return Promise.resolve("ok" as const);
    },
    "codex-failed-self-test": () =>
      played({
        kind: "update",
        engine: "codex",
        version: bumped(world.engines.healthOf("codex").version),
        selfTest: "fails",
      }),
    // A version just under the one Codex's model needs: "Codex is updated" then installs the first that serves it.
    "codex-too-old": () => played({ kind: "too-old", engine: "codex", version: "0.161.0" }),
    "engines-missing": async () => {
      await played({ kind: "missing", engine: "claude" });
      return played({ kind: "missing", engine: "codex" });
    },
    // The code a sign-in to the shared App shows, entered or refused on GitHub (ADR 0066), as on its fake device page:
    // the service's next poll, on the clock, finds it.
    "sign-in-entered": () => onTheCode((code) => world.host.enterCode(code)),
    "sign-in-denied": () => onTheCode((code) => world.host.denyCode(code)),
    // The person signed out on GitHub (ADR 0066): the sign-in no longer renews, every call refused as signed out until
    // Sign in again's code is entered.
    "github-signed-out": () =>
      room.snapshot().connection.way === "shared"
        ? onGitHubThen(() => world.host.signOut())
        : Promise.resolve("not_signed_in" as const),
    // The first organisation the shared App reaches asks for SAML SSO the person's sign-in hasn't (ADR 0066): its
    // account holds the cause, found by the poll now; the others go on.
    "sso-asked": () => {
      const [first] = scenario.world.shared?.reaches ?? [];
      return first === undefined
        ? Promise.resolve("no_organisation_reached" as const)
        : onGitHubThen(() => world.host.askSso(first.organisation.login));
    },
    // An owner of the first organisation the shared App reaches suspends it there (ADR 0067), GitHub naming them: its
    // account holds the cause, found by the accounts listed again now (the 5-minute discovery's); the others go on.
    "organisation-suspended": () => {
      const [first] = scenario.world.shared?.reaches ?? [];
      return first === undefined
        ? Promise.resolve("no_organisation_reached" as const)
        : discovered(() => world.host.suspend(first.organisation.login, SUSPENDED_BY));
    },
    // An owner of the organisation the person asked about first installs the shared App there (ADR 0067), on all its
    // repositories: listed again now, as the 5-minute discovery would, the ask forgotten in the same event.
    "owner-installs": () => {
      const asked = room.snapshot().connection.unreached.find((u) => u.askedAt !== null);
      return asked === undefined
        ? Promise.resolve("nothing_asked" as const)
        : discovered(() => world.host.installOn(asked.account.login));
    },
    "connection-lost": () => played({ kind: "refuse", failure: "unavailable", forMs: CONNECTION_LOST_MS }),
    "app-uninstalled": () =>
      installed() === null
        ? Promise.resolve("not_installed" as const)
        : onGitHubThen(() => world.host.uninstall()),
    "app-suspended": () =>
      installed() === null
        ? Promise.resolve("not_installed" as const)
        : onGitHubThen(() => world.host.suspend()),
    "key-refused": () => onGitHubThen(() => world.host.revokeKey()),
    // The keychain loses the App store's entry; a running service never reads it again, so it restarts.
    // Once the commands under way have answered, so none writes to the room after its stop.
    "key-lost": async (settled: () => Promise<void>) => {
      if ((await apps.read()).state !== "kept") return "no_app_kept";
      await restart(settled, async () => {
        for (const name of keychain.names()) await keychain.delete(name);
      });
      return "ok";
    },
    "nothing-granted": () => discovered(() => world.host.install([])),
    "repository-added": () => {
      const owner = scenario.world.repo.owner;
      const held = world.host.onGitHub().repositories;
      const name = ADDABLE.find((n) => !held.some(({ repo }) => repo.name === n));
      if (name === undefined) return Promise.resolve("nothing_to_add" as const);
      return discovered(() => world.host.addRepository({ owner, name }));
    },
    "repository-removed": () => {
      const last: RepositoryRef | undefined = installed()?.granted.at(-1);
      if (last === undefined) return Promise.resolve("nothing_to_remove" as const);
      return discovered(() => world.host.removeRepository(last));
    },
    // The repository that left last, said departed (ADR 0059), added back on GitHub.
    "repository-back": () => {
      const last = room.snapshot().departed.at(-1);
      if (last === undefined) return Promise.resolve("nothing_departed" as const);
      return discovered(() => world.host.addRepository({ owner: last.owner, name: last.name }));
    },
    "github-limit": () => played({ kind: "refuse", failure: "rate_limited", forMs: GITHUB_LIMIT_MS }),
    "agent-opens-change": () => opens("agent"),
    "other-opens-change": () => opens("other"),
    "you-push": () => {
      const [change] = world.pushable();
      return change === undefined
        ? Promise.resolve("nothing_to_push" as const)
        : played({ kind: "push", change });
    },
    "close-change": () => {
      const [change] = world.open();
      return change === undefined
        ? Promise.resolve("nothing_to_close" as const)
        : played({ kind: "close", change });
    },
    "codex-updated": () =>
      played({
        kind: "update",
        engine: "codex",
        version: bumped(world.engines.healthOf("codex").version),
        selfTest: "passes",
      }),
    // Every settings save is refused from now on, the file held open by another program, until the next load.
    "settings-unwritable": () => {
      settings.breakWrites();
      return Promise.resolve("ok" as const);
    },
    // The registration removed outside Lookover, and the computer refusing a new one, until the next load: the
    // service, restarted, finds it chosen but not registered.
    "login-refused": async (settled: () => Promise<void>) => {
      await restart(settled, async () => {
        await loginItem.unregister();
        loginItem.refuse("Access is denied.");
      });
      return "ok";
    },
    // Every write of the PATH, then of the agents' skill folders, refused from now on, until the next load (ADR 0058).
    "path-refused": () => {
      commandPath.refuse("Access is denied.");
      return Promise.resolve("ok" as const);
    },
    // Lookover's launcher on the PATH, left by an earlier download: a terminal's `lookover` runs that copy.
    "launcher-stale": async () => {
      await commandPath.add();
      commandPath.staleLauncher(String.raw`${DEMO_USER_HOME}\Downloads\Lookover 0.0.9\lookover.exe`);
      await room.agent.check();
      return "ok" as const;
    },
    // The program restarted as `npm install -g lookover` installed it: npm's shim first on the PATH, nothing offered.
    "npm-install": (settled: () => Promise<void>) => asNpm(settled, "yes"),
    // The same, npm's folder off the PATH (a Node installed without it): said with that folder, nothing offered.
    "npm-off-path": (settled: () => Promise<void>) => asNpm(settled, "no"),
    "skill-refused": () => {
      skillFolders.refuse("Access is denied.");
      return Promise.resolve("ok" as const);
    },
    // The person's `gh` signed in as the scenario's owner (ADR 0059), a member of no organisation, until signed out.
    "gh-signed-in": () => {
      const { id, login } = scenario.world.owner;
      gh.signIn({ id, login });
      return Promise.resolve("ok" as const);
    },
    // The person's `gh` gone from the computer (ADR 0059): every read says it isn't installed.
    "gh-uninstalled": () => {
      gh.signIn("missing");
      return Promise.resolve("ok" as const);
    },
    // The person's `gh` signed out (ADR 0059), the membership checked now as the hour's check would: it can't answer
    // for them, so the last answer stands and reviews go on, the log saying why.
    "gh-signed-out": async () => {
      gh.signIn(null);
      await room.github.checkMembership();
      return "ok" as const;
    },
    // An admin removes the person from the organisation the App lives on (ADR 0059), the membership checked now as
    // the hour's check would: reviews stop until "Check again" finds them added back.
    "not-a-member": async () => {
      const { organisation, owner } = scenario.world;
      if (organisation === undefined) return "no_organisation" as const;
      const app = room.github.app();
      if (app === null) return "no_app_kept" as const;
      // A personal App lives on no organisation the person could be removed from.
      if (app.account.type !== "Organization") return "no_organisation" as const;
      gh.leave(organisation.account.login, owner);
      await room.github.checkMembership();
      return "ok" as const;
    },
  } satisfies Record<FaultId, (settled: () => Promise<void>) => Promise<"ok" | InjectRefusal>>;

  return {
    get room() {
      return room;
    },
    scenario,
    inject: (fault, settled = () => Promise.resolve()) => faults[fault](settled),
    restarting: () => restarting,
    github: fakeGitHubPages(world.host, DEMO_API.github, { sharedApp: SHARED_APP.slug, gh }),
    appName: DEMO_APP_NAME,
    listing: () => ({
      scenarios: (o.scenarios ?? SCENARIOS).map(({ id, title, what, steps, later, path }) => ({
        id,
        title,
        what,
        steps,
        later,
        path,
      })),
      current: scenario.id,
      clock: { now: clock.now(), running: clock.running, speed: clock.speed, nextIn: clock.next() },
      faults: FAULTS,
    }),
  };
}

/**
 * The owner's `gh` as the world says it (`given`, a test's, emptied first, or a new one): signed in as the owner, signed out (unless
 * the world says more) or not installed; the owner an active member of the organisation the App lives on, its admin
 * or not.
 */
function ghOf(world: Scenario["world"], given: MemoryGh | undefined): MemoryGh {
  const gh = given ?? memoryGh();
  gh.empty();
  const state = world.gh ?? "signed-out";
  gh.signIn(state === "signed-in" ? world.owner : state === "missing" ? "missing" : null);
  if (world.organisation !== undefined) {
    const { account, admin } = world.organisation;
    gh.join(account, world.owner, { state: "active", admin });
  }
  for (const { organisation, role } of world.memberships ?? [])
    gh.join(organisation, world.owner, { state: "active", admin: role === "owner" });
  return gh;
}

/**
 * The owner signed in to the shared App before the room starts (ADR 0066), as a code entered on GitHub's page would
 * have: a sign-in the fake issued through its own device flow, so it renews there, kept in the room's sign-in store.
 * The fake's ports post as the owner from then on.
 */
async function signedIn(host: FakeGitHost, signIns: SignInStore): Promise<void> {
  const grant = await host.startSignIn();
  host.enterCode(grant.userCode);
  const polled = await host.pollSignIn(grant);
  if (polled.kind !== "issued") throw new Error(`The fake didn't sign the owner in: ${polled.kind}`);
  await signIns.write({ ...polled.tokens, person: await host.person(polled.tokens.token) });
  host.postAs("person");
}

/** A refusal of GitHub's: the connection shows it, the fault was played all the same. */
function hostRefused(error: unknown): void {
  if (!(error instanceof HostError)) throw error;
}
