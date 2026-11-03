// The engines' self-tests through the service (ADR 0044, #91), on fakes, self-tests ended by hand: a version never
// tested is tested at start, before its first review, and the engine is busy meanwhile; a version that failed
// shows it and holds its jobs with that reason, is not tested again by itself, and "Check again" tests it again,
// or a new version, so the held job starts once one passes; a result is kept across a restart; a run that couldn't
// say keeps nothing; a run that couldn't finish is run again at once, and twice unfinished is its own state, which
// a known failure outweighs (ADR 0075).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { Engines } from "@lookover/contracts";
import {
  fakeEngines,
  HeldSelfTests,
  home,
  lastEvent,
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

/** The lines a self-test's runs and the states they lead to write in the log. */
const selfTestLines = (logged: string[]) =>
  logged.filter((line) => line.startsWith("self-test of") || line.startsWith("Claude "));

test("a self-test that never tried the wall is run again at once, nothing shown between; passed, the job starts (ADR 0075)", async () => {
  const { service, time, engines, selfTests, logged, cookie, state } = await started();
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  selfTests.end("claude", "untried");
  await time.advance(0);
  // The retry runs: Claude still shows ready, the job still waits its turn, and nothing reviews meanwhile.
  expect(selfTests.ran).toHaveLength(2);
  expect((await state()).engines.claude.state).toBe("ready");
  expect((await state()).reviews[PLANTED]?.job).toMatchObject({ state: "queued", deferral: null });
  expect(engines.runs).toHaveLength(0);
  selfTests.end("claude", "passed");
  await time.advance(0);
  expect(engines.runs).toHaveLength(1);
  expect(selfTestLines(logged)).toEqual([
    "self-test of claude 2.4.1: inconclusive (the wall not tried), 0 ms",
    "self-test of claude 2.4.1: passed, 0 ms",
  ]);
});

test("a self-test that couldn't finish twice shows it, holds the job with that reason, keeps nothing; a tick doesn't test again, 'Try again' does", async () => {
  const dir = home();
  const first = await started({ home: dir });
  expect((await review(first.service, first.cookie)).status).toBe(200);
  first.selfTests.end("claude", "untried");
  await first.time.advance(0);
  first.selfTests.end("claude", "untried");
  await first.time.advance(0);
  expect((await first.state()).engines.claude).toMatchObject({
    state: "self-test-unfinished",
    version: "2.4.1",
  });
  expect((await first.state()).reviews[PLANTED]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "engine-self-test-unfinished", engine: "claude" },
  });
  // One line per run, then the state's.
  expect(selfTestLines(first.logged)).toEqual([
    "self-test of claude 2.4.1: inconclusive (the wall not tried), 0 ms",
    "self-test of claude 2.4.1: inconclusive (the wall not tried), 0 ms",
    "Claude couldn't finish Lookover's safety check",
  ]);
  await first.time.advance(60_000);
  expect(first.selfTests.ran).toHaveLength(2);
  // "Try again" sends `engine.check`: a fresh pair. While it runs, Claude still shows the unfinished state.
  expect((await post(first.service, first.cookie, { type: "engine.check" })).status).toBe(200);
  await first.time.advance(0);
  expect(first.selfTests.ran).toHaveLength(3);
  expect((await first.state()).engines.claude.state).toBe("self-test-unfinished");
  first.selfTests.end("claude", "untried");
  await first.time.advance(0);
  expect(first.selfTests.ran).toHaveLength(4);
  expect((await first.state()).engines.claude.state).toBe("self-test-unfinished");
  await first.service.stop();

  // Nothing was kept: the next start tests again.
  const again = await started({ home: dir });
  expect(again.selfTests.ran).toHaveLength(1);
});

test("a run that couldn't be made, twice, shows the unfinished state too", async () => {
  const { time, selfTests, state } = await started();
  selfTests.end("claude", "not-run");
  await time.advance(0);
  expect(selfTests.ran).toHaveLength(2);
  selfTests.end("claude", "not-run");
  await time.advance(0);
  expect((await state()).engines.claude.state).toBe("self-test-unfinished");
});

test("a run that ended before the engine did anything, twice, is unfinished: retried, said plainly, never kept (#522)", async () => {
  const dir = home();
  const first = await started({ home: dir });
  first.selfTests.end("claude", "did-nothing");
  await first.time.advance(0);
  expect(first.selfTests.ran).toHaveLength(2);
  expect((await first.state()).engines.claude.state).toBe("ready");
  first.selfTests.end("claude", "did-nothing");
  await first.time.advance(0);
  expect((await first.state()).engines.claude.state).toBe("self-test-unfinished");
  expect(selfTestLines(first.logged)).toEqual([
    "self-test of claude 2.4.1: inconclusive (the run did nothing: crashed), 0 ms",
    "self-test of claude 2.4.1: inconclusive (the run did nothing: crashed), 0 ms",
    "Claude couldn't finish Lookover's safety check",
  ]);
  await first.service.stop();

  const again = await started({ home: dir });
  expect(again.selfTests.ran).toHaveLength(1);
});

test("unfinished, then failed on the retry: a failure, kept across a restart", async () => {
  const dir = home();
  const first = await started({ home: dir });
  first.selfTests.end("claude", "untried");
  await first.time.advance(0);
  first.selfTests.end("claude", "failed");
  await first.time.advance(0);
  expect((await first.state()).engines.claude.state).toBe("failed-self-test");
  await first.service.stop();

  const again = await started({ home: dir });
  expect(again.selfTests.ran).toEqual([]);
  expect((await again.state()).engines.claude.state).toBe("failed-self-test");
});

test("unfinished, then signed out or at its limit on the retry: those states, as a first run's", async () => {
  const signedOut = await started();
  signedOut.selfTests.end("claude", "untried");
  await signedOut.time.advance(0);
  signedOut.selfTests.end("claude", "signed-out");
  await signedOut.time.advance(0);
  expect((await signedOut.state()).engines.claude.state).toBe("signed-out");

  const limited = await started();
  const reset = limited.time.now() + 3 * 3_600_000;
  limited.selfTests.end("claude", "untried");
  await limited.time.advance(0);
  limited.selfTests.end("claude", { limitUntil: reset });
  await limited.time.advance(0);
  expect((await limited.state()).engines.claude).toMatchObject({ state: "limit", limitUntil: reset });
});

test("a known failure wins over an unfinished pair: 'Check again' on a failed version shows it failed still, and keeps the failure", async () => {
  const dir = home();
  const first = await started({ home: dir });
  first.selfTests.end("claude", "failed");
  await first.time.advance(0);
  expect((await post(first.service, first.cookie, { type: "engine.check" })).status).toBe(200);
  await first.time.advance(0);
  first.selfTests.end("claude", "untried");
  await first.time.advance(0);
  first.selfTests.end("claude", "untried");
  await first.time.advance(0);
  expect((await first.state()).engines.claude.state).toBe("failed-self-test");
  expect((await review(first.service, first.cookie)).status).toBe(200);
  await first.time.advance(0);
  expect((await first.state()).reviews[PLANTED]?.job).toMatchObject({ state: "deferred", deferral: FAILED });
  await first.service.stop();

  const again = await started({ home: dir });
  expect(again.selfTests.ran).toEqual([]);
  expect((await again.state()).engines.claude.state).toBe("failed-self-test");
});

test("a known failure of a program that printed no version wins too: held, never expired by the pair", async () => {
  const { service, time, selfTests, cookie, state } = await started({ version: null });
  selfTests.end("claude", "failed");
  await time.advance(0);
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  selfTests.end("claude", "untried");
  await time.advance(0);
  selfTests.end("claude", "untried");
  await time.advance(0);
  expect((await state()).engines.claude.state).toBe("failed-self-test");
  // Past the unfinished state's hold, the failure still holds: nothing tests it again by itself.
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(20 * 60_000);
  expect(selfTests.ran).toHaveLength(3);
  expect((await state()).engines.claude.state).toBe("failed-self-test");
});

test("a known failure of a program that printed no version outlasts a pair ending signed out: told, never expired", async () => {
  const { service, time, selfTests, cookie, state } = await started({ version: null });
  selfTests.end("claude", "failed");
  await time.advance(0);
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  selfTests.end("claude", "untried");
  await time.advance(0);
  selfTests.end("claude", "signed-out");
  await time.advance(0);
  expect((await state()).engines.claude.state).toBe("signed-out");
  // Past the signed-out state's hold and the unfinished one's, the failure still holds: no self-test by itself.
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(20 * 60_000);
  expect(selfTests.ran).toHaveLength(3);
  expect((await state()).engines.claude.state).toBe("failed-self-test");
});

for (const [kind, version] of [
  ["printed no version", null],
  ["kept", undefined],
] as const) {
  test(`a known failure (${kind}) and 'Check again' ending signed out, a review waiting: signed out at once and for its hold, then the failure`, async () => {
    const { service, time, selfTests, cookie, state } = await started(version === null ? { version } : {});
    selfTests.end("claude", "failed");
    await time.advance(0);
    expect((await review(service, cookie)).status).toBe(200);
    await time.advance(0);
    expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
    await time.advance(0);
    selfTests.end("claude", "untried");
    await time.advance(0);
    selfTests.end("claude", "signed-out");
    await time.advance(0);
    expect((await state()).engines.claude.state).toBe("signed-out");
    // The waiting job's look at the engine doesn't flip it back while the hold lasts.
    await time.advance(30_000);
    expect((await state()).engines.claude.state).toBe("signed-out");
    await time.advance(60_000);
    expect((await state()).engines.claude.state).toBe("failed-self-test");
    expect((await state()).reviews[PLANTED]?.job).toMatchObject({ state: "deferred", deferral: FAILED });
    await time.advance(20 * 60_000);
    expect(selfTests.ran).toHaveLength(3);
    expect((await state()).engines.claude.state).toBe("failed-self-test");
  });
}

test("a kept failure and 'Check again' ending at the limit, a review waiting: at its limit until the reset, then the failure", async () => {
  const { service, time, selfTests, cookie, state } = await started();
  selfTests.end("claude", "failed");
  await time.advance(0);
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  const reset = time.now() + 3 * 3_600_000;
  selfTests.end("claude", { limitUntil: reset });
  await time.advance(0);
  expect((await state()).engines.claude).toMatchObject({ state: "limit", limitUntil: reset });
  await time.advance(2 * 3_600_000);
  expect((await state()).engines.claude.state).toBe("limit");
  await time.advance(3_600_000 + 60_000);
  expect((await state()).engines.claude.state).toBe("failed-self-test");
  expect(selfTests.ran).toHaveLength(2);
});

test("a kept failure, 'Check again' at the limit, then 'Check again' unfinished twice before the reset, a review waiting: the failure at once and after", async () => {
  const { service, time, selfTests, cookie, state } = await started();
  selfTests.end("claude", "failed");
  await time.advance(0);
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  selfTests.end("claude", { limitUntil: time.now() + 3 * 3_600_000 });
  await time.advance(0);
  expect((await state()).engines.claude.state).toBe("limit");
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  selfTests.end("claude", "untried");
  await time.advance(0);
  selfTests.end("claude", "untried");
  await time.advance(0);
  expect((await state()).engines.claude).toMatchObject({ state: "failed-self-test", limitUntil: null });
  // The waiting job's look at the engine doesn't bring the old limit back.
  await time.advance(30_000);
  expect((await state()).engines.claude.state).toBe("failed-self-test");
  await time.advance(3_600_000);
  expect((await state()).engines.claude.state).toBe("failed-self-test");
  expect((await state()).reviews[PLANTED]?.job).toMatchObject({ state: "deferred", deferral: FAILED });
  expect(selfTests.ran).toHaveLength(4);
});

test("a kept failure, 'Check again' signed out, then 'Check again' passing within the minute, a review waiting: ready at once and after", async () => {
  const { service, time, selfTests, cookie, state } = await started();
  selfTests.end("claude", "failed");
  await time.advance(0);
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  selfTests.end("claude", "signed-out");
  await time.advance(0);
  expect((await state()).engines.claude.state).toBe("signed-out");
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  await time.advance(0);
  selfTests.end("claude", "passed");
  await time.advance(0);
  expect((await state()).engines.claude.state).toBe("ready");
  await time.advance(30_000);
  expect((await state()).engines.claude.state).toBe("ready");
  expect(selfTests.ran).toHaveLength(3);
});

test("stopping during the retry keeps and says nothing, and the next start tests again", async () => {
  const dir = home();
  const first = await started({ home: dir });
  first.selfTests.end("claude", "untried");
  await first.time.advance(0);
  expect(first.selfTests.ran).toHaveLength(2);
  const before = await first.state();
  await first.service.stop();
  expect(selfTestLines(first.logged)).toEqual([
    "self-test of claude 2.4.1: inconclusive (the wall not tried), 0 ms",
  ]);
  // The cancelled retry sent no event: Claude's state stays as it was shown.
  expect(before.engines.claude.state).toBe("ready");
  expect(lastEvent(dir)).toBe(before.seq);

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
