// Run folders kept 30 days (ADR 0056, SR-13): at start, after the restart's recovery, and once a day, the service
// deletes the folders of runs that ended more than 30 days ago on its clock, never a running or resumed one's; a folder
// the store doesn't know goes by its modification time; a job folder left empty goes too; mirrors and self-test
// folders stay.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY_MS } from "./index.ts";
import {
  api,
  BOT,
  daysOnly,
  fakeEngines,
  HeldReviews,
  heldRuns,
  home,
  lastEvent,
  messages,
  openApp,
  pr1,
  review,
  SANDBOX,
  sinceStart,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

/** Makes `dir/name` with a file in it, both last modified at `at`. */
function planted(dir: string, name: string, at: number): string {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "stdout.jsonl"), "{}\n");
  utimesSync(join(folder, "stdout.jsonl"), at / 1000, at / 1000);
  utimesSync(folder, at / 1000, at / 1000);
  return folder;
}

/** A service on `dir` whose one review has ended: its run's folder is `runs/id-1/id-2`. */
async function reviewed(dir: string) {
  const started = await start({ home: dir, engines: fakeEngines({ reviews: 1 }), changes: [pr1] });
  const cookie = await openApp(started.service);
  const stream = messages(await fetch(api(started.service, "/events"), { headers: { cookie } }));
  await review(started.service, cookie);
  await until(stream, "round.finished");
  return started;
}

test("a run that ended more than 30 days ago loses its folder at the next start; mirrors and self-tests stay", async () => {
  const dir = home();
  const first = await reviewed(dir);
  const run = join(dir, "runs", "id-1", "id-2");
  expect(existsSync(run)).toBe(true);
  await first.service.stop();

  await first.time.advance(31 * DAY_MS);
  const now = first.time.now();
  // Folders the store doesn't know: one untouched for 31 days, one written yesterday.
  const stale = planted(join(dir, "runs"), join("lost", "old"), now - 31 * DAY_MS);
  const fresh = planted(join(dir, "runs"), join("kept", "new"), now - DAY_MS);
  const mirror = planted(dir, join("repos", "sasensi", "lookover-sandbox"), now - 90 * DAY_MS);
  const selfTest = planted(dir, join("self-tests", "claude"), now - 90 * DAY_MS);
  await start({ home: dir, host: first.host, time: first.time, idsFrom: 100, changes: [pr1] });

  expect(existsSync(run)).toBe(false);
  // Its job folder, left empty, goes too.
  expect(existsSync(join(dir, "runs", "id-1"))).toBe(false);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(join(dir, "runs", "lost"))).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(mirror)).toBe(true);
  expect(existsSync(selfTest)).toBe(true);
});

test("a run's folder is kept 30 days, and goes at the day's prune after them", async () => {
  const dir = home();
  const first = await reviewed(dir);
  await first.service.stop();
  const run = join(dir, "runs", "id-1", "id-2");
  // Started again 29 and a half days later: a recent run, kept.
  await first.time.advance(29.5 * DAY_MS);
  await start({ home: dir, host: first.host, time: first.time, idsFrom: 100, changes: [pr1] });
  expect(existsSync(run)).toBe(true);
  await first.time.advance(DAY_MS - 1);
  expect(existsSync(run)).toBe(true);
  await first.time.advance(1);
  expect(existsSync(run)).toBe(false);
});

test("a run resumed at start keeps its folder, its posts held a day and more; then it is a recent one", async () => {
  const dir = home();
  const host = new HeldReviews({ repo: SANDBOX, bot: BOT, changes: [pr1] });
  const engines = fakeEngines({ reviews: 1 });
  const first = await start({ home: dir, host, engines });
  await review(first.service, await openApp(first.service));
  // The round's review is begun, and the service stops before GitHub answers it.
  await host.asked;
  await first.service.stop();
  const run = join(dir, "runs", "id-1", "id-2");
  // Written 40 days ago, as far as the disk says: the store says it is open.
  utimesSync(run, (first.time.now() - 40 * DAY_MS) / 1000, (first.time.now() - 40 * DAY_MS) / 1000);

  await first.time.advance(31 * DAY_MS);
  const last = lastEvent(dir);
  // Only the day's waits fire: the polls would fire thousands of times in the days that pass.
  const second = await start({
    home: dir,
    host,
    engines,
    time: first.time,
    timers: daysOnly(first.time),
    idsFrom: 100,
  });
  expect(existsSync(run)).toBe(true);
  await first.time.advance(DAY_MS);
  expect(existsSync(run)).toBe(true);
  host.release();
  await until(await sinceStart(second.service, await openApp(second.service), last), "round.finished");
  await first.time.advance(DAY_MS);
  expect(existsSync(run)).toBe(true);
});

test("the day's prune keeps the folders of a running job, its interrupted run's ended more than 30 days ago", async () => {
  const dir = home();
  const held = heldRuns(fakeEngines());
  const first = await start({ home: dir, engines: held.engines, changes: [pr1] });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  await review(first.service, cookie);
  await until(stream, "run.step");
  await first.service.stop();
  const run = join(dir, "runs", "id-1", "id-2");
  expect(existsSync(run)).toBe(true);

  // Started again: the recovery ends the interrupted run now, and runs its job again, held. Only the day's waits fire:
  // the polls and the review's 20-minute limit would cut the run, and fire too often for a month to pass.
  const again = heldRuns(fakeEngines());
  const time = first.time;
  const second = await start({
    home: dir,
    engines: again.engines,
    host: first.host,
    time,
    timers: daysOnly(time),
    idsFrom: 100,
  });
  const rerun = join(dir, "runs", "id-1", "id-101");
  await time.advance(31 * DAY_MS);
  // 31 prunes have passed: the interrupted run ended 31 days ago, its job runs, and both its runs keep their folders.
  const shown = await snapshot(second.service, await openApp(second.service));
  expect(shown.reviews["lookover-sandbox#1"].job.state).toBe("running");
  expect(existsSync(run)).toBe(true);
  expect(existsSync(rerun)).toBe(true);
});
