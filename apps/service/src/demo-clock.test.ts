// The demo clock through the service's door (ADR 0046): the developer drawer's `demo.advance`, `demo.step` and
// `demo.clock` on the commands endpoint move the engine room's one clock, so the poll runs, a timed pause ends
// and the UI's `now` follows: one `clock` event per move, and the keepalive carrying the service's time while
// nothing moves. On fakes only; nothing here waits on the wall clock.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, type Event, jobId, type ReviewJob } from "@lookover/contracts";
import { DemoClock, type FakeChange, type Wall } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  messages,
  next,
  openApp,
  PLANTED,
  post,
  pr1,
  review,
  SHA1,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const HOUR = 3_600_000;
/** How often the service lists while a change is hot: `demo.step` lands on the poll's next wake. */
const WAKE_MS = 10_000;
const NINTH = changeId("sasensi/lookover-sandbox#9");
/** Another pull request of the owner's, a draft: listed when it opens, reviewed by nobody. */
const ninth: FakeChange = { ...pr1, number: 9, url: pr1.url.replace(/\/1$/, "/9"), draft: true };
const pausedJob: ReviewJob = {
  id: jobId("id-1"),
  sha: SHA1,
  trigger: "manual",
  state: "deferred",
  deferral: { reason: "paused" },
  skip: null,
  cancel: null,
  failure: null,
  turn: null,
  stepIn: null,
};
const named = (e: Event) => {
  if (e.type === "change.opened") return `${e.type} ${e.change.id}`;
  return "changeId" in e ? `${e.type} ${e.changeId}` : e.type;
};

/** The real time, moved by hand: what a flowing demo clock follows in a test that never sleeps. */
class HeldWall implements Wall {
  private at = 1_000;
  private armed: { due: number; fire: () => void }[] = [];
  now = () => this.at;
  after = (ms: number, fire: () => void) => {
    const timer = { due: this.at + ms, fire };
    this.armed.push(timer);
    return () => {
      this.armed = this.armed.filter((t) => t !== timer);
    };
  };
  /** The real time passes: every real timeout that falls due fires, in order. */
  passes(ms: number): void {
    const until = this.at + ms;
    for (;;) {
      const due = this.armed.filter((t) => t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      this.armed = this.armed.filter((t) => t !== due);
      this.at = due.due;
      due.fire();
    }
    this.at = until;
  }
}

test("demo.advance moves the room's time: the poll runs, a timed pause ends, and each move is one clock event, numbered", async () => {
  const { service, host } = await start({ engines: fakeEngines({ reviews: 1 }), changes: [pr1] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(`${api(service, "/events")}?after=3`, { headers: { cookie } }));
  expect((await post(service, cookie, { type: "service.pause", for: "hour" })).status).toBe(200);
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: pausedJob });

  // A minute on: the poll ran by itself and saw the pull request opened meanwhile; the pause still holds.
  host.open(ninth);
  expect((await post(service, cookie, { type: "demo.advance", ms: 60_000 })).status).toBe(200);
  const minute = await until(stream, "clock");
  expect(minute.map(named)).toEqual([`change.opened ${NINTH}`, "clock"]);
  // Numbered by the store like any event: the start, the repository, #1, the pause, the job twice, #9, then it.
  expect(minute.at(-1)).toMatchObject({ type: "clock", at: T0 + 60_000, seq: 8 });
  const shown = await snapshot(service, cookie);
  expect(shown).toMatchObject({ seq: 8, now: T0 + 60_000 });
  expect(shown.reviews[PLANTED]).toMatchObject({ job: pausedJob, run: null });

  // The rest of the hour: the pause ends at its time, and the review it held runs to its round before the move
  // ends (nothing on these fakes waits on real time: the work a timer starts settles before the next fires).
  expect((await post(service, cookie, { type: "demo.advance", ms: HOUR - 60_000 })).status).toBe(200);
  const ended = await until(stream, "clock");
  expect(ended.map(named)).toEqual([
    "service.changed",
    `run.started ${PLANTED}`,
    `run.step ${PLANTED}`,
    `run.step ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `round.finished ${PLANTED}`,
    "clock",
  ]);
  expect(ended[0]).toMatchObject({ at: T0 + HOUR, patch: { paused: null } });
  expect(ended.at(-1)).toMatchObject({ at: T0 + HOUR });
  const after = await snapshot(service, cookie);
  expect(after.now).toBe(T0 + HOUR);
  expect(after.service.paused).toBeNull();
  expect(after.reviews[PLANTED]?.rounds).toHaveLength(1);
});

test("a scripted run's duration elapses on the held clock: the round lands when demo.advance reaches it", async () => {
  const time = new DemoClock({ at: T0 });
  const { service } = await start({
    time,
    engines: fakeEngines({ reviews: 1, tookMs: 90_000, time }),
    changes: [pr1],
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(`${api(service, "/events")}?after=3`, { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.step");
  expect((await post(service, cookie, { type: "demo.advance", ms: 89_999 })).status).toBe(200);
  expect((await until(stream, "clock")).map(named)).not.toContain(`round.finished ${PLANTED}`);
  expect((await post(service, cookie, { type: "demo.advance", ms: 1 })).status).toBe(200);
  expect((await until(stream, "clock")).map(named)).toContain(`round.finished ${PLANTED}`);
});

test("while nothing moves, the keepalive carries the service's now; demo.advance then sends the clock event", async () => {
  const { service } = await start({ changes: [pr1] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(`${api(service, "/events")}?after=3`, { headers: { cookie } }));
  const two = Promise.all([next(stream), next(stream)]);
  expect((await post(service, cookie, { type: "demo.advance", ms: 20_000 })).status).toBe(200);
  const [alive, moved] = await two;
  expect(alive).toEqual({ id: null, event: "keepalive", data: JSON.stringify({ at: T0 + 15_000 }) });
  expect(moved.event).toBe("event");
  expect(JSON.parse(moved.data)).toEqual({ type: "clock", at: T0 + 20_000, seq: 4 });
});

test("demo.step jumps to the next timer: the poll's wake, 10 s away", async () => {
  const { service } = await start({ changes: [pr1] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(`${api(service, "/events")}?after=3`, { headers: { cookie } }));
  expect((await post(service, cookie, { type: "demo.step" })).status).toBe(200);
  expect(await until(stream, "clock")).toEqual([{ type: "clock", at: T0 + WAKE_MS, seq: 4 }]);
  expect((await snapshot(service, cookie)).now).toBe(T0 + WAKE_MS);
});

test("demo.clock runs the clock with the real time at a speed, and stands it still again; nothing is stored while it flows", async () => {
  const wall = new HeldWall();
  const { service } = await start({ changes: [pr1], time: new DemoClock({ at: T0, wall: wall }) });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "demo.clock", running: true, speed: 60 })).status).toBe(200);
  // One real second at sixty times the speed: a minute on the service's clock, and no event for it.
  wall.passes(1_000);
  expect(await snapshot(service, cookie)).toMatchObject({ seq: 3, now: T0 + 60_000 });

  expect((await post(service, cookie, { type: "demo.clock", running: false, speed: 1 })).status).toBe(200);
  wall.passes(1_000);
  expect(await snapshot(service, cookie)).toMatchObject({ seq: 3, now: T0 + 60_000 });

  // A speed of zero is no speed.
  expect((await post(service, cookie, { type: "demo.clock", running: true, speed: 0 })).status).toBe(400);
});
