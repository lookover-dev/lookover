// The queue's rules, through the service's entry, on fakes only (no git, no process): a job starts once, whatever
// asks for it; a waiting job moves to the change's newest commit under the same id (ADR 0040); asking again for a
// deferred job only puts it back in the queue, and the take alone decides whether it starts (ADR 0042); the
// oldest waiting job goes first, one run per engine, and a job whose engine reviews another waits its turn; the
// take runs after a request, after a run ends, and every minute while a job waits on an engine, so a deferred
// review starts by itself (ADR 0043); a change has one waiting job, and a request while its job runs queues a
// follow-up that runs after it (#65). (A job left running at a restart: `recovery.test.ts`.)
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  apply,
  type ChangeId,
  changeId,
  commitSha,
  type EngineId,
  type Engines,
  type Event,
  jobId,
  type ReviewJob,
  type State,
  type Turn,
} from "@lookover/contracts";
import type { FakeChange } from "@lookover/testkit";
import {
  api,
  BOT,
  fakeEngines,
  HeldReviews,
  heldRuns,
  home,
  messages,
  openApp,
  PLANTED,
  post,
  pr1,
  review,
  SANDBOX,
  SHA1,
  SHA1_PUSHED,
  slowHealth,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const HEAD = SHA1;
/** A second push after `SHA1_PUSHED`. */
const NEWEST = commitSha("d4e5f60718293a4b5c6d7e8f9012345678a1b2c3");
const OTHER = changeId("sasensi/lookover-sandbox#9");
const TENTH = changeId("sasensi/lookover-sandbox#10");
/** Another pull request of the owner's, on the same commits as the first. */
const numbered = (number: number): FakeChange => ({
  ...pr1,
  number,
  url: pr1.url.replace(/\/1$/, `/${number}`),
});
const SIGNED_OUT = { reason: "engine-signed-out", engine: "claude" } as const;
const queued: ReviewJob = {
  id: jobId("id-1"),
  sha: HEAD,
  trigger: "manual",
  state: "queued",
  deferral: null,
  stepIn: null,
  skip: null,
  cancel: null,
  failure: null,
  turn: null,
};
// The owner's change, reviewed with both engines: Codex may step in for the signed-out Claude (ADR 0047).
const deferred: ReviewJob = { ...queued, state: "deferred", deferral: SIGNED_OUT, stepIn: "codex" };
const named = (e: { type: string; changeId?: string }) => (e.changeId ? `${e.type} ${e.changeId}` : e.type);
/** Waiting behind Claude reviewing `change` (ADR 0055). */
const behind = (change: ChangeId): Turn => ({
  behind: "engines",
  engines: ["claude"],
  changes: [change],
  testing: false,
});

/** Engines that count the health checks they answer: the take is the only one that asks (ADR 0042). */
function counted(engines: Engines) {
  const asked: EngineId[] = [];
  return {
    asked,
    engines: {
      run: (spec, signal) => engines.run(spec, signal),
      health: (engine) => {
        asked.push(engine);
        return engines.health(engine);
      },
    } satisfies Engines,
  };
}

test("a job is taken once: a second request while the first is admitting it leaves it queued, and it runs once", async () => {
  const slow = slowHealth(fakeEngines({ reviews: 1 }));
  const { service } = await start({ engines: slow.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // The first "Review now" takes the job and asks the engine's health, which is slow to answer.
  const health = slow.hold();
  const first = review(service, cookie);
  await health.asked;
  // A second "Review now" meanwhile: the job is taken, so it is left as it is, queued, and nothing runs.
  expect((await review(service, cookie)).status).toBe(200);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: queued, run: null });

  // The health answers: the first request starts the job, once.
  health.release();
  expect((await first).status).toBe(200);
  const events = await until(stream, "round.finished");
  expect(events.map((e) => e.type)).toEqual([
    "job.changed",
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
  expect(events.at(-1)).toMatchObject({ job: { ...queued, state: "done" }, round: { n: 1 } });
});

test("signed out defers the job, its check saying why; signed in, the next request re-queues it, the take starts it and round 1 posts", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const { service, host, time } = await start({ engines });
  const cookie = await openApp(service);
  const before: State = await snapshot(service, cookie);
  expect(before.engines.claude.state).toBe("signed-out");
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // Signed out: the job waits with its reason; nothing failed (ADR 0029). Asked for, then held.
  expect((await review(service, cookie)).status).toBe(200);
  const waiting = [...(await until(stream, "job.changed")), ...(await until(stream, "job.changed"))];
  expect(waiting.map((e) => e.type)).toEqual(["job.changed", "job.changed"]);
  expect(waiting.at(-1)).toMatchObject({ type: "job.changed", changeId: PLANTED, job: deferred });
  await time.advance(0);
  expect(
    host.posts.map((p) => (p.kind === "check.updated" ? `${p.kind} ${p.output.title}` : p.kind)),
  ).toEqual(["check.created", "check.updated Waiting: Claude is signed out"]);

  // Signed in: the next "Review now" puts the waiting job back in the queue (ADR 0042), the take asks the health,
  // sees Claude ready and starts it, and the round goes all the way through.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  expect((await review(service, cookie)).status).toBe(200);
  const events = await until(stream, "round.finished");
  expect(events.map((e) => e.type)).toEqual([
    "job.changed",
    "engine.changed",
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
  expect(events[0]).toMatchObject({ job: queued });
  expect(events[1]).toMatchObject({ type: "engine.changed", id: "claude", patch: { state: "ready" } });
  expect(events[2]).toMatchObject({
    changeId: PLANTED,
    job: { ...queued, state: "running" },
    run: {
      id: "id-2",
      reviewer: "claude",
      // Depth Standard (ADR 0044): Codex isn't installed, so the finder is planned to confirm, in a new session.
      confirmer: "claude",
      confirmFallback: { reason: "not-ready", engine: "codex", state: "missing" },
      sha: HEAD,
      preview: false,
      step: "preparing",
      steps: [],
    },
  });
  expect(events.at(-1)).toMatchObject({
    job: { ...queued, state: "done" },
    round: { n: 1, sha: HEAD, confirmer: null, confirmFallback: null, confirmFailure: null, ruledOut: [] },
  });
  await time.advance(0);
  // The job's one check: waiting (signed out, then its turn once asked again), in progress, completed by the round.
  expect(
    host.posts.map((p) => (p.kind === "check.updated" ? `${p.kind} ${p.output.title}` : p.kind)),
  ).toEqual([
    "check.created",
    "check.updated Waiting: Claude is signed out",
    "check.updated Waiting for its turn",
    "check.updated Looking over a1b2c3d",
    "review",
    "summary.created",
    "check.completed",
  ]);
  // A tab that followed the events and one that loads the snapshot see the same thing.
  const state: State = await snapshot(service, cookie);
  expect(state).toEqual([...waiting, ...events].reduce(apply, before));
  expect(state.engines.claude.state).toBe("ready");
});

test("a deferred job asked for again after a push moves to the newest commit as the same job, queued, and the take defers it again (ADR 0040)", async () => {
  const { service, host } = await start({ engines: fakeEngines({ signedIn: false }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect(
    [...(await until(stream, "job.changed")), ...(await until(stream, "job.changed"))].at(-1),
  ).toMatchObject({ job: deferred });

  // A push while it waits: the listing moves the same job to the new head, still deferred. Then "Review now":
  // back in the queue; its turn comes at once, and Claude is still signed out.
  host.push({ repo: SANDBOX, number: 1 }, SHA1_PUSHED, []);
  expect((await review(service, cookie)).status).toBe(200);
  const events = [
    ...(await until(stream, "job.changed")),
    ...(await until(stream, "job.changed")),
    ...(await until(stream, "job.changed")),
  ];
  expect(events.map(named)).toEqual([
    `change.pushed ${PLANTED}`,
    `job.changed ${PLANTED}`,
    `job.changed ${PLANTED}`,
    `job.changed ${PLANTED}`,
  ]);
  expect(events[1]).toMatchObject({ job: { ...deferred, sha: SHA1_PUSHED } });
  expect(events[2]).toMatchObject({ job: { ...queued, sha: SHA1_PUSHED } });
  expect(events[3]).toMatchObject({ job: { ...deferred, sha: SHA1_PUSHED } });
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({
    job: { ...deferred, sha: SHA1_PUSHED },
    run: null,
  });
});

/**
 * Both pull requests asked for while Claude is signed out, so both wait for it; then Claude signs in and the
 * tick starts the oldest. Gives the stream, the health checks counted, and what holds the run.
 */
async function bothDeferredThenOneRuns() {
  const engines = fakeEngines({ signedIn: false, reviews: 2 });
  const held = heldRuns(engines);
  const health = counted(held.engines);
  const started = await start({ engines: health.engines, changes: [pr1, numbered(9)] });
  const { service, time } = started;
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  for (const id of [PLANTED, OTHER]) {
    expect((await post(service, cookie, { type: "review.request", changeId: id })).status).toBe(200);
    await until(stream, "job.changed");
    expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
      changeId: id,
      job: { state: "deferred" },
    });
  }
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(60_000);
  return { ...started, engines, held, health, cookie, stream };
}
const takes = (e: { type: string }) => e.type === "job.changed" || e.type === "run.started";

test("a deferred job whose engine starts reviewing another waits its turn, queued, with no health asked for it; asked again, nothing changes; once the run ends it starts", async () => {
  const { service, held, health, cookie, stream } = await bothDeferredThenOneRuns();
  // The tick: Claude is ready, the oldest starts, and the other now waits its turn behind it, queued.
  const ticked = await until(stream, "job.changed");
  expect(ticked.filter(takes).map(named)).toEqual([`run.started ${PLANTED}`, `job.changed ${OTHER}`]);
  expect(ticked.at(-1)).toMatchObject({
    changeId: OTHER,
    job: { ...queued, id: jobId("id-2"), turn: behind(PLANTED) },
  });
  const checks = health.asked.length;

  // "Review now" on it: it already waits its turn; nothing is recorded, and no health is asked while Claude reviews.
  expect((await post(service, cookie, { type: "review.request", changeId: OTHER })).status).toBe(200);
  expect(health.asked).toHaveLength(checks);
  expect((await snapshot(service, cookie)).reviews[OTHER]).toMatchObject({
    job: { state: "queued" },
    run: null,
  });

  // The run's round is saved, and Claude is free (ADR 0044): the take asks, Claude is ready, and the job runs
  // while round 1 is posted.
  held.release();
  const events = [...(await until(stream, "round.finished")), ...(await until(stream, "round.finished"))];
  expect(events.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    `run.started ${OTHER}`,
    `round.finished ${PLANTED}`,
    `round.finished ${OTHER}`,
  ]);
  // Its finder, then Codex, the confirmer it would take were Codex ready now (ADR 0044): it isn't installed.
  expect(health.asked.slice(checks)).toEqual(["claude", "codex"]);
});

test("a job waiting its turn behind a run defers with its reason when Claude signed out by the time the run ends", async () => {
  const { service, engines, held, cookie, stream } = await bothDeferredThenOneRuns();
  await until(stream, "job.changed");

  // Signed out while the review runs; its round saved, Claude is free (ADR 0044): the take asks, and the job waits
  // again for Claude, while round 1 is posted.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: false });
  held.release();
  const events = [...(await until(stream, "job.changed")), ...(await until(stream, "round.finished"))];
  expect(events.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    "engine.changed",
    `job.changed ${OTHER}`,
    `round.finished ${PLANTED}`,
  ]);
  expect(events.find((e) => e.type === "job.changed")).toMatchObject({
    job: { ...deferred, id: jobId("id-2") },
  });
  expect((await snapshot(service, cookie)).reviews[OTHER]).toMatchObject({
    job: { ...deferred, id: jobId("id-2") },
    run: null,
  });
});

test("when a run ends and Claude has signed out meanwhile, every queued job is deferred, none left queued", async () => {
  const engines = fakeEngines({ reviews: 1 });
  const held = heldRuns(engines);
  const { service } = await start({ engines: held.engines, changes: [pr1, numbered(9), numbered(10)] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // The first pull request's job runs; the other two are asked for meanwhile and wait their turn.
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.step");
  for (const id of [OTHER, TENTH]) {
    expect((await post(service, cookie, { type: "review.request", changeId: id })).status).toBe(200);
  }
  const waiting = (await snapshot(service, cookie)).reviews;
  expect([waiting[OTHER]?.job?.state, waiting[TENTH]?.job?.state]).toEqual(["queued", "queued"]);

  // Claude signs out; the run's round is saved, and Claude is free (ADR 0044): each queued job is taken in turn,
  // and waits for Claude, while round 1 is posted.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: false });
  held.release();
  const ended = [
    ...(await until(stream, "job.changed")),
    ...(await until(stream, "job.changed")),
    ...(await until(stream, "round.finished")),
  ];
  expect(
    ended
      .filter((e) => e.type !== "run.step" && e.type !== "run.posting")
      .map(named)
      .slice(-4),
  ).toEqual(["engine.changed", `job.changed ${OTHER}`, `job.changed ${TENTH}`, `round.finished ${PLANTED}`]);
  const after = (await snapshot(service, cookie)).reviews;
  expect(after[OTHER]?.job).toMatchObject({ state: "deferred", deferral: SIGNED_OUT });
  expect(after[TENTH]?.job).toMatchObject({ state: "deferred", deferral: SIGNED_OUT });
});

test("a review deferred because Claude is signed out starts by itself once Claude reports ready, at the next tick, with nobody asking", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const { service, time } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect(
    [...(await until(stream, "job.changed")), ...(await until(stream, "job.changed"))].at(-1),
  ).toMatchObject({ job: deferred });

  // The owner signs Claude in, and asks nothing; a minute later the take looks again.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(60_000);
  const events = await until(stream, "round.finished");
  expect(events.map(named)).toEqual([
    "engine.changed",
    `run.started ${PLANTED}`,
    `run.step ${PLANTED}`,
    `run.step ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  expect(events.at(-1)).toMatchObject({ job: { ...queued, state: "done" }, round: { n: 1 } });
});

test("'Check again' reads both engines' health now and sends what changed: Codex signed out with why, and Claude signed in starts the review deferred on it", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  const { service } = await start({ engines });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).engines.codex.state).toBe("ready");
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect(
    [...(await until(stream, "job.changed")), ...(await until(stream, "job.changed"))].at(-1),
  ).toMatchObject({ job: deferred });

  // Codex was signed in again with an API key, which Lookover doesn't use; Claude's sign-in came. The owner presses
  // "Check again", no tick needed.
  const why =
    "Codex is signed in with an API key. Lookover uses your ChatGPT plan only: sign in with ChatGPT.";
  engines.setHealth("codex", {
    installed: true,
    version: "0.162.1",
    signedIn: false,
    why: { kind: "signed-in-otherwise", how: "an API key" },
  });
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  expect((await post(service, cookie, { type: "engine.check" })).status).toBe(200);
  const events = await until(stream, "round.finished");
  expect(events.map(named)).toEqual([
    "engine.changed",
    "engine.changed",
    `run.started ${PLANTED}`,
    `run.step ${PLANTED}`,
    `run.step ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  expect(events.slice(0, 2)).toMatchObject([
    { id: "claude", patch: { state: "ready", version: "2.4.1" } },
    { id: "codex", patch: { state: "signed-out", version: "0.162.1", detail: why } },
  ]);
  expect((await snapshot(service, cookie)).engines.codex).toMatchObject({ state: "signed-out", detail: why });
});

test("while Claude stays signed out, each tick asks Claude alone and an unchanged deferral tells nothing", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const health = counted(engines);
  const { service, time } = await start({ engines: health.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");
  const before = health.asked.length;

  // Two ticks: Claude, which the job waits for, is asked each time; the job is left as it is.
  await time.advance(59_999);
  expect(health.asked.slice(before)).toEqual([]);
  await time.advance(60_001);
  expect(health.asked.slice(before)).toEqual(["claude", "claude"]);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: deferred, run: null });

  // Signed in, the third tick starts it: the first events since the deferral are its start's.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(60_000);
  expect((await until(stream, "run.started")).map(named)).toEqual([
    "engine.changed",
    `run.started ${PLANTED}`,
  ]);
});

test("a job the owner sent to Codex has Codex's health asked before each take, not Claude's (ADR 0047)", async () => {
  // Claude signed out, Codex not installed: the job waits on Claude, then, sent to Codex, waits on Codex.
  const engines = fakeEngines({ signedIn: false });
  const health = counted(engines);
  const { service, time } = await start({ engines: health.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");

  // The reroute's take asks Codex alone: the finder is the engine the job was sent to.
  const before = health.asked.length;
  expect((await post(service, cookie, { type: "engine.reroute", from: "claude" })).status).toBe(200);
  await until(stream, "job.changed");
  expect(health.asked.slice(before)).toEqual(["codex"]);
  const missing = { reason: "engine-missing", engine: "codex" } as const;
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({
    job: { ...deferred, deferral: missing, stepIn: "claude" },
  });

  // Each tick asks Codex again, which the job now waits for; never Claude.
  const rerouted = health.asked.length;
  await time.advance(60_000);
  await time.advance(60_000);
  expect(health.asked.slice(rerouted)).toEqual(["codex", "codex"]);
});

test("a job asked for while Claude reviews waits its turn; when the run ends, the oldest waiting job goes first", async () => {
  const engines = fakeEngines({ reviews: 3 });
  const held = heldRuns(engines);
  const { service } = await start({ engines: held.engines, changes: [pr1, numbered(9), numbered(10)] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.step");

  // The tenth is asked for first, then the ninth, then the tenth again: asking again doesn't jump the line. Each
  // is queued, then waits behind Claude reviewing the first (ADR 0055); once the tenth runs, the ninth waits behind it.
  for (const id of [TENTH, OTHER, TENTH]) {
    expect((await post(service, cookie, { type: "review.request", changeId: id })).status).toBe(200);
  }
  held.release();
  const events = [
    ...(await until(stream, "round.finished")),
    ...(await until(stream, "round.finished")),
    ...(await until(stream, "round.finished")),
  ];
  const waits = events.filter((e) => e.type === "job.changed" || e.type === "run.started");
  expect(waits.map(named)).toEqual([
    `job.changed ${TENTH}`,
    `job.changed ${TENTH}`,
    `job.changed ${OTHER}`,
    `job.changed ${OTHER}`,
    `run.started ${TENTH}`,
    `job.changed ${OTHER}`,
    `run.started ${OTHER}`,
  ]);
  expect(waits.map((e) => (e.type === "job.changed" ? e.job.turn : null))).toEqual([
    null,
    behind(PLANTED),
    null,
    behind(PLANTED),
    null,
    behind(TENTH),
    null,
  ]);
});

test("'Review now' while the change's review runs queues a follow-up on the newest commit; the run finishes, then the follow-up runs (#65)", async () => {
  const engines = fakeEngines({ reviews: 2 });
  const held = heldRuns(engines);
  const { service, host } = await start({ engines: held.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.step");

  // The agent pushes while the review runs, and the owner asks again; then once more: the second ask joins the
  // follow-up, moved to the newest commit. The UI goes on showing the run, on its commit.
  host.push({ repo: SANDBOX, number: 1 }, SHA1_PUSHED, []);
  expect((await review(service, cookie)).status).toBe(200);
  host.push({ repo: SANDBOX, number: 1 }, NEWEST, []);
  expect((await review(service, cookie)).status).toBe(200);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({
    job: { ...queued, state: "running" },
    run: { sha: HEAD, step: "finding" },
  });

  // The run ends and posts round 1; the follow-up, a new job on the newest commit, then runs as round 2.
  held.release();
  const events = [
    ...(await until(stream, "round.finished")),
    ...(await until(stream, "round.finished")),
  ].filter((e) => e.type !== "run.step" && e.type !== "run.posting");
  expect(events.map(named)).toEqual([
    `change.pushed ${PLANTED}`,
    `change.pushed ${PLANTED}`,
    `round.finished ${PLANTED}`,
    `job.changed ${PLANTED}`,
    `run.started ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  const followUp: ReviewJob = { ...queued, id: jobId("id-3"), sha: NEWEST };
  expect(events[2]).toMatchObject({ job: { ...queued, state: "done" }, round: { n: 1, sha: HEAD } });
  // Shown once the run ended, its turn not said yet: its change's round is over (ADR 0055); it starts at once.
  expect(events[3]).toMatchObject({ job: { ...followUp, turn: null } });
  expect(events.at(-1)).toMatchObject({
    job: { ...followUp, state: "done", turn: null },
    round: { n: 2, sha: NEWEST },
  });
});

test("while a round is posted, its engine reviews another change, and the change's next review waits for the posts (ADR 0044)", async () => {
  const host = new HeldReviews({ repo: SANDBOX, bot: BOT, changes: [pr1, numbered(9)] });
  const { service } = await start({ host, engines: fakeEngines({ reviews: 3 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  // Round 1 is saved, and GitHub holds its review: Claude is free, and the change is not.
  await host.asked;
  expect((await review(service, cookie)).status).toBe(200);
  expect((await post(service, cookie, { type: "review.request", changeId: OTHER })).status).toBe(200);
  // The other change's review runs on Claude meanwhile, up to its own posts; the change's follow-up waits.
  const before = [...(await until(stream, "run.started")), ...(await until(stream, "run.started"))];
  expect(before.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    `job.changed ${PLANTED}`,
    `run.started ${PLANTED}`,
    `job.changed ${OTHER}`,
    `run.started ${OTHER}`,
  ]);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({
    job: { ...queued, state: "running" },
    run: { step: "publishing" },
  });

  // The reviews land: round 1 is posted, and only then does the change's next review run, as round 2.
  host.release();
  const after = [
    ...(await until(stream, "round.finished")),
    ...(await until(stream, "round.finished")),
    ...(await until(stream, "round.finished")),
  ].filter((e) => e.type !== "run.step" && e.type !== "run.posting" && named(e).endsWith(PLANTED));
  expect(after.map(named)).toEqual([
    `round.finished ${PLANTED}`,
    `job.changed ${PLANTED}`,
    `run.started ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  expect(after[0]).toMatchObject({ job: { ...queued, state: "done" }, round: { n: 1 } });
  expect(after.at(-1)).toMatchObject({ round: { n: 2 } });
});

test("two requests for a change whose job waits leave one waiting job, which runs once", async () => {
  const engines = fakeEngines({ reviews: 2 });
  const held = heldRuns(engines);
  const { service } = await start({ engines: held.engines, changes: [pr1, numbered(9)] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // The ninth runs, so Claude is busy: the first pull request's job waits its turn.
  expect((await post(service, cookie, { type: "review.request", changeId: OTHER })).status).toBe(200);
  await until(stream, "run.step");
  expect((await review(service, cookie)).status).toBe(200);
  expect((await review(service, cookie)).status).toBe(200);
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({
    job: { ...queued, id: jobId("id-3"), turn: behind(OTHER) },
    run: null,
  });

  held.release();
  const events = [...(await until(stream, "round.finished")), ...(await until(stream, "round.finished"))];
  // Asked, then waiting behind Claude reviewing the ninth (ADR 0055), then started.
  expect(events.filter(takes).map(named)).toEqual([
    `job.changed ${PLANTED}`,
    `job.changed ${PLANTED}`,
    `run.started ${PLANTED}`,
  ]);
  expect(events.filter((e) => e.type === "round.finished").map(named)).toEqual([
    `round.finished ${OTHER}`,
    `round.finished ${PLANTED}`,
  ]);
});

test("'Review now' on a change closed while its job waits answers no such change: it leaves the list, and the take cancels the job", async () => {
  const { service, host } = await start({ changes: [pr1], engines: fakeEngines({ signedIn: false }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect(
    [...(await until(stream, "job.changed")), ...(await until(stream, "job.changed"))].at(-1),
  ).toMatchObject({ job: deferred });

  // Closed on the host: the listing no longer has it, so it is gone, and its waiting job will never run.
  host.close({ repo: SANDBOX, number: 1 });
  expect((await review(service, cookie)).status).toBe(404);
  const events = await until(stream, "job.changed");
  expect(events.map(named)).toEqual([`change.closed ${PLANTED}`, `job.changed ${PLANTED}`]);
  expect(events.at(-1)).toMatchObject({ job: { id: jobId("id-1"), state: "cancelled", cancel: "closed" } });
  // It leaves the list; its review is kept (a reopening goes on from it), its job cancelled and why.
  const state: State = await snapshot(service, cookie);
  expect(state.changes[PLANTED]).toBeUndefined();
  expect(state.reviews[PLANTED]?.job).toMatchObject({ state: "cancelled", cancel: "closed" });
});

test("a job whose start rule can't be asked fails, and the queue goes on to the job queued behind it", async () => {
  const slow = slowHealth(fakeEngines({ reviews: 1 }));
  const { service, logged } = await start({ engines: slow.engines, changes: [pr1, numbered(9)] });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // The first pull request's job is taken; while its health is asked, the other one is asked for and queued.
  const health = slow.hold();
  const first = review(service, cookie);
  await health.asked;
  expect((await post(service, cookie, { type: "review.request", changeId: OTHER })).status).toBe(200);
  // The health check throws: that job fails with what it said, and the queue takes the next one.
  health.fail(new Error("health check broke"));
  expect((await first).status).toBe(200);
  const events = await until(stream, "round.finished");
  expect(events.map(named)).toEqual([
    `job.changed ${PLANTED}`,
    `job.changed ${OTHER}`,
    `job.changed ${PLANTED}`,
    `run.started ${OTHER}`,
    `run.step ${OTHER}`,
    `run.step ${OTHER}`,
    `run.posting ${OTHER}`,
    `run.posting ${OTHER}`,
    `run.posting ${OTHER}`,
    `run.posting ${OTHER}`,
    `run.posting ${OTHER}`,
    `round.finished ${OTHER}`,
  ]);
  const failed: ReviewJob = {
    ...queued,
    state: "failed",
    failure: { kind: "unexpected", detail: "Claude's health check threw: health check broke", engine: null },
  };
  expect(events[2]).toMatchObject({ job: failed });
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ job: failed, run: null });
  // The log says it once, the cause in the failure's line (ADR 0055).
  expect(logged.filter((line) => line.includes("failed"))).toEqual([
    "sasensi/lookover-sandbox#1 review failed: the review could not run (Claude's health check threw: health check broke)",
  ]);
});

test("an engine that refused its prompt fails the job, the failure saying what the engine said", async () => {
  const engines = fakeEngines();
  engines.answer({
    outcome: "invalid_output",
    text: "Input exceeds the maximum length of 1048576 characters.",
  });
  const { service } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  let last: Event | undefined;
  for (let i = 0; i < 5 && !(last?.type === "job.changed" && last.job.state === "failed"); i++) {
    last = (await until(stream, "job.changed")).at(-1);
  }
  expect(last).toMatchObject({
    job: {
      state: "failed",
      failure: {
        kind: "review_failed",
        detail: "invalid_output\nInput exceeds the maximum length of 1048576 characters.",
      },
    },
  });
});

test("a run whose folder can't be made fails its job, recorded, and the queue is free for the next request", async () => {
  const dir = home();
  // A file where the runs' folder goes: a run's folder can't be made.
  writeFileSync(join(dir, "runs"), "");
  const { service } = await start({ home: dir, engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  const failed = [...(await until(stream, "run.started")), ...(await until(stream, "job.changed"))];
  expect(failed.map((e) => e.type)).toEqual(["job.changed", "run.started", "job.changed"]);
  expect(failed.at(-1)).toMatchObject({
    changeId: PLANTED,
    job: { id: "id-1", state: "failed", failure: { kind: "unexpected" } },
  });
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.run).toBeNull();

  // The folder can be made again: the next "Review now" runs a new job.
  rmSync(join(dir, "runs"));
  expect((await review(service, cookie)).status).toBe(200);
  const events = await until(stream, "round.finished");
  expect(events.map((e) => e.type)).toEqual([
    "job.changed",
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
  expect(events.at(-1)).toMatchObject({ job: { id: "id-3", sha: HEAD, state: "done" } });
});
