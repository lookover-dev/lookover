// A data folder an older version wrote (ADR 0085, #671), through the service's door on the held demo clock and the
// fake host: its log holds a `state.replaced` saying 0.9.0 and a `service.changed`, both with a check result in 0.3.0's
// shape, a repository in an old shape and an event `apply` throws on. The start serves this version, no check
// results, the watched repository back and the review it can read, says what it dropped and skipped, and a start
// after it ends on the same state.
import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { changeId, repositoryId, type State } from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  HeldReviews,
  home,
  lastEvent,
  messages,
  ONE_FINDING,
  OWNER,
  onTheDiff,
  openApp,
  post,
  pr1,
  pr2,
  review,
  SANDBOX,
  SHARED_BOT,
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

const MIN = 60_000;
const ID = changeId("sasensi/lookover-sandbox#1");
const REPO_ID = repositoryId("sasensi/lookover-sandbox");

/** Appends `bodies` to the data folder's log as an older version wrote them: JSON, unchecked. */
function written(dir: string, bodies: unknown[]): void {
  const db = new Database(join(dir, "lookover.sqlite"), { strict: true });
  const insert = db.query("INSERT INTO events (body) VALUES (?)");
  for (const body of bodies) insert.run(JSON.stringify(body));
  db.close();
}

/** The types of the events the data folder's log holds after `seq`, in order. */
function typesAfter(dir: string, seq: number): string[] {
  const db = new Database(join(dir, "lookover.sqlite"), { strict: true, readonly: true });
  const rows = db
    .query<{ type: string }, [number]>(
      "SELECT json_extract(body, '$.type') AS type FROM events WHERE seq > ? ORDER BY seq",
    )
    .all(seq);
  db.close();
  return rows.map((r) => r.type);
}

/** The state with what each start sets anew (its number, its time) taken out. */
const settled = (state: State) => ({ ...state, seq: 0, now: 0 });

/** A data folder where the sandbox's pull request #1 was reviewed once, its service stopped, and its state then. */
async function reviewedOnce() {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [], clock: time });
  const first = await start({ home: dir, host, time, engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  host.open(pr1);
  await time.advance(MIN);
  await until(stream, "round.finished");
  const before: State = await snapshot(first.service, cookie);
  await first.service.stop();
  return { dir, time, host, before };
}

test("a data folder an older version wrote: this version, no checks, the repository back, the readable review, and what was dropped said", async () => {
  const { dir, time, host, before } = await reviewedOnce();

  // As 0.9.0 left it (#671): its renaming's `state.replaced` freezing its version and 0.3.0's check item, a
  // `service.changed` carrying that check result again (no `atLogin`), then a repository in an older shape, and an
  // event this version's `apply` throws on.
  const at = T0 + 2 * MIN;
  const oldCheck = { check: "service", state: "running", since: T0, startsAtLogin: true };
  const oldChecks = { at, running: false, items: [oldCheck] };
  written(dir, [
    {
      type: "state.replaced",
      at,
      state: { ...before, service: { ...before.service, version: "0.9.0", checks: oldChecks } },
    },
    { type: "service.changed", at, patch: { checks: oldChecks } },
    { type: "repo.added", at, repo: { id: REPO_ID, owner: SANDBOX.owner, name: SANDBOX.name } },
    { type: "change.opened", at },
  ]);
  const planted = lastEvent(dir);

  const logged: string[] = [];
  const second = await start({
    home: dir,
    host,
    time,
    engines: fakeEngines(),
    idsFrom: 100,
    version: "0.12.0",
    log: (line) => logged.push(line),
  });
  const cookie2 = await openApp(second.service);
  const state: State = await snapshot(second.service, cookie2);
  expect(state.service.version).toBe("0.12.0");
  expect(state.service.checks).toBeNull();
  expect(state.repos.map((r) => [r.id, r.enabled])).toEqual([[REPO_ID, true]]);
  expect(Object.keys(state.changes)).toEqual([ID]);
  expect(state.reviews[ID]?.rounds.map((r) => r.n)).toEqual([1]);

  // The start's first event replaces the state, one only, before the repository is sent again and before the
  // snapshot is served: the snapshot is current up to the last event, so a tab that loads it never applies an event
  // twice.
  const types = typesAfter(dir, planted);
  expect(types).toEqual(["state.replaced", "repo.added"]);
  expect(state.seq).toBe(lastEvent(dir));

  // The log file names each piece dropped and each event skipped.
  expect(logged.some((line) => line.startsWith(`skipped event ${planted} (change.opened): `))).toBe(true);
  expect(logged.some((line) => line.startsWith(`dropped repos ${REPO_ID}: enabled: `))).toBe(true);
  await second.service.stop();

  // The log is not rewritten: the next start reads the same events and ends on the same state, replacing nothing.
  const last = lastEvent(dir);
  const third = await start({
    home: dir,
    host,
    time,
    engines: fakeEngines(),
    idsFrom: 200,
    version: "0.12.0",
  });
  const again: State = await snapshot(third.service, await openApp(third.service));
  expect(settled(again)).toEqual(settled(state));
  expect(typesAfter(dir, last)).not.toContain("state.replaced");
});

test("an open pull request whose review an older version wrote comes back from the start's listing, its old review dropped", async () => {
  const { dir, time, host, before } = await reviewedOnce();
  const job = before.reviews[ID]?.job;
  if (!job) throw new Error("no job");
  // A job as written before ADR 0081: no `askedBy`.
  const { askedBy: _, ...old } = job;
  written(dir, [{ type: "job.changed", at: T0 + 2 * MIN, changeId: ID, job: old }]);

  const last = lastEvent(dir);

  const logged: string[] = [];
  const second = await start({ home: dir, host, time, idsFrom: 100, log: (line) => logged.push(line) });
  const cookie = await openApp(second.service);
  const stream = messages(await fetch(api(second.service, "/events"), { headers: { cookie } }));
  const state: State = await snapshot(second.service, cookie);
  expect(state.changes[ID]).toMatchObject({ id: ID, title: pr1.title, number: 1 });
  expect(state.reviews[ID]?.rounds).toEqual([]);
  expect(logged).toContain(
    `dropped reviews ${ID}: job.askedBy: Invalid option: expected one of "agent"|"person"`,
  );
  expect(logged).toContain(`dropped changes ${ID}: its review was dropped`);

  // The next poll lists the same pull request beside a new one: only the new one is opened.
  host.open(pr2);
  await time.advance(MIN);
  await until(stream, "change.opened");
  expect(typesAfter(dir, last).filter((type) => type === "change.opened")).toEqual([
    "change.opened",
    "change.opened",
  ]);
  expect(Object.keys((await snapshot(second.service, cookie)).changes).sort()).toEqual(
    [ID, changeId("sasensi/lookover-sandbox#2")].sort(),
  );
});

test("a replayed object carrying a key beyond its type: the state read is sent, and the log says where it differed with nothing dropped", async () => {
  const { dir, time, host, before } = await reviewedOnce();
  const job = before.reviews[ID]?.job;
  if (!job) throw new Error("no job");
  written(dir, [
    { type: "job.changed", at: T0 + 2 * MIN, changeId: ID, job: { ...job, carried: "beyond its type" } },
  ]);
  const last = lastEvent(dir);

  const logged: string[] = [];
  const second = await start({ home: dir, host, time, idsFrom: 100, log: (line) => logged.push(line) });
  const state: State = await snapshot(second.service, await openApp(second.service));
  expect(state.reviews[ID]?.job).toEqual(job);
  expect(typesAfter(dir, last)[0]).toBe("state.replaced");
  expect(logged.filter((line) => line.startsWith("dropped "))).toEqual([]);
  expect(logged).toContain(
    `the state read differs from the replay at reviews.${ID}.job.carried with nothing dropped: sent as read`,
  );
});

test("an open pull request whose review was dropped at start shows its job still waiting again", async () => {
  // Paused, the pull request's review waits, deferred, in the jobs table across the stop.
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [], clock: time });
  const first = await start({ home: dir, host, time });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  expect((await post(first.service, cookie, { type: "service.pause", for: "forever" })).status).toBe(200);
  host.open(pr1);
  await time.advance(MIN);
  await until(stream, "job.changed");
  const job = (await snapshot(first.service, cookie)).reviews[ID]?.job;
  expect(job).toMatchObject({ state: "deferred", deferral: { reason: "paused" } });
  if (!job) throw new Error("no job");
  await first.service.stop();
  // Its review, as written before ADR 0081: dropped at start, while its job still waits.
  const { askedBy: _, ...old } = job;
  written(dir, [{ type: "job.changed", at: T0 + 2 * MIN, changeId: ID, job: old }]);

  const second = await start({ home: dir, host, time, idsFrom: 100 });
  const state: State = await snapshot(second.service, await openApp(second.service));
  expect(state.changes[ID]).toMatchObject({ id: ID, number: 1 });
  expect(state.reviews[ID]?.job).toEqual(job);
});

test("a review dropped at start while its job was stopped mid-publishing shows its run again, and its posts move on", async () => {
  // The service stops while GitHub holds the round's review: its job is left running, its run at publishing.
  const dir = home();
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const retrieval = onTheDiff();
  const host = new HeldReviews({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1] });
  const first = await start({ home: dir, host, engines, retrieval });
  const cookie = await openApp(first.service);
  await review(first.service, cookie);
  await host.asked;
  const before = (await snapshot(first.service, cookie)).reviews[ID];
  const job = before?.job;
  const run = before?.run;
  if (!job || !run) throw new Error("no running job");
  expect(run.step).toBe("publishing");
  await first.service.stop();
  // Its review, as written before ADR 0081: dropped at start, while its job still runs.
  const { askedBy: _, ...old } = job;
  written(dir, [{ type: "job.changed", at: first.time.now() + MIN, changeId: ID, job: old }]);
  const last = lastEvent(dir);

  const second = await start({ home: dir, host, engines, retrieval, time: first.time, idsFrom: 100 });
  const again = await openApp(second.service);
  const stream = await sinceStart(second.service, again, last);
  await until(stream, "run.posting");
  // The review shows its run at publishing, as the store holds it, and the posts its outbox counts.
  const state: State = await snapshot(second.service, again);
  expect(state.reviews[ID]?.job).toEqual(job);
  expect(state.reviews[ID]?.run).toEqual({
    ...run,
    activities: [],
    posting: { sent: 1, owed: 4, wait: null },
  });

  host.release();
  await until(stream, "round.finished");
  const after: State = await snapshot(second.service, again);
  expect(after.reviews[ID]?.rounds.map((r) => r.n)).toEqual([1]);
});

test("an event this version doesn't know, a newer version's, is skipped and said: the events before and after it stay", async () => {
  const { dir, time, host, before } = await reviewedOnce();
  const head = before.changes[ID]?.headSha;
  if (!head) throw new Error("no change");
  const at = T0 + 2 * MIN;
  written(dir, [
    { type: "review.pinned", at, changeId: ID },
    { type: "change.pushed", at, changeId: ID, sha: head, commits: 0, by: "agent" },
  ]);
  const planted = lastEvent(dir);

  const logged: string[] = [];
  const second = await start({ home: dir, host, time, idsFrom: 100, log: (line) => logged.push(line) });
  const state: State = await snapshot(second.service, await openApp(second.service));
  expect(state.reviews[ID]?.rounds.map((r) => r.n)).toEqual([1]);
  expect(state.reviews[ID]?.timeline.at(-1)).toMatchObject({ kind: "pushed", by: "agent", at });
  expect(logged.filter((line) => line.startsWith("dropped "))).toEqual([]);
  expect(logged).toContain(
    `skipped event ${planted - 1} (review.pinned): this version doesn't know this event`,
  );
});

test("an update on a folder this version reads states its version and drops the checks, replacing nothing", async () => {
  const { dir, time, host } = await reviewedOnce();
  const last = lastEvent(dir);
  const second = await start({ home: dir, host, time, idsFrom: 100, version: "0.12.0" });
  const state: State = await snapshot(second.service, await openApp(second.service));
  expect(state.service).toMatchObject({
    version: "0.12.0",
    checks: null,
    unlocked: false,
    loginItem: "stand-in",
  });
  const types = typesAfter(dir, last);
  expect(types[0]).toBe("service.changed");
  expect(types).not.toContain("state.replaced");
});
