// `lookover start`, `open`, `status` and `stop` (ADR 0054, "Links, stop and the background"): the service started
// in the background, reused while it runs, a link minted and the browser opened on it, said running or stopped, and
// stopped through its API. The spawner keeps `serve` as this test's child (killed in cleanup, whatever happened), the
// browser is a fake; the real detached start was made by hand on Windows (the ticket's note). The kill after 30 s
// without an answer is checked at its seam: a lock held in this process, a clock that jumps.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackgroundPorts,
  carriedWebFiles,
  cloneWebBuild,
  type LookoverDeps,
  loginCommand,
  lookover,
  lookoverCommand,
  memoryCommandPath,
  memoryLoginItem,
  probeInstance,
  realSystem,
  type Self,
  type ServeStarted,
  selfCommand,
  takeInstance,
  type WebBuild,
} from "./index.ts";

const MAIN = join(import.meta.dir, "main.ts");
/** This clone, as `main.ts` runs it. */
const SELF = { kind: "clone", bun: process.execPath, main: MAIN } as const;
setDefaultTimeout(20_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  // In reverse: the data folder goes once the service in it has stopped (Windows says EBUSY otherwise).
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function folder(): string {
  const made = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-background-"));
  cleanups.push(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

/**
 * `lookover serve <args>` as this test's child, in `where`'s folder (this test's by default) with its environment, its output
 * dropped as the real start's is; killed in cleanup.
 */
async function childServe(args: string[], where: Where): Promise<ServeStarted> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(where.env)) if (value !== undefined) env[name] = value;
  const child = Bun.spawn([process.execPath, MAIN, "serve", ...args], {
    ...(where.cwd === undefined ? {} : { cwd: where.cwd }),
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  cleanups.push(async () => {
    child.kill();
    await child.exited;
  });
  return { started: true, pid: child.pid, inTerminalJob: false, running: () => child.exitCode === null };
}

const REAL_TIME = { now: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) };

/** Where the background service runs: its folder and its environment, as the real start hands them on. */
interface Where {
  cwd?: string;
  env: Record<string, string | undefined>;
}

/**
 * The command on this machine with `ports` (the child spawner, a fake browser, no kill), and what it printed; `env`
 * adds to this machine's environment, for the command and its service, which runs in `cwd`.
 */
function command(
  ports: Partial<BackgroundPorts> = {},
  given: { env?: Record<string, string>; cwd?: string; self?: Self; platform?: NodeJS.Platform } = {},
) {
  const machine = realSystem();
  const system = {
    ...machine,
    env: { ...machine.env, ...given.env },
    platform: given.platform ?? machine.platform,
  };
  const out: string[] = [];
  const err: string[] = [];
  const spawned: string[][] = [];
  const opened: string[] = [];
  const killed: number[] = [];
  const loginItem = memoryLoginItem();
  const atLogin: string[][] = [];
  const background: BackgroundPorts = {
    startServe: async (args) => {
      spawned.push(args);
      return await childServe(args, {
        env: system.env,
        ...(given.cwd === undefined ? {} : { cwd: given.cwd }),
      });
    },
    openBrowser: async (url) => {
      opened.push(url);
      return true;
    },
    kill: (pid) => {
      killed.push(pid);
    },
    webBuild: (): WebBuild => "program",
    time: REAL_TIME,
    loginItem: (command) => {
      atLogin.push(command);
      return loginItem;
    },
    // Off the PATH: the binary is named by its path.
    commandPath: () => memoryCommandPath({ folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin" }),
    ...ports,
  };
  const deps: LookoverDeps = {
    print: { out: (line) => out.push(line), err: (line) => err.push(line) },
    system,
    self: given.self ?? SELF,
    agent: async () => {
      throw new Error("no agent here");
    },
    serve: async () => {
      throw new Error("start never serves in this process");
    },
    background,
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    return await lookover(argv, deps);
  };
  return { run, out, err, spawned, opened, killed, loginItem, atLogin };
}

const LINK = /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/session\?token=[A-Za-z0-9_-]{32}$/;

/** The one-time link on a line of its own in what was printed. */
const linkIn = (printed: string[]): string | undefined =>
  printed
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => LINK.test(line));

test("start runs the service in the background, start again reuses it; status, open and stop reach it, then status says stopped", async () => {
  const home = folder();
  const c = command();
  expect(await c.run("start", "--demo", `--home=${home}`, "--no-open")).toBe(0);
  // `serve` with the same arguments, told it runs in the background, so it prints nothing.
  expect(c.spawned).toEqual([["--demo", `--home=${home}`, "--background"]]);
  const link = linkIn(c.out);
  expect(link).toBeDefined();
  expect(c.out.join("\n")).toContain("You can close this terminal.");
  expect(c.opened).toEqual([]);
  // The link works, once: the service the command started is the one answering.
  const followed = await fetch(link ?? "", { redirect: "manual" });
  expect(followed.status).toBe(303);

  expect(await c.run("start", "--demo", `--home=${home}`)).toBe(0);
  expect(c.spawned).toHaveLength(1);
  expect(c.out.join("\n")).toContain(
    "Lookover already runs. It keeps the options it was started with: --demo wasn't used.",
  );
  expect(c.opened).toHaveLength(1);
  expect(c.opened[0]).toMatch(LINK);

  expect(await c.run("status", `--home=${home}`, "--json")).toBe(0);
  const status = JSON.parse(c.out.join("\n"));
  expect(status).toEqual({
    running: true,
    address: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    home,
    version: "0.1.0",
    pid: expect.any(Number),
    since: expect.any(Number),
    startsAtLogin: false,
  });

  expect(await c.run("open", `--home=${home}`, "--no-open")).toBe(0);
  expect(linkIn(c.out)).toBeDefined();
  expect(c.opened).toHaveLength(1);

  expect(await c.run("stop", `--home=${home}`)).toBe(0);
  expect(c.out.join("\n")).toContain("Lookover stopped.");
  expect(probeInstance(home)).toBe("free");
  expect(c.killed).toEqual([]);

  expect(await c.run("status", `--home=${home}`)).toBe(3);
  expect(c.out.join("\n")).toContain("Lookover is stopped.");
  expect(await c.run("status", `--home=${home}`, "--json")).toBe(3);
  expect(JSON.parse(c.out.join("\n"))).toEqual({ running: false, home, startsAtLogin: false });
});

/** The two lines `start` and `open` say once the browser was handed the link (ADR 0058). */
const opening = (named: string) => [
  "Lookover is opening in your browser.",
  `Don't see it? \`${named} open --no-open\` prints a link to paste (it works once, within 2 minutes).`,
];

test("start and open name Lookover's command, never the bare address; --no-open prints the link; status keeps the address", async () => {
  // The binary in a folder with a space, on a data folder with one too, which isn't the profile's: both quoted, and
  // PowerShell's call operator before the quoted executable.
  const home = join(folder(), "my data");
  mkdirSync(home);
  const binary: Self = {
    kind: "binary",
    path: "C:\\Program Files\\Lookover\\lookover.exe",
    webFiles: carriedWebFiles(new Map()),
  };
  const named = `& 'C:\\Program Files\\Lookover\\lookover.exe' '--home=${home}'`;
  const c = command({}, { self: binary, platform: "win32" });
  expect(await c.run("start", "--demo", `--home=${home}`)).toBe(0);
  expect(c.out).toEqual([
    "Lookover runs in the background.",
    ...opening(named),
    "You can close this terminal.",
  ]);
  expect(c.opened).toHaveLength(1);

  expect(await c.run("start", `--home=${home}`)).toBe(0);
  expect(c.out).toEqual(["Lookover already runs.", ...opening(named), "You can close this terminal."]);

  expect(await c.run("open", `--home=${home}`)).toBe(0);
  expect(c.out).toEqual(opening(named));
  expect(c.opened).toHaveLength(3);

  expect(await c.run("open", `--home=${home}`, "--no-open")).toBe(0);
  expect(c.out).toEqual([`Open Lookover (the link works once, within 2 minutes):\n  ${linkIn(c.out)}`]);

  // The browser that doesn't open: the link, to paste.
  const closed = command({ openBrowser: async () => false }, { self: binary, platform: "win32" });
  expect(await closed.run("open", `--home=${home}`)).toBe(0);
  expect(closed.out).toEqual([
    `The browser didn't open. Open Lookover with this link (it works once, within 2 minutes):\n  ${linkIn(closed.out)}`,
  ]);

  expect(await c.run("status", `--home=${home}`)).toBe(0);
  expect(c.out.join("\n")).toMatch(/^Lookover runs at http:\/\/127\.0\.0\.1:\d+\n/);
  expect(await c.run("stop", `--home=${home}`)).toBe(0);
});

test("the binary is named lookover once the PATH as saved reaches it; under a live config, by its path", async () => {
  // A space in the data folder: quoted by every shell.
  const home = join(folder(), "my data");
  mkdirSync(home);
  const binary: Self = {
    kind: "binary",
    path: "C:\\Tools\\lookover.exe",
    webFiles: carriedWebFiles(new Map()),
  };
  const asked: string[] = [];
  const onPath = command(
    {
      commandPath: (executable) => {
        asked.push(executable);
        return memoryCommandPath({
          folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin",
          reach: "yes",
        });
      },
    },
    { self: binary, platform: "win32" },
  );
  expect(await onPath.run("open", `--home=${home}`)).toBe(3);
  expect(onPath.err).toEqual([`Lookover isn't running. Start it with \`lookover '--home=${home}' start\`.`]);
  expect(asked).toEqual(["C:\\Tools\\lookover.exe"]);
  // A live config's program keeps the PATH in memory: its command is the binary's path, the PATH not asked.
  writeFileSync(join(home, "live.json"), "{}");
  expect(await onPath.run("open", `--home=${home}`)).toBe(3);
  expect(onPath.err).toEqual([
    `Lookover isn't running. Start it with \`C:\\Tools\\lookover.exe '--home=${home}' start\`.`,
  ]);
  expect(asked).toHaveLength(1);
  // A PATH the machine can't read: the binary's path.
  const unread = memoryCommandPath({ folder: "C:\\Lookover\\bin", reach: "yes" });
  unread.unreadable("Access is denied.");
  const other = join(folder(), "my data");
  mkdirSync(other);
  const blind = command({ commandPath: () => unread }, { self: binary, platform: "win32" });
  expect(await blind.run("open", `--home=${other}`)).toBe(3);
  expect(blind.err).toEqual([
    `Lookover isn't running. Start it with \`C:\\Tools\\lookover.exe '--home=${other}' start\`.`,
  ]);
});

test("an npm install is named lookover, which npm put on the PATH: the PATH as saved isn't asked", async () => {
  const home = join(folder(), "my data");
  mkdirSync(home);
  const npm: Self = {
    kind: "npm",
    path: "C:\\npm\\node_modules\\lookover\\node_modules\\@lookover\\win32-x64\\lookover.exe",
    launcher: "C:\\npm\\node_modules\\lookover\\bin\\lookover.js",
    webFiles: carriedWebFiles(new Map()),
  };
  const asked: string[] = [];
  const c = command(
    {
      commandPath: (executable) => {
        asked.push(executable);
        return memoryCommandPath({ folder: "C:\\npm" });
      },
    },
    { self: npm, platform: "win32" },
  );
  expect(await c.run("open", `--home=${home}`)).toBe(3);
  expect(c.err).toEqual([`Lookover isn't running. Start it with \`lookover '--home=${home}' start\`.`]);
  expect(asked).toEqual([]);
});

test("from a clone, start and open name bun run lookover; the profile's data folder isn't named", async () => {
  const home = join(folder(), "my data");
  mkdirSync(home);
  const c = command();
  expect(await c.run("start", "--demo", `--home=${home}`)).toBe(0);
  // Quoted as this machine's shell reads it back.
  const quoted = `'--home=${home}'`;
  expect(c.out).toEqual([
    "Lookover runs in the background.",
    ...opening(`bun run lookover ${quoted}`),
    "You can close this terminal.",
  ]);
  expect(await c.run("stop", `--home=${home}`)).toBe(0);

  // The profile's data folder, as `LOOKOVER_HOME` isn't set: `bun run lookover` alone, which `open` is then given.
  const profile = command({}, { env: { XDG_DATA_HOME: home, LOOKOVER_HOME: "" }, platform: "linux" });
  expect(await profile.run("open")).toBe(3);
  expect(profile.err).toEqual(["Lookover isn't running. Start it with `bun run lookover start`."]);
});

test("the data folder may come before the verb, as Lookover's command names it", async () => {
  const home = folder();
  const c = command();
  expect(await c.run(`--home=${home}`, "status", "--json")).toBe(3);
  expect(JSON.parse(c.out.join("\n"))).toEqual({ running: false, home, startsAtLogin: false });
});

test("status says whether the program on the data folder starts at login, asked with the command it registers", async () => {
  const home = folder();
  const c = command();
  await c.loginItem.register();
  expect(await c.run("status", `--home=${home}`, "--json")).toBe(3);
  expect(JSON.parse(c.out.join("\n"))).toEqual({ running: false, home, startsAtLogin: true });
  expect(c.atLogin).toEqual([loginCommand(home, realSystem(), selfCommand(SELF))]);
  expect(await c.run("status", `--home=${home}`)).toBe(3);
  expect(c.out.join("\n")).toBe(`Lookover is stopped. Data folder: ${home}\nIt starts at login.`);
  await c.loginItem.unregister();
  expect(await c.run("status", `--home=${home}`)).toBe(3);
  expect(c.out.join("\n")).toContain("It doesn't start at login.");

  // Guarded by a live.json, the program there registers nothing on the machine: the port isn't even asked.
  writeFileSync(join(home, "live.json"), JSON.stringify({ repositories: ["sasensi/lookover-sandbox"] }));
  await c.loginItem.register();
  c.atLogin.length = 0;
  expect(await c.run("status", `--home=${home}`, "--json")).toBe(3);
  expect(JSON.parse(c.out.join("\n"))).toEqual({ running: false, home, startsAtLogin: false });
  expect(c.atLogin).toEqual([]);
});

test("an instance.json a crash left behind is never taken for the service just started", async () => {
  const home = folder();
  const crashed = { pid: 1, port: 1, address: "http://127.0.0.1:1", version: "0.1.0", since: 0 };
  writeFileSync(join(home, "instance.json"), JSON.stringify(crashed));
  const c = command();
  expect(await c.run("start", "--demo", `--home=${home}`, "--no-open")).toBe(0);
  expect(c.out.join("\n")).not.toContain("http://127.0.0.1:1.");
  expect(linkIn(c.out)).toBeDefined();
  expect(await c.run("stop", `--home=${home}`)).toBe(0);
});

test("open and stop on a stopped service say so; nothing is started", async () => {
  const home = folder();
  const c = command();
  expect(await c.run("open", `--home=${home}`)).toBe(3);
  expect(c.err.join("\n")).toContain(
    `Lookover isn't running. Start it with \`${lookoverCommand(SELF, home, realSystem(), false)} start\`.`,
  );
  expect(await c.run("stop", `--home=${home}`)).toBe(0);
  expect(c.out.join("\n")).toContain("Lookover isn't running.");
  expect(c.spawned).toEqual([]);
  expect(c.opened).toEqual([]);
});

test("the program's start refuses a clone whose web app is missing or wasn't built for the program", async () => {
  for (const build of ["missing", "other"] as const) {
    const c = command({ webBuild: () => build });
    expect(await c.run("start", `--home=${folder()}`, "--no-open")).toBe(1);
    expect(c.err.join("\n")).toContain("Run `bun run build` first");
    expect(c.spawned).toEqual([]);
  }
});

test("a clone's web app is the program's when the program's build left its marker beside index.html", () => {
  const dist = join(folder(), "dist");
  expect(cloneWebBuild(dist)).toBe("missing");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html>");
  expect(cloneWebBuild(dist)).toBe("other");
  writeFileSync(join(dist, "lookover-program.json"), '{"mode":"program"}');
  expect(cloneWebBuild(dist)).toBe("program");
});

test("a start Windows refuses says why; one left in the terminal's job says closing the terminal may stop it", async () => {
  const refused = command({
    startServe: async () => ({ started: false, reason: "CreateProcessW failed (error 2)" }),
  });
  expect(await refused.run("start", "--demo", `--home=${folder()}`, "--no-open")).toBe(1);
  expect(refused.err.join("\n")).toContain("Lookover didn't start: CreateProcessW failed (error 2)");

  const inJob = command({
    startServe: async (args) => ({
      ...(await childServe(args, { env: realSystem().env })),
      inTerminalJob: true,
    }),
  });
  const home = folder();
  expect(await inJob.run("start", "--demo", `--home=${home}`, "--no-open")).toBe(0);
  expect(inJob.err.join("\n")).toContain(
    "Windows keeps Lookover tied to this terminal: closing it may stop Lookover. Keep it open.",
  );
  expect(inJob.out.join("\n")).not.toContain("You can close this terminal.");
  expect(await inJob.run("stop", `--home=${home}`)).toBe(0);
});

test("a serve that dies before it answers is a failed start, with where its log is", async () => {
  const home = folder();
  const c = command({
    startServe: async () => ({ started: true, pid: 1, inTerminalJob: false, running: () => false }),
  });
  expect(await c.run("start", "--demo", `--home=${home}`, "--no-open")).toBe(1);
  expect(c.err.join("\n")).toContain(`Lookover didn't start: its log is in ${join(home, "logs")}.`);
});

/** How far a test's clock jumps at each wait: a probe of the lock costs real milliseconds, 600 of them add up. */
const JUMP_MS = 5_000;

/** A clock that jumps 5 s at each wait, from 0. */
function jumpingTime() {
  let now = 0;
  return {
    now: () => now,
    sleep: async () => {
      now += JUMP_MS;
    },
  };
}

/**
 * The data folder `home` held in this process, `instance.json` naming `pid` at the address of a server that says
 * yes to the stop, and never stops.
 */
async function heldBy(home: string, pid: number) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "session"), "a".repeat(32));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
  cleanups.push(() => server.stop(true));
  const instance = takeInstance(home, async () => {});
  cleanups.push(() => instance.release());
  const address = `http://127.0.0.1:${server.port}`;
  const announce = (by: number) =>
    instance.announce({ pid: by, port: server.port ?? 0, address, version: "0.1.0", since: 0 });
  await announce(pid);
  return { release: () => instance.release(), announce };
}

test("a service that doesn't answer within 30 s is killed while its lock is held and its id is instance.json's", async () => {
  const home = folder();
  const instance = await heldBy(home, 4242);
  const killed: number[] = [];
  const c = command({
    time: jumpingTime(),
    kill: (pid) => {
      killed.push(pid);
      instance.release();
    },
  });
  expect(await c.run("stop", `--home=${home}`)).toBe(0);
  expect(killed).toEqual([4242]);
  expect(c.out.join("\n")).toContain("Lookover didn't answer in 30 s: process 4242 was ended.");
  expect(probeInstance(home)).toBe("free");
});

test("no kill when instance.json names another process than the one asked to stop", async () => {
  const home = folder();
  const instance = await heldBy(home, 4242);
  let waited = 0;
  const time = {
    now: () => waited,
    sleep: async () => {
      waited += JUMP_MS;
      // Another service took the folder meanwhile.
      if (waited === JUMP_MS) await instance.announce(5151);
    },
  };
  const c = command({ time });
  expect(await c.run("stop", `--home=${home}`)).toBe(1);
  expect(c.killed).toEqual([]);
  expect(c.err.join("\n")).toContain("Lookover didn't stop:");
});

const LINK_GIVEN = "http://127.0.0.1:1/api/v1/session?token=given";

/**
 * The data folder `home` held in this process by a service still starting: its lock taken, no `instance.json` until
 * `announce` writes it, at the address of a server that mints `LINK_GIVEN`.
 */
function booting(home: string) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "session"), "a".repeat(32));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ url: LINK_GIVEN }),
  });
  cleanups.push(() => server.stop(true));
  const instance = takeInstance(home, async () => {});
  cleanups.push(() => instance.release());
  const address = `http://127.0.0.1:${server.port}`;
  const announce = () =>
    instance.announce({ pid: 4242, port: server.port ?? 0, address, version: "0.1.0", since: 0 });
  return { address, announce, release: () => instance.release() };
}

/** A clock that jumps 5 s at each wait, from 0, running `then(wait)` after each; the waits counted. */
function countedTime(then: (wait: number) => Promise<void> | void) {
  const waits = { count: 0 };
  return {
    waits,
    time: {
      now: () => waits.count * JUMP_MS,
      sleep: async () => {
        waits.count++;
        await then(waits.count);
      },
    },
  };
}

test("a service still starting: status says starting; start waits for it to say where it serves, then reuses it", async () => {
  const home = folder();
  const service = booting(home);
  const c = command();
  expect(await c.run("status", `--home=${home}`)).toBe(0);
  expect(c.out.join("\n")).toContain(`Lookover is starting. Data folder: ${home}`);
  expect(await c.run("status", `--home=${home}`, "--json")).toBe(0);
  expect(JSON.parse(c.out.join("\n"))).toEqual({
    running: true,
    home,
    address: null,
    startsAtLogin: false,
  });

  const { time } = countedTime(async (wait) => {
    if (wait === 2) await service.announce();
  });
  const later = command({ time });
  expect(await later.run("start", `--home=${home}`, "--no-open")).toBe(0);
  expect(later.spawned).toEqual([]);
  expect(later.out.join("\n")).toContain("Lookover already runs.");
  expect(later.out.join("\n")).not.toContain(service.address);
  // Only the data folder was given: no option to say wasn't used.
  expect(later.out.join("\n")).not.toContain("wasn't used");
  expect(later.out.join("\n")).toContain(LINK_GIVEN);
});

test("a service still starting after 60 s: start says so, with where its log is", async () => {
  const home = folder();
  booting(home);
  const c = command({ time: jumpingTime() });
  expect(await c.run("start", `--home=${home}`, "--no-open")).toBe(1);
  expect(c.err.join("\n")).toContain(
    `Lookover is still starting after 60 s: its log is in ${join(home, "logs")}.`,
  );
  expect(c.spawned).toEqual([]);
});

test("a service that dies while it starts is noticed at once, not after 60 s", async () => {
  const home = folder();
  const service = booting(home);
  const { waits, time } = countedTime(() => service.release());
  const c = command({ time });
  expect(await c.run("open", `--home=${home}`, "--no-open")).toBe(1);
  expect(c.err.join("\n")).toContain(`Lookover didn't start: its log is in ${join(home, "logs")}.`);
  expect(waits.count).toBe(1);
});

/** Runs in `folder` until the test ends, as a terminal opened there would. */
function inFolder(folder: string): void {
  const was = process.cwd();
  process.chdir(folder);
  cleanups.push(() => process.chdir(was));
}

test("start hands the service the folders it was named, made absolute: the service runs in another folder", async () => {
  // A terminal in `here`, naming the data folder and the announce file relative to it; the service runs elsewhere.
  const here = folder();
  const elsewhere = folder();
  mkdirSync(join(here, "data"));
  inFolder(here);
  const home = join(here, "data");
  const c = command({}, { cwd: elsewhere });
  expect(await c.run("start", "--demo", "--home=./data", "--announce=service.json", "--no-open")).toBe(0);
  expect(c.spawned).toEqual([
    ["--demo", `--home=${home}`, `--announce=${join(here, "service.json")}`, "--background"],
  ]);
  expect(existsSync(join(here, "service.json"))).toBe(true);
  expect(await c.run("status", "--home=./data", "--json")).toBe(0);
  expect(await c.run("stop", "--home=./data")).toBe(0);
  expect(probeInstance(home)).toBe("free");

  // LOOKOVER_HOME relative to the terminal's folder: the service is told the folder it names.
  const byEnv = command({}, { cwd: elsewhere, env: { LOOKOVER_HOME: "data" } });
  expect(await byEnv.run("start", "--demo", "--no-open")).toBe(0);
  expect(byEnv.spawned).toEqual([["--demo", `--home=${home}`, "--background"]]);
  expect(await byEnv.run("status", "--json")).toBe(0);
  expect(JSON.parse(byEnv.out.join("\n"))).toMatchObject({ running: true, home });
  expect(await byEnv.run("stop")).toBe(0);
  expect(probeInstance(home)).toBe("free");
});

test("start hands the program the live config it was named, made absolute, from --live-config or LOOKOVER_LIVE_CONFIG", async () => {
  const here = folder();
  const home = folder();
  writeFileSync(join(here, "guard.json"), JSON.stringify({ repositories: ["sasensi/lookover-sandbox"] }));
  inFolder(here);
  const asked: string[][] = [];
  // Nothing is started: the arguments it would be started with are all this needs.
  const startServe = async (args: string[]): Promise<ServeStarted> => {
    asked.push(args);
    return { started: false, reason: "not in this test" };
  };
  const guard = join(here, "guard.json");
  expect(await command({ startServe }).run("start", `--home=${home}`, "--live-config=guard.json")).toBe(1);
  const byEnv = command({ startServe }, { env: { LOOKOVER_LIVE_CONFIG: "guard.json" } });
  expect(await byEnv.run("start", `--home=${home}`)).toBe(1);
  expect(asked).toEqual([
    [`--home=${home}`, `--live-config=${guard}`, "--background"],
    [`--home=${home}`, `--live-config=${guard}`, "--background"],
  ]);
});
