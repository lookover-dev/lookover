// A scenario load through the drawer's door (ADR 0046): `demo.load` builds a new engine room under the same server
// and session, numbers its events after the last room's, tells every open tab to reload, and leaves nothing of
// the old room; a seed that fails keeps the old room answering. On fakes only; nothing here waits on the wall clock.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, jobId, SSE } from "@lookover/contracts";
import { buildDemoRoom, type DemoRoom, type Room, type Scenario, scenarioOf } from "../index.ts";
import { api, next, TEST_LIMIT_MS } from "../service.test-support.ts";
import {
  advance,
  BRIEF_SEEDED,
  brief,
  inject,
  listing,
  load,
  logOf,
  send,
  snapshotOf,
  startScenario,
  stopAll,
  stream,
  T0,
  until,
} from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const id = (n: number) => changeId(`lookover-sandbox#${n}`);
/**
 * S10's seed: sixty-eight events (the start, the repository, six pull requests and their reviews, their outboxes as
 * they posted, main's rules read and counted three times).
 */
const SEEDED = 68;
/** The pull requests S10's seed opens. */
const S10_CHANGES = [135, 137, 139, 141, 144, 146].map(id);
/** What a load adds to the seed: the one `clock` event that ends it, so the UI's `now` follows. */
const LOADED = SEEDED + 1;
const BRIEF_LOADED = BRIEF_SEEDED + 1;
/**
 * The service on the brief story, which a load may name too: the tests of the load's own steps stand on it, the
 * story behind them being no matter. The first test loads S10 itself.
 */
const startBrief = (options: Parameters<typeof startScenario>[1] = {}) =>
  startScenario(brief(), { scenarios: [brief()], ...options });

test("loaded twice, a scenario's events go on numbering where the last room stopped, and the room is told the same story from one", async () => {
  const door = await startScenario(scenarioOf("S10"));
  expect((await snapshotOf(door)).seq).toBe(SEEDED);

  expect(await load(door, "S10")).toEqual({ status: 200, body: { ok: true } });
  const once = await snapshotOf(door);
  expect(once.seq).toBe(SEEDED + LOADED);
  // The same story, from the top: the seed's two and a half hours end at the fixed instant again, and the ids count from 1.
  expect(once.now).toBe(T0);
  expect(once.service.since).toBe(T0 - 150 * MIN);
  expect(Object.keys(once.changes).sort()).toEqual(S10_CHANGES);
  expect(once.reviews[id(135)]?.job?.id).toBe(jobId("1"));

  expect(await load(door, "S10")).toEqual({ status: 200, body: { ok: true } });
  const twice = await snapshotOf(door);
  expect(twice.seq).toBe(SEEDED + 2 * LOADED);
  expect(twice.now).toBe(T0);
  // The log on disk is the last room's alone, numbered on from the room before it, the load's clock event last.
  const log = logOf(door);
  expect(log.map((e) => e.seq)).toEqual(Array.from({ length: LOADED }, (_, i) => SEEDED + LOADED + i + 1));
  expect(log.at(-1)).toEqual({ type: "clock", at: T0, seq: SEEDED + 2 * LOADED });
  expect((await listing(door)).body.current).toBe("S10");
});

test("every open stream is told to reload once the rooms are swapped, and so is a tab that reconnects with a number from the old room", async () => {
  const door = await startBrief();
  const open = await stream(door, BRIEF_SEEDED);
  expect(await load(door, "T-brief")).toEqual({ status: 200, body: { ok: true } });
  expect((await next(open)).event).toBe(SSE.reload);
  // The old room's last number is the new room's start: at or before it, a tab saw another room's story.
  expect((await next(await stream(door, BRIEF_SEEDED))).event).toBe(SSE.reload);
  expect((await next(await stream(door, 5))).event).toBe(SSE.reload);
  // One that reloaded and saw the new room's last waits for what comes next.
  const { service, cookie } = door;
  const current = await fetch(`${api(service, "/events")}?after=${BRIEF_SEEDED + BRIEF_LOADED}`, {
    headers: { cookie },
  });
  expect(current.status).toBe(200);
  await current.body?.cancel();
});

test("a load during a running round: the clock moved on after it shows nothing of the old room", async () => {
  const door = await startBrief();
  // The agent's #146, the first of its changes the brief story never opened, opens and its round starts (opened,
  // queued, started, preparing: four events); its find pass is under way on the old room's clock.
  expect(await inject(door, "agent-opens-change")).toBe(200);
  const opened = await snapshotOf(door);
  expect(opened.seq).toBe(BRIEF_SEEDED + 4);
  expect(opened.reviews[id(146)]?.run).not.toBeNull();

  expect(await load(door, "T-brief")).toEqual({ status: 200, body: { ok: true } });
  const loaded = BRIEF_SEEDED + 4 + BRIEF_LOADED;
  expect((await snapshotOf(door)).seq).toBe(loaded);
  const events = await stream(door, loaded);
  // Long enough for the old room's round to have ended, had it gone on.
  await advance(door, 200_000);
  const moved = await until(events, "clock");
  expect(moved.map((e) => [e.seq, e.type])).toEqual([[loaded + 1, "clock"]]);
  const state = await snapshotOf(door);
  expect(state.now).toBe(T0 + 200_000);
  expect(Object.keys(state.changes)).toEqual([id(135)]);
  expect(Object.values(state.reviews).every((r) => r.run === null)).toBe(true);
});

/** S10 with #141's find pass left unscripted: a review of it crashes, so the seed fails on it. */
function broken(): Scenario {
  const quiet = scenarioOf("S10");
  return {
    ...quiet,
    id: "T-broken",
    changes: quiet.changes.map((c) => {
      if (c.number !== 141) return c;
      const { sha, message, diff } = c.commits[0];
      return { ...c, commits: [{ sha, message, diff }] };
    }),
    script: [{ at: 1 * MIN, move: { kind: "open", change: 141 } }],
    seed: 5 * MIN,
  };
}

/** A promise and the hand that settles it: where a test holds a load. */
function held() {
  let release = () => {};
  const at = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { at, release };
}

/** The room `demo` built, with some of its room's doors replaced: the rest of the driver is untouched. */
function patched(demo: DemoRoom, patch: (room: Room) => Partial<Room>): DemoRoom {
  return { ...demo, room: { ...demo.room, ...patch(demo.room) } };
}

/** Its demo clock's verbs, with some replaced. */
function clockOf(room: Room, patch: Partial<NonNullable<Room["demo"]>>): Room["demo"] {
  const clock = room.demo;
  if (clock === null) throw new Error("A demo room has a demo clock");
  return { ...clock, ...patch };
}

test("while a scenario loads, commands answer 409 loading and a new stream waits; a seed that fails keeps the old room answering, its clock as it was, and leaves nothing on disk; an unknown id is 404", async () => {
  // The next room's seed waits for the test: the load is under way until it says so.
  const building = held();
  const seed = held();
  let rooms = 0;
  const door = await startBrief({
    scenarios: [brief(), broken()],
    driver: async (o) => {
      if (rooms++ > 0) {
        building.release();
        await seed.at;
      }
      return buildDemoRoom(o);
    },
  });
  expect((await send(door, { type: "demo.clock", running: true, speed: 1 })).status).toBe(200);
  const loading = load(door, "T-broken");
  await building.at;
  const refused = await send(door, { type: "refresh" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "loading" });
  const waiting = stream(door, BRIEF_SEEDED);

  seed.release();
  const { status, body } = await loading;
  expect(status).toBe(500);
  expect(body).toEqual({ error: expect.stringContaining("The seed of T-broken failed on #141: ") });
  // The old room answers as before, its clock flowing again; the stream that waited follows it from where it was.
  expect((await snapshotOf(door)).seq).toBe(BRIEF_SEEDED);
  expect((await listing(door)).body).toMatchObject({ current: "T-brief", clock: { running: true } });
  expect((await send(door, { type: "refresh" })).status).toBe(200);
  await advance(door, 0);
  expect((await until(await waiting, "clock")).map((e) => e.seq)).toEqual([BRIEF_SEEDED + 1]);
  // The failed room's folder is swept: the old room's is the only one left.
  expect(logOf(door).at(-1)?.seq).toBe(BRIEF_SEEDED + 1);

  expect(await load(door, "S99")).toEqual({ status: 404, body: { error: "no scenario S99" } });
});

test("a load waits for a command already under way, and numbers the next room after what it sent", async () => {
  // The old room's `demo.advance` is held once it has begun; its clock standing still says the load has begun.
  const advancing = held();
  const advanceMay = held();
  const latched = held();
  let rooms = 0;
  const door = await startBrief({
    driver: async (o) => {
      const demo = await buildDemoRoom(o);
      if (rooms++ > 0) return demo;
      return patched(demo, (room) => {
        const clock = clockOf(room, {});
        return {
          demo: clockOf(room, {
            advance: async (ms) => {
              advancing.release();
              await advanceMay.at;
              return clock?.advance(ms);
            },
            set: (running, speed) => {
              latched.release();
              clock?.set(running, speed);
            },
          }),
        };
      });
    },
  });
  const advanced = advance(door, 0);
  await advancing.at;
  const loading = load(door, "T-brief");
  await latched.at;
  advanceMay.release();
  await advanced;

  expect(await loading).toEqual({ status: 200, body: { ok: true } });
  // The advance's clock event is the old room's last: the next room numbers on after it, nothing numbered twice.
  expect((await snapshotOf(door)).seq).toBe(BRIEF_SEEDED + 1 + BRIEF_LOADED);
  expect(logOf(door)[0]?.seq).toBe(BRIEF_SEEDED + 2);
});

test("key-lost waits for a command already under way: commands answer 409 loading meanwhile, the held one answers from its room, then the service restarts", async () => {
  // The first room's `demo.advance` is held once it has begun.
  const advancing = held();
  const advanceMay = held();
  const door = await startBrief({
    driver: async (o) => {
      const demo = await buildDemoRoom(o);
      const first = demo.room;
      const slow: Room = {
        ...first,
        demo: clockOf(first, {
          advance: async (ms) => {
            advancing.release();
            await advanceMay.at;
            return first.demo?.advance(ms);
          },
        }),
      };
      return {
        ...demo,
        get room() {
          return demo.room === first ? slow : demo.room;
        },
      };
    },
  });
  const advanced = send(door, { type: "demo.advance", ms: 0 });
  await advancing.at;
  let restarted = false;
  const lost = inject(door, "key-lost").finally(() => {
    restarted = true;
  });
  // The restart has begun: another command is refused, as during a load, until the held one has answered.
  let refused: Response;
  do refused = await send(door, { type: "refresh" });
  while (refused.status === 200 && !restarted);
  expect(restarted).toBe(false);
  expect([refused.status, await refused.json()]).toEqual([409, { error: "loading" }]);
  advanceMay.release();
  expect((await advanced).status).toBe(200);
  expect(await lost).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({ cause: { kind: "key-lost" } });
});

test("what the old room sends as it stops reaches no stream: they are told to reload, and no number is given twice", async () => {
  let rooms = 0;
  const door = await startBrief({
    driver: async (o) => {
      const demo = await buildDemoRoom(o);
      if (rooms++ > 0) return demo;
      // As "Run all checks" ending as the room stops: one event, sent by the stop itself.
      return patched(demo, (room) => ({
        stop: async () => {
          room.unlock();
          await room.stop();
        },
      }));
    },
  });
  const open = await stream(door, BRIEF_SEEDED);
  expect(await load(door, "T-brief")).toEqual({ status: 200, body: { ok: true } });
  const first = await next(open);
  expect([first.event, first.id]).toEqual([SSE.reload, null]);
  expect((await snapshotOf(door)).seq).toBe(BRIEF_SEEDED + BRIEF_LOADED);
});

test("an old room that numbers an event while the next is built fails the load: the old room answers on, the next is stopped and swept", async () => {
  let old: Room | null = null;
  const door = await startBrief({
    driver: async (o) => {
      if (old !== null) old.unlock();
      const demo = await buildDemoRoom(o);
      old ??= demo.room;
      return demo;
    },
  });
  const { status, body } = await load(door, "T-brief");
  expect(status).toBe(500);
  expect(body).toEqual({ error: expect.stringContaining("moved on") });
  expect((await snapshotOf(door)).seq).toBe(BRIEF_SEEDED + 1);
  expect((await send(door, { type: "refresh" })).status).toBe(200);
  expect(logOf(door).at(-1)?.seq).toBe(BRIEF_SEEDED + 1);
});

test("a load that fails after its room is built stops that room and sweeps its folder: the old room answers on", async () => {
  let rooms = 0;
  const door = await startBrief({
    driver: async (o) => {
      const demo = await buildDemoRoom(o);
      if (rooms++ === 0) return demo;
      return patched(demo, (room) => ({
        demo: clockOf(room, { advance: () => Promise.reject(new Error("the clock broke")) }),
      }));
    },
  });
  expect(await load(door, "T-brief")).toEqual({ status: 500, body: { error: "the clock broke" } });
  expect((await snapshotOf(door)).seq).toBe(BRIEF_SEEDED);
  expect(logOf(door).at(-1)?.seq).toBe(BRIEF_SEEDED);
});

test("a seed that throws midway stops its own room: the load fails and leaves nothing of it on disk", async () => {
  const lost: Scenario = {
    ...brief(),
    id: "T-lost",
    script: [{ at: 1 * MIN, move: { kind: "open", change: 999 } }],
  };
  const door = await startBrief({ scenarios: [brief(), lost] });
  const { status, body } = await load(door, "T-lost");
  expect(status).toBe(500);
  expect(body).toEqual({ error: "T-lost has no pull request #999" });
  expect(logOf(door).at(-1)?.seq).toBe(BRIEF_SEEDED);
});
