// What the service reads to decide (#64, spec #69): the queue and the run read the open changes and the jobs from
// the store's handles, never a replay of the event log, so a decision costs the same after a year of history as
// on the first day; the snapshot is the UI's state, kept in memory and built from the log once, at start.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  api,
  fakeEngines,
  home,
  messages,
  openApp,
  recordedStore,
  review,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

/** What the service reads and writes in the store for one review, from "Review now" to its round, with `past` events. */
async function readsOfOneReview(past: number): Promise<string[]> {
  const dir = home();
  const { store, calls } = recordedStore(dir, past);
  const { service, time } = await start({ home: dir, store, engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  calls.length = 0;
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "round.finished");
  // The take after the run's end settles too.
  await time.advance(0);
  return calls.toSorted();
}

test("a review reads the same from the store with 10 or 10,000 events recorded, and never the event log", async () => {
  const few = await readsOfOneReview(10);
  const many = await readsOfOneReview(10_000);
  expect(many).toEqual(few);
  expect(few.filter((call) => call.startsWith("events.all"))).toEqual([]);
});

test("the snapshot reads the event log once, at start, and follows each event after that", async () => {
  const dir = home();
  const { store, calls } = recordedStore(dir, 10);
  const { service } = await start({ home: dir, store, engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  const events = await until(stream, "round.finished");
  const shown = await snapshot(service, cookie);
  await snapshot(service, cookie);
  expect(calls.filter((call) => call.startsWith("events.all"))).toEqual(["events.all (10 rows)"]);
  // The snapshot holds what the events said: the last one's number, and the round it finished.
  expect(shown.seq).toBe(events.at(-1)?.seq);
  expect(shown.reviews["lookover-sandbox#1"]).toMatchObject({ job: { state: "done" }, rounds: [{ n: 1 }] });
});
