#!/usr/bin/env bun
// Visual proof: screenshots of every main screen, in both themes. `bun run proof` writes
// .proof/<theme>/<name>.png and .proof/index.html. Attach them to UI pull requests.
// The app on the service in demo mode (ADR 0046), as `bun dev` runs it: the scripted GitHub and engines, no
// network, on a data folder of its own in the temp folder, its clock standing still at one instant (`--frozen`).
// The UI talks to it through its own Vite server. The shots are listed in scripts/proof-shots.ts: each names a
// scenario, how far its clock moves on and the faults made to happen; proof loads it (`demo.load`), moves it
// (`demo.advance`, `demo.inject`), then opens the page with the session, acts and shoots. A shot that lands on
// any screen but its own (the session screen, the setup) fails.
// `bun run proof home review` takes only the shots whose name contains one of the words. `--jobs=<n>` shoots n at
// once (4 by default).
// `bun run proof --diff <base-ref>` also shoots <base-ref> (into .proof/base) and lists only the shots whose
// bytes differ; .proof/index.html then shows those, base beside current. Base shots are kept in the temp folder
// (lookover-proof-cache, a week after their last use) per base commit and version of these two files and the
// browser, so a second diff against the same base shoots only the current tree; otherwise the base is shot from a
// temporary worktree, at the same time as the current tree.
// Shots are deterministic: the service's clock stands still, the page's `Date` with it, the time zone fixed,
// animations and transitions off, a toast held as it is. Each worktree takes its own ports (scripts/port.ts), so
// two can run proof at once. Proof never calls `claude`, `codex` or the network.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { API, DEMO_API, type DemoCommand, type DemoListing, type FaultId } from "@lookover/contracts";
import { type Browser, type BrowserContextOptions, chromium, type Request } from "playwright";
import { instanceOf, portFor } from "./port.ts";
import { type Demo, SHOTS, type Shot, screenOf } from "./proof-shots.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, ".proof");
// The long form of the temp path: under a Windows 8.3 short name, Bun can't link the workspace packages.
const temp = realpathSync.native(tmpdir());
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];
// Every shot starts at this instant, read in UTC: Tuesday 6 October 2026, 08:52.
const FROZEN_AT = Date.UTC(2026, 9, 6, 8, 52);
// The time zone of the page and of the service alike (its log lines, the times it puts on GitHub's checks): a shot
// never depends on the machine's.
const ZONE = "UTC";
// Shot as they are: no animation, no transition, so a toast is caught whole and the eyes stand still.
const STILL = "*, *::before, *::after { animation: none !important; transition: none !important; }";

type Cookie =
  NonNullable<BrowserContextOptions["storageState"]> extends infer S
    ? S extends { cookies: (infer C)[] }
      ? C
      : never
    : never;

// ---- Processes ---------------------------------------------------------------------------------------------

/** Every server still running, stopped on Ctrl+C too. */
const running = new Set<ChildProcess>();
process.on("SIGINT", () => {
  for (const child of running) kill(child);
  process.exit(130);
});

/** A server proof started, and the end of what it said on stderr, for when it fails to start. */
interface Proc {
  child: ChildProcess;
  lastWords(): string;
}

function start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Proc {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"], env });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  running.add(child);
  child.on("exit", () => running.delete(child));
  return { child, lastWords: () => stderr.trim() };
}

/** Stops the process and everything it started; resolves once it is gone. */
async function stop({ child }: Proc): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((ok) => child.once("exit", () => ok()));
  kill(child);
  await Promise.race([gone, Bun.sleep(5_000)]);
}

function kill(child: ChildProcess): void {
  // The whole tree: Vite's and the service's children too. Best effort: the tree may already be gone.
  if (process.platform === "win32")
    Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  else child.kill("SIGTERM");
}

/** Runs a program to its end without blocking the shots in flight. */
function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((ok) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => ok({ status, stderr: stderr.trim() }));
  });
}

/** Removes a folder a stopped process held: Windows releases its handles a moment after the process is gone. */
async function removeDir(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i >= 40) throw error;
      await Bun.sleep(250);
    }
  }
}

async function ready(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function waitFor(what: string, done: () => boolean | Promise<boolean>, proc: Proc) {
  for (let i = 0; i < 300; i++) {
    if (await done()) return;
    if (proc.child.exitCode !== null) break;
    await Bun.sleep(100);
  }
  throw new Error(`${what} did not start. ${proc.lastWords()}`);
}

// ---- The service -------------------------------------------------------------------------------------------

/** Vite's own entry, not its .cmd shim: the process tree then stops cleanly on Windows. */
function viteOf(worktree: string): string {
  const pkg = createRequire(join(worktree, "apps", "web", "package.json")).resolve("vite/package.json");
  return join(dirname(pkg), "bin", "vite.js");
}

/** The dev verbs proof sends, as the developer drawer sends them, with the session. */
interface DemoDoor {
  load(id: string): Promise<void>;
  advance(ms: number): Promise<void>;
  inject(fault: FaultId): Promise<void>;
  /** The instant the clock stands at. */
  now(): Promise<number>;
}

interface ServiceServer {
  url: string;
  /** The session cookie the one-time link gave. */
  cookie: Cookie;
  demo: DemoDoor;
  stop(): Promise<void>;
}

/**
 * The worktree's service in demo mode, its clock standing still, on a fresh data folder, and the app on it: its
 * own Vite server proxies `/api` to the service, so the browser sees one origin, as with `bun dev`. Every browser
 * context is closed before `stop`, so no event stream is left open through the proxy.
 */
async function serveService(worktree: string): Promise<ServiceServer> {
  const uiPort = await portFor(worktree, 4);
  const servicePort = await portFor(worktree, 5);
  const url = `http://127.0.0.1:${uiPort}`;
  const home = join(temp, `lookover-proof-service-${instanceOf(worktree)}`);
  // A run stopped half way leaves its data folder: every run starts on an empty one.
  await removeDir(home);
  mkdirSync(home, { recursive: true });
  const announce = join(home, "service.json");
  const service = start(
    process.execPath,
    [
      join(worktree, "apps", "service", "src", "main.ts"),
      "serve",
      "--demo",
      `--frozen=${FROZEN_AT}`,
      `--home=${home}`,
      `--port=${servicePort}`,
      `--origin=${url}`,
      `--announce=${announce}`,
    ],
    worktree,
    { ...process.env, TZ: ZONE },
  );
  const vite = start(process.execPath, [viteOf(worktree)], join(worktree, "apps", "web"), {
    ...process.env,
    LOOKOVER_UI_PORT: String(uiPort),
    LOOKOVER_API: `http://127.0.0.1:${servicePort}`,
    VITE_LOOKOVER_MODE: "demo",
  });
  const stopAll = async () => {
    await stop(vite);
    await stop(service);
    await removeDir(home);
  };
  try {
    await waitFor(`The service of ${worktree}`, () => existsSync(announce), service);
    await waitFor(`The app server of ${worktree}`, () => ready(url), vite);
    const announced: unknown = JSON.parse(readFileSync(announce, "utf8"));
    const openUrl =
      typeof announced === "object" && announced !== null && "openUrl" in announced
        ? announced.openUrl
        : null;
    if (typeof openUrl !== "string") throw new Error(`The service announced no link to open: ${announce}`);
    const opened = await fetch(openUrl, { redirect: "manual" });
    const [name = "", value = ""] = (opened.headers.get("set-cookie") ?? "").split(";")[0]?.split("=") ?? [];
    if (!value) throw new Error(`The link to open the app answered ${opened.status} with no session`);
    const cookie: Cookie = {
      name,
      value,
      domain: "127.0.0.1",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
    };
    return { url, cookie, demo: demoDoor(url, `${name}=${value}`), stop: stopAll };
  } catch (error) {
    await stopAll();
    throw error;
  }
}

/** The dev verbs on the service, as the drawer posts them: same origin, the session cookie. */
function demoDoor(url: string, cookie: string): DemoDoor {
  const call = (path: string, init?: RequestInit) =>
    fetch(`${url}${path}`, { ...init, headers: { ...init?.headers, cookie, origin: url } });
  const send = async (verb: DemoCommand) => {
    const res = await call(API.commands, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(verb),
    });
    if (!res.ok) throw new Error(`${JSON.stringify(verb)} answered ${res.status} ${await res.text()}`);
  };
  return {
    load: (id) => send({ type: "demo.load", id }),
    advance: (ms) => send({ type: "demo.advance", ms }),
    inject: (fault) => send({ type: "demo.inject", fault }),
    now: async () => {
      const res = await call(DEMO_API.listing);
      if (!res.ok) throw new Error(`The demo listing answered ${res.status}`);
      const listing: DemoListing = await res.json();
      return listing.clock.now;
    },
  };
}

/**
 * What a shot needs before its page opens: a scenario loaded, its clock moved on, faults made to happen, the clock
 * moved on again.
 */
const worldOf = (shot: Shot) => ({
  scenario: shot.scenario,
  advance: shot.advance ?? 0,
  inject: shot.inject ?? [],
  after: shot.afterFaults ?? 0,
});

/** Brings the service to the shot's world; the instant its clock then stands at. */
async function enter(demo: DemoDoor, shot: Shot): Promise<number> {
  const world = worldOf(shot);
  await demo.load(world.scenario);
  if (world.advance > 0) await demo.advance(world.advance);
  for (const fault of world.inject) await demo.inject(fault);
  if (world.after > 0) await demo.advance(world.after);
  return demo.now();
}

// ---- Shots -------------------------------------------------------------------------------------------------

/** At most `n` shots at once, across both trees. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active < n) active += 1;
    else await new Promise<void>((ok) => waiting.push(ok));
    try {
      return await work();
    } finally {
      // The slot goes straight to the next in line, if any.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/** The service a page is shot on, and the instant its clock stands at. */
interface Visit {
  url: string;
  cookie: Cookie;
  demo: DemoDoor;
  now: number;
}

async function shootOne(browser: Browser, visit: Visit, theme: Theme, shot: Shot, file: string) {
  const context = await browser.newContext({
    viewport: shot.phone ? { width: 390, height: 780 } : { width: 1180, height: 820 },
    reducedMotion: "reduce",
    timezoneId: ZONE,
    locale: "en-GB",
    ...(shot.noSession ? {} : { storageState: { cookies: [visit.cookie], origins: [] } }),
  });
  await context.addInitScript(
    ([t, drawer, still]) => {
      localStorage.setItem("lookover.theme", t);
      localStorage.setItem("lookover.drawer", drawer);
      // Before the first paint: an animation that ran and was stopped later can leave Chrome painting a stale
      // frame (the eyes' pupils, cut out by an SVG mask, stayed where the animation left them).
      const hold = () => {
        const style = document.createElement("style");
        style.textContent = still;
        document.documentElement.append(style);
      };
      if (document.documentElement) hold();
      else
        new MutationObserver((_, watch) => {
          if (!document.documentElement) return;
          watch.disconnect();
          hold();
        }).observe(document, { childList: true });
    },
    [theme, shot.drawer ? "open" : "closed", STILL] as const,
  );
  // The page's `Date` stands where the service's clock stands.
  await context.clock.setFixedTime(visit.now);
  // A shot takes a few seconds; a step that waits longer waits for something that won't come (a screen the
  // base doesn't have), and its second try would double Playwright's 30 s.
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  // The commands the page sent and the service has not answered yet: an act moves the clock only once they are.
  let unanswered = 0;
  const isCommand = (request: Request) =>
    request.method() === "POST" && new URL(request.url()).pathname === API.commands;
  page.on("request", (request) => {
    if (isCommand(request)) unanswered += 1;
  });
  const answered = (request: Request) => {
    if (isCommand(request)) unanswered -= 1;
  };
  page.on("requestfinished", answered);
  page.on("requestfailed", answered);
  /** Once every command the page sent has been answered. */
  const settled = async () => {
    for (let i = 0; unanswered > 0; i++) {
      if (i >= 100) throw new Error("A command the page sent was not answered within 5 s");
      await Bun.sleep(50);
    }
  };
  const demo: Demo = {
    advance: async (ms) => {
      await settled();
      await visit.demo.advance(ms);
    },
    inject: async (fault) => {
      await settled();
      await visit.demo.inject(fault);
    },
  };
  const screen = screenOf(shot);
  try {
    await page.goto(`${visit.url}${shot.path ?? "/"}`);
    await page.waitForSelector(screen);
    await shot.act?.(page, demo);
    // Still on its own screen once acted: never the session screen, or the setup, in place of the app.
    await page.waitForSelector(screen);
    if (!shot.noSession && (await page.locator(".session").count()) > 0)
      throw new Error("The session screen showed: the service no longer knew the tab");
    // A sticky top bar would be drawn in the middle of a full-page shot.
    if (shot.fullPage) await page.addStyleTag({ content: ".app > .top { position: static !important; }" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
    await page.screenshot({ path: file, fullPage: shot.fullPage ?? false, animations: "disabled" });
  } finally {
    await context.close();
  }
}

/** "<theme>/<name>": a shot in one theme, and its file under an output folder. */
type Key = `${Theme}/${string}`;
const keyOf = (theme: Theme, shot: Shot): Key => `${theme}/${shot.name}`;

interface Side {
  worktree: string;
  outDir: string;
  /** "base " or "": what the log puts before each shot. */
  prefix: string;
  /** The base of a diff: one that can't load scenarios at all says so once, every shot new. */
  base?: boolean;
  /** The shots to take on this side. */
  wanted: (key: Key) => boolean;
}

/** One side being shot: where each shot goes, and the record of each. */
interface Shooting {
  browser: Browser;
  side: Side;
  slot: ReturnType<typeof limiter>;
  /** Takes one shot, logs it, and records it failed if it throws. */
  one(key: Key, work: () => Promise<void>): Promise<void>;
  /** Records shots failed without a line each. */
  skip(keys: Key[]): void;
  fileOf(key: Key): string;
  /** The wanted shots, in both themes. */
  each(shots: Shot[]): { theme: Theme; shot: Shot; key: Key }[];
}

type Todo = ReturnType<Shooting["each"]>;

/** The shots grouped by world, in order: those of one world share its load; an `alone` shot is a world of its own. */
function byWorld(todo: Todo): Todo[] {
  const worlds = new Map<string, Todo>();
  for (const item of todo) {
    const id = item.shot.alone ? item.key : JSON.stringify(worldOf(item.shot));
    worlds.set(id, [...(worlds.get(id) ?? []), item]);
  }
  return [...worlds.values()];
}

/** One world's shots on the service: loaded once and its shots taken at once, or alone, loaded on each try. */
async function shootWorld(s: Shooting, server: ServiceServer, items: Todo): Promise<void> {
  const { url, cookie, demo } = server;
  const take = (theme: Theme, shot: Shot, key: Key, now: number) =>
    shootOne(s.browser, { url, cookie, demo, now }, theme, shot, s.fileOf(key));
  const [first] = items;
  if (!first) return;
  if (first.shot.alone) {
    const { theme, shot, key } = first;
    await s.slot(() => s.one(key, async () => take(theme, shot, key, await enter(demo, shot))));
    return;
  }
  let now: number;
  try {
    now = await enter(demo, first.shot);
  } catch (error) {
    for (const { key } of items) await s.one(key, () => Promise.reject(error));
    return;
  }
  await Promise.all(
    items.map(({ theme, shot, key }) => s.slot(() => s.one(key, () => take(theme, shot, key, now)))),
  );
}

/** Whether the service loads any of the shots' scenarios: one that loads, and the others are tried no further. */
async function loadsAny(demo: DemoDoor, todo: Todo): Promise<boolean> {
  for (const scenario of new Set(todo.map(({ shot }) => shot.scenario))) {
    // This one it can't load: the next may.
    const loaded = await demo.load(scenario).then(
      () => true,
      () => false,
    );
    if (loaded) return true;
  }
  return false;
}

/** The shots of one side, on one service, world after world. */
async function shootService(s: Shooting): Promise<void> {
  const todo = s.each(shots);
  if (todo.length === 0) return;
  let server: ServiceServer;
  try {
    server = await serveService(s.side.worktree);
  } catch (error) {
    for (const { key } of todo) await s.one(key, () => Promise.reject(error));
    return;
  }
  try {
    if (s.side.base && !(await loadsAny(server.demo, todo))) {
      console.log("base: the base can't load scenarios: every shot is new");
      s.skip(todo.map(({ key }) => key));
      return;
    }
    for (const items of byWorld(todo)) await shootWorld(s, server, items);
  } finally {
    await server.stop();
  }
}

/** Shoots the wanted shots of one tree into `outDir`/<theme>. Returns the failed ones. */
async function shootSide(browser: Browser, side: Side, slot: ReturnType<typeof limiter>): Promise<Key[]> {
  const failed: Key[] = [];
  for (const theme of THEMES) mkdirSync(join(side.outDir, theme), { recursive: true });
  const shooting: Shooting = {
    browser,
    side,
    slot,
    one: async (key, work) => {
      // A second try: on a machine busy with other worktrees, a step can miss its timeout once.
      try {
        await work().catch(() => work());
        console.log(`ok   ${side.prefix}${key}`);
      } catch (error) {
        failed.push(key);
        console.log(`FAIL ${side.prefix}${key}: ${String(error).split("\n")[0]}`);
      }
    },
    skip: (keys) => {
      failed.push(...keys);
    },
    fileOf: (key) => join(side.outDir, `${key}.png`),
    each: (list) =>
      THEMES.flatMap((theme) => list.map((shot) => ({ theme, shot, key: keyOf(theme, shot) }))).filter(
        ({ key }) => side.wanted(key),
      ),
  };
  await shootService(shooting);
  return failed;
}

// ---- The base, from the cache or a worktree ----------------------------------------------------------------

const WEEK = 7 * 24 * 3_600_000;

/** Removes the kept shots of bases no diff used for a week (about 11 MB each), and marks `using` as used now. */
function forgetOld(caches: string, using: string): void {
  mkdirSync(using, { recursive: true });
  const now = new Date();
  utimesSync(using, now, now);
  for (const entry of readdirSync(caches)) {
    const dir = join(caches, entry);
    if (statSync(dir).mtimeMs < now.getTime() - WEEK) rmSync(dir, { recursive: true, force: true });
  }
}

async function git(...args: string[]) {
  return run("git", args, root);
}

/**
 * Shoots `ref` into `outDir`: the shots kept from an earlier run against the same commit are copied from the
 * cache, the others are shot from a fresh detached worktree, its dependencies installed, then removed.
 */
async function shootBase(
  browser: Browser,
  ref: string,
  outDir: string,
  keys: Key[],
  slot: ReturnType<typeof limiter>,
): Promise<Key[]> {
  const sha = Bun.spawnSync(["git", "rev-parse", "--verify", `${ref}^{commit}`], { cwd: root })
    .stdout.toString()
    .trim();
  if (!sha) throw new Error(`${ref} is not a commit`);
  // The shots depend on the base's tree, on what proof does and on the browser.
  const harness = createHash("sha1")
    .update(readFileSync(join(import.meta.dir, "proof.ts")))
    .update(readFileSync(join(import.meta.dir, "proof-shots.ts")))
    .update(browser.version())
    .digest("hex")
    .slice(0, 12);
  const caches = join(temp, "lookover-proof-cache");
  const cache = join(caches, `${sha.slice(0, 12)}-${harness}`);
  const kept = (key: Key) => join(cache, `${key}.png`);
  forgetOld(caches, cache);
  for (const theme of THEMES) mkdirSync(join(outDir, theme), { recursive: true });
  const missing = keys.filter((key) => !existsSync(kept(key)));
  for (const key of keys) if (!missing.includes(key)) copyFileSync(kept(key), join(outDir, `${key}.png`));
  console.log(
    `base ${ref}: ${keys.length - missing.length} shots from the cache, ${missing.length} to shoot`,
  );
  if (missing.length === 0) return [];

  const worktree = join(temp, `lookover-proof-${instanceOf(root)}`);
  const remove = async () => {
    await git("worktree", "remove", "--force", worktree);
    await removeDir(worktree);
    await git("worktree", "prune");
  };
  if (existsSync(worktree)) await remove();
  const added = await git("worktree", "add", "--detach", worktree, sha);
  if (added.status !== 0) throw new Error(`git worktree add ${ref} failed: ${added.stderr}`);
  try {
    // Only from Bun's cache, never the network (AGENTS.md rule 1). No lifecycle scripts: `prepare` would set up
    // git hooks for a worktree that lives for one run.
    const install = await run(
      process.execPath,
      ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
      worktree,
    );
    if (install.status !== 0)
      throw new Error(
        `${ref} needs packages that aren't in Bun's cache, and proof never downloads. Run \`bun install\` on ${ref} once, then try again.\n${install.stderr}`,
      );
    const wanted = new Set(missing);
    const failed = await shootSide(
      browser,
      { worktree, outDir, prefix: "base ", base: true, wanted: (k) => wanted.has(k) },
      slot,
    );
    // Kept for the next diff against this commit: a file is whole or absent.
    for (const key of missing.filter((k) => !failed.includes(k))) {
      mkdirSync(dirname(kept(key)), { recursive: true });
      const part = `${kept(key)}.${process.pid}.part`;
      copyFileSync(join(outDir, `${key}.png`), part);
      renameSync(part, kept(key));
    }
    return failed;
  } finally {
    await remove();
  }
}

// ---- Main --------------------------------------------------------------------------------------------------

/** `[words] [--diff <ref> | --diff=<ref>] [--jobs=<n>]`. Any other `--` option is a mistake, not a word. */
function parseArgs(args: string[]): { words: string[]; baseRef: string | undefined; jobs: number } {
  const words: string[] = [];
  let baseRef: string | undefined;
  let jobs = 4;
  const usage = () => {
    console.error("Usage: bun run proof [words] [--diff <base-ref>] [--jobs=<n>]");
    process.exit(2);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--diff") baseRef = args[++i] ?? "";
    else if (arg.startsWith("--diff=")) baseRef = arg.slice("--diff=".length);
    else if (arg.startsWith("--jobs=")) jobs = Number(arg.slice("--jobs=".length));
    else if (arg.startsWith("-")) usage();
    else words.push(arg);
    if (baseRef === "" || !(jobs >= 1)) usage();
  }
  return { words, baseRef, jobs: Math.floor(jobs) };
}

const { words, baseRef, jobs } = parseArgs(process.argv.slice(2));
const shots: Shot[] = SHOTS.filter((shot) => words.length === 0 || words.some((w) => shot.name.includes(w)));
// The index labels each shot by its scenario.
const everyShot = THEMES.flatMap((theme) => shots.map((shot) => ({ theme, shot, key: keyOf(theme, shot) })));

const began = Date.now();
// The system Edge: no browser download needed on Windows. Elsewhere, Playwright's own Chromium.
const browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge" } : {});
// No shot left over from an earlier run.
rmSync(out, { recursive: true, force: true });
const slot = limiter(jobs);
// Both trees at once: the base's worktree is made and installed while the current tree is shot.
const [baseFailed, failed] = await Promise.all([
  baseRef
    ? shootBase(
        browser,
        baseRef,
        join(out, "base"),
        everyShot.map((s) => s.key),
        slot,
      )
    : Promise.resolve<Key[]>([]),
  shootSide(browser, { worktree: root, outDir: out, prefix: "", wanted: () => true }, slot),
]);
await browser.close();

const cell = (dir: string, s: (typeof everyShot)[number], tag = "") =>
  `<figure><img loading="lazy" src="${dir}${s.key}.png" alt=""><figcaption>${s.shot.name} · ${s.theme} · ${s.shot.scenario}${tag}</figcaption></figure>`;
const html = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:14px system-ui;background:#111;color:#ddd;margin:24px}main{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{width:100%;border:1px solid #333}figure{margin:0}figcaption{padding:4px 0 12px;color:#999}</style><h1>${title}</h1><main>${body}</main>`;

if (baseRef) {
  const bytes = (key: string, dir: string) => readFileSync(join(dir, `${key}.png`));
  const onBoth = everyShot.filter(({ key }) => !failed.includes(key) && !baseFailed.includes(key));
  const changed = onBoth.filter(({ key }) => !bytes(key, join(out, "base")).equals(bytes(key, out)));
  // Shots the base couldn't take (a new screen, or one it can't reach yet) but the current tree did.
  const added = everyShot.filter(({ key }) => baseFailed.includes(key) && !failed.includes(key));
  const title = `Lookover proof: ${changed.length} changed, ${added.length} new since ${baseRef}`;
  const body = [
    ...changed.map((s) => cell("base/", s, " · base") + cell("", s)),
    ...added.map((s) => `${cell("", s, " · new")}<div></div>`),
  ];
  writeFileSync(join(out, "index.html"), html(title, body.join("")));
  console.log(`\n${changed.length} of ${everyShot.length} shots differ from ${baseRef}, ${added.length} new`);
  for (const { key } of changed) console.log(`  changed ${key}`);
  for (const { key } of added) console.log(`  new     ${key}`);
  if (body.length > 0) console.log(`Base beside current: ${join(out, "index.html")}`);
} else {
  const body = shots.map((shot) =>
    THEMES.map((theme) => cell("", { theme, shot, key: keyOf(theme, shot) })).join(""),
  );
  writeFileSync(join(out, "index.html"), html("Lookover proof", body.join("")));
}
const seconds = Math.round((Date.now() - began) / 1000);
console.log(
  `\n${everyShot.length - failed.length} screenshots in ${out} (${seconds} s)${failed.length ? `, ${failed.length} failed` : ""}`,
);
process.exit(failed.length ? 1 : 0);
