// The pause, through the service's entry, on fakes only (ADR 0040): while paused nothing starts, a review asked
// for waits as deferred "paused" and starts by itself on resume or when a timed pause ends; a running review
// finishes; the pause and the jobs it holds outlive a restart.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, type Engines, jobId, type ReviewJob } from "@lookover/contracts";
import type { FakeChange } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  heldRuns,
  home,
  LAGGING,
  lastEvent,
  messages,
  openApp,
  PLANTED,
  post,
  pr1,
  review,
  SHA1,
  sinceStart,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const queued: ReviewJob = {
  id: jobId("id-1"),
  sha: SHA1,
  trigger: "manual",
  state: "queued",
  deferral: null,
  stepIn: null,
  skip: null,
  cancel: null,
  failure: null,
  turn: null,
};
const HOUR = 3_600_000;
const NINTH = changeId("lookover-sandbox#9");
/** Another pull request of the owner's, on the same commits as the first. */
const ninth: FakeChange = { ...pr1, number: 9, url: pr1.url.replace(/\/1$/, "/9") };
const named = (e: { type: string; changeId?: string }) => (e.changeId ? `${e.type} ${e.changeId}` : e.type);
const pausedJob: ReviewJob = { ...queued, state: "deferred", deferral: { reason: "paused" } };

test("a review asked for while paused waits, deferred 'paused', and starts by itself on resume", async () => {
  const { service } = await start({ engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  expect((await post(service, cookie, { type: "service.pause", for: "forever" })).status).toBe(200);
  expect(await until(stream, "service.changed")).toMatchObject([
    { type: "service.changed", patch: { paused: { since: T0, until: null } } },
  ]);
  expect((await review(service, cookie)).status).toBe(200);
  const asked = [...(await until(stream, "job.changed")), ...(await until(stream, "job.changed"))];
  expect(asked.at(-1)).toMatchObject({ job: pausedJob });
  const shown = await snapshot(service, cookie);
  expect(shown.service.paused).toEqual({ since: T0, until: null });
  expect(shown.reviews[PLANTED]).toMatchObject({ job: pausedJob, run: null });

  expect((await post(service, cookie, { type: "service.resume" })).status).toBe(200);
  const resumed = await until(stream, "round.finished");
  expect(resumed.map((e) => e.type)).toEqual([
    "service.changed",
    "run.started",
    "run.step",
    "run.step",
    "run.posting",
    "run.posting",
    "run.posting",
    "run.posting",
    "run.posting",
    "round.finished",
  ]);
  expect(resumed[0]).toMatchObject({ patch: { paused: null } });
  expect(resumed.at(-1)).toMatchObject({ job: { ...queued, state: "done" } });
});

test("a pause for an hour ends at its time with nobody asking, and the review waiting on it starts", async () => {
  const { service, time } = await start({ engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "service.pause", for: "hour" })).status).toBe(200);
  expect(await until(stream, "service.changed")).toMatchObject([
    { patch: { paused: { since: T0, until: T0 + HOUR } } },
  ]);
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: pausedJob });

  // A minute before its end, the pause still holds.
  await time.advance(HOUR - 60_000);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: pausedJob, run: null });

  await time.advance(60_000);
  const ended = await until(stream, "round.finished");
  expect(ended.map((e) => e.type)).toEqual([
    "service.changed",
    "run.started",
    "run.step",
    "run.step",
    "run.posting",
    "run.posting",
    "run.posting",
    "run.posting",
    "run.posting",
    "round.finished",
  ]);
  expect(ended[0]).toMatchObject({ at: T0 + HOUR, patch: { paused: null } });
  expect((await snapshot(service, cookie)).service.paused).toBeNull();
});

test("a timed pause past its end whose timer is late is over at the next take, which says so before anything starts", async () => {
  const { service, time } = await start({ engines: fakeEngines({ reviews: 1 }), timers: LAGGING });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await post(service, cookie, { type: "service.pause", for: "hour" });
  await review(service, cookie);
  expect((await until(stream, "job.changed")).at(0)).toMatchObject({
    patch: { paused: { until: T0 + HOUR } },
  });
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: pausedJob });

  // The clock passes the pause's end; its timer doesn't fire. "Review now" again: the pause is over.
  await time.advance(HOUR + 60_000);
  expect((await review(service, cookie)).status).toBe(200);
  const events = await until(stream, "round.finished");
  expect(events.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    `job.changed ${PLANTED}`,
    "service.changed",
    `run.started ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  expect(events[1]).toMatchObject({ at: T0 + HOUR + 60_000, patch: { paused: null } });
  expect((await snapshot(service, cookie)).service.paused).toBeNull();
});

test("while paused, a review asked for asks no engine's health: nothing can start", async () => {
  const engines = fakeEngines();
  const asked: string[] = [];
  const counted: Engines = {
    run: (spec, signal) => engines.run(spec, signal),
    health: (engine) => {
      asked.push(engine);
      return engines.health(engine);
    },
  };
  const { service } = await start({ engines: counted });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await post(service, cookie, { type: "service.pause", for: "forever" });
  const atStart = asked.length;
  await review(service, cookie);
  await until(stream, "job.changed");
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: pausedJob });
  expect(asked.length).toBe(atStart);
});

test("a review running when the pause starts finishes; what is asked meanwhile waits, the run's own follow-up hidden until it ends", async () => {
  const held = heldRuns(fakeEngines({ reviews: 1 }));
  const { service, time } = await start({ engines: held.engines, changes: [pr1, ninth] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.step");

  // Paused while the review runs; then "Review now" on its change (a follow-up, which the take defers "paused")
  // and on another. The UI goes on showing the run; the other change waits for the resume.
  expect((await post(service, cookie, { type: "service.pause", for: "forever" })).status).toBe(200);
  expect((await review(service, cookie)).status).toBe(200);
  expect((await post(service, cookie, { type: "review.request", changeId: NINTH })).status).toBe(200);
  const meanwhile = [...(await until(stream, "job.changed")), ...(await until(stream, "job.changed"))];
  expect(meanwhile.map(named)).toEqual(["service.changed", `job.changed ${NINTH}`, `job.changed ${NINTH}`]);
  expect(meanwhile.at(-1)).toMatchObject({ job: { ...pausedJob, id: jobId("id-4") } });
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({
    job: { ...queued, state: "running" },
    run: { step: "finding" },
  });

  // The run finishes and posts its round; then the UI is shown the follow-up, waiting for the resume. Nothing
  // else starts.
  held.release();
  const after = [...(await until(stream, "round.finished")), ...(await until(stream, "job.changed"))];
  expect(after.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    `round.finished ${PLANTED}`,
    `job.changed ${PLANTED}`,
  ]);
  expect(after.at(-2)).toMatchObject({ job: { ...queued, state: "done" }, round: { n: 1 } });
  expect(after.at(-1)).toMatchObject({ job: { ...pausedJob, id: jobId("id-3") } });
  await time.advance(0);
  const shown = await snapshot(service, cookie);
  expect(shown.reviews[PLANTED]).toMatchObject({ job: { ...pausedJob, id: jobId("id-3") } });
  expect(shown.reviews[NINTH]).toMatchObject({ job: { ...pausedJob, id: jobId("id-4") }, run: null });
});

test("paused at a restart: the jobs waiting stay deferred 'paused', the interrupted one joins them, and resume starts the oldest", async () => {
  const dir = home();
  const first = await start({
    home: dir,
    engines: heldRuns(fakeEngines()).engines,
    changes: [pr1, ninth],
  });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  await review(first.service, cookie);
  await until(stream, "run.step");
  await post(first.service, cookie, { type: "service.pause", for: "forever" });
  await post(first.service, cookie, { type: "review.request", changeId: NINTH });
  await first.service.stop();

  // The service starts again a minute later: still paused; the review it cut goes back to wait with the other.
  await first.time.advance(60_000);
  const last = lastEvent(dir);
  const second = await start({
    home: dir,
    engines: fakeEngines({ reviews: 2 }),
    host: first.host,
    time: first.time,
    idsFrom: 100,
  });
  const again = await openApp(second.service);
  const events = await sinceStart(second.service, again, last);
  const restarted = [...(await until(events, "job.changed")), ...(await until(events, "job.changed"))];
  expect(restarted.map(named)).toEqual([`job.changed ${PLANTED}`, `job.changed ${PLANTED}`]);
  expect(restarted.at(-1)).toMatchObject({ job: pausedJob });
  await second.time.advance(0);
  const shown = await snapshot(second.service, again);
  expect(shown.service.paused).toEqual({ since: T0, until: null });
  expect(shown.reviews[PLANTED]).toMatchObject({ job: pausedJob });
  expect(shown.reviews[NINTH]).toMatchObject({ job: { ...pausedJob, id: jobId("id-3") }, run: null });

  // Resumed: the oldest, the interrupted review, runs first; the other waits its turn behind it, and starts once
  // the first round is saved and Claude is free (ADR 0044).
  await post(second.service, again, { type: "service.resume" });
  const resumed = [...(await until(events, "round.finished")), ...(await until(events, "round.finished"))];
  expect(resumed.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    "service.changed",
    `run.started ${PLANTED}`,
    `job.changed ${NINTH}`,
    `run.started ${NINTH}`,
    `round.finished ${PLANTED}`,
    `round.finished ${NINTH}`,
  ]);
  // It waits behind Claude reviewing the first (ADR 0055).
  expect(resumed.find((e) => e.type === "job.changed")).toMatchObject({
    job: {
      ...queued,
      id: jobId("id-3"),
      turn: { behind: "engines", engines: ["claude"], changes: [PLANTED], testing: false },
    },
  });
});

test("a timed pause outlives a restart and ends at its time; one that ended while the service was stopped is over at start", async () => {
  const dir = home();
  const first = await start({ home: dir, engines: fakeEngines() });
  const cookie = await openApp(first.service);
  await post(first.service, cookie, { type: "service.pause", for: "hour" });
  await review(first.service, cookie);
  await first.service.stop();

  // Half an hour later: still paused, until its end.
  await first.time.advance(HOUR / 2);
  const second = await start({
    home: dir,
    engines: fakeEngines({ reviews: 1 }),
    host: first.host,
    time: first.time,
    idsFrom: 100,
  });
  const again = await openApp(second.service);
  const stream = messages(await fetch(api(second.service, "/events"), { headers: { cookie: again } }));
  await second.time.advance(0);
  expect((await snapshot(second.service, again)).reviews[PLANTED]).toMatchObject({
    job: pausedJob,
    run: null,
  });
  await second.time.advance(HOUR / 2);
  const ended = await until(stream, "round.finished");
  expect(ended[0]).toMatchObject({ type: "service.changed", at: T0 + HOUR, patch: { paused: null } });

  // Paused for an hour again, stopped, and started two hours later: the pause is over, and the review asked
  // during it runs.
  await post(second.service, again, { type: "service.pause", for: "hour" });
  await review(second.service, again);
  await second.service.stop();
  await second.time.advance(2 * HOUR);
  const last = lastEvent(dir);
  const third = await start({
    home: dir,
    engines: fakeEngines({ reviews: 1 }),
    host: first.host,
    time: first.time,
    idsFrom: 200,
  });
  const events = await sinceStart(third.service, await openApp(third.service), last);
  const started = await until(events, "round.finished");
  expect(started.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    "service.changed",
    `run.started ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  expect(started[0]).toMatchObject({ at: T0 + 3 * HOUR, patch: { paused: null } });
});
