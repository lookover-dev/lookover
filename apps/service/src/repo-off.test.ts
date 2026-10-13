// A request in a repository switched off (ADR 0047), through the service's door on the held demo clock: "Review
// now" and `/lookover review` are recorded as a skip that says the repository is off, in the snapshot and on the
// check, never honoured and never lost; beside a review already waiting or running, the request joins it, so the
// pending review is never hidden; and the owner's request on a draft is reviewed as before.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, repositoryId } from "@lookover/contracts";
import {
  api,
  fakeEngines,
  heldRuns,
  messages,
  OWNER,
  openApp,
  post,
  pr1,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const ONE = changeId("lookover-sandbox#1");
const REPO = repositoryId(`${SANDBOX.owner}/${SANDBOX.name}`);
const ref = { repo: SANDBOX, number: 1 };
const off = { type: "repo.setEnabled", repoId: REPO, enabled: false };

test("Review now in a repository switched off is recorded as a skip, and its check says the repository is off", async () => {
  const { service, host, time } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  expect((await post(service, cookie, off)).status).toBe(200);
  expect((await snapshot(service, cookie)).repos).toMatchObject([{ id: REPO, enabled: false }]);

  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[ONE]?.job).toMatchObject({
    trigger: "manual",
    state: "skipped",
    skip: "repo-off",
  });
  expect(host.view(ref).checks.map((c) => [c.status, c.conclusion, c.output.title])).toEqual([
    ["completed", "skipped", "Reviews are off for this repository"],
  ]);
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
});

test("/lookover review in a repository switched off is recorded as a skip too", async () => {
  const { service, host, time } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  expect((await post(service, cookie, off)).status).toBe(200);
  await time.advance(5_000);
  host.seedComment(ref, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[ONE]?.job).toMatchObject({
    trigger: "comment",
    state: "skipped",
    skip: "repo-off",
  });
  expect(host.view(ref).checks.map((c) => c.conclusion)).toEqual(["skipped"]);
});

test("a request beside a review already waiting joins it, the repository switched off since: no skip hides it", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // Claude is signed out: the owner's review waits on it.
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  const waiting = (await snapshot(service, cookie)).reviews[ONE]?.job;
  expect(waiting).toMatchObject({ state: "deferred", trigger: "manual" });

  expect((await post(service, cookie, off)).status).toBe(200);
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  host.seedComment(ref, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[ONE]?.job).toMatchObject({
    id: waiting?.id,
    state: "deferred",
    skip: null,
  });
  expect(
    host
      .view(ref)
      .checks.map((c) => c.conclusion)
      .filter((c) => c === "skipped"),
  ).toEqual([]);

  // Signed in, the review that waited runs.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(MIN);
  await until(stream, "round.finished");
  expect((await snapshot(service, cookie)).reviews[ONE]?.job).toMatchObject({
    id: waiting?.id,
    state: "done",
  });
});

test("a request beside a review running, the repository switched off since, queues the follow-up review as any request does", async () => {
  const held = heldRuns(fakeEngines({ reviews: 2 }));
  const { service, host, time } = await start({ changes: [pr1], engines: held.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await until(stream, "run.started");

  // Joining the change's pending job is the rule (ADR 0047): while it runs, that is a follow-up behind it, never a
  // skip. On purpose: the owner asked in person, and the review running is shown until it ends.
  expect((await post(service, cookie, off)).status).toBe(200);
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  held.release();
  await until(stream, "round.finished");
  await until(stream, "round.finished");
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[ONE]).toMatchObject({
    job: { trigger: "manual", state: "done", skip: null },
    rounds: [{ n: 1 }, { n: 2 }],
  });
  expect(
    host
      .view(ref)
      .checks.map((c) => c.conclusion)
      .filter((c) => c === "skipped"),
  ).toEqual([]);
});

test("the owner's request on a draft is still reviewed", async () => {
  const { service, host } = await start({
    changes: [{ ...pr1, draft: true }],
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await until(stream, "round.finished");
  expect((await snapshot(service, cookie)).reviews[ONE]?.job).toMatchObject({
    trigger: "manual",
    state: "done",
  });
  expect(host.posts.filter((p) => p.kind === "review")).toHaveLength(1);
});
