// The first review (ADR 0047), through the service's door on the held demo clock: "Preview here only, post
// nothing" runs a real review whose round is kept with an empty outbox and marked a preview, with nothing on the
// host (no check, no review, no reaction); "Review this pull request" is an ordinary request that posts, with the
// first-review trigger. Either way the setup keeps the change it was asked for.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, repositoryId } from "@lookover/contracts";
import { openStore, type Store } from "@lookover/store";
import { DemoClock, FakeGitHost, type ScriptedRun } from "@lookover/testkit";
import {
  api,
  BOT,
  fakeEngines,
  home,
  lastEvent,
  messages,
  OWNER,
  openApp,
  post,
  pr1,
  SANDBOX,
  SHA1,
  SHA1_PUSHED,
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

const ONE = changeId("sasensi/lookover-sandbox#1");
const ref = { repo: SANDBOX, number: 1 };
const REPO = repositoryId(`${SANDBOX.owner}/${SANDBOX.name}`);

test("a preview first review keeps its round with an empty outbox, posts nothing and says it was a preview", async () => {
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  const { service, host } = await start({
    home: dir,
    store,
    changes: [pr1],
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const before = host.posts.length;

  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: true });
  expect(asked.status).toBe(200);
  const events = await until(stream, "round.finished");

  const started = events.find((e) => e.type === "run.started");
  if (started?.type !== "run.started") throw new Error("no run started");
  expect(started.run.preview).toBe(true);
  expect(started.job.trigger).toBe("first-review");
  expect(events.at(-1)).toMatchObject({
    type: "round.finished",
    preview: true,
    job: { trigger: "first-review", state: "done" },
    round: { n: 1 },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "setup.changed",
      setup: expect.objectContaining({ firstReviewChange: ONE }),
    }),
  );
  // A preview never publishes: no step says so, and its round counts none.
  const steps = events.flatMap((e) => (e.type === "run.step" ? [e.step] : []));
  expect(steps).not.toContain("publishing");
  const finished = events.at(-1);
  if (finished?.type !== "round.finished") throw new Error("no round");
  expect(finished.round.steps.map((s) => s.step)).not.toContain("publishing");
  // The round is kept, its outbox empty: nothing was owed to the host, and nothing reached it.
  expect(store.posts.of(started.run.id)?.posts).toEqual([]);
  expect(host.posts.slice(before)).toEqual([]);
  expect(host.view(ref).checks).toEqual([]);

  // The review page's data: the round, said to be a preview.
  const state = await snapshot(service, cookie);
  expect(state.setup.firstReviewChange).toBe(ONE);
  expect(state.reviews[ONE]).toMatchObject({
    preview: true,
    job: { trigger: "first-review", state: "done" },
    rounds: [{ n: 1 }],
  });
});

/** A find pass: one blocking finding on a line of pull request #1's diff. */
const FOUND: ScriptedRun = {
  outcome: "ok",
  text: [
    "```json",
    JSON.stringify({
      findings: [
        {
          path: "src/total.ts",
          line: 12,
          severity: "blocking",
          category: "correctness",
          title: "The total skips the last invoice",
          body: "The loop stops one short, so the last invoice is never added.",
          defect_key: "total-skips-last-invoice",
        },
      ],
    }),
    "```",
  ].join("\n"),
};

/** The confirm pass: the finding confirmed, still blocking. */
const CONFIRMED: ScriptedRun = {
  outcome: "ok",
  text: [
    "```json",
    JSON.stringify({
      verdicts: [
        {
          id: "C1",
          verdict: "confirmed",
          reason: "The loop's bound is length - 1.",
          evidence: ["src/total.ts:12"],
          severity: "blocking",
        },
      ],
    }),
    "```",
  ].join("\n"),
};

test("the next round after a preview posts the preview's open finding on the pull request", async () => {
  const engines = fakeEngines();
  // The preview finds and confirms F1; the next round finds it again (so nothing new to confirm).
  engines.answer(FOUND, CONFIRMED, FOUND);
  const { service, host } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  expect(
    (await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: true })).status,
  ).toBe(200);
  const preview = (await until(stream, "round.finished")).at(-1);
  expect(preview).toMatchObject({ preview: true, findings: [{ id: "F1", severity: "blocking" }] });
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);

  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  const next = (await until(stream, "round.finished")).at(-1);
  expect(next).toMatchObject({ preview: false, round: { n: 2 }, findings: [{ id: "F1", posted: true }] });
  const reviews = host.posts.flatMap((p) => (p.kind === "review" ? [p.review] : []));
  expect(reviews).toHaveLength(1);
  // The review says it; the line is outside the fake diff, so the finding itself is in the summary.
  expect(reviews[0]?.body).toContain("One new thing to fix, total.ts line 12.");
  const summary = host.posts.find((p) => p.kind === "summary.created");
  expect(summary?.kind === "summary.created" && summary.body).toContain(
    "F1 · Blocking · `src/total.ts` line 12 · The total skips the last invoice",
  );
});

test("a first review without preview is an ordinary request that posts, with the first-review trigger", async () => {
  const { service, host } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: false });
  expect(asked.status).toBe(200);
  expect((await until(stream, "round.finished")).at(-1)).toMatchObject({
    preview: false,
    job: { trigger: "first-review", state: "done" },
  });
  expect(host.posts.filter((p) => p.kind === "review")).toHaveLength(1);
  expect(host.view(ref).checks.map((c) => c.status)).toEqual(["completed"]);
  const state = await snapshot(service, cookie);
  expect(state.setup.firstReviewChange).toBe(ONE);
  expect(state.reviews[ONE]).toMatchObject({ preview: false, rounds: [{ n: 1 }] });
});

test("a first review of a pull request already being reviewed on its head commit follows that review: no second round", async () => {
  // The review takes ten minutes: the poll saw the pull request opened and its review runs when the owner picks it.
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ reviews: 2, tookMs: 10 * 60_000, time });
  const { service, host } = await start({ changes: [pr1], engines, time });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  await until(stream, "run.started");

  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: false });
  expect(asked.status).toBe(200);
  await time.advance(12 * 60_000);
  await until(stream, "round.finished");
  await time.advance(12 * 60_000);
  await time.advance(0);
  expect(engines.runs).toHaveLength(1);
  expect(host.posts.filter((p) => p.kind === "review")).toHaveLength(1);
  const state = await snapshot(service, cookie);
  expect(state.setup.firstReviewChange).toBe(ONE);
  expect(state.reviews[ONE]).toMatchObject({ job: { state: "done" }, rounds: [{ n: 1 }] });
});

test("a first review of a pull request the poll saw opened, asked while that review runs, follows it: one round, one review, one check", async () => {
  // The live race of #201: the poll sees the owner's new pull request and reviews it, unasked; the owner picks it
  // in the setup while that review runs.
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ reviews: 2, tookMs: 10 * 60_000, time });
  const { service, host } = await start({ changes: [], engines, time });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.open(pr1);
  await time.advance(60_000);
  const started = (await until(stream, "run.started")).at(-1);
  expect(started).toMatchObject({ job: { trigger: "opened", sha: SHA1 } });

  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: false });
  expect(asked.status).toBe(200);
  await time.advance(12 * 60_000);
  await until(stream, "round.finished");
  await time.advance(12 * 60_000);
  await time.advance(0);
  expect(engines.runs).toHaveLength(1);
  expect(host.posts.filter((p) => p.kind === "review")).toHaveLength(1);
  expect(host.view(ref).checks.map((c) => c.status)).toEqual(["completed"]);
  const state = await snapshot(service, cookie);
  expect(state.setup.firstReviewChange).toBe(ONE);
  expect(state.reviews[ONE]).toMatchObject({ job: { trigger: "opened", state: "done" }, rounds: [{ n: 1 }] });
});

test("a preview first review asked while the change's review runs gets its own round, which posts nothing", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ reviews: 2, tookMs: 10 * 60_000, time });
  const { service, host } = await start({ changes: [pr1], engines, time });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  await until(stream, "run.started");

  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: true });
  expect(asked.status).toBe(200);
  await time.advance(12 * 60_000);
  const first = await until(stream, "round.finished");
  await time.advance(12 * 60_000);
  const rounds = [...first, ...(await until(stream, "round.finished"))];
  const finished = rounds.flatMap((e) => (e.type === "round.finished" ? [[e.round.n, e.preview]] : []));
  expect(finished).toEqual([
    [1, false],
    [2, true],
  ]);
  expect(engines.runs).toHaveLength(2);
  expect(host.posts.filter((p) => p.kind === "review")).toHaveLength(1);
});

test("a first review that posts, asked while a preview that joined the owner's review runs, gets its own round, which posts", async () => {
  // Claude signed out: the owner's review waits; the preview joins it (its trigger stays "manual") and runs once
  // Claude is back. A run that posts nothing is no review to follow.
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ signedIn: false, reviews: 2, tookMs: 10 * 60_000, time });
  const { service, host } = await start({ changes: [pr1], engines, time });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  const preview = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: true });
  expect(preview.status).toBe(200);
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(60_000);
  expect((await until(stream, "run.started")).at(-1)).toMatchObject({
    job: { trigger: "manual", sha: SHA1 },
    run: { preview: true },
  });

  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: false });
  expect(asked.status).toBe(200);
  await time.advance(12 * 60_000);
  const first = await until(stream, "round.finished");
  await time.advance(12 * 60_000);
  const rounds = [...first, ...(await until(stream, "round.finished"))];
  const finished = rounds.flatMap((e) => (e.type === "round.finished" ? [[e.round.n, e.preview]] : []));
  expect(finished).toEqual([
    [1, true],
    [2, false],
  ]);
  expect(engines.runs).toHaveLength(2);
  expect(host.posts.filter((p) => p.kind === "review")).toHaveLength(1);
});

test("a first review asked while a review of an older commit runs is a follow-up on the new head", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ reviews: 2, tookMs: 10 * 60_000, time });
  const { service, host } = await start({ changes: [pr1], engines, time });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  await until(stream, "run.started");

  // A push while it runs: the first review is of the new head, which nobody reviews yet.
  host.push(ref, SHA1_PUSHED, pr1.diff);
  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: false });
  expect(asked.status).toBe(200);
  await time.advance(12 * 60_000);
  const first = await until(stream, "round.finished");
  await time.advance(12 * 60_000);
  const events = [...first, ...(await until(stream, "round.finished"))];
  const ran = events.flatMap((e) => (e.type === "run.started" ? [[e.job.trigger, e.job.sha]] : []));
  expect(ran).toEqual([["first-review", SHA1_PUSHED]]);
  expect(engines.runs).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({ job: { trigger: "first-review", sha: SHA1_PUSHED }, preview: false });
});

test("a first review of a pull request the service doesn't know is refused, and the setup keeps nothing", async () => {
  const { service } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const asked = await post(service, cookie, {
    type: "setup.firstReview",
    changeId: changeId("sasensi/lookover-sandbox#9"),
    preview: true,
  });
  expect(asked.status).toBe(404);
  expect((await snapshot(service, cookie)).setup.firstReviewChange).toBeNull();
});

test("a preview first review in a repository switched off is a skip with no check on the host", async () => {
  const { service, host, time } = await start({ changes: [pr1], engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const off = { type: "repo.setEnabled", repoId: REPO, enabled: false };
  expect((await post(service, cookie, off)).status).toBe(200);
  const before = host.posts.length;

  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: true });
  expect(asked.status).toBe(200);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[ONE]?.job).toMatchObject({
    trigger: "first-review",
    state: "skipped",
    skip: "repo-off",
  });
  expect(host.posts.slice(before)).toEqual([]);
  expect(host.view(ref).checks).toEqual([]);
});

test("a preview joining a review whose check GitHub shows ends that check: skipped, a preview, nothing posted", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // Claude signed out: the owner's review waits, its check on GitHub.
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  expect(host.view(ref).checks.map((c) => c.status)).toEqual(["queued"]);

  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: true });
  expect(asked.status).toBe(200);
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(60_000);
  expect((await until(stream, "round.finished")).at(-1)).toMatchObject({ preview: true });
  await time.advance(0);
  expect(host.view(ref).checks.map((c) => [c.status, c.conclusion, c.output.title])).toEqual([
    ["completed", "skipped", "A preview: nothing was posted"],
  ]);
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
});

test("a preview whose job a push moves ends the old commit's check and makes none on the new one", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // Claude signed out: the owner's review waits, its check on GitHub; a preview joins it.
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  expect(host.view(ref).checks.map((c) => c.status)).toEqual(["queued"]);
  const preview = { type: "setup.firstReview", changeId: ONE, preview: true };
  expect((await post(service, cookie, preview)).status).toBe(200);

  // A push while it waits, then "Review now": the same job, still a preview, on the new head.
  host.push(ref, SHA1_PUSHED, pr1.diff);
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  const shown = (sha: typeof SHA1) =>
    host.view(ref, sha).checks.map((c) => [c.status, c.conclusion, c.output.title]);
  expect(shown(SHA1)).toEqual([["completed", "skipped", "A newer commit was pushed"]]);
  expect(shown(SHA1_PUSHED)).toEqual([]);

  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(60_000);
  expect((await until(stream, "round.finished")).at(-1)).toMatchObject({ preview: true });
  await time.advance(0);
  expect(shown(SHA1_PUSHED)).toEqual([]);
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
});

test("an agent's /lookover review beside the owner's waiting preview gets a review of its own: 👀 and a check at once, the preview first and posting nothing, then its round posted and 🚀", async () => {
  // Each review takes ten minutes: the preview's round finishes well before the request's.
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ signedIn: false, reviews: 2, tookMs: 10 * 60_000, time });
  const { service, host } = await start({ changes: [pr1], engines, time });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  await time.advance(5_000);
  // Claude signed out: the owner's preview waits, with nothing on GitHub.
  const preview = { type: "setup.firstReview", changeId: ONE, preview: true };
  expect((await post(service, cookie, preview)).status).toBe(200);
  await time.advance(0);
  expect(host.view(ref).checks).toEqual([]);

  // The agent asks: seen at the next poll, its 👀 and its own review's check come at once.
  const comment = host.seedComment(ref, { author: OWNER, body: "/lookover review" });
  await time.advance(60_000);
  await time.advance(0);
  const reactions = () => {
    const c = host.view(ref).comments.find((x) => x.id === comment);
    return c?.reactions;
  };
  expect(reactions()).toEqual({ eyes: 1, rocket: 0 });
  const checks = () => host.view(ref).checks.map((c) => [c.status, c.conclusion]);
  expect(checks()).toEqual([["queued", null]]);

  // Signed in: the preview runs first and posts nothing; then the request's review, which posts.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(12 * 60_000);
  const first = await until(stream, "round.finished");
  await time.advance(0);
  // The preview's round answers no request: the 👀 only, still.
  expect(reactions()).toEqual({ eyes: 1, rocket: 0 });
  await time.advance(12 * 60_000);
  const rounds = [...first, ...(await until(stream, "round.finished"))];
  const ran = rounds.flatMap((e) => (e.type === "run.started" ? [[e.job.trigger, e.run.preview]] : []));
  expect(ran).toEqual([
    ["first-review", true],
    ["comment", false],
  ]);
  const finished = rounds.flatMap((e) => (e.type === "round.finished" ? [[e.round.n, e.preview]] : []));
  expect(finished).toEqual([
    [1, true],
    [2, false],
  ]);
  await time.advance(0);
  expect(host.posts.filter((p) => p.kind === "review")).toHaveLength(1);
  expect(checks()).toEqual([["completed", "success"]]);
  expect(reactions()).toEqual({ eyes: 1, rocket: 1 });
});

test("a preview's check end the host refused is sent again until it lands, after a restart too", async () => {
  const dir = home();
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const first = await start({ home: dir, changes: [pr1], engines, log: () => {} });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  expect((await post(first.service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await first.time.advance(0);
  expect(first.host.view(ref).checks.map((c) => c.status)).toEqual(["queued"]);
  const preview = { type: "setup.firstReview", changeId: ONE, preview: true };
  expect((await post(first.service, cookie, preview)).status).toBe(200);

  // GitHub refuses every check write while the preview runs and ends: the check stays queued there.
  first.host.refuseChecks("unavailable");
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await first.time.advance(60_000);
  expect((await until(stream, "round.finished")).at(-1)).toMatchObject({ preview: true });
  await first.time.advance(60_000);
  expect(first.host.view(ref).checks.map((c) => c.status)).toEqual(["queued"]);
  await first.service.stop();

  // Back, the host answering: the end owed is sent at the first take.
  first.host.refuseChecks(null);
  const second = await start({ home: dir, host: first.host, engines, time: first.time, idsFrom: 100 });
  await second.time.advance(60_000);
  expect(first.host.view(ref).checks.map((c) => [c.status, c.conclusion, c.output.title])).toEqual([
    ["completed", "skipped", "A preview: nothing was posted"],
  ]);
  expect(first.host.posts.filter((p) => p.kind === "review")).toEqual([]);
});

/** A host that holds every check it is asked to create until `release`: GitHub slow to answer. */
class HeldCheck extends FakeGitHost {
  private heard = () => {};
  /** Settles at the first check held. */
  readonly asked = new Promise<void>((resolve) => {
    this.heard = resolve;
  });
  private let = () => {};
  private readonly released = new Promise<void>((resolve) => {
    this.let = resolve;
  });

  release(): void {
    this.let();
  }

  override async createCheck(...args: Parameters<FakeGitHost["createCheck"]>): Promise<string> {
    this.heard();
    await this.released;
    return super.createCheck(...args);
  }
}

test("a preview joining a review while GitHub is still creating its check ends that check once it is made", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new HeldCheck({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const { service } = await start({ host, time, engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // Claude signed out: the owner's review waits, its check being created on GitHub, not answered yet.
  expect((await post(service, cookie, { type: "review.request", changeId: ONE })).status).toBe(200);
  await time.advance(0);
  await host.asked;

  // The preview joins it in that window; then GitHub answers: the check exists, queued.
  const asked = await post(service, cookie, { type: "setup.firstReview", changeId: ONE, preview: true });
  expect(asked.status).toBe(200);
  host.release();
  await time.advance(0);
  expect(host.view(ref).checks.map((c) => c.status)).toEqual(["queued"]);

  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(60_000);
  expect((await until(stream, "round.finished")).at(-1)).toMatchObject({ preview: true });
  await time.advance(0);
  expect(host.view(ref).checks.map((c) => [c.status, c.conclusion, c.output.title])).toEqual([
    ["completed", "skipped", "A preview: nothing was posted"],
  ]);
  expect(host.posts.filter((p) => p.kind === "review")).toEqual([]);
});

test("a preview left at publishing by a stopped service ends as its round at the next start: nothing found again, nothing posted", async () => {
  const dir = home();
  const engines = fakeEngines({ reviews: 1 });
  const real = openStore({ home: dir, durable: false });
  // A full disk at the run's end: neither the round nor the failure is recorded, so the job is left at publishing.
  const full: Store = {
    ...real,
    jobs: {
      ...real.jobs,
      runEnded: () => {
        throw new Error("disk I/O error");
      },
    },
  };
  const first = await start({ home: dir, store: full, changes: [pr1], engines, log: () => {} });
  const asked = await post(first.service, await openApp(first.service), {
    type: "setup.firstReview",
    changeId: ONE,
    preview: true,
  });
  expect(asked.status).toBe(200);
  while (real.jobs.leftRunning()[0]?.step !== "publishing") await first.time.advance(0);
  await first.service.stop();
  const before = first.host.posts.length;

  const last = lastEvent(dir);
  const second = await start({ home: dir, host: first.host, engines, time: first.time, idsFrom: 100 });
  const since = await sinceStart(second.service, await openApp(second.service), last);
  expect((await until(since, "round.finished")).at(-1)).toMatchObject({
    preview: true,
    job: { state: "done" },
    round: { n: 1 },
  });
  expect(engines.runs).toHaveLength(1);
  expect(first.host.posts.slice(before)).toEqual([]);
});
