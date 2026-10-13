// The program's start as a function (`runService`, ADR 0054): what `main.ts` does once it has read the
// configuration, here in this process with the printing, the signals and the exit in the test's hands. One
// service per data folder: its instance lock, `instance.json` and the port it prefers.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, type Gh, type NoSession, type Setup, type State } from "@lookover/contracts";
import { DemoClock, FakeGitHost, memoryGh, ScriptedRetrieval } from "@lookover/testkit";
import {
  acquireLiveLock,
  appStore,
  type Config,
  carriedWebFiles,
  diskWebFiles,
  type GitHubSide,
  InstanceHeld,
  type LiveConfig,
  LiveLockHeld,
  type MemorySkillFolders,
  memoryCommandPath,
  memoryKeychain,
  memoryLoginItem,
  memorySkillFolders,
  type ProgramDeps,
  type ProgramProcess,
  probeInstance,
  type RunningService,
  readConfig,
  runService,
  type Self,
  type System,
  VERSION,
} from "./index.ts";
import { BOT, fakeEngines, linkOf, SANDBOX } from "./service.test-support.ts";

// Tuesday 6 October 2026, 08:52 UTC.
const FROZEN_AT = Date.UTC(2026, 9, 6, 8, 52);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  // In reverse: the data folder goes once the service in it has stopped (Windows says EBUSY otherwise).
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A process the test holds: the handlers registered, by event, and the codes it was asked to exit with. */
function heldProcess() {
  const handlers = new Map<string, ((error?: unknown) => void)[]>();
  const exits: number[] = [];
  const held: ProgramProcess = {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    exit: (code) => {
      exits.push(code);
    },
    pid: 4242,
  };
  const fire = (event: string, error?: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(error);
  };
  return { held, fire, exits };
}

function newHome(): string {
  const home = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-run-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Your coding agent as `readConfig` reads it, for Lookover's `command` off the PATH, run as `offer` says. */
const agentOf = (command: string, offer: "binary" | "clone"): Config["agent"] => ({
  offer,
  folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin",
  executable: offer === "binary" ? "C:\\Users\\Your Name\\lookover.exe" : null,
  command: { onPath: offer === "binary" ? "lookover" : command, offPath: command },
  skillCommand: command,
});

const demo = (home: string, port = 0): Config => ({
  mode: "demo",
  agent: agentOf("bun run lookover", "clone"),
  home,
  port,
  origin: undefined,
  announce: undefined,
  eventsKept: undefined,
  env: {},
  git: "git",
  frozen: FROZEN_AT,
  scenario: "S1",
});

/**
 * The deps a test runs the program with: its own process and printer, a scratch lock home, no real adapter; start at
 * login on a fake, the commands it was asked for kept; the PATH on a fake (off it unless `reach` says), the
 * executables it was asked for kept.
 */
function deps(home: string, reach: "yes" | "no" = "no") {
  const out: string[] = [];
  const err: string[] = [];
  const userOnly: string[] = [];
  const program = heldProcess();
  const loginItem = memoryLoginItem();
  const atLogin: string[][] = [];
  const onPath: string[] = [];
  const path = memoryCommandPath({ folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin", reach });
  /** The skill folders the run asked for, by the name it installs under. */
  const skillFolders = new Map<string, MemorySkillFolders>();
  /** How many times the run asked for the person's `gh`. */
  const ghAsked: number[] = [];
  const given: ProgramDeps = {
    clock: { now: () => FROZEN_AT },
    print: { out: (line) => out.push(line), err: (line) => err.push(line) },
    lockHome: join(home, "user"),
    liveAdapters: () => Promise.reject(new Error("a live start reached the real adapters")),
    userOnly: async (path) => {
      userOnly.push(path);
    },
    process: program.held,
    loginItem: (command) => {
      atLogin.push(command);
      return loginItem;
    },
    commandPath: (executable, launcher) => {
      // An npm install's port reads npm's shim of its launcher.
      onPath.push(launcher ?? executable);
      return path;
    },
    skillFolders: (name) => {
      const skills = memorySkillFolders({ name });
      skillFolders.set(name, skills);
      return skills;
    },
    gh: () => {
      ghAsked.push(1);
      return memoryGh({ as: { id: 11247504, login: "sasensi" } });
    },
  };
  return { given, out, err, userOnly, program, loginItem, atLogin, onPath, path, skillFolders, ghAsked };
}

/** Waits until `exits` has an entry, or 5 s. */
async function exited(exits: number[]): Promise<void> {
  for (let i = 0; i < 250 && exits.length === 0; i++) await Bun.sleep(20);
}

test("runService starts demo mode, announces it, prints the URL to open, and stops on SIGTERM, exiting 0", async () => {
  const home = newHome();
  const announce = join(home, "service.json");
  const run = deps(home);
  const service = await runService({ ...demo(home), announce }, run.given);
  cleanups.push(() => service.stop());

  const announced = JSON.parse(readFileSync(announce, "utf8"));
  expect(announced).toEqual({ origin: service.origin, port: service.port, openUrl: service.openUrl });
  expect(run.out.join("\n")).toContain(`Lookover service (demo mode, S1) · ${service.origin}`);
  expect(run.out.join("\n")).toContain(`Open the app: ${service.openUrl}`);
  const opened = await fetch(linkOf(service), { redirect: "manual" });
  expect(opened.status).toBe(303);
  // Lookover's one version is the one the service says.
  const cookie = opened.headers.get("set-cookie")?.split(";")[0] ?? "";
  const snapshot = await fetch(`${service.origin}${API.snapshot}`, {
    headers: { cookie, origin: service.origin },
  });
  expect((await snapshot.json()).service.version).toBe(VERSION);
  // Development's 401 names no command: the screen keeps naming the link `bun dev` printed (ADR 0058).
  const signedOut = await fetch(`${service.origin}${API.snapshot}`, { headers: { origin: service.origin } });
  expect(signedOut.status).toBe(401);
  expect(await signedOut.json()).toEqual({ error: "no session" });

  run.program.fire("SIGTERM");
  await exited(run.program.exits);
  expect(run.program.exits).toEqual([0]);
  await expect(fetch(`${service.origin}/`)).rejects.toThrow();
});

test("a second service on the same data folder is refused while the first runs, and starts once it stopped", async () => {
  const home = newHome();
  const first = await runService(demo(home), deps(home).given);
  cleanups.push(() => first.stop());

  const second = deps(home);
  const refused = runService(demo(home), second.given);
  await expect(refused).rejects.toBeInstanceOf(InstanceHeld);
  expect(second.err).toEqual([
    `Another Lookover runs on this data folder (${home}): process 4242 at ${first.origin} since ` +
      `${new Date(FROZEN_AT).toISOString()}. Stop it before starting another, or pass another --home.`,
  ]);
  expect(second.program.exits).toEqual([1]);
  expect(second.out).toEqual([]);

  await first.stop();
  const third = await runService(demo(home), deps(home).given);
  cleanups.push(() => third.stop());
  expect((await fetch(linkOf(third), { redirect: "manual" })).status).toBe(303);
});

test("instance.json says who serves the data folder, user-only, once serving, and is removed at a clean stop", async () => {
  const home = newHome();
  const file = join(home, "instance.json");
  const run = deps(home);
  const service = await runService(demo(home), run.given);
  cleanups.push(() => service.stop());

  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    pid: 4242,
    port: service.port,
    address: service.origin,
    version: VERSION,
    since: FROZEN_AT,
  });
  // The data folder and its logs first, as the log is opened (ADR 0054); then the file.
  expect(run.userOnly.slice(0, 2)).toEqual([home, join(home, "logs")]);
  expect(run.userOnly.length).toBe(3);
  expect(run.userOnly[2]?.startsWith(file)).toBe(true);

  run.program.fire("SIGINT");
  await exited(run.program.exits);
  expect(run.program.exits).toEqual([0]);
  expect(existsSync(file)).toBe(false);
});

test("the probe says held while a service runs and free once it stopped, without taking the lock", async () => {
  const home = newHome();
  expect(probeInstance(home)).toBe("free");
  // Probed while free, the lock is still free to take.
  const service = await runService(demo(home), deps(home).given);
  expect(probeInstance(home)).toBe("held");
  expect(probeInstance(home)).toBe("held");
  await service.stop();
  expect(probeInstance(home)).toBe("free");
  expect(probeInstance(home)).toBe("free");
  const again = await runService(demo(home), deps(home).given);
  cleanups.push(() => again.stop());
  expect(probeInstance(home)).toBe("held");
});

test("the port used last is kept in the data folder and tried first; a port that can't be bound falls back", async () => {
  const home = newHome();
  const first = await runService(demo(home), deps(home).given);
  const used = first.port;
  expect(readFileSync(join(home, "port"), "utf8").trim()).toBe(String(used));
  await first.stop();

  const second = await runService(demo(home), deps(home).given);
  expect(second.port).toBe(used);
  await second.stop();

  // Another program took that port meanwhile: any free one, and that one is kept.
  const squatter = Bun.serve({ hostname: "127.0.0.1", port: used, fetch: () => new Response() });
  cleanups.push(() => squatter.stop(true));
  const third = await runService(demo(home), deps(home).given);
  cleanups.push(() => third.stop());
  expect(third.port).not.toBe(used);
  expect(readFileSync(join(home, "port"), "utf8").trim()).toBe(String(third.port));
});

test("a port file that isn't a port is ignored", async () => {
  const home = newHome();
  writeFileSync(join(home, "port"), "not a port");
  const service = await runService(demo(home), deps(home).given);
  cleanups.push(() => service.stop());
  expect(service.port).toBeGreaterThan(0);
});

const LEDGER = { owner: "sasensi", name: "ledger" };

/** The owner on the GitHub step, no App made yet. */
const ON_GITHUB: Setup = {
  done: false,
  step: "github",
  reached: "github",
  github: "start",
  githubRefused: null,
  firstReviewChange: null,
};

const program = (home: string, live?: LiveConfig, asOrganisation?: string): Config => ({
  mode: "program",
  agent: agentOf(PROGRAM_COMMAND, "binary"),
  home,
  port: 0,
  origin: undefined,
  announce: undefined,
  eventsKept: undefined,
  env: {},
  git: "git",
  live,
  processes: join(home, "processes.json"),
  atLogin: AT_LOGIN,
  ...(asOrganisation === undefined ? {} : { asOrganisation }),
});

/**
 * Lookover's command for a binary in a folder with a space, on a data folder that isn't the profile's, as
 * `lookoverCommand` writes it (ADR 0058).
 */
const PROGRAM_COMMAND = "& 'C:\\Users\\Your Name\\lookover.exe' '--home=D:\\my data'";

/** What the program's start at login registers, as `readConfig` would make it. */
const AT_LOGIN = ["C:\\bun.exe", "C:\\clone\\main.ts", "start", "--no-open"];

/**
 * The program's adapters on the fake GitHub holding the sandbox and the ledger: the fake's App as given, or (`noApp`)
 * none yet, the App store on a fake keychain. They guard nothing themselves: the program's wiring must.
 */
function onFakeHost(home: string, { noApp = false } = {}): NonNullable<ProgramDeps["liveAdapters"]> {
  const host = new FakeGitHost({
    repo: SANDBOX,
    repositories: [LEDGER],
    bot: BOT,
    changes: [],
    clock: new DemoClock({ at: FROZEN_AT }),
    ...(noApp ? { app: { made: false } } : {}),
  });
  const side: GitHubSide = {
    installations: host,
    connect: ({ key }) => {
      host.useKey(key);
      return { intake: host, writer: host };
    },
    ...(noApp
      ? { apps: appStore({ home, keychain: memoryKeychain(), userOnly: async () => {} }) }
      : { given: host.credentials() }),
  };
  return async () => ({
    github: side,
    engines: fakeEngines(),
    selfTests: null,
    signIn: { open: async () => ({ opened: false, reason: "no terminal in a test" }) },
    retrieval: new ScriptedRetrieval(),
    ...(noApp ? { setup: ON_GITHUB } : {}),
    setUpAtOnce: !noApp,
  });
}

/** The program's session, as `lookover open` will make it (ADR 0054): the data folder's secret as the cookie. */
function sessionOf(home: string): string {
  const name = `lookover-${createHash("sha1").update(home).digest("hex").slice(0, 8)}`;
  return `${name}=${readFileSync(join(home, "session"), "utf8")}`;
}

async function stateOf(service: RunningService, home: string): Promise<State> {
  const res = await fetch(`${service.origin}${API.snapshot}`, {
    headers: { cookie: sessionOf(home), origin: service.origin },
  });
  return await res.json();
}

function createApp(service: RunningService, home: string): Promise<Response> {
  return fetch(`${service.origin}${API.commands}`, {
    method: "POST",
    headers: { cookie: sessionOf(home), origin: service.origin, "content-type": "application/json" },
    body: JSON.stringify({ type: "connection.createApp", organisation: null }),
  });
}

const names = (state: State) => state.repos.map((r) => `${r.owner}/${r.name}`).sort();

test("the program with a live.json is guarded: only its repositories are watched", async () => {
  const home = newHome();
  const run = deps(home);
  const live = { repositories: [SANDBOX] };
  const service = await runService(program(home, live), { ...run.given, liveAdapters: onFakeHost(home) });
  cleanups.push(() => service.stop());
  expect(names(await stateOf(service, home))).toEqual(["sasensi/lookover-sandbox"]);
  expect(run.out).toEqual([
    `\n  Lookover runs. Its live config guards it. Run \`${PROGRAM_COMMAND} open\` to open it.\n`,
  ]);
});

test("a start its live config runs as the organisation's App says so once, before its link", async () => {
  const home = newHome();
  const run = deps(home);
  const said =
    "Runs as lookover-dev's App 5297673 on lookover-dev/lookover-sandbox and lookover-dev/lookover-private.";
  const live = {
    repositories: [
      { owner: "lookover-dev", name: "lookover-sandbox" },
      { owner: "lookover-dev", name: "lookover-private" },
    ],
  };
  const service = await runService(program(home, live, said), {
    ...run.given,
    liveAdapters: onFakeHost(home),
  });
  cleanups.push(() => service.stop());
  expect(run.out).toEqual([
    said,
    `\n  Lookover runs. Its live config guards it. Run \`${PROGRAM_COMMAND} open\` to open it.\n`,
  ]);
});

test("the program without a live.json is unguarded: every repository the installation lists is watched", async () => {
  const home = newHome();
  const run = deps(home);
  const service = await runService(program(home), { ...run.given, liveAdapters: onFakeHost(home) });
  cleanups.push(() => service.stop());
  expect(names(await stateOf(service, home))).toEqual(["sasensi/ledger", "sasensi/lookover-sandbox"]);
});

test("only the program without a live.json registers start at login on the machine: with one, a fake does", async () => {
  const bare = newHome();
  const run = deps(bare);
  const unguarded = await runService(program(bare), { ...run.given, liveAdapters: onFakeHost(bare) });
  cleanups.push(() => unguarded.stop());
  expect(run.atLogin).toEqual([AT_LOGIN]);
  // The PATH on the machine too, for the binary (ADR 0058); the fake in memory for every other wiring.
  expect(run.onPath).toEqual(["C:\\Users\\Your Name\\lookover.exe"]);
  expect(await run.loginItem.registered()).toBe(true);
  expect((await stateOf(unguarded, bare)).service).toMatchObject({ startsAtLogin: true, loginItem: "os" });

  const home = newHome();
  const guardedRun = deps(home);
  const guarded = await runService(program(home, { repositories: [SANDBOX] }), {
    ...guardedRun.given,
    liveAdapters: onFakeHost(home),
  });
  cleanups.push(() => guarded.stop());
  expect(guardedRun.atLogin).toEqual([]);
  expect(guardedRun.onPath).toEqual([]);
  // The fake's registration, in memory.
  expect((await stateOf(guarded, home)).service).toMatchObject({ startsAtLogin: true, loginItem: "memory" });
  await guarded.stop();

  // Live mode too: the UI says start at login isn't set up in development.
  const liveHome = newHome();
  const liveRun = deps(liveHome);
  const live = await runService(
    {
      mode: "live",
      agent: agentOf("bun run lookover", "clone"),
      home: liveHome,
      port: 0,
      origin: undefined,
      announce: undefined,
      eventsKept: undefined,
      env: {},
      git: "git",
      live: { repositories: [SANDBOX] },
      processes: join(liveHome, "processes.json"),
    },
    { ...liveRun.given, liveAdapters: onFakeHost(liveHome) },
  );
  cleanups.push(() => live.stop());
  expect(liveRun.atLogin).toEqual([]);
  expect(liveRun.onPath).toEqual([]);
  expect((await stateOf(live, liveHome)).service).toMatchObject({ loginItem: "memory" });
});

test("the program without a live.json is wired to the real start at login, which refuses to run under bun test", async () => {
  const home = newHome();
  const { loginItem: _fake, ...given } = deps(home).given;
  await expect(runService(program(home), { ...given, liveAdapters: onFakeHost(home) })).rejects.toThrow(
    /never runs under bun test/,
  );
  // Nothing left held.
  expect(probeInstance(home)).toBe("free");
});

test("the program's binary without a live.json is wired to the real PATH, which refuses to run under bun test", async () => {
  const home = newHome();
  const { commandPath: _fake, ...given } = deps(home).given;
  await expect(runService(program(home), { ...given, liveAdapters: onFakeHost(home) })).rejects.toThrow(
    /PATH adapter never runs under bun test/,
  );
  expect(probeInstance(home)).toBe("free");
  // From a clone, there is no one executable to put on the PATH: the PATH port is never asked, real or given.
  const clone = newHome();
  const service = await runService(
    { ...program(clone), agent: agentOf("bun run lookover", "clone") },
    { ...given, liveAdapters: onFakeHost(clone) },
  );
  cleanups.push(() => service.stop());
  const fakedClone = newHome();
  const cloneRun = deps(fakedClone);
  const asked = await runService(
    { ...program(fakedClone), agent: agentOf("bun run lookover", "clone") },
    { ...cloneRun.given, liveAdapters: onFakeHost(fakedClone) },
  );
  cleanups.push(() => asked.stop());
  expect(cloneRun.onPath).toEqual([]);
});

test("an npm install's program reads the PATH for npm's shim of its launcher, and offers nothing there", async () => {
  const home = newHome();
  const run = deps(home);
  const launcher = "C:\\Users\\Your Name\\AppData\\Roaming\\npm\\node_modules\\lookover\\bin\\lookover.js";
  const npm: Config = {
    ...program(home),
    agent: { ...agentOf("lookover", "binary"), offer: "npm", launcher },
  };
  const service = await runService(npm, { ...run.given, liveAdapters: onFakeHost(home) });
  cleanups.push(() => service.stop());
  expect(run.onPath).toEqual([launcher]);
  expect((await stateOf(service, home)).service.agent.offer).toBe("npm");
});

test("the skill goes in the agents' real folders: the user's name unguarded, the dev name under a live config", async () => {
  const bare = newHome();
  const run = deps(bare);
  const unguarded = await runService(program(bare), { ...run.given, liveAdapters: onFakeHost(bare) });
  cleanups.push(() => unguarded.stop());
  expect([...run.skillFolders.keys()]).toEqual(["lookover-review-loop"]);
  expect((await stateOf(unguarded, bare)).service.agent.skills[0]?.folder).toBe(
    "~/.claude/skills/lookover-review-loop",
  );

  const home = newHome();
  const guardedRun = deps(home);
  const guarded = await runService(program(home, { repositories: [SANDBOX] }), {
    ...guardedRun.given,
    liveAdapters: onFakeHost(home),
  });
  cleanups.push(() => guarded.stop());
  expect([...guardedRun.skillFolders.keys()]).toEqual(["lookover-dev-review-loop"]);
  const cookie = sessionOf(home);
  const install = await fetch(`${guarded.origin}${API.commands}`, {
    method: "POST",
    headers: { cookie, origin: guarded.origin, "content-type": "application/json" },
    body: JSON.stringify({ type: "agent.skill", agent: "claude", on: true }),
  });
  expect(install.status).toBe(200);
  // Its `name:` is the dev one too: the agent never takes it for the user's own skill.
  expect(await guardedRun.skillFolders.get("lookover-dev-review-loop")?.read("claude")).toContain(
    "\nname: lookover-dev-review-loop\n",
  );
});

test("a Lookover whose command no skill line holds: installing the skill is refused with the configuration's why", async () => {
  const home = newHome();
  const run = deps(home);
  const refused = "The skill can't be installed: Lookover's command holds a line break.";
  const config = program(home);
  const odd = { ...config, agent: { ...config.agent, skillCommand: "", skillRefused: refused } };
  const service = await runService(odd, { ...run.given, liveAdapters: onFakeHost(home) });
  cleanups.push(() => service.stop());
  const install = await fetch(`${service.origin}${API.commands}`, {
    method: "POST",
    headers: { cookie: sessionOf(home), origin: service.origin, "content-type": "application/json" },
    body: JSON.stringify({ type: "agent.skill", agent: "claude", on: true }),
  });
  expect([install.status, await install.json()]).toEqual([
    500,
    { error: `The skill didn't change: ${refused}` },
  ]);
  expect(await run.skillFolders.get("lookover-review-loop")?.read("claude")).toBeNull();
});

test("the program is wired to the real skill folders, which refuse to run on the user's home under bun test", async () => {
  const home = newHome();
  const { skillFolders: _fake, ...given } = deps(home).given;
  await expect(runService(program(home), { ...given, liveAdapters: onFakeHost(home) })).rejects.toThrow(
    /under bun test/,
  );
  expect(probeInstance(home)).toBe("free");
});

test("the person's gh: the program, guarded or not, and live mode read the real one, demo mode the fake (ADR 0059)", async () => {
  const bare = newHome();
  const run = deps(bare);
  cleanups.push(
    await runService(program(bare), { ...run.given, liveAdapters: onFakeHost(bare) }).then(
      (s) => () => s.stop(),
    ),
  );
  expect(run.ghAsked).toEqual([1]);

  const home = newHome();
  const guardedRun = deps(home);
  const guarded = await runService(program(home, { repositories: [SANDBOX] }), {
    ...guardedRun.given,
    liveAdapters: onFakeHost(home),
  });
  cleanups.push(() => guarded.stop());
  expect(guardedRun.ghAsked).toEqual([1]);

  const demoHome = newHome();
  const demoRun = deps(demoHome);
  const shown = await runService(demo(demoHome), demoRun.given);
  cleanups.push(() => shown.stop());
  expect(demoRun.ghAsked).toEqual([]);
});

test("live mode's adapters get the person's gh, asked once: live.json's organisation App works for its person", async () => {
  const home = newHome();
  const run = deps(home);
  const made: Gh[] = [];
  const seen: (Gh | undefined)[] = [];
  const service = await runService(program(home, { repositories: [SANDBOX] }), {
    ...run.given,
    gh: () => {
      const gh = memoryGh({ as: { id: 11247504, login: "sasensi" } });
      made.push(gh);
      return gh;
    },
    liveAdapters: (options) => {
      seen.push(options.gh);
      return onFakeHost(home)(options);
    },
  });
  cleanups.push(() => service.stop());
  expect(made).toHaveLength(1);
  expect(seen).toEqual(made);
  expect(seen[0]).toBe(made[0]);
});

test("the program is wired to the real gh, which refuses to run under bun test", async () => {
  const home = newHome();
  const { gh: _fake, ...given } = deps(home).given;
  await expect(runService(program(home), { ...given, liveAdapters: onFakeHost(home) })).rejects.toThrow(
    /real gh never runs under bun test/,
  );
  expect(probeInstance(home)).toBe("free");
  // Demo mode never asks for it: the fake.
  const demoHome = newHome();
  const shown = await runService(demo(demoHome), given);
  cleanups.push(() => shown.stop());
});

test("the program creates an App only unguarded: with a live.json, Create it on GitHub refuses", async () => {
  const bare = newHome();
  const unguarded = await runService(program(bare), {
    ...deps(bare).given,
    liveAdapters: onFakeHost(bare, { noApp: true }),
  });
  cleanups.push(() => unguarded.stop());
  expect((await createApp(unguarded, bare)).status).toBe(200);

  const home = newHome();
  const guardedRun = await runService(program(home, { repositories: [SANDBOX] }), {
    ...deps(home).given,
    liveAdapters: onFakeHost(home, { noApp: true }),
  });
  cleanups.push(() => guardedRun.stop());
  const refused = await createApp(guardedRun, home);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ createApp: { kind: "live-config" } });
});

test("the program holds the machine's live lock while it runs, and lets it go when it stops", async () => {
  const home = newHome();
  const run = deps(home);
  const lockHome = run.given.lockHome ?? "";
  const service = await runService(program(home), { ...run.given, liveAdapters: onFakeHost(home) });
  expect(() => acquireLiveLock({ home: lockHome, folder: "/elsewhere" })).toThrow(LiveLockHeld);
  await service.stop();
  acquireLiveLock({ home: lockHome, folder: "/elsewhere" }).release();
});

test("the program makes no one-time link at start: it says it runs and how to open it, and no token opens it", async () => {
  const home = newHome();
  const run = deps(home);
  const service = await runService(program(home), { ...run.given, liveAdapters: onFakeHost(home) });
  cleanups.push(() => service.stop());
  expect(service.openUrl).toBeNull();
  expect(run.out).toEqual([`\n  Lookover runs. Run \`${PROGRAM_COMMAND} open\` to open it.\n`]);
  // Not the bare address: it opens nothing without a session (ADR 0058).
  expect(run.out.join("\n")).not.toContain(service.origin);
  const opened = await fetch(`${service.origin}${API.session}?token=`, { redirect: "manual" });
  expect(opened.status).toBe(403);
});

test("the program's 401 names the command that opens Lookover, and its snapshot Lookover's command", async () => {
  // The configuration as `lookover serve` reads it: the binary in a folder with a space, on PowerShell, on a data
  // folder that isn't the profile's.
  const home = join(newHome(), "my data");
  mkdirSync(home);
  const binary: Self = {
    kind: "binary",
    path: "C:\\Users\\Your Name\\Downloads\\lookover.exe",
    webFiles: carriedWebFiles(new Map()),
  };
  const windows: System = {
    platform: "win32",
    homedir: "C:\\Users\\Your Name",
    env: { LOCALAPPDATA: "C:\\Users\\Your Name\\AppData\\Local" },
    which: (program) => (program === "git" ? "C:\\Git\\git.exe" : null),
  };
  const config = readConfig([`--home=${home}`], windows, binary);
  const command = `& 'C:\\Users\\Your Name\\Downloads\\lookover.exe' '--home=${home}'`;
  const run = deps(home);
  const service = await runService(config, { ...run.given, liveAdapters: onFakeHost(home) });
  cleanups.push(() => service.stop());
  expect(run.out).toEqual([`\n  Lookover runs. Run \`${command} open\` to open it.\n`]);
  const answer = (path: string, init: RequestInit = {}) =>
    fetch(`${service.origin}${path}`, { ...init, headers: { origin: service.origin } });
  // Every door a tab without the session knocks on: the snapshot, the commands, the stream and the logs.
  const doors = [
    await answer(API.snapshot),
    await answer(API.commands, { method: "POST", body: "{}" }),
    await answer(API.events),
    await answer(API.logs),
  ];
  for (const door of doors) {
    expect(door.status).toBe(401);
    const body: NoSession = await door.json();
    expect(body).toEqual({ error: "no session", open: `${command} open` });
  }
  expect((await stateOf(service, home)).service.command).toBe(command);
});

test("a start sends its own Lookover's command with service.changed, over an earlier start's", async () => {
  const home = newHome();
  const first = await runService(program(home), { ...deps(home).given, liveAdapters: onFakeHost(home) });
  await first.stop();
  // Started again once the PATH as saved reaches it: the replayed log says the binary's path; this start's event, and
  // what it prints, say `lookover`.
  const run = deps(home, "yes");
  const again = await runService(program(home), { ...run.given, liveAdapters: onFakeHost(home) });
  cleanups.push(() => again.stop());
  expect(run.out).toEqual(["\n  Lookover runs. Run `lookover open` to open it.\n"]);
  expect((await stateOf(again, home)).service.command).toBe("lookover");
  const signedOut = await fetch(`${again.origin}${API.snapshot}`, { headers: { origin: again.origin } });
  expect(await signedOut.json()).toEqual({ error: "no session", open: "lookover open" });
});

/** A POST to one of the `lookover` commands' routes, as the command makes it: the folder's session and the Origin. */
function postTo({ origin }: { origin: string }, home: string, path: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { cookie: sessionOf(home), origin: origin },
  });
}

test("the program opens through a minted link, once, and its token is never written to the log", async () => {
  const home = newHome();
  const run = deps(home);
  const service = await runService(program(home), { ...run.given, liveAdapters: onFakeHost(home) });
  cleanups.push(() => service.stop());
  const minted = await postTo(service, home, API.link);
  expect(minted.status).toBe(200);
  const { url } = await minted.json();
  const token = new URL(url).searchParams.get("token") ?? "";
  expect(token.length).toBeGreaterThan(20);
  expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
  expect((await fetch(url, { redirect: "manual" })).status).toBe(403);

  // A line that names it, whatever path it takes to the log, has it removed.
  run.program.fire("uncaughtException", new Error(`the link ${url} failed`));
  const log = logOf(home);
  expect(log).toContain("the link http://127.0.0.1:");
  expect(log).not.toContain(token);
  expect(run.err.join("\n")).not.toContain(token);
});

test("the program stops when asked over its API, as on Ctrl+C: it exits 0 and lets the data folder's lock go", async () => {
  const home = newHome();
  const run = deps(home);
  const lockHome = run.given.lockHome ?? "";
  const service = await runService(program(home), { ...run.given, liveAdapters: onFakeHost(home) });
  cleanups.push(() => service.stop());
  expect(probeInstance(home)).toBe("held");

  const stopped = await postTo(service, home, API.stop);
  expect(stopped.status).toBe(200);
  await exited(run.program.exits);
  expect(run.program.exits).toEqual([0]);
  expect(probeInstance(home)).toBe("free");
  expect(existsSync(join(home, "instance.json"))).toBe(false);
  acquireLiveLock({ home: lockHome, folder: "/elsewhere" }).release();
  await expect(fetch(`${service.origin}/`)).rejects.toThrow();
});

test("a stop asked over the API before the program has said it serves is kept, and done once it has", async () => {
  const home = newHome();
  const run = deps(home);
  let asked: number | undefined;
  const service = await runService(program(home), {
    ...run.given,
    liveAdapters: onFakeHost(home),
    // The service serves by then: `instance.json` is being made user-only, the program not yet done announcing.
    userOnly: async (path) => {
      if (statSync(path).isDirectory()) return;
      const address: string = JSON.parse(readFileSync(path, "utf8")).address;
      asked = (await postTo({ origin: address }, home, API.stop)).status;
    },
  });
  cleanups.push(() => service.stop());
  expect(asked).toBe(200);
  await exited(run.program.exits);
  expect(run.program.exits).toEqual([0]);
  expect(probeInstance(home)).toBe("free");
});

/** A built web app's folder in `home`: its page, and the program's marker when `program` (`build:program`, ADR 0054). */
function builtApp(home: string, { program }: { program: boolean }): string {
  const dist = join(home, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Lookover</title>");
  if (program) writeFileSync(join(dist, "lookover-program.json"), JSON.stringify({ mode: "program" }));
  return dist;
}

test("the program serves the web app the program's build made", async () => {
  const home = newHome();
  const run = deps(home);
  const service = await runService(program(home), {
    ...run.given,
    liveAdapters: onFakeHost(home),
    webDist: builtApp(home, { program: true }),
  });
  cleanups.push(() => service.stop());
  const page = await fetch(`${service.origin}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>Lookover</title>");
});

test("the program serves no web app another build made (demo or live): it has no program marker", async () => {
  const home = newHome();
  const run = deps(home);
  const service = await runService(program(home), {
    ...run.given,
    liveAdapters: onFakeHost(home),
    webDist: builtApp(home, { program: false }),
  });
  cleanups.push(() => service.stop());
  expect((await fetch(`${service.origin}/`)).status).toBe(404);
});

test("the web app the compiled binary carries is served in every mode, demo mode as the program, never the clone's", async () => {
  // `bun run build`'s smoke check runs the binary in demo mode: it must serve the app it carries there too.
  const home = newHome();
  const carried = diskWebFiles(builtApp(home, { program: false }));
  const inDemo = await runService(demo(home), { ...deps(home).given, webFiles: carried });
  cleanups.push(() => inDemo.stop());
  expect(await (await fetch(`${inDemo.origin}/`)).text()).toContain("<title>Lookover</title>");
  await inDemo.stop();

  // The program given the clone's program build too: the carried app, the one the binary was built with.
  const clone = join(home, "clone");
  mkdirSync(clone);
  writeFileSync(join(clone, "index.html"), "<!doctype html><title>The clone's</title>");
  writeFileSync(join(clone, "lookover-program.json"), JSON.stringify({ mode: "program" }));
  const inProgram = await runService(program(home), {
    ...deps(home).given,
    liveAdapters: onFakeHost(home),
    webDist: clone,
    webFiles: carried,
  });
  cleanups.push(() => inProgram.stop());
  expect(await (await fetch(`${inProgram.origin}/`)).text()).toContain("<title>Lookover</title>");
});

test("a start whose announcement fails stops the service it started, lets both locks go, and rejects", async () => {
  const home = newHome();
  const run = deps(home);
  const lockHome = run.given.lockHome ?? "";
  let address = "";
  const started = runService(program(home), {
    ...run.given,
    liveAdapters: onFakeHost(home),
    // The service serves by then: its address is in the file being made user-only (the log's folders come first).
    userOnly: async (path) => {
      if (statSync(path).isDirectory()) return;
      address = JSON.parse(readFileSync(path, "utf8")).address;
      throw new Error("icacls refused");
    },
  });
  await expect(started).rejects.toThrow("icacls refused");
  expect(address).not.toBe("");
  await expect(fetch(`${address}/`)).rejects.toThrow();
  expect(probeInstance(home)).toBe("free");
  acquireLiveLock({ home: lockHome, folder: "/elsewhere" }).release();
  expect(run.out).toEqual([]);
});

test("runService refuses live mode while another live run holds the lock: prints who, exits 1, starts nothing", async () => {
  const home = newHome();
  const run = deps(home);
  const lockHome = run.given.lockHome ?? "";
  // The holder is this test's own process, on another data folder; taken on the real clock under a minute ago.
  const held = acquireLiveLock({ home: lockHome, folder: "/elsewhere" });
  const since = new Date(JSON.parse(readFileSync(held.holderFile, "utf8")).since).toISOString();
  cleanups.push(() => held.release());
  const config: Config = {
    mode: "live",
    agent: agentOf("bun run lookover", "clone"),
    home,
    port: 0,
    origin: undefined,
    announce: join(home, "service.json"),
    eventsKept: undefined,
    env: {},
    git: "git",
    live: { repositories: [{ owner: "sasensi", name: "lookover-sandbox" }] },
    processes: join(home, "processes"),
  };

  const started = runService(config, run.given);

  await expect(started).rejects.toBeInstanceOf(LiveLockHeld);
  expect(run.err).toEqual([
    `Another live run holds the lock: process ${process.pid} on the data folder /elsewhere since ${since} ` +
      "(0 min ago). One real review at a time on this machine (ADR 0039): wait for it to stop.",
  ]);
  expect(run.program.exits).toEqual([1]);
  expect(run.out).toEqual([]);
  expect(existsSync(config.announce ?? "")).toBe(false);
  // The data folder's own lock went with the failed start.
  expect(probeInstance(home)).toBe("free");
});

/** The log file of the day FROZEN_AT falls on, in the machine's time zone: what the program wrote to it. */
function logOf(home: string): string {
  const at = new Date(FROZEN_AT);
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  return readFileSync(join(home, "logs", `lookover-${day}.log`), "utf8");
}

test("the program's lines go to the day's log file, its link's token removed, and are still printed as they were", async () => {
  const home = newHome();
  const run = deps(home);
  const service = await runService(demo(home), run.given);
  cleanups.push(() => service.stop());
  const token = new URL(linkOf(service)).searchParams.get("token") ?? "";
  expect(token.length).toBeGreaterThan(20);

  // `bun dev` prints what it printed: the URL to open, with its token.
  expect(run.out.join("\n")).toContain(`Open the app: ${service.openUrl}`);
  const log = logOf(home);
  // Stamped in the machine's local time with its offset, the instant the clock says; the banner one stamped line per
  // line (ADR 0055), its blank lines and indent left out.
  const stamp = /^(\S+[+-]\d{2}:\d{2}) Lookover service \(demo mode, S1\)/m.exec(log)?.[1] ?? "";
  expect(new Date(stamp).getTime()).toBe(FROZEN_AT);
  expect(log).toContain(`${stamp} Open the app: http://127.0.0.1:`);
  for (const line of log.trimEnd().split("\n")) expect(line).toMatch(/^\S+[+-]\d{2}:\d{2} \S/);
  expect(log).not.toContain(token);
});

test("demo mode with its clock standing still stamps every line at that instant, so `proof` shoots the same Logs page", async () => {
  const home = newHome();
  const run = deps(home);
  const service = await runService(demo(home), {
    ...run.given,
    clock: { now: () => FROZEN_AT + 3_600_000 },
  });
  cleanups.push(() => service.stop());
  const stamps = new Set(
    logOf(home)
      .trimEnd()
      .split("\n")
      .map((line) => new Date(line.slice(0, line.indexOf(" "))).getTime()),
  );
  expect([...stamps]).toEqual([FROZEN_AT]);
});

test("a stop says what asked for it, then that the service stopped: Ctrl+C, SIGTERM or `lookover stop`", async () => {
  const stops: ["SIGINT" | "SIGTERM" | "API", string][] = [
    ["SIGINT", "Ctrl+C"],
    ["SIGTERM", "SIGTERM"],
    ["API", "lookover stop"],
  ];
  for (const [how, who] of stops) {
    const home = newHome();
    const run = deps(home);
    const service = await runService(demo(home), run.given);
    cleanups.push(() => service.stop());
    if (how === "API") expect((await postTo(service, home, API.stop)).status).toBe(200);
    else run.program.fire(how);
    await exited(run.program.exits);
    expect(run.program.exits).toEqual([0]);
    const lines = logOf(home)
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(line.indexOf(" ") + 1));
    expect(lines.slice(-2)).toEqual([`Lookover is stopping (${who})`, "Lookover stopped"]);
  }
});

test("an uncaught error or rejection is written to the log, its secrets removed, and the program exits 1", async () => {
  const home = newHome();
  const run = deps(home);
  const service = await runService(demo(home), run.given);
  cleanups.push(() => service.stop());
  const token = new URL(linkOf(service)).searchParams.get("token") ?? "";
  const session = readFileSync(join(home, "session"), "utf8");

  run.program.fire("uncaughtException", new Error(`the cookie ${session} met the link ${token}`));
  run.program.fire("unhandledRejection", new Error(`refused: Authorization: Bearer ghs_${"a".repeat(36)}`));
  expect(run.program.exits).toEqual([1, 1]);
  const log = logOf(home);
  expect(log).toContain("the cookie [redacted] met the link [redacted]");
  expect(log).toContain("refused: Authorization: [redacted]");
  for (const shown of [log, run.err.join("\n")]) {
    expect(shown).not.toContain(session);
    expect(shown).not.toContain(token);
    expect(shown).not.toContain("ghs_aaaa");
  }
  // Printed too, as the file keeps it, with where it was thrown.
  expect(run.err.join("\n")).toContain("the cookie [redacted] met the link [redacted]");
  expect(log).toContain("run-service.test.ts");
});

/** Makes the day's log file a folder: every later line's append throws, as on a full disk. */
function logUnwritable(home: string): void {
  const at = new Date(FROZEN_AT);
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  const file = join(home, "logs", `lookover-${day}.log`);
  rmSync(file, { force: true });
  mkdirSync(file);
}

test("a log that can't be written stops no stop: the service still stops gracefully, lets its lock go and exits 0", async () => {
  const home = newHome();
  const run = deps(home);
  await runService(demo(home), run.given);
  logUnwritable(home);
  run.program.fire("SIGTERM");
  await exited(run.program.exits);
  expect(run.program.exits).toEqual([0]);
  expect(probeInstance(home)).toBe("free");
  // Each line printed as it would have been logged, with why it wasn't.
  expect(run.err.join("\n")).toContain("Lookover is stopping (SIGTERM) (not logged: ");
  expect(run.err.join("\n")).toContain("Lookover stopped (not logged: ");
});

test("a log that can't be written stops no exit: an uncaught error still exits 1, its secrets removed from what is printed", async () => {
  const home = newHome();
  const run = deps(home);
  const service = await runService(demo(home), run.given);
  cleanups.push(() => service.stop());
  logUnwritable(home);
  const token = `ghs_${"b".repeat(36)}`;
  run.program.fire("uncaughtException", new Error(`refused ${token}`));
  expect(run.program.exits).toEqual([1]);
  expect(run.err.join("\n")).toContain("refused [redacted]");
  expect(run.err.join("\n")).not.toContain(token);
});

test("in live mode GitHub's adapter is given the sink's secret: a value it registers is removed from every later line", async () => {
  const home = newHome();
  const run = deps(home);
  // Shaped like nothing the filter knows: only its registration removes it.
  const held = "an-unshaped-app-secret-0123456789";
  const config: Config = {
    mode: "live",
    agent: agentOf("bun run lookover", "clone"),
    home,
    port: 0,
    origin: undefined,
    announce: undefined,
    eventsKept: undefined,
    env: {},
    git: "git",
    live: { repositories: [{ owner: "sasensi", name: "lookover-sandbox" }] },
    processes: join(home, "processes"),
  };
  const started = runService(config, {
    ...run.given,
    liveAdapters: (options) => {
      options.secret?.(held);
      return Promise.reject(new Error("no real adapter in a test"));
    },
  });
  await expect(started).rejects.toThrow("no real adapter in a test");

  run.program.fire("uncaughtException", new Error(`GitHub echoed ${held}`));
  const log = logOf(home);
  expect(log).toContain("GitHub echoed [redacted]");
  expect(log).not.toContain(held);
  expect(run.err.join("\n")).not.toContain(held);
});
