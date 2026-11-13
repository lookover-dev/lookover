#!/usr/bin/env bun
// Visual proof: screenshots of every main screen, in both themes. `bun run proof` writes
// .proof/<theme>/<name>.png and .proof/index.html. Attach them to UI pull requests.
// The app on the service in demo mode (ADR 0046), as `bun dev` runs it: the scripted GitHub and engines, no
// network, on a data folder of its own in the temp folder, its clock standing still at one instant (`--frozen`).
// The UI talks to it through its own Vite server. The shots are listed in scripts/proof-shots.ts: each names a
// scenario, how far its clock moves on and the faults made to happen; proof loads it (`demo.load`), moves it
// (`demo.advance`, `demo.inject`), then opens the page with the session, acts and shoots; the act of a shot sharing
// its world's load can't move the demo (`demoFor`, ADR 0093), it fails saying so. A shot that lands on
// any screen but its own (the session screen, the setup) fails, and so does one whose page logs a console error or
// throws an uncaught error (React's development warnings included, ADR 0085), but for the errors a shot is made to
// log (`Shot.console`: a refusal its fault causes, a tab without the session), which it must then log. Before the
// shots, proof proves both listeners bite on a page of its own, served under the service's CSP (`CSP`, never a
// copy): a `data:` font the policy blocks must log a console error, a throw in a timer a page error; if either is
// missed, proof fails. A diff's base is shot as a picture to compare with: its console is not judged.
// After the shots, the layout pass (ADR 0086, scripts/proof-layout.ts) lays the main screens out at 1024 and 1440 px
// (390 px where a screen has a phone layout) and fails any cell a hidden copy makes taller than what it shows, and any
// row or card ending on empty room. Its self-test first: pages of its own under the app's CSS must fail today's cases
// and pass a correct page, or proof fails and no screen is judged. A failure a later ticket fixes is allowed, named
// with its ticket; a whole run (no words) that judged every screen fails on an allowance nothing needed any more.
// Motion (ADR 0087, scripts/proof-motion.ts): shots run with motion on (`reducedMotion: "no-preference"`), only the
// loops kept still from before the first paint (the eyes, the pulse, the shimmer, a setting's highlight: a loop
// stopped after it ran left Chrome painting a stale frame). Before each act, screenshot and layout measure the page is
// settled: finite animations finished, then nothing left leaving (`[data-leaving]`), no scroll moving, two animation
// frames on; a page that doesn't settle in 5 s fails its shot. A frames shot (`Shot.frames`) stands the page's
// timeline still before its act, pauses the motion the act started, seeks it with `currentTime` to fixed times from 0
// to its end, measuring its subject at each, then seeks it again, finishes it and settles the page, shooting each in
// the box of the whole motion (the measures' union, ADR 0089), and lays the frames side by side into one strip per
// theme, .proof/frames/<name>-<theme>.png, shot by the browser from a page of the frames (site:strip's way): listed in
// the index, never compared by `--diff`, never shot on a diff's base. Then the reduced-motion pass replays every frames
// shot's act under `reducedMotion: "reduce"` and fails on any `animationstart`, `transitionrun`, script animation
// started (`animate`, `play`) or running animation; its self-test first, under the service's CSP and through the same
// lifecycle (settled, acted on, looked at after the same wait): a page that moves must be seen moving, its 180 ms
// script animations over by then included, one that keeps its motion for those who don't ask for less must be seen
// still, or proof fails and no act is judged.
// `bun run proof home review` takes only the shots whose name contains one of the words. `--jobs=<n>` shoots n at
// once (4 by default).
// `bun run proof --diff <base-ref>` also shoots <base-ref> (into .proof/base) and lists only the shots whose
// bytes differ; .proof/index.html then shows those, base beside current. Base shots are kept in the temp folder
// (lookover-proof-cache, a week after their last use) per base commit and version of proof's files and the
// browser, so a second diff against the same base shoots only the current tree; otherwise the base is shot from a
// temporary worktree, at the same time as the current tree.
// Shots are deterministic: the service's clock stands still, the page's `Date` with it, the time zone fixed,
// the fonts in before an act, every motion settled before a shot, the loops still. Just before a shot (ADR 0096) the
// demo's listing reads are answered, a full page gets a window as tall as it, an open modal plays its entry again, and
// Chrome lays the page's layers out afresh (`LayerTree.enable`). Each worktree takes its own
// ports (scripts/port.ts), so two can run proof at once. Proof never calls `claude`, `codex` or the network.
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
import { CSP } from "@lookover/service";
import { type Browser, type BrowserContextOptions, chromium, type Page, type Request } from "playwright";
import { instanceOf, portFor } from "./port.ts";
import {
  allowedOn,
  type BitePage,
  type Failure,
  failureLine,
  judgeScript,
  LAYOUT_BITES,
  MEASURED,
  NARROW_PHONE,
  PHONE,
  sameWidthMisses,
  unneeded,
  widthsOf,
} from "./proof-layout.ts";
import {
  BITE_MOTION,
  type Box,
  biteAct,
  type Frame,
  finishMotion,
  frameTimes,
  MOTION_BITE_PAGE,
  MOTION_BITES,
  type MotionBite,
  motionClip,
  motionSeen,
  motionStarted,
  pauseMotion,
  regionOf,
  STILL,
  seekMotion,
  settle,
  stripPage,
  unpausedMotion,
  watchMotion,
} from "./proof-motion.ts";
import { demoFor, SHOTS, type Shot, screenOf } from "./proof-shots.ts";

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
// How long a page may take to settle (scripts/proof-motion.ts): a leaving thing that outlives it is a fault.
const SETTLE_MS = 5_000;

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

// ---- The console -------------------------------------------------------------------------------------------

/**
 * What a page said wrong from now on: each console message of type error, with the address it came from (` at <url>`:
 * Chromium's "Failed to load resource" line names no URL), and each uncaught error it threw.
 */
function watchConsole(page: Page): () => string[] {
  const said: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    said.push(`console error: ${message.text()}${url ? ` at ${url}` : ""}`);
  });
  page.on("pageerror", (error) => said.push(`page error: ${error.message}`));
  return () => [...said];
}

/** Waits up to 3 s for what the page said to hold a line `wanted` matches. */
async function heard(said: () => string[], wanted: RegExp): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (said().some((line) => wanted.test(line))) return true;
    await Bun.sleep(50);
  }
  return false;
}

// The bite page: served by `page.route` on an origin of its own, under the service's CSP. Its stylesheet is a file,
// so only its face breaks the policy; every other path answers empty, so no missing file logs an error of its own.
const BITE = "http://bite.localhost";
const BITE_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Bite</title><link rel="stylesheet" href="/bite.css"></head><body><p>Lookover</p></body></html>';
const BITE_FACE =
  '@font-face { font-family: "Bite"; src: url(data:font/woff2;base64,d09GMgABAAAAAAZ0) format("woff2"); } p { font-family: "Bite"; }';

/**
 * Proves the shots' listeners bite (ADR 0085): a `data:` font the service's CSP blocks must log a console error, and
 * a throw in a timer must be a page error. The lines missed, or none.
 */
async function consoleBites(browser: Browser): Promise<string[]> {
  const context = await browser.newContext();
  try {
    await context.route(`${BITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      const [type, body] =
        path === "/"
          ? ["text/html", BITE_PAGE]
          : path === "/bite.css"
            ? ["text/css", BITE_FACE]
            : ["text/plain", ""];
      return route.fulfill({
        status: body ? 200 : 204,
        contentType: type,
        headers: { "content-security-policy": CSP },
        body,
      });
    });
    const page = await context.newPage();
    const said = watchConsole(page);
    await page.goto(`${BITE}/`);
    await page.evaluate(() => document.fonts.load('16px "Bite"', "Lookover").catch(() => []));
    const missed: string[] = [];
    if (!(await heard(said, /^console error: .*font-src/)))
      missed.push("a data: font the CSP blocks logged no console error");
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("proof's bite");
      });
    });
    if (!(await heard(said, /^page error: proof's bite$/)))
      missed.push("a throw in a timer was no page error");
    return missed;
  } finally {
    await context.close();
  }
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
  /** Whether the page's console is judged: what it said wrong fails the shot. */
  judged: boolean;
}

/** A shot's window: a phone's, or a desktop's at its width (1180 px unless it names one). */
const viewportOf = (shot: Shot) =>
  shot.phone
    ? { width: shot.phone === "narrow" ? NARROW_PHONE : PHONE, height: 780 }
    : { width: shot.width ?? 1180, height: 820 };

/** How a visit treats motion: on, as the app ships (its loops still), or as one who asks for reduced motion. */
interface Motion {
  /** Under `prefers-reduced-motion: reduce`, nothing stilled, every animation and transition that starts recorded. */
  reduced?: boolean;
  /** Runs once the page has settled, just before the shot's act (a frames shot stands its timeline still). */
  beforeAct?: (page: Page) => Promise<void>;
}

/** A shot's browser context in `theme`: its window, its session, its loops still or its motion watched. */
async function contextFor(browser: Browser, visit: Visit, theme: Theme, shot: Shot, reduced: boolean) {
  const context = await browser.newContext({
    viewport: viewportOf(shot),
    reducedMotion: reduced ? "reduce" : "no-preference",
    timezoneId: ZONE,
    locale: "en-GB",
    ...(shot.noSession ? {} : { storageState: { cookies: [visit.cookie], origins: [] } }),
  });
  await context.addInitScript(
    ([t, drawer, still]) => {
      localStorage.setItem("lookover.theme", t);
      localStorage.setItem("lookover.drawer", drawer);
      // The loops stopped before the first paint: a loop that ran and was stopped later can leave Chrome painting a
      // stale frame (the eyes' pupils, cut out by an SVG mask, stayed where the animation left them). An adopted
      // sheet, not a `<style>`: a page served under the service's CSP (GitHub's fake pages) refuses inline styles,
      // and says so in the console.
      if (still === "") return;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(still);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    },
    // Under reduced motion nothing is stilled: the app's own rule must keep every loop still.
    [theme, shot.drawer ? "open" : "closed", reduced ? "" : STILL] as const,
  );
  if (reduced) await context.addInitScript(watchMotion);
  // The page's `Date` stands where the service's clock stands.
  await context.clock.setFixedTime(visit.now);
  return context;
}

/** Settles the page (scripts/proof-motion.ts): finite motion finished, nothing left leaving. Throws if it can't. */
async function atRest(page: Page): Promise<void> {
  const left = await page.evaluate(settle, SETTLE_MS);
  if (left !== null) throw new Error(`The page didn't settle within ${SETTLE_MS} ms: ${left}`);
}

/** Counts the page's `method` requests to `path` not answered yet; `drained` waits for none (5 s, then throws `why`). */
function inFlight(page: Page, method: string, path: string) {
  let open = 0;
  const ours = (request: Request) => request.method() === method && new URL(request.url()).pathname === path;
  page.on("request", (request) => {
    if (ours(request)) open += 1;
  });
  const answered = (request: Request) => {
    if (ours(request)) open -= 1;
  };
  page.on("requestfinished", answered);
  page.on("requestfailed", answered);
  return {
    async drained(why: string) {
      for (let i = 0; open > 0; i++) {
        if (i >= 100) throw new Error(why);
        await Bun.sleep(50);
      }
    },
  };
}

/**
 * Opens the shot's page in `theme`, settles it, acts on it, checks it is still on its screen, then runs `look` on it;
 * then judges what its console said (when the visit is judged).
 */
async function visitShot(
  browser: Browser,
  visit: Visit,
  theme: Theme,
  shot: Shot,
  look: (page: Page) => Promise<void>,
  motion: Motion = {},
) {
  const context = await contextFor(browser, visit, theme, shot, motion.reduced === true);
  // A shot takes a few seconds; a step that waits longer waits for something that won't come (a screen the
  // base doesn't have), and its second try would double Playwright's 30 s.
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  const said = watchConsole(page);
  // The commands the page sent and the service has not answered yet: an act moves the clock only once they are.
  const commands = inFlight(page, "POST", API.commands);
  // The demo's listing reads not answered yet: the drawer's tab ("Demo · S2") is drawn only once one is in, and under
  // load it came after the shot on some runs (ADR 0096).
  const listings = inFlight(page, "GET", DEMO_API.listing);
  /** Once every command the page sent has been answered. */
  const settled = () => commands.drained("A command the page sent was not answered within 5 s");
  // A shared world's act can't move it (ADR 0093): its shots' pages run at once on the one load.
  const demo = demoFor(shot, visit.demo, settled);
  const screen = screenOf(shot);
  try {
    await page.goto(`${visit.url}${shot.path ?? "/"}`);
    await page.waitForSelector(screen);
    // The page as it lands, its fonts in and its entries played out: an act starts from rest. An act that scrolls to
    // a row while a font still loads lands a few pixels off once it comes in, on some runs and not others (ADR 0093).
    // Laid out first: a font is asked for only once a layout uses it.
    await page.evaluate(async () => {
      document.body.getBoundingClientRect();
      await document.fonts.ready;
    });
    await atRest(page);
    await motion.beforeAct?.(page);
    await shot.act?.(page, demo);
    // Still on its own screen once acted: never the session screen, or the setup, in place of the app.
    await page.waitForSelector(screen);
    if (!shot.noSession && (await page.locator(".session").count()) > 0)
      throw new Error("The session screen showed: the service no longer knew the tab");
    await page.evaluate(() => document.fonts.ready);
    await listings.drained("The demo's listing was not read within 5 s");
    await look(page);
    // What the shot's page logged that it isn't made to, and what it is made to log but didn't.
    const lines = said();
    const meant = shot.console ?? [];
    const wrong = [
      ...lines.filter((line) => !meant.some((pattern) => pattern.test(line))),
      ...meant
        .filter((pattern) => !lines.some((line) => pattern.test(line)))
        .map((p) => `nothing matched ${p}`),
    ];
    if (visit.judged && wrong.length > 0) throw new Error(`The page said: ${wrong.join(" | ")}`);
  } finally {
    await context.close();
  }
}

function shootOne(browser: Browser, visit: Visit, theme: Theme, shot: Shot, file: string) {
  return visitShot(browser, visit, theme, shot, async (page) => {
    // A sticky top bar, or setup's sticky footer, would be drawn in the middle of a full-page shot.
    if (shot.fullPage) await adopt(page, ".app > .top, .setup-acts-footer { position: static !important; }");
    await page.waitForTimeout(350);
    // Shot with its motion on, as it ships: settled first, so it lands where a person sees it come to rest.
    await atRest(page);
    // A full page in a window as tall as the page, settled again: Chrome's own capture beyond the window lays the page
    // out taller in the frame it shoots, and a sticky head drawn there landed a fraction of a pixel apart, run to run.
    if (shot.fullPage) await growToPage(page);
    await replayModals(page);
    await fullCompositingUpdate(page);
    await page.screenshot({ path: file, fullPage: shot.fullPage ?? false, animations: "allow" });
  });
}

/** Makes the window as tall as the page, then settles it; again while the page grows with the window. */
async function growToPage(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const size = page.viewportSize();
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (!size || height <= size.height) return;
    if (i === 3)
      throw new Error(`The page still grew with the window: ${height} px in a ${size.height} px window`);
    await page.setViewportSize({ width: size.width, height });
    await atRest(page);
  }
}

/**
 * Every element's style computed again (an unused property set on the root for a frame), and an open modal and its
 * backdrop playing their entry again, as on any opening. An element whose animation ended in a frame that recomputed
 * nothing kept the mark of a running opacity animation, so Chrome drew it through a surface of its own on some runs:
 * the palette opened again during its own fade had its shadow, or the blurred page behind its backdrop, a level apart,
 * and restyling them was not enough. A sheet of proof's own takes their animations off for a frame (the backdrop
 * hidden; the dialog shown, so focus stays where it is), then the page settles. Their transitions stay off until the
 * page closes after its shot: given back while the entry ran, they left the dialogs a level apart again.
 */
async function replayModals(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    const root = document.documentElement;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      ":modal, :modal::backdrop { transition: none !important; animation: none !important } :modal::backdrop { display: none !important }",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    root.style.setProperty("--proof-restyle", "1");
    getComputedStyle(root).getPropertyValue("--proof-restyle");
    await frame();
    sheet.replaceSync(":modal, :modal::backdrop { transition: none !important }");
    root.style.removeProperty("--proof-restyle");
  });
  await atRest(page);
}

/**
 * Has Chrome lay the page's layers out afresh from where everything rests, then draw a frame. Between two layouts
 * Chrome updates only the layers repainted, each placed where the last full update put it: a layer that moved by a
 * fraction of a pixel since (a dialog that scaled in, a sticky head whose row moved) was drawn at its old fraction on
 * some runs and not others, its text and edges a pixel apart. DevTools' layer tree asks for that full update when it
 * is turned on (`LayerTree.enable`); nothing on the page changes.
 */
async function fullCompositingUpdate(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("LayerTree.enable");
    await nextFrame(page);
  } finally {
    await cdp.detach();
  }
}

/** Waits for the page's next frame to be drawn: what a seek changed is painted. */
const nextFrame = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))),
  );

/**
 * The page's timeline stood still, through DevTools' animation rate: a motion the act starts can't run ahead of proof,
 * however slow the act's round trip. Gives back a function that lets it run again.
 */
async function standStill(page: Page): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  return async () => {
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    await cdp.detach();
  };
}

/**
 * The box of the whole motion (ADR 0089): what `around` names, measured at each of `times`, its union with a margin,
 * within the window; null for the whole window. Throws when nothing is `around` at any of them.
 */
async function motionBox(page: Page, around: string | undefined, times: readonly number[]) {
  if (!around) return null;
  const boxes: (Box | null)[] = [];
  let window = { width: 0, height: 0 };
  for (const ms of times) {
    await page.evaluate(seekMotion, ms);
    const measured = await page.evaluate(regionOf, around);
    boxes.push(measured.box);
    window = measured.window;
  }
  const clip = motionClip(boxes, 24, window);
  if (clip === null) throw new Error(`Nothing on the page is ${around}`);
  return clip;
}

/**
 * The motion the act started, measured at each of `frameTimes` then shot at each in the box of the whole motion
 * `around` names, then finished, the timeline let go (`letGo`) and the page settled, shot last in the same box.
 */
async function framesOf(page: Page, shot: Shot, letGo: () => Promise<void>): Promise<Frame[]> {
  if (!(await page.evaluate(motionStarted, 2_000))) throw new Error("Its act started no motion");
  const end = await page.evaluate(pauseMotion);
  const times = frameTimes(end);
  const clip = await motionBox(page, shot.frames?.around, times);
  const frames: Frame[] = [];
  const take = async (label: string) => {
    await nextFrame(page);
    const png = await page.screenshot({ animations: "allow", ...(clip ? { clip } : {}) });
    frames.push({ label, png: png.toString("base64") });
  };
  for (const ms of times) {
    await page.evaluate(seekMotion, ms);
    await take(`${ms} ms`);
  }
  // What started after the pause stood at its first frame through every one: the strip would lie.
  const frozen = await page.evaluate(unpausedMotion);
  if (frozen.length > 0)
    throw new Error(`Motion started after its frames' pause, shown frozen: ${frozen.join(", ")}`);
  await page.evaluate(finishMotion);
  await letGo();
  await atRest(page);
  await take("settled");
  return frames;
}

/**
 * A frames shot (scripts/proof-motion.ts): its page settled, its timeline stood still, its act run; the motion paused,
 * measured at each of `frameTimes`, then sought to each again and shot in the box of the whole motion, then finished,
 * the timeline let go and the page settled, shot last in the same box; the frames laid side by side into `file`.
 */
async function shootFrames(browser: Browser, visit: Visit, theme: Theme, shot: Shot, file: string) {
  let frames: Frame[] = [];
  let letGo: () => Promise<void> = async () => {};
  const look = async (page: Page) => {
    frames = await framesOf(page, shot, letGo);
  };
  const beforeAct = async (page: Page) => {
    letGo = await standStill(page);
  };
  await visitShot(browser, visit, theme, shot, look, { beforeAct });
  await stripOf(browser, shot.name, theme, frames, file);
}

/** Lays `frames` side by side on a page of their own, shot by the browser into `file` (site:strip's way). */
async function stripOf(browser: Browser, name: string, theme: Theme, frames: Frame[], file: string) {
  const context = await browser.newContext({ viewport: { width: 800, height: 100 } });
  try {
    const page = await context.newPage();
    await page.setContent(stripPage(name, theme, frames), { waitUntil: "load" });
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
  } finally {
    await context.close();
  }
}

// ---- The reduced-motion pass (ADR 0087) -------------------------------------------------------------------------

/** The motion bite's origin: its own, served under the service's CSP. */
const MOTION_BITE = "http://motion.localhost";

/** The reduced-motion pass's look once acted, the bite's and each act's: a frame drawn, 300 ms on, what moved. */
async function reducedLook(page: Page): Promise<string[]> {
  await nextFrame(page);
  await page.waitForTimeout(300);
  return page.evaluate(motionSeen);
}

/** What `watchMotion` saw on one bite page, settled then acted on: what the pass missed on it, or nothing. */
async function motionBiteMissed(browser: Browser, bite: MotionBite): Promise<string[]> {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  try {
    await context.addInitScript(watchMotion);
    await context.route(`${MOTION_BITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      const [type, body] =
        path === "/"
          ? ["text/html", MOTION_BITE_PAGE]
          : path === "/motion.css"
            ? ["text/css", bite.css]
            : path === "/motion.js"
              ? ["text/javascript", bite.js]
              : ["", ""];
      return route.fulfill({
        status: body ? 200 : 204,
        contentType: type || "text/plain",
        headers: { "content-security-policy": CSP },
        body,
      });
    });
    const page = await context.newPage();
    // The service pass's lifecycle (visitShot): settled as it lands, acted on, looked at after the same wait.
    await page.goto(`${MOTION_BITE}/`);
    await atRest(page);
    await page.evaluate(biteAct);
    const seen = await reducedLook(page);
    if (!bite.moves) return seen.length > 0 ? [`${bite.name}: seen moving (${seen.join(", ")})`] : [];
    const missed = BITE_MOTION.filter((m) => !seen.includes(m));
    return missed.length > 0 ? [`${bite.name}: not seen (${missed.join(", ")})`] : [];
  } finally {
    await context.close();
  }
}

/** What the reduced-motion pass found wrong on this run: its self-test, a frames shot's act. */
const motionWrong: string[] = [];

/**
 * The reduced-motion pass on the service: its self-test first, then each frames shot's act replayed under reduced
 * motion, in the dark theme: any animation or transition that starts, or still runs, fails it.
 */
async function reducedService(s: Shooting, server: ServiceServer): Promise<void> {
  const framed = shots.filter((shot) => shot.frames !== undefined);
  if (framed.length === 0) return;
  const missed = (await Promise.all(MOTION_BITES.map((bite) => motionBiteMissed(s.browser, bite)))).flat();
  if (missed.length > 0) {
    for (const line of missed) console.log(`FAIL the reduced-motion bite: ${line}`);
    motionWrong.push(...missed);
    return;
  }
  console.log(
    "ok   the reduced-motion bite: a page that moves was seen moving, one kept still was seen still",
  );
  const { url, cookie, demo } = server;
  for (const shot of framed) {
    const label = `reduced motion ${shot.name}`;
    let seen: string[] = [];
    const look = async (page: Page) => {
      seen = await reducedLook(page);
    };
    try {
      const attempt = async () => {
        const now = await enter(demo, shot);
        await visitShot(s.browser, { url, cookie, demo, now, judged: true }, "dark", shot, look, {
          reduced: true,
        });
      };
      await s.slot(() => attempt().catch(() => attempt()));
    } catch (error) {
      seen = [`could not replay its act: ${String(error).split("\n")[0]}`];
    }
    const line = seen.length > 0 ? `${label}: ${seen.join(", ")}` : null;
    if (line) motionWrong.push(line);
    console.log(line ? `FAIL ${line}` : `ok   ${label}: nothing moved`);
  }
}

/** Adds `rules` to the page's CSS: an adopted sheet, which a page under the service's CSP accepts. */
function adopt(page: Page, rules: string): Promise<void> {
  return page.evaluate((rules) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(rules);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, rules);
}

// ---- The layout pass (scripts/proof-layout.ts) ----------------------------------------------------------------

/** The shot laid out at `width` in the dark theme and judged: what failed, allowed or not. */
async function measureOne(browser: Browser, visit: Visit, shot: Shot, width: number): Promise<Failure[]> {
  let failures: Failure[] = [];
  const window: Shot = { ...shot, phone: width === PHONE, width };
  await visitShot(browser, visit, "dark", window, async (page) => {
    await page.waitForTimeout(350);
    await atRest(page);
    failures = await page.evaluate<Failure[]>(judgeScript("body", allowedOn(shot.name)));
  });
  return failures;
}

/** One page of the layout's self-test laid out in `page`: what the pass missed on it, or nothing. */
async function biteMissed(page: Page, bite: BitePage): Promise<string[]> {
  await page.evaluate(
    ({ html, css }) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [sheet];
      const body = document.createElement("body");
      body.innerHTML = html;
      document.body.replaceWith(body);
    },
    { html: bite.html, css: bite.css },
  );
  await page.evaluate(() => document.fonts.ready);
  const found = await page.evaluate<Failure[]>(judgeScript("body", []));
  const lines = found.map((f) => failureLine(bite.name, 1024, f)).join("; ");
  if (bite.fails !== null)
    return found.some((f) => f.measure === bite.fails)
      ? []
      : [`${bite.name} passed its ${bite.fails} measure${lines ? ` (found only: ${lines})` : ""}`];
  // The correct page passes, and its `SameWidth` places, under the app's own CSS, hold width, never height.
  const sameWidth = (await page.evaluate(sameWidthMisses)).map((miss) => `${bite.name}'s SameWidth: ${miss}`);
  return [...(found.length > 0 ? [`${bite.name} failed: ${lines}`] : []), ...sameWidth];
}

/**
 * Proves the layout pass bites (ADR 0086) on pages of its own under the app's CSS, the app's session screen emptied:
 * each bad page must fail its measure, the correct page must pass, its `SameWidth` places as wide as their widest
 * label and as tall as the label they show. What it missed, or nothing.
 */
async function layoutBites(browser: Browser, url: string): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 820 } });
  try {
    await context.addInitScript(() => localStorage.setItem("lookover.theme", "dark"));
    const page = await context.newPage();
    await page.goto(`${url}/`);
    await page.waitForSelector(".session");
    await page.evaluate(() => document.fonts.ready);
    const missed: string[] = [];
    for (const bite of LAYOUT_BITES) missed.push(...(await biteMissed(page, bite)));
    return missed;
  } finally {
    await context.close();
  }
}

/**
 * What the layout pass found wrong on this run (the self-test, a screen), the allowances it used, and whether it
 * judged every screen it measured: the bite bit, every world entered, every screen measured.
 */
const layoutWrong: string[] = [];
const allowancesUsed = new Set<number>();
let layoutJudgedAll = false;

/**
 * The layout pass on one side's service: its self-test first, then each measured shot among those this run takes,
 * at each of its widths, one world after another (an `alone` shot loaded for each width).
 */
async function measureService(s: Shooting, server: ServiceServer): Promise<void> {
  const missed = await layoutBites(s.browser, server.url);
  if (missed.length > 0) {
    for (const line of missed) console.log(`FAIL the layout's bite: ${line}`);
    layoutWrong.push(...missed);
    return;
  }
  let judgedAll = true;
  console.log("ok   the layout's bite: every bad page failed its measure, the correct page passed");
  const named = new Map(shots.map((shot) => [shot.name, shot]));
  const todo = MEASURED.flatMap((m) => {
    const shot = named.get(m.shot);
    return shot === undefined ? [] : widthsOf(m).map((width) => ({ shot, width }));
  });
  const worlds = new Map<string, typeof todo>();
  for (const item of todo) {
    const id = item.shot.alone ? `${item.shot.name}@${item.width}` : JSON.stringify(worldOf(item.shot));
    worlds.set(id, [...(worlds.get(id) ?? []), item]);
  }
  const { url, cookie, demo } = server;
  const one = async (shot: Shot, width: number, now: number | null) => {
    const label = `layout ${shot.name} at ${width} px`;
    try {
      // A second try, as a shot has: an `alone` shot's world loaded again for it.
      const attempt = async () => {
        const at = now ?? (await enter(demo, shot));
        return measureOne(s.browser, { url, cookie, demo, now: at, judged: true }, shot, width);
      };
      const found = await attempt().catch(() => attempt());
      const wrong = found.filter((f) => f.allowedBy === null);
      for (const f of found) if (f.allowedBy !== null) allowancesUsed.add(f.allowedBy);
      const allowed = found.length - wrong.length;
      if (wrong.length === 0) console.log(`ok   ${label}${allowed ? ` (${allowed} allowed)` : ""}`);
      for (const f of wrong) {
        const line = failureLine(shot.name, width, f);
        layoutWrong.push(line);
        console.log(`FAIL layout ${line}`);
      }
    } catch (error) {
      judgedAll = false;
      layoutWrong.push(`${label}: ${String(error).split("\n")[0]}`);
      console.log(`FAIL ${label}: ${String(error).split("\n")[0]}`);
    }
  };
  for (const items of worlds.values()) {
    const [first] = items;
    if (!first) continue;
    if (first.shot.alone) {
      await s.slot(() => one(first.shot, first.width, null));
      continue;
    }
    let now: number;
    try {
      now = await enter(demo, first.shot);
    } catch (error) {
      judgedAll = false;
      layoutWrong.push(`layout ${first.shot.name}: ${String(error).split("\n")[0]}`);
      console.log(`FAIL layout ${first.shot.name}: ${String(error).split("\n")[0]}`);
      continue;
    }
    await Promise.all(items.map(({ shot, width }) => s.slot(() => one(shot, width, now))));
  }
  layoutJudgedAll = judgedAll;
}

/** "<theme>/<name>": a shot in one theme, and its file under an output folder. */
type Key = `${Theme}/${string}`;
const keyOf = (theme: Theme, shot: Shot): Key => `${theme}/${shot.name}`;
/** Where a frames shot's strip goes: `.proof/frames/<name>-<theme>.png`, the current tree's only. */
const stripFile = (shot: Shot, theme: Theme) => join(out, "frames", `${shot.name}-${theme}.png`);

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
  const take = (theme: Theme, shot: Shot, key: Key, now: number) => {
    const visit = { url, cookie, demo, now, judged: !s.side.base };
    return shot.frames
      ? shootFrames(s.browser, visit, theme, shot, stripFile(shot, theme))
      : shootOne(s.browser, visit, theme, shot, s.fileOf(key));
  };
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
    // Reduced motion and the layout are judged on the tree being proved, never on a diff's base.
    if (!s.side.base) await reducedService(s, server);
    if (!s.side.base) await measureService(s, server);
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
  // The shots depend on the base's tree, on what proof does (its loops still, how it settles) and on the browser.
  const harness = createHash("sha1")
    .update(readFileSync(join(import.meta.dir, "proof.ts")))
    .update(readFileSync(join(import.meta.dir, "proof-shots.ts")))
    .update(readFileSync(join(import.meta.dir, "proof-motion.ts")))
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
// The index labels each shot by its scenario. A frames shot is a strip, never a still: listed apart, never compared.
const stills = shots.filter((shot) => shot.frames === undefined);
const everyShot = THEMES.flatMap((theme) => stills.map((shot) => ({ theme, shot, key: keyOf(theme, shot) })));
const everyStrip = THEMES.flatMap((theme) =>
  shots.filter((shot) => shot.frames !== undefined).map((shot) => ({ theme, shot, key: keyOf(theme, shot) })),
);

const began = Date.now();
// The system Edge: no browser download needed on Windows. Elsewhere, Playwright's own Chromium.
const browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge" } : {});
// No shot left over from an earlier run.
rmSync(out, { recursive: true, force: true });
// The console's listeners bite, or no shot is worth judging by them.
const missed = await consoleBites(browser);
if (missed.length > 0) {
  for (const line of missed) console.log(`FAIL the console's bite: ${line}`);
  await browser.close();
  process.exit(1);
}
console.log("ok   the console's bite: a font the CSP blocks and a throw in a timer were both heard");
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
// The strips the run made, each at its own size: a motion in both themes, never compared with a base.
const strips = everyStrip
  .filter(({ key }) => !failed.includes(key))
  .map(
    ({ theme, shot }) =>
      `<figure><img loading="lazy" src="frames/${shot.name}-${theme}.png" alt=""><figcaption>${shot.name} · ${theme} · ${shot.scenario} · frames</figcaption></figure>`,
  );
const html = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:14px system-ui;background:#111;color:#ddd;margin:24px}main{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{width:100%;border:1px solid #333}figure{margin:0}figcaption{padding:4px 0 12px;color:#999}.strips{display:flex;flex-direction:column;gap:16px;overflow-x:auto}.strips img{width:auto;max-width:none}</style><h1>${title}</h1><main>${body}</main>${strips.length ? `<h2>Motion, frame by frame</h2><section class="strips">${strips.join("")}</section>` : ""}`;

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
  const body = stills.map((shot) =>
    THEMES.map((theme) => cell("", { theme, shot, key: keyOf(theme, shot) })).join(""),
  );
  writeFileSync(join(out, "index.html"), html("Lookover proof", body.join("")));
}
// On a whole run that judged every screen, an allowance nothing needed is one its ticket fixed: it goes.
for (const line of unneeded(allowancesUsed, words.length === 0 && layoutJudgedAll)) {
  layoutWrong.push(line);
  console.log(`FAIL layout ${line}`);
}
const seconds = Math.round((Date.now() - began) / 1000);
// Stills and strips counted apart: a failed strip is no missing screenshot.
const stillsFailed = everyShot.filter(({ key }) => failed.includes(key)).length;
const stripsFailed = everyStrip.filter(({ key }) => failed.includes(key)).length;
const stripsLine = everyStrip.length
  ? `, ${everyStrip.length - stripsFailed} frames strips${stripsFailed ? ` (${stripsFailed} failed)` : ""}`
  : "";
console.log(
  `\n${everyShot.length - stillsFailed} screenshots${stillsFailed ? ` (${stillsFailed} failed)` : ""}${stripsLine} in ${out} (${seconds} s)`,
);
if (layoutWrong.length > 0)
  console.log(`The layout pass found ${layoutWrong.length} wrong (lines FAIL above)`);
if (motionWrong.length > 0)
  console.log(`The reduced-motion pass found ${motionWrong.length} wrong (lines FAIL above)`);
process.exit(failed.length || layoutWrong.length || motionWrong.length ? 1 : 0);
