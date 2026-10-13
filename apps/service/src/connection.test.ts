// The host's connection, through the service's entry, on fakes only (ADR 0047): a listing GitHub refuses as
// unauthorised or unavailable shows the connection disconnected, a review asked meanwhile waits on it, and a
// listing that answers (the owner's "Reconnect", or the loop's next poll) shows it connected and starts what
// waited. A rate limit is no disconnection: the connection only says until when. A disconnection carries its cause
// (ADR 0053): GitHub unreachable, or its key refused; connected again, none.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { jobId, type ReviewJob } from "@lookover/contracts";
import {
  api,
  fakeEngines,
  messages,
  openApp,
  PLANTED,
  post,
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

const MIN = 60_000;
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
const waitingOnHost: ReviewJob = { ...queued, state: "deferred", deferral: { reason: "connection" } };
const named = (e: { type: string; changeId?: string }) => (e.changeId ? `${e.type} ${e.changeId}` : e.type);

test("a listing GitHub refuses shows the connection disconnected; a review asked meanwhile waits on it; Reconnect lists, and the review starts", async () => {
  const { service, host, time } = await start({ engines: fakeEngines({ reviews: 1 }), log: () => {} });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // GitHub is down at the loop's next listing, a minute after the start.
  host.refuse("unavailable");
  await time.advance(MIN);
  expect(await until(stream, "connection.changed")).toEqual([
    {
      type: "connection.changed",
      seq: 5,
      at: T0 + MIN,
      patch: { state: "disconnected", cause: { kind: "unreachable" }, since: T0 + MIN },
    },
  ]);

  // "Review now" still records the review, on the head of the last listing: it waits for GitHub.
  expect((await review(service, cookie)).status).toBe(200);
  const asked = [...(await until(stream, "job.changed")), ...(await until(stream, "job.changed"))];
  expect(asked.map(named)).toEqual([`job.changed ${PLANTED}`, `job.changed ${PLANTED}`]);
  expect(asked.at(-1)).toMatchObject({ job: waitingOnHost });
  const shown = await snapshot(service, cookie);
  expect(shown.connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "unreachable" },
    since: T0 + MIN,
    limitUntil: null,
  });
  expect(shown.reviews[PLANTED]).toMatchObject({ job: waitingOnHost, run: null });

  // "Reconnect" while GitHub still refuses: the refusal is the answer, and nothing changes.
  const refused = await post(service, cookie, { type: "connection.reconnect" });
  expect(refused.status).toBe(502);
  expect(await refused.json()).toEqual({ error: "unavailable" });
  expect((await snapshot(service, cookie)).connection.state).toBe("disconnected");
  // Still down, for another cause: the connection shows the new one, lost since the first.
  host.refuse("unauthorized");
  expect((await post(service, cookie, { type: "connection.reconnect" })).status).toBe(502);
  expect((await snapshot(service, cookie)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "key-refused", why: null },
    since: T0 + MIN,
  });
  expect((await until(stream, "connection.changed")).at(-1)).toMatchObject({
    patch: { cause: { kind: "key-refused", why: null } },
  });

  // GitHub answers again: "Reconnect" lists, the connection is back, and the review that waited runs.
  host.refuse(null);
  expect((await post(service, cookie, { type: "connection.reconnect" })).status).toBe(200);
  const back = await until(stream, "round.finished");
  expect(back.map((e) => e.type)).toEqual([
    "connection.changed",
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
  expect(back[0]).toMatchObject({
    at: T0 + MIN,
    patch: { state: "connected", cause: null, since: T0 + MIN },
  });
  expect(back.at(-1)).toMatchObject({ job: { ...queued, state: "done" } });
  expect((await snapshot(service, cookie)).connection).toMatchObject({
    state: "connected",
    cause: null,
    since: T0 + MIN,
  });
});

test("unauthorised disconnects the same; the loop's next listing that answers reconnects by itself; a rate limit only says until when", async () => {
  const { service, host, time } = await start({ engines: fakeEngines({ reviews: 1 }), log: () => {} });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // The App's key refused: disconnected, and the review asked waits.
  host.refuse("unauthorized");
  await time.advance(MIN);
  expect((await until(stream, "connection.changed")).at(-1)).toMatchObject({
    patch: { state: "disconnected", cause: { kind: "key-refused", why: null }, since: T0 + MIN },
  });
  await review(service, cookie);
  await until(stream, "job.changed");
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: waitingOnHost });

  // GitHub answers again: the loop lists 10 s later (a review waits: the hot cadence), nobody asking, and the
  // review runs.
  host.refuse(null);
  await time.advance(10_000);
  const back = await until(stream, "round.finished");
  expect(back.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    "connection.changed",
    `run.started ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  expect(back[0]).toMatchObject({
    at: T0 + MIN + 10_000,
    patch: { state: "connected", cause: null, since: T0 + MIN + 10_000 },
  });

  // A rate limit is a wait, not a disconnection: the connection stays connected and says until when.
  const resetAt = time.now() + 5 * MIN;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(MIN);
  expect((await until(stream, "connection.changed")).at(-1)).toMatchObject({
    patch: { limitUntil: resetAt },
  });
  expect((await snapshot(service, cookie)).connection).toMatchObject({
    state: "connected",
    limitUntil: resetAt,
  });
});

test("the App uninstalled after a listing answered shows the connection disconnected, uninstalled; Review now still records the review, waiting on it", async () => {
  const { service, host, time } = await start({ engines: fakeEngines({ reviews: 1 }), log: () => {} });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // GitHub refuses the token's installation as not found, its cause saying the App is gone.
  host.uninstall();
  await time.advance(MIN);
  expect((await until(stream, "connection.changed")).at(-1)).toMatchObject({
    patch: { state: "disconnected", cause: { kind: "uninstalled", suspended: false }, since: T0 + MIN },
  });

  // "Review now": the listing refused is no answer, and the review waits on the connection.
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: waitingOnHost });
});
