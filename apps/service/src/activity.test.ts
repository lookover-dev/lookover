// What the engine does while a round runs (ADR 0055, "The engine's activity, live"), on the fakes and the held clock:
// the run gathers each pass's activities and sends them as `run.activity`, numbered and stored, only when there are
// new ones, at most one a second, each activity's whole text through the log sink's secrets filter and then cut to
// 200 characters; nothing once the run is cut.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineActivity, Event, RunActivity } from "@lookover/contracts";
import { DemoClock, type ScriptedActivity } from "@lookover/testkit";
import { openLogSink } from "./index.ts";
import {
  api,
  fakeEngines,
  home,
  messages,
  openApp,
  PLANTED,
  pr1,
  refusingActivities,
  review,
  snapshot,
  start,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const read = (path: string): EngineActivity => ({ kind: "read", path });
const at = (afterMs: number, activity: EngineActivity): ScriptedActivity => ({ afterMs, activity });
const claudeFound = (activity: EngineActivity): RunActivity => ({ engine: "claude", pass: "find", activity });

/** Engines whose one find pass takes `tookMs` on `time`, reporting `activity` as it goes. */
function enginesOf(time: DemoClock, activity: ScriptedActivity[], tookMs = 10_000) {
  const engines = fakeEngines({ time });
  engines.answer({ outcome: "ok", text: '```json\n{"findings": []}\n```', tookMs, activity });
  return engines;
}

/** The planted change's events of these types, in order. */
const of = (events: Event[], types: Event["type"][]) =>
  events.filter((e) => types.includes(e.type) && "changeId" in e && e.changeId === PLANTED);

test("a round's activities land between the finding step and its end, numbered and stored, at most one event a second, only when new", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = enginesOf(time, [
    at(100, read("src/a.ts")),
    at(200, read("src/b.ts")),
    at(300, read("src/c.ts")),
    at(2_500, { kind: "search", pattern: "listInvoices" }),
    at(2_600, { kind: "list", pattern: "**/*.ts" }),
    at(8_000, read("src/d.ts")),
  ]);
  const { service } = await start({ time, engines, changes: [pr1] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  const seen = await until(stream, "run.started");
  const startedAt = seen.at(-1)?.at ?? 0;
  await time.advance(3_000);
  // Halfway: the snapshot (what a reload sees) holds the lines so far, from the store's events.
  const running = await snapshot(service, cookie);
  expect(running.reviews[PLANTED].run.activities).toEqual([
    claudeFound(read("src/a.ts")),
    claudeFound(read("src/b.ts")),
    claudeFound(read("src/c.ts")),
    claudeFound({ kind: "search", pattern: "listInvoices" }),
  ]);
  await time.advance(7_000);
  seen.push(...(await until(stream, "round.finished")));

  const lived = of(seen, ["run.step", "run.activity", "round.finished"]);
  expect(lived.map((e) => e.type)).toEqual([
    "run.step",
    "run.activity",
    "run.activity",
    "run.activity",
    "run.activity",
    "run.activity",
    "run.step",
    "round.finished",
  ]);
  expect(lived[0]).toMatchObject({ type: "run.step", step: "finding" });
  const activities = lived.flatMap((e) => (e.type === "run.activity" ? [e] : []));
  // The first at once; the two heard within its second, together a second after it; and so on.
  expect(activities.map((e) => [e.at - startedAt, e.activities])).toEqual([
    [100, [claudeFound(read("src/a.ts"))]],
    [1_100, [claudeFound(read("src/b.ts")), claudeFound(read("src/c.ts"))]],
    [2_500, [claudeFound({ kind: "search", pattern: "listInvoices" })]],
    [3_500, [claudeFound({ kind: "list", pattern: "**/*.ts" })]],
    [8_000, [claudeFound(read("src/d.ts"))]],
  ]);
  const numbers = activities.map((e) => e.seq);
  expect(numbers.every((n, i) => i === 0 || n > (numbers[i - 1] ?? 0))).toBe(true);
  // The run goes with its round: the lines were live only.
  expect((await snapshot(service, cookie)).reviews[PLANTED].run).toBeNull();
});

/** A GitHub token, by its shape: what the log sink's filter removes whoever wrote it. */
const TOKEN = `ghp_${"S".repeat(36)}`;

test("a token in an activity's text never reaches an event, also where the 200-character cut would halve it", async () => {
  const time = new DemoClock({ at: T0 });
  const long = `${"d/".repeat(95)}${TOKEN}/invoices.ts`;
  const engines = enginesOf(time, [
    at(100, read(`src/${TOKEN}.ts`)),
    at(1_200, read(long)),
    at(2_400, { kind: "command", text: `curl -H "Authorization: token ${TOKEN}" ${"x".repeat(300)}` }),
  ]);
  const { service } = await start({ time, engines, changes: [pr1] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  await time.advance(10_000);
  const seen = await until(stream, "round.finished");

  const texts = of(seen, ["run.activity"]).flatMap((e) =>
    e.type === "run.activity" ? e.activities.map((a) => a.activity) : [],
  );
  expect(texts).toEqual([
    read("src/[redacted].ts"),
    read(`${"d/".repeat(95)}[redacted]`),
    // The filter takes an `Authorization` value with its scheme.
    { kind: "command", text: `curl -H "Authorization: [redacted]" ${"x".repeat(164)}` },
  ]);
  expect(JSON.stringify(seen)).not.toContain("ghp_S");
});

test("a secret the service registered with the log sink is removed from an activity too", async () => {
  const dir = home();
  const sink = await openLogSink({ home: dir, clock: { now: () => T0 }, userOnly: async () => {} });
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time });
  const { service } = await start({ home: dir, time, engines, changes: [pr1], logSink: sink });
  // The session's secret, registered with the sink as the server started.
  const secret = readFileSync(join(dir, "session"), "utf8");
  engines.answer({
    outcome: "ok",
    text: '```json\n{"findings": []}\n```',
    tookMs: 1_000,
    activity: [at(100, { kind: "search", pattern: `cookie=${secret}` })],
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  await time.advance(1_000);
  const seen = await until(stream, "round.finished");

  expect(of(seen, ["run.activity"])).toMatchObject([
    { activities: [claudeFound({ kind: "search", pattern: "cookie=[redacted]" })] },
  ]);
  expect(JSON.stringify(seen)).not.toContain(secret);
});

test("nothing is sent once the run is cut: the activities still held for the next second go with it", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = enginesOf(time, [at(100, read("src/a.ts")), at(200, read("src/b.ts"))], 60_000);
  const { room } = await startRoom({ time, engines, changes: [pr1] });
  expect(await room.review(PLANTED)).toBe("ok");
  await time.advance(500);
  const before = room.events.last();
  await room.stop();
  await time.advance(5_000);
  expect(room.events.last()).toBe(before);
});

test("a round that ends with an activity held drops it: nothing follows the round, its timer cancelled", async () => {
  const time = new DemoClock({ at: T0 });
  // The second activity waits for 1.1 s; the find pass ends at 1 s.
  const engines = enginesOf(time, [at(100, read("src/a.ts")), at(200, read("src/b.ts"))], 1_000);
  const { room } = await startRoom({ time, engines, changes: [pr1] });
  const seen: Event[] = [];
  const finished = new Promise<void>((resolve) =>
    room.events.subscribe((event) => {
      seen.push(event);
      if (event.type === "round.finished") resolve();
    }),
  );
  expect(await room.review(PLANTED)).toBe("ok");
  await time.advance(1_000);
  await finished;
  await time.advance(5_000);

  expect(of(seen, ["run.step", "run.activity", "round.finished"]).map((e) => e.type)).toEqual([
    "run.step",
    "run.activity",
    "run.step",
    "round.finished",
  ]);
  expect(of(seen, ["run.activity"])).toMatchObject([{ activities: [claudeFound(read("src/a.ts"))] }]);
});

test("activities whose delayed event can't be written are dropped and logged: the run goes on to its round's end", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  // The first is sent at once; the second waits a second, and its write fails, as a full disk would.
  const engines = enginesOf(time, [at(100, read("src/a.ts")), at(200, read("src/b.ts"))], 3_000);
  const { room, logged } = await startRoom({
    home: dir,
    time,
    engines,
    changes: [pr1],
    store: refusingActivities(dir, 1, 1),
  });
  const seen: Event[] = [];
  const finished = new Promise<void>((resolve) =>
    room.events.subscribe((event) => {
      seen.push(event);
      if (event.type === "round.finished") resolve();
    }),
  );
  expect(await room.review(PLANTED)).toBe("ok");
  await time.advance(3_000);
  await finished;

  expect(of(seen, ["run.activity"])).toMatchObject([{ activities: [claudeFound(read("src/a.ts"))] }]);
  expect(logged).toContain("The engine's activity was not sent: disk full");
});
