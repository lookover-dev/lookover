// The engines' self-tests through the service (ADR 0044, #91), on fakes, self-tests ended by hand: a version never
// tested is tested at start, before its first review, and the engine is busy meanwhile; a version that failed
// shows it and holds its jobs with that reason, is not tested again by itself, and "Check again" tests it again,
// or a new version, so the held job starts once one passes; a result is kept across a restart; a run that couldn't
// say keeps nothing.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { Engines } from "@lookover/contracts";
import {
  fakeEngines,
  HeldSelfTests,
  home,
  onFakeClaude,
  openApp,
  PassingSelfTests,
  PLANTED,
  post,
  review,
  sinceStart,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const FAILED = { reason: "engine-failed-self-test", engine: "claude" } as const;

/**
 * The service on fakes with Claude ready (version 2.4.1) and `reviews` find passes scripted; self-tests by hand;
 * what it logs kept.
 */
async function started(options: { reviews?: number; home?: string; version?: string | null } = {}) {
  const engines = fakeEngines({ reviews: options.reviews ?? 1 });
  if (options.version !== undefined) {
    engines.setHealth("claude", { installed: true, version: options.version, signedIn: true });
  }
  const selfTests = new HeldSelfTests();
  const logged: string[] = [];
  const s = await start({
    engines,
    selfTests,
    log: (line) => logged.push(line),
    ...(options.home === undefined ? {} : { home: options.home }),
  });
  const cookie = await openApp(s.service);
  const state = () => snapshot(s.service, cookie);
  return { ...s, engines, selfTests, logged, cookie, state };
}

test("a version never tested runs the self-test at start, before its first review; the job waits its turn meanwhile", async () => {
  const { service, time, engines, selfTests, cookie, state } = await started();
  // Codex isn't installed: only Claude is tested, in a folder of its own under the data folder.
  expect(selfTests.ran.map((r) => r.engine)).toEqual(["claude"]);
  expect((await state()).engines.claude).toMatchObject({ state: "ready", version: "2.4.1" });

  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  expect((await state()).reviews[PLANTED]?.job).toMatchObject({ state: "queued", deferral: null });
  expect(engines.runs).toHaveLength(0);

  selfTests.end("claude", "passed");
  await time.advance(0);
  expect(engines.runs).toHaveLength(1);
  expect(selfTests.ran).toHaveLength(1);
});

test("a version that failed shows it and holds the job with that reason; a tick doesn't test it again", async () => {
  const { service, time, selfTests, logged, cookie, state } = await started();
  selfTests.end("claude", "failed");
  await time.advance(0);
  expect((await state()).engines.claude).toMatchObject({ state: "failed-self-test", version: "2.4.1" });
  expect(logged).toEqual([
    "sasensi/lookover-sandbox#1 opened by sasensi: Add unpaid filter and rewrite total",
    "sasensi/lookover-sandbox#2 opened as a draft by octocat: Bump the dev dependencies",
    "self-test of claude 2.4.1: failed (wall), 0 ms",
    "Claude didn't pass Lookover's safety check",
  ]);

  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  expect((await state()).reviews[PLANTED]?.job).toMatchObject({ state: "deferred", deferral: FAILED });
  await time.advance(3 * 60_000);
  expect(selfTests.ran).toHaveLength(1);
  expect((await state()).reviews[PLANTED]?.job).toMatchObject({ state: "deferred", deferral: FAILED });
});

test("'Check again' tests a failed version again: failed again it stays held; passed, the held job starts", async () => {
  const { service, time, engines, selfTests, cookie, state } = await started();
  selfTests.end("claude", "failed");
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);

  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  expect(selfTests.ran).toHaveLength(2);
  // While it runs, Claude still shows the failed state.
  expect((await state()).engines.claude.state).toBe("failed-self-test");
  selfTests.end("claude", "failed");
  await time.advance(0);
  expect((await state()).reviews[PLANTED]?.job).toMatchObject({ state: "deferred", deferral: FAILED });

  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  selfTests.end("claude", "passed");
  await time.advance(0);
  expect((await state()).engines.claude.state).toBe("ready");
  expect(engines.runs).toHaveLength(1);
});

test("a new version is tested at the next look, and the job held on the failed one starts once it passes", async () => {
  const { service, time, engines, selfTests, cookie, state } = await started();
  selfTests.end("claude", "failed");
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);

  engines.setHealth("claude", { installed: true, version: "2.4.2", signedIn: true });
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  expect(selfTests.ran).toHaveLength(2);
  selfTests.end("claude", "passed");
  await time.advance(0);
  expect((await state()).engines.claude).toMatchObject({ state: "ready", version: "2.4.2" });
  expect(engines.runs).toHaveLength(1);
});

test("a version's result is kept: after a restart, one that passed isn't tested again, nor one that failed", async () => {
  const dir = home();
  const first = await started({ home: dir });
  first.selfTests.end("claude", "passed");
  await first.time.advance(0);
  await first.service.stop();

  const again = await started({ home: dir });
  expect(again.selfTests.ran).toEqual([]);
  expect((await review(again.service, again.cookie)).status).toBe(200);
  await again.time.advance(0);
  expect(again.engines.runs).toHaveLength(1);
});

test("a failed version stays failed across a restart, untested", async () => {
  const dir = home();
  const first = await started({ home: dir });
  first.selfTests.end("claude", "failed");
  await first.time.advance(0);
  await first.service.stop();

  const again = await started({ home: dir });
  expect(again.selfTests.ran).toEqual([]);
  expect((await again.state()).engines.claude.state).toBe("failed-self-test");
});

test("a self-test that couldn't say keeps nothing: signed out, Claude shows it, and a restart tests again", async () => {
  const dir = home();
  const first = await started({ home: dir });
  first.selfTests.end("claude", "signed-out");
  await first.time.advance(0);
  expect((await first.state()).engines.claude.state).toBe("signed-out");
  await first.service.stop();

  const again = await started({ home: dir });
  expect(again.selfTests.ran.map((r) => r.engine)).toEqual(["claude"]);
});

test("signed out in the self-test's run while its health says signed in, Claude is tested again at the next tick", async () => {
  const { service, time, engines, selfTests, cookie, state } = await started();
  selfTests.end("claude", "signed-out");
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  expect((await state()).reviews[PLANTED]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "engine-signed-out", engine: "claude" },
  });
  // The tick a minute on asks again: the health says signed in, so the self-test runs again, and passes.
  await time.advance(60_000);
  expect(selfTests.ran).toHaveLength(2);
  selfTests.end("claude", "passed");
  await time.advance(0);
  expect((await state()).engines.claude.state).toBe("ready");
  expect(engines.runs).toHaveLength(1);
});

test("a self-test that never tried the wall keeps nothing: Claude shows it didn't pass, and 'Check again' tests at once", async () => {
  const dir = home();
  const first = await started({ home: dir });
  first.selfTests.end("claude", "untried");
  await first.time.advance(0);
  expect((await first.state()).engines.claude.state).toBe("failed-self-test");
  // A take meanwhile doesn't test it again; "Check again" does.
  await first.time.advance(60_000);
  expect(first.selfTests.ran).toHaveLength(1);
  expect((await post(first.service, first.cookie, { type: "engine.check" })).status).toBe(200);
  await first.time.advance(0);
  expect(first.selfTests.ran).toHaveLength(2);
  await first.service.stop();

  const again = await started({ home: dir });
  expect(again.selfTests.ran).toHaveLength(1);
});

test("a version the program didn't print is never kept: passed, it reviews, and the next start tests it again", async () => {
  const dir = home();
  const first = await started({ home: dir, version: null });
  first.selfTests.end("claude", "passed");
  await first.time.advance(0);
  expect((await review(first.service, first.cookie)).status).toBe(200);
  await first.time.advance(0);
  expect(first.engines.runs).toHaveLength(1);
  expect(first.selfTests.ran).toHaveLength(1);
  await first.service.stop();

  const again = await started({ home: dir, version: null });
  expect(again.selfTests.ran).toHaveLength(1);
});

test("stopping cancels a self-test under way: nothing is kept, and the next start tests again", async () => {
  const dir = home();
  const first = await started({ home: dir });
  // Each self-test has its folder under the data folder's `self-tests`.
  expect(first.selfTests.ran[0]?.dir.startsWith(join(dir, "self-tests"))).toBe(true);
  await first.service.stop();
  const again = await started({ home: dir });
  expect(again.selfTests.ran).toHaveLength(1);
});

test("a self-test that ends while the room is still starting is shown passed, not thrown", async () => {
  const logged: string[] = [];
  const { service } = await start({
    engines: fakeEngines({ reviews: 0 }),
    selfTests: new PassingSelfTests(),
    log: (line) => logged.push(line),
  });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "ready",
    version: "2.4.1",
  });
  expect(logged.filter((line) => line.includes("threw"))).toEqual([]);
  expect(logged.some((line) => line.includes("self-test of claude 2.4.1: passed"))).toBe(true);
});

test("on the engines module and the fake claude, a version whose self-test crosses the wall shows it, sent as it ends", async () => {
  const dir = home();
  const engines = onFakeClaude(dir, "self-test-wall");
  const { service } = await start({ home: dir, engines, selfTests: engines, log: () => {} });
  const cookie = await openApp(service);
  // From the start's first event: the self-test may end before this connects.
  const stream = await sinceStart(service, cookie, 0);
  const [changed] = (await until(stream, "engine.changed")).filter((e) => e.type === "engine.changed");
  expect(changed).toMatchObject({ id: "claude", patch: { state: "failed-self-test" } });
  expect((await snapshot(service, cookie)).engines.claude).toMatchObject({
    state: "failed-self-test",
    version: "2.1.283",
  });
});

test("a self-test that fails while another engine's health is pending stays failed: the older health doesn't overwrite it (PR #100)", async () => {
  const fake = fakeEngines({ reviews: 1 });
  let release = () => {};
  const codexAnswered = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holdCodex = false;
  const engines: Engines = {
    run: (spec, signal) => fake.run(spec, signal),
    health: async (engine) => {
      if (engine === "codex" && holdCodex) await codexAnswered;
      return fake.health(engine);
    },
  };
  const selfTests = new HeldSelfTests();
  const { service, time } = await start({ engines, selfTests, log: () => {} });
  const cookie = await openApp(service);
  selfTests.end("claude", "passed");
  await time.advance(0);

  // Claude updated, "Check again": its new version is under test. A request's take then asks Claude (finder) and
  // Codex (confirmer); Claude answers at once, Codex not yet, and Claude's self-test fails meanwhile.
  fake.setHealth("claude", { installed: true, version: "2.4.2", signedIn: true });
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  expect(selfTests.ran).toHaveLength(2);
  holdCodex = true;
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  selfTests.end("claude", "failed");
  await time.advance(0);

  release();
  await time.advance(0);
  const state = await snapshot(service, cookie);
  expect(state.engines.claude.state).toBe("failed-self-test");
  expect(state.reviews[PLANTED]?.job).toMatchObject({ state: "deferred", deferral: FAILED });
  expect(fake.runs).toHaveLength(0);
});
