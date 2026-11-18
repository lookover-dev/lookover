// Lookover in the tray through the service, on the fake `Tray` (ADR 0105 §8-12): the icon told the pill's words only
// when they change, the choice kept by the store (on by default) turning it off and on at once, an icon that ends
// started again once and unavailable after a second end, each end logged, and `Service.tray` saying it, set afresh
// by each start.
import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { API, type State } from "@lookover/contracts";
import { RetrievalError } from "@lookover/retrieval";
import { ScriptedRetrieval } from "@lookover/testkit";
import { memoryTray, type Tray } from "./index.ts";
import {
  eventually,
  fakeEngines,
  home,
  openApp,
  post,
  pr1,
  review,
  SANDBOX,
  snapshot,
  start,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

/** Engines both ready (Codex not installed is a problem the tray would say), with `answers` scripted. */
function readyEngines(...answers: Parameters<ReturnType<typeof fakeEngines>["answer"]>) {
  const engines = fakeEngines();
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  if (answers.length > 0) engines.answer(...answers);
  return engines;
}

/** Waits until `holds` of the fake tray. */
async function trayHolds(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !holds(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(holds()).toBe(true);
}

test("the icon follows a review: all good, reviewing, needs you, all good, told only when its view changes", async () => {
  const tray = memoryTray();
  // The review fails (its code can't be fetched): a failed review needs the person.
  const retrieval = new ScriptedRetrieval();
  retrieval.refuse(new RetrievalError("fetch_failed", "fatal: could not read from remote repository"));
  const { service, host } = await start({ engines: readyEngines(), retrieval, changes: [pr1], tray });
  const cookie = await openApp(service);
  await trayHolds(() => tray.views().length === 1);
  expect((await snapshot(service, cookie)).service.tray).toEqual({ on: true, shown: "shown", reason: null });

  expect((await review(service, cookie)).status).toBe(200);
  await trayHolds(() => tray.views().at(-1)?.state === "needs-you");
  host.close({ repo: SANDBOX, number: pr1.number });
  expect((await post(service, cookie, { type: "refresh" })).status).toBe(200);
  await trayHolds(() => tray.views().at(-1)?.state === "idle" && tray.views().length > 1);

  expect(tray.views()).toEqual([
    { state: "idle", tooltip: "Lookover: All good", line: "All good", paused: false },
    {
      state: "reviewing",
      tooltip: "Lookover: Reviewing sasensi/lookover-sandbox #1",
      line: "Reviewing sasensi/lookover-sandbox #1",
      paused: false,
    },
    {
      state: "needs-you",
      tooltip: "Lookover: 1 pull request needs you",
      line: "1 pull request needs you",
      paused: false,
    },
    { state: "idle", tooltip: "Lookover: All good", line: "All good", paused: false },
  ]);
});

test("the choice off stops the icon at once and is kept; on starts it again", async () => {
  const tray = memoryTray();
  const dir = home();
  const { service } = await start({ home: dir, engines: readyEngines(), tray });
  const cookie = await openApp(service);
  await trayHolds(() => tray.running());

  expect((await post(service, cookie, { type: "service.tray", on: false })).status).toBe(200);
  expect(tray.running()).toBe(false);
  expect((await snapshot(service, cookie)).service.tray).toEqual({ on: false, shown: "off", reason: null });

  expect((await post(service, cookie, { type: "service.tray", on: true })).status).toBe(200);
  await trayHolds(() => tray.running());
  const state = await eventually(
    () => snapshot(service, cookie),
    (s: State) => s.service.tray.shown === "shown",
  );
  expect(state.service.tray).toEqual({ on: true, shown: "shown", reason: null });
  // Started again, it is told what to show at once.
  expect(tray.views().map((view) => view.state)).toEqual(["idle", "idle"]);
});

test("a start with the choice off starts no icon", async () => {
  const tray = memoryTray();
  const dir = home();
  const first = await start({ home: dir, engines: readyEngines(), tray });
  const cookie = await openApp(first.service);
  expect((await post(first.service, cookie, { type: "service.tray", on: false })).status).toBe(200);
  await first.service.stop();

  const again = memoryTray();
  const { service } = await start({ home: dir, engines: readyEngines(), tray: again });
  const state = await snapshot(service, await openApp(service));
  expect(state.service.tray).toEqual({ on: false, shown: "off", reason: null });
  expect(again.running()).toBe(false);
});

test("an icon that ends is started again once; a second end leaves it unavailable, with why, each end logged", async () => {
  const tray = memoryTray();
  const { service, logged } = await start({ engines: readyEngines(), tray });
  const cookie = await openApp(service);
  await trayHolds(() => tray.running());

  tray.end("The tray helper exited with code 3");
  await trayHolds(() => tray.running());
  expect(tray.views()).toHaveLength(2);
  expect((await snapshot(service, cookie)).service.tray.shown).toBe("shown");

  tray.end("The tray helper exited with code 3");
  const state = await eventually(
    () => snapshot(service, cookie),
    (s: State) => s.service.tray.shown === "unavailable",
  );
  expect(state.service.tray).toEqual({
    on: true,
    shown: "unavailable",
    reason: "The tray helper exited with code 3",
  });
  expect(tray.running()).toBe(false);
  expect(logged.filter((line) => line.startsWith("The tray icon"))).toEqual([
    "The tray icon ended (The tray helper exited with code 3): it is started again",
    "The tray icon ended again (The tray helper exited with code 3): it isn't started again until Lookover restarts or the choice is turned on",
  ]);
});

test("a tray that can't run at start is said unavailable, with why, and logged", async () => {
  const tray = memoryTray();
  tray.unavailable("No desktop to show an icon on");
  const { service, logged } = await start({ engines: readyEngines(), tray });
  const cookie = await openApp(service);
  const state = await eventually(
    () => snapshot(service, cookie),
    (s: State) => s.service.tray.shown === "unavailable",
  );
  expect(state.service.tray).toEqual({
    on: true,
    shown: "unavailable",
    reason: "No desktop to show an icon on",
  });
  expect(logged).toContain("The tray icon can't be shown: No desktop to show an icon on");
});

test("on the stand-in (live mode, a guarded program), no icon is shown, said from the start's first state, nothing logged", async () => {
  // No tray given: the room's own stand-in.
  const { service, logged } = await start({ engines: readyEngines() });
  const cookie = await openApp(service);
  const unavailable = {
    on: true,
    shown: "unavailable",
    reason: "Lookover shows no tray icon while it runs for development",
  };
  expect((await snapshot(service, cookie)).service.tray).toEqual(unavailable);
  expect(logged.filter((line) => line.startsWith("The tray"))).toEqual([]);
  // Turned off and on again, it is still said unavailable.
  expect((await post(service, cookie, { type: "service.tray", on: false })).status).toBe(200);
  expect((await post(service, cookie, { type: "service.tray", on: true })).status).toBe(200);
  expect((await snapshot(service, cookie)).service.tray).toEqual(unavailable);
});

test("a start says this start's tray, never the one the replayed state kept", async () => {
  const dir = home();
  const tray = memoryTray();
  const first = await start({ home: dir, engines: readyEngines(), tray });
  await trayHolds(() => tray.running());
  await first.service.stop();

  // This start's tray hasn't answered yet: starting, not the last run's shown.
  const silent: Tray = { start: () => new Promise(() => {}) };
  const { service } = await start({ home: dir, engines: readyEngines(), tray: silent });
  const state = await snapshot(service, await openApp(service));
  expect(state.service.tray).toEqual({ on: true, shown: "starting", reason: null });
});

test("the snapshot says the computer's system, which says where the icon sits", async () => {
  const systemOf = async (platform: NodeJS.Platform) => {
    const { service } = await start({ engines: readyEngines(), tray: memoryTray(), platform });
    return (await snapshot(service, await openApp(service))).service.os;
  };
  expect(await systemOf("win32")).toBe("windows");
  expect(await systemOf("darwin")).toBe("macos");
  expect(await systemOf("linux")).toBe("linux");
});

test("a start on another system says its own, never the one a replayed whole state kept", async () => {
  const dir = home();
  const first = await start({ home: dir, engines: readyEngines(), tray: memoryTray(), platform: "win32" });
  const before = await snapshot(first.service, await openApp(first.service));
  await first.service.stop();
  // A whole state in the log, as a start that renamed or dropped a piece writes it: Windows' system in it.
  expect(before.service.os).toBe("windows");
  const db = new Database(join(dir, "lookover.sqlite"), { strict: true });
  db.query("INSERT INTO events (body) VALUES (?)").run(
    JSON.stringify({ type: "state.replaced", at: T0, state: before }),
  );
  db.close();

  const { service } = await start({
    home: dir,
    engines: readyEngines(),
    tray: memoryTray(),
    platform: "darwin",
  });
  expect((await snapshot(service, await openApp(service))).service.os).toBe("macos");
});

test("Open mints a link that opens the app once, within two minutes, and opens the browser on it", async () => {
  const tray = memoryTray();
  const opened: string[] = [];
  const openBrowser = (url: string) => {
    opened.push(url);
    return Promise.resolve(true);
  };
  const { service, time } = await start({ engines: readyEngines(), tray, openBrowser });
  const cookie = await openApp(service);
  await trayHolds(() => tray.running());

  tray.click("open");
  await trayHolds(() => opened.length === 1);
  const [url = ""] = opened;
  expect(url).toStartWith(`${service.origin}${API.session}?token=`);
  const followed = await fetch(url, { redirect: "manual" });
  expect(followed.status).toBe(303);
  expect(followed.headers.get("set-cookie")?.split(";")[0]).toBe(cookie);
  expect((await fetch(url, { redirect: "manual" })).status).toBe(403);

  // Two minutes on, a link not followed opens nothing.
  tray.click("open");
  await trayHolds(() => opened.length === 2);
  await time.advance(120_000);
  expect((await fetch(opened[1] ?? "", { redirect: "manual" })).status).toBe(403);
});

test("Open with a browser that won't open says so in the log, never the link", async () => {
  const tray = memoryTray();
  const { logged } = await start({
    engines: readyEngines(),
    tray,
    openBrowser: () => Promise.resolve(false),
  });
  await trayHolds(() => tray.running());
  tray.click("open");
  await trayHolds(() => logged.some((line) => line.startsWith("The tray's Open")));
  expect(logged.filter((line) => line.startsWith("The tray's"))).toEqual([
    "The tray's Open didn't open a browser: run `lookover open`",
  ]);
});

test("each Pause pauses as the app's does, and the icon says it; Resume resumes", async () => {
  const tray = memoryTray();
  const { service } = await start({ engines: readyEngines(), tray });
  const cookie = await openApp(service);
  await trayHolds(() => tray.running());
  const paused = async () => (await snapshot(service, cookie)).service.paused;

  tray.click("pause.hour");
  await trayHolds(() => tray.views().at(-1)?.paused === true);
  expect(await paused()).toEqual({ since: T0, until: T0 + 3_600_000 });
  tray.click("resume");
  await trayHolds(() => tray.views().at(-1)?.paused === false);
  expect(await paused()).toBeNull();

  tray.click("pause.forever");
  await trayHolds(() => tray.views().at(-1)?.paused === true);
  expect(await paused()).toEqual({ since: T0, until: null });
  tray.click("resume");
  await trayHolds(() => tray.views().at(-1)?.paused === false);

  // Until tomorrow: the app's own pause, asked on another service at the same instant, ends when the tray's does.
  tray.click("pause.tomorrow");
  await trayHolds(() => tray.views().at(-1)?.paused === true);
  const other = await start({ engines: readyEngines() });
  const otherCookie = await openApp(other.service);
  expect((await post(other.service, otherCookie, { type: "service.pause", for: "tomorrow" })).status).toBe(
    200,
  );
  const tomorrow = (await snapshot(other.service, otherCookie)).service.paused;
  expect(await paused()).toEqual(tomorrow);
  // 08:52 UTC on 6 October 2026, 18 hours on: the same instant whatever the machine's time zone.
  expect(tomorrow).toEqual({ since: T0, until: Date.UTC(2026, 9, 7, 2, 52) });
});

test("Quit asks for the stop the service was given, the one `lookover stop` asks for, and logs nothing itself", async () => {
  const tray = memoryTray();
  let quits = 0;
  const { logged } = await start({
    engines: readyEngines(),
    tray,
    trayQuit: () => {
      quits += 1;
    },
  });
  await trayHolds(() => tray.running());
  tray.click("quit");
  expect(quits).toBe(1);
  expect(logged.filter((line) => line.startsWith("The tray"))).toEqual([]);
});

test("Quit, with only `lookover stop`'s stop given, asks for that one, as `lookover stop` does", async () => {
  const tray = memoryTray();
  let stops = 0;
  const { logged } = await start({
    engines: readyEngines(),
    tray,
    stopAsked: () => {
      stops += 1;
    },
  });
  await trayHolds(() => tray.running());
  tray.click("quit");
  expect(stops).toBe(1);
  expect(tray.running()).toBe(true);
  expect(logged.filter((line) => line.startsWith("The tray"))).toEqual([]);
});

test("an Open clicked before the server listens opens nothing, and the log says so", async () => {
  const opened: string[] = [];
  // Clicked as the icon starts, inside the room's build: before the server around the room listens.
  const early: Tray = {
    start: (onClick) => {
      onClick("open");
      return Promise.resolve({ show: () => {}, stop: () => {} });
    },
  };
  const { logged } = await start({
    engines: readyEngines(),
    tray: early,
    openBrowser: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
  });
  expect(opened).toEqual([]);
  expect(logged.filter((line) => line.startsWith("The tray's"))).toEqual([
    "The tray's Open came before Lookover was listening, so nothing opened",
  ]);
});

test("Quit, with no stop given, stops the service: nothing answers on its port any more", async () => {
  const tray = memoryTray();
  const { service } = await start({ engines: readyEngines(), tray });
  await trayHolds(() => tray.running());
  tray.click("quit");
  await trayHolds(() => !tray.running());
  let answers = true;
  for (let i = 0; i < 250 && answers; i++) {
    answers = await fetch(`${service.origin}${API.snapshot}`).then(
      () => true,
      () => false,
    );
    if (answers) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(answers).toBe(false);
});

test("on a room with no server (demo mode's), Open and Quit are only logged, and the room goes on", async () => {
  const tray = memoryTray();
  const { room, logged } = await startRoom({ engines: readyEngines(), tray });
  await trayHolds(() => tray.running());
  tray.click("open");
  tray.click("quit");
  expect(logged.filter((line) => line.startsWith("The tray's menu"))).toEqual([
    "The tray's menu asked to open Lookover",
    "The tray's menu asked to quit Lookover",
  ]);
  expect(tray.running()).toBe(true);
  tray.click("pause.forever");
  expect(room.snapshot().service.paused).toEqual({ since: T0, until: null });
});
