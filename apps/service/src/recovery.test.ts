// The queue's recovery and the run's failures, on fakes only (no git, no process): a job the service left running
// when it stopped runs again at the next start, before the jobs queued behind it, unless its run had reached
// publishing or a restart already retried it, which fails it (ADR 0043, #62); a host that won't answer, or a
// prepare that fails, during a run fails the job, recorded and shown.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, type Event, HostError, jobId, type ReviewJob, type State } from "@lookover/contracts";
import { RetrievalError } from "@lookover/retrieval";
import { openStore } from "@lookover/store";
import { type FakeChange, FakeGitHost, ScriptedRetrieval } from "@lookover/testkit";
import {
  api,
  BOT,
  fakeEngines,
  HeldReviews,
  heldRuns,
  home,
  lastEvent,
  messages,
  openApp,
  PLANTED,
  post,
  pr1,
  refusingEnds,
  refusingPosts,
  review,
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

/** A host that lists its changes but can't say what one is: GitHub down between the request and the run. */
class HostDown extends FakeGitHost {
  override getChange(): Promise<never> {
    return Promise.reject(new HostError("unavailable", "GitHub answered 503"));
  }
}

/** A host that lists and describes the change but refuses to say how to fetch it, as a repository read refused. */
class FetchRefused extends FakeGitHost {
  override fetchSpec(): Promise<never> {
    return Promise.reject(new HostError("unauthorized", "GitHub answered 403"));
  }
}

/**
 * A host that refuses every review and every check completed while `down`, as GitHub failing on its side for an
 * hour; `refused` settles at the first review refused.
 */
class RefusingPosts extends FakeGitHost {
  down = true;
  private heard = () => {};
  readonly refused = new Promise<void>((resolve) => {
    this.heard = resolve;
  });

  override publishReview(...args: Parameters<FakeGitHost["publishReview"]>): Promise<string> {
    if (!this.down) return super.publishReview(...args);
    this.heard();
    return Promise.reject(new HostError("unavailable", "GitHub answered 502"));
  }

  override completeCheck(...args: Parameters<FakeGitHost["completeCheck"]>): Promise<void> {
    if (!this.down) return super.completeCheck(...args);
    return Promise.reject(new HostError("unavailable", "GitHub answered 502"));
  }
}

const MIN = 60_000;
const PR1 = { repo: SANDBOX, number: 1 };

/** A find pass that answers one blocking finding on a line of pull request #1's diff. */
const ONE_FINDING = [
  "```json",
  JSON.stringify({
    findings: [
      {
        severity: "blocking",
        category: "security",
        title: "The key is logged",
        body: "When the total is computed, the API key is printed, because the debug line was left in.",
        path: "src/total.ts",
        side: "head",
        line: 3,
        end_line: null,
        line_text: null,
        defect_key: "secret-logged",
      },
    ],
  }),
  "```",
].join("\n");

const OTHER = changeId("sasensi/lookover-sandbox#9");
const TENTH = changeId("sasensi/lookover-sandbox#10");
/** Another pull request of the owner's, on the same commits as the first. */
const numbered = (number: number): FakeChange => ({
  ...pr1,
  number,
  url: pr1.url.replace(/\/1$/, `/${number}`),
});
const CHANGES = [pr1, numbered(9), numbered(10)];
const named = (e: { type: string; changeId?: string }) => (e.changeId ? `${e.type} ${e.changeId}` : e.type);
const job1: ReviewJob = {
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
const stopped: ReviewJob = {
  ...job1,
  state: "failed",
  failure: { kind: "service_stopped", detail: "", engine: "claude" },
};

type Started = Awaited<ReturnType<typeof start>>;

/**
 * A service on `dir` listing three pull requests of the owner's, whose reviews wait for `release` (or are cut when
 * it stops); a restart goes on with the first start's host and time, and its ids from `ids`.
 */
async function heldService(
  dir: string,
  restart?: { first: Started; ids: number },
  log: (line: string) => void = () => {},
) {
  const held = heldRuns(fakeEngines({ reviews: 3 }));
  const started = await start({
    home: dir,
    engines: held.engines,
    changes: CHANGES,
    log,
    ...(restart ? { host: restart.first.host, time: restart.first.time, idsFrom: restart.ids } : {}),
  });
  return { ...started, held };
}

test("a restart starts again the job it interrupted before publishing, then the jobs queued behind it, in turn (#62)", async () => {
  const dir = home();
  const retrieval = new ScriptedRetrieval();
  const first = await start({
    home: dir,
    engines: heldRuns(fakeEngines()).engines,
    changes: CHANGES,
    retrieval,
  });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  await review(first.service, cookie);
  await until(stream, "run.step");
  for (const id of [OTHER, TENTH])
    await post(first.service, cookie, { type: "review.request", changeId: id });
  await first.service.stop();
  // The run was cut, and its worktree went with it.
  expect(retrieval.disposed).toEqual([jobId("id-1")]);

  // A minute later, on the same clock, the service starts again: the interrupted job is first in line.
  await first.time.advance(60_000);
  const last = lastEvent(dir);
  const logged: string[] = [];
  const second = await heldService(dir, { first, ids: 100 }, (line) => logged.push(line));
  // The log says what the restart did with the job it found running (ADR 0055).
  expect(logged.slice(0, 1)).toEqual([
    "sasensi/lookover-sandbox#1 review runs again: the service stopped while it ran",
  ]);
  const again = await openApp(second.service);
  const events = await sinceStart(second.service, again, last);
  second.held.release();
  const seen = [
    ...(await until(events, "round.finished")),
    ...(await until(events, "round.finished")),
    ...(await until(events, "round.finished")),
  ];
  const shown = seen.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named);
  expect(shown[0]).toBe(`job.changed ${PLANTED}`);
  // Each round saved frees Claude for the next job while it is posted (ADR 0044): the runs start in turn, and
  // the rounds are posted in the same order.
  const of = (type: string) => shown.filter((name) => name.startsWith(type));
  expect(of("run.started")).toEqual([PLANTED, OTHER, TENTH].map((id) => `run.started ${id}`));
  expect(of("round.finished")).toEqual([PLANTED, OTHER, TENTH].map((id) => `round.finished ${id}`));
  // The tenth waits behind Claude reviewing the first, then the ninth: its turn moves once (ADR 0055).
  expect(of("job.changed")).toEqual([`job.changed ${PLANTED}`, `job.changed ${TENTH}`]);
  expect(shown).toHaveLength(8);
  // A job starts only once the run before it has saved its round and freed Claude: its step, publishing.
  const index = (found: (e: Event) => boolean) => seen.findIndex(found);
  const publishing = (id: string) =>
    index((e) => e.type === "run.step" && e.changeId === id && e.step === "publishing");
  const started = (id: string) => index((e) => e.type === "run.started" && e.changeId === id);
  expect(started(OTHER)).toBeGreaterThan(publishing(PLANTED));
  expect(started(TENTH)).toBeGreaterThan(publishing(OTHER));
  expect(publishing(PLANTED)).toBeGreaterThan(-1);
  // Back in the queue as the same job, its run ended; then a new run of it.
  expect(seen[0]).toMatchObject({ job: job1 });
  expect(seen.find((e) => e.type === "round.finished")).toMatchObject({ job: { ...job1, state: "done" } });
  const state: State = await snapshot(second.service, again);
  expect(state.service.since).toBe(T0 + 60_000);
  // Its one check followed it across the restart (ADR 0043): back to its turn, in progress again, then the round.
  const [created] = first.host.posts;
  if (created?.kind !== "check.created") throw new Error("the job's check was not created first");
  expect(
    first.host.posts.flatMap((p) => {
      if (p.kind === "check.created" || p.kind === "check.updated")
        return p.checkId === created.checkId ? [`${p.status}: ${p.output.title}`] : [];
      return p.kind === "check.completed" && p.checkId === created.checkId ? [`${p.conclusion}`] : [];
    }),
  ).toEqual([
    "queued: Waiting for its turn",
    "in_progress: Looking over a1b2c3d",
    "queued: Waiting for its turn",
    "in_progress: Looking over a1b2c3d",
    "success",
  ]);
});

test("a job interrupted a second time fails, the service stopped, and the jobs queued behind it run", async () => {
  const dir = home();
  const first = await heldService(dir);
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  await review(first.service, cookie);
  await until(stream, "run.step");
  await post(first.service, cookie, { type: "review.request", changeId: OTHER });
  await first.service.stop();

  // Restarted: it runs again, and the service stops again while it runs.
  const second = await heldService(dir, { first, ids: 100 });
  const twice = await openApp(second.service);
  expect((await snapshot(second.service, twice)).reviews[PLANTED]).toMatchObject({
    job: { ...job1, state: "running" },
  });
  await second.service.stop();

  const last = lastEvent(dir);
  const logged: string[] = [];
  const third = await heldService(dir, { first, ids: 200 }, (line) => logged.push(line));
  expect(logged.slice(0, 1)).toEqual([
    "sasensi/lookover-sandbox#1 review failed: the service stopped before the review finished",
  ]);
  const thrice = await openApp(third.service);
  const events = await sinceStart(third.service, thrice, last);
  third.held.release();
  const seen = await until(events, "round.finished");
  expect(seen.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    `job.changed ${PLANTED}`,
    `run.started ${OTHER}`,
    `round.finished ${OTHER}`,
  ]);
  expect(seen[0]).toMatchObject({ job: stopped });
  const store = openStore({ home: dir, durable: false });
  expect(store.jobs.latest(PLANTED)).toEqual({ changeId: PLANTED, job: stopped });
  // Its run ended with it: nothing is left running.
  expect(store.jobs.leftRunning()).toEqual([]);
  store.close();
});

test("a restart that finds a follow-up behind the interrupted job runs the follow-up, on the newest commit, and cancels the job", async () => {
  const dir = home();
  const first = await heldService(dir);
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  await review(first.service, cookie);
  await until(stream, "run.step");
  first.host.push({ repo: SANDBOX, number: 1 }, SHA1_PUSHED, []);
  await review(first.service, cookie);
  await first.service.stop();

  const last = lastEvent(dir);
  const logged: string[] = [];
  const second = await heldService(dir, { first, ids: 100 }, (line) => logged.push(line));
  expect(logged.slice(0, 1)).toEqual([
    "sasensi/lookover-sandbox#1 review cancelled: a newer review took its place",
  ]);
  const again = await openApp(second.service);
  const events = await sinceStart(second.service, again, last);
  second.held.release();
  const seen = (await until(events, "round.finished")).filter(
    (e) => e.type !== "run.step" && e.type !== "run.posting",
  );
  expect(seen.map(named)).toEqual([
    `job.changed ${PLANTED}`,
    `job.changed ${PLANTED}`,
    `run.started ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  const followUp: ReviewJob = { ...job1, id: jobId("id-3"), sha: SHA1_PUSHED };
  expect(seen[0]).toMatchObject({ job: { ...job1, state: "cancelled", cancel: "replaced" } });
  // Its turn not said yet: its change's run is over (ADR 0055); it starts at once.
  expect(seen[1]).toMatchObject({ job: { ...followUp, turn: null } });
  expect(seen.at(-1)).toMatchObject({
    job: { ...followUp, state: "done" },
    round: { n: 1, sha: SHA1_PUSHED },
  });
  // The cancelled job's check says a newer review took its place; the follow-up's, created while the UI still
  // showed the run, is completed by its round.
  const checks = (sha: typeof SHA1) =>
    first.host
      .view({ repo: SANDBOX, number: 1 }, sha)
      .checks.map((c) => `${c.conclusion}: ${c.output.title}`);
  expect(checks(SHA1)).toEqual(["skipped: A newer review took its place"]);
  expect(checks(SHA1_PUSHED)).toEqual(["success: Looked over c3d4e5f: nothing to fix"]);
});

test("a restart during publishing resumes the round's posts: nothing is found again, and the check completes (ADR 0044)", async () => {
  const dir = home();
  const engines = fakeEngines({ reviews: 1 });
  const host = new HeldReviews({ repo: SANDBOX, bot: BOT, changes: [pr1] });
  const first = await start({ home: dir, host, engines });
  await review(first.service, await openApp(first.service));
  // The service stops while GitHub holds the review's answer: the round is saved, its review begun, never answered.
  await host.asked;
  await first.service.stop();
  expect(host.view({ repo: SANDBOX, number: 1 }).reviews).toEqual([]);

  host.holding = false;
  const last = lastEvent(dir);
  const logged: string[] = [];
  const log = (line: string) => logged.push(line);
  const second = await start({ home: dir, host, engines, time: first.time, idsFrom: 100, log });
  expect(logged).toEqual([
    "sasensi/lookover-sandbox#1 review resumes its posts: the service stopped while it posted",
  ]);
  const again = await openApp(second.service);
  const seen = await until(await sinceStart(second.service, again, last), "round.finished");
  expect(logged.at(-1)).toBe("sasensi/lookover-sandbox#1 round 1 posted: no open findings");
  // No job is asked again, and the engine never runs again: the round's posts resume.
  // Its outbox shown as kept (the check sent before the stop), then each post sent.
  expect(seen.map(named)).toEqual([
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `run.posting ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  expect(seen[0]).toMatchObject({ posting: { sent: 1, owed: 4, wait: null } });
  expect(seen.at(-1)).toMatchObject({ job: { ...job1, state: "done" }, round: { n: 1, sha: SHA1 } });
  expect(engines.runs).toHaveLength(1);
  const shown = host.view({ repo: SANDBOX, number: 1 });
  expect(shown.reviews).toHaveLength(1);
  expect(shown.checks.map((c) => `${c.status} ${c.conclusion}`)).toEqual(["completed success"]);
  expect(shown.comments).toHaveLength(1);
});

/**
 * A host that keeps the first review it is asked to post, then holds its answer until `stopped`, and fails it then:
 * the service stopped after GitHub accepted the review and before Lookover marked it sent (`bun run live`'s crash
 * step, ADR 0056). `kept` settles once the review is on the host.
 */
class KeptThenStopped extends FakeGitHost {
  private armed = true;
  private heard = () => {};
  readonly kept = new Promise<void>((resolve) => {
    this.heard = resolve;
  });
  private stop = () => {};
  private readonly stoppedYet = new Promise<void>((resolve) => {
    this.stop = resolve;
  });

  stopped(): void {
    this.stop();
  }

  override async publishReview(...args: Parameters<FakeGitHost["publishReview"]>): Promise<string> {
    const id = await super.publishReview(...args);
    if (!this.armed) return id;
    this.armed = false;
    this.heard();
    await this.stoppedYet;
    throw new Error("the service stopped while GitHub answered the review");
  }
}

test("a review GitHub kept as the service stopped is found by its marker after the restart: one review, no engine run (ADR 0056)", async () => {
  const dir = home();
  const engines = fakeEngines({ reviews: 1 });
  const host = new KeptThenStopped({ repo: SANDBOX, bot: BOT, changes: [pr1] });
  const first = await start({ home: dir, host, engines });
  await review(first.service, await openApp(first.service));
  await host.kept;
  await first.service.stop();
  // The stopped service's post fails now: nothing of it goes on.
  host.stopped();
  await first.time.advance(0);
  expect(host.view(PR1).reviews).toHaveLength(1);

  const last = lastEvent(dir);
  const logged: string[] = [];
  const second = await start({
    home: dir,
    host,
    engines,
    time: first.time,
    idsFrom: 100,
    log: (line) => logged.push(line),
  });
  expect(logged[0]).toBe(
    "sasensi/lookover-sandbox#1 review resumes its posts: the service stopped while it posted",
  );
  const seen = await until(
    await sinceStart(second.service, await openApp(second.service), last),
    "round.finished",
  );
  expect(seen.at(-1)).toMatchObject({ job: { state: "done" }, round: { n: 1, sha: SHA1 } });
  expect(engines.runs).toHaveLength(1);
  const shown = host.view(PR1);
  expect(shown.reviews).toHaveLength(1);
  expect(shown.comments).toHaveLength(1);
  expect(shown.checks.map((c) => `${c.status} ${c.conclusion}`)).toEqual(["completed success"]);
});

test("a service stopped while a refused review waits to be sent again resumes, and finds the review GitHub kept: one review", async () => {
  const dir = home();
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const first = await start({ home: dir, engines, changes: [pr1] });
  const { host, time } = first;
  // GitHub answers the review "422 An internal error occurred" and keeps it all the same.
  host.refuseNext("unavailable", { post: "review", saved: true });
  await review(first.service, await openApp(first.service));
  while (host.view(PR1).reviews.length === 0) await time.advance(0);
  // Stopped during the wait before the review is sent again.
  await first.service.stop();
  const ran = engines.runs.length;

  const last = lastEvent(dir);
  const second = await start({ home: dir, host, engines, time, idsFrom: 100 });
  const seen = await until(
    await sinceStart(second.service, await openApp(second.service), last),
    "round.finished",
  );
  expect(seen.at(-1)).toMatchObject({ job: { state: "done" }, round: { n: 1 } });
  // Nothing is found again: the posts resume.
  expect(engines.runs).toHaveLength(ran);
  expect(host.view(PR1).reviews).toHaveLength(1);
});

/** Pull request #1's diff as the worktree gives it: head lines 1 to 4, line 3 the logging line the finding is on. */
const TOTAL_DIFF = [
  "diff --git a/src/total.ts b/src/total.ts",
  "--- a/src/total.ts",
  "+++ b/src/total.ts",
  "@@ -1,2 +1,4 @@",
  " export function total(items: Item[]) {",
  "+  const key = process.env.API_KEY;",
  "+  console.log(key);",
  " }",
  "",
].join("\n");

/**
 * A host that takes comments on head lines 1 and 2 only, and holds each review with no comment until `release`;
 * `inline` counts the reviews asked with comments.
 */
class NarrowHost extends HeldReviews {
  inline = 0;

  override publishReview(...args: Parameters<FakeGitHost["publishReview"]>): Promise<string> {
    const [, posted] = args;
    // Refused for its comment on line 3 as GitHub refuses it, before anything is held.
    if (posted.comments.length > 0) {
      this.inline++;
      return FakeGitHost.prototype.publishReview.apply(this, args);
    }
    return super.publishReview(...args);
  }
}

test("a review GitHub refused for a comment it can't place goes with its findings in the summary, after a restart too", async () => {
  const dir = home();
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = TOTAL_DIFF;
  const narrow = { ...pr1, diff: [{ path: "src/total.ts", side: "head" as const, from: 1, to: 2 }] };
  const host = new NarrowHost({ repo: SANDBOX, bot: BOT, changes: [narrow] });
  const first = await start({ home: dir, host, engines, retrieval });
  await review(first.service, await openApp(first.service));
  // The review with its findings in the summary is begun, and the service stops before GitHub answers it.
  await host.asked;
  await first.service.stop();

  host.release();
  const last = lastEvent(dir);
  const second = await start({ home: dir, host, engines, retrieval, time: first.time, idsFrom: 100 });
  await until(await sinceStart(second.service, await openApp(second.service), last), "round.finished");
  const shown = host.view(PR1);
  expect(shown.reviews.map((r) => r.comments)).toEqual([[]]);
  // The store kept it: after the restart, the review was not tried with its comment again.
  expect(host.inline).toBe(1);
  expect(shown.comments[0]?.body).toContain(
    "No comment on the line: GitHub would not place this round's comments.",
  );
});

test("a run's end that can't be recorded is tried once more", async () => {
  const dir = home();
  const { service } = await start({
    home: dir,
    store: refusingEnds(dir, "round", 1),
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { ...job1, state: "done" },
    round: { n: 1 },
  });
});

test("a run's end that can't be recorded twice fails the job in its own write and frees Claude: the change's next request runs (#65)", async () => {
  const dir = home();
  const { service, host, time } = await start({
    home: dir,
    store: refusingEnds(dir, "round", 2),
    engines: fakeEngines({ reviews: 2 }),
  });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  const failed = [...(await until(events, "run.started")), ...(await until(events, "job.changed"))];
  expect(failed.filter((e) => e.type !== "run.step" && e.type !== "run.posting").map(named)).toEqual([
    `job.changed ${PLANTED}`,
    `run.started ${PLANTED}`,
    `job.changed ${PLANTED}`,
  ]);
  expect(failed.at(-1)).toMatchObject({
    job: { ...job1, state: "failed", failure: { kind: "unexpected", detail: "disk I/O error" } },
  });
  expect((await snapshot(service, cookie)).reviews[PLANTED]).toMatchObject({ run: null, rounds: [] });
  // The round was posted and completed the job's check: its result stays there, never replaced by the failure.
  await time.advance(0);
  expect(
    host.posts.map((p) => (p.kind === "check.completed" ? `${p.kind} ${p.conclusion}` : p.kind)),
  ).toEqual(["check.created", "check.updated", "review", "summary.created", "check.completed success"]);

  // Nothing is left running: the next "Review now" runs at once, a new job.
  expect((await review(service, cookie)).status).toBe(200);
  const next = (await until(events, "round.finished")).filter(
    (e) => e.type !== "run.step" && e.type !== "run.posting",
  );
  expect(next.map(named)).toEqual([
    `job.changed ${PLANTED}`,
    `run.started ${PLANTED}`,
    `round.finished ${PLANTED}`,
  ]);
  // Round 1 was saved before it was posted (ADR 0044): the next one is round 2.
  expect(next.at(-1)).toMatchObject({ job: { ...job1, id: jobId("id-3"), state: "done" }, round: { n: 2 } });
});

test("a store that fails while the round is posted fails the job 'unexpected', keeps the round and frees the change", async () => {
  const dir = home();
  const { service } = await start({
    home: dir,
    store: refusingPosts(dir, 1),
    engines: fakeEngines({ reviews: 2 }),
    log: () => {},
  });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { ...job1, state: "failed", failure: { kind: "unexpected", detail: "disk I/O error" } },
    round: { n: 1 },
  });

  // Nothing is left running: the change's next "Review now" runs at once, as round 2.
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { ...job1, id: jobId("id-3"), state: "done" },
    round: { n: 2 },
  });
});

test("a review GitHub took whose record failed is found by the next round: its findings count as posted, never posted twice", async () => {
  const dir = home();
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const { service, host } = await start({
    home: dir,
    store: refusingPosts(dir, 1, "review"),
    engines,
    changes: [pr1],
    log: () => {},
  });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "failed", failure: { kind: "unexpected" } },
  });
  expect(host.view(PR1).reviews).toHaveLength(1);

  // Round 2 finds the same defect: round 1's review holds it, so it is not posted again.
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "done" },
    round: { n: 2, open: 1 },
    findings: [{ id: "F1", status: "open", posted: true }],
  });
  const [, second] = host.view(PR1).reviews;
  expect(second?.body).toContain("Nothing new to fix");
});

test("a finding whose review GitHub refused is posted by the next round while the defect is there, and holds it open", async () => {
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const { service, host } = await start({ engines, changes: [pr1] });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // A refusal publish doesn't try again: round 1's posts are given up at once, its finding held off.
  host.refuseNext("unauthorized", { post: "review" });
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "failed", failure: { kind: "publish_failed" } },
    findings: [{ id: "F1", posted: false }],
  });

  // Round 2 finds the same defect: F1 goes on the pull request now, and the round is not clean.
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "done" },
    round: { n: 2, open: 1 },
    loop: "open",
    findings: [{ id: "F1", status: "open", posted: true }],
  });
  const shown = host.view(PR1);
  expect(shown.reviews).toHaveLength(1);
  expect(shown.reviews[0]?.body).toContain("One new thing to fix");
  expect(shown.comments[0]?.body).toContain("The key is logged");
  // Not clean: one thing to fix (a Should fix, its blocking unconfirmed with no confirm answer).
  expect(shown.checks.at(-1)).toMatchObject({
    status: "completed",
    output: { title: "Looked over a1b2c3d: one thing to fix" },
  });
});

test("an hour of GitHub refusing the review fails the job, the round kept and its findings held off the pull request; the check completes neutral once GitHub answers", async () => {
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const host = new RefusingPosts({ repo: SANDBOX, bot: BOT, changes: [pr1] });
  const { service, time } = await start({ host, engines });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await host.refused;
  // Tried again and again for most of an hour: the job still runs, posting.
  await time.advance(50 * MIN);
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.run?.step).toBe("publishing");
  await time.advance(15 * MIN);
  const kept = (await until(events, "round.finished")).at(-1);
  // The finding counts as open in the round, and the loop with it: it was found, and nothing fixed it. It is held
  // off the pull request, which never got the review.
  expect(kept).toMatchObject({
    job: { state: "failed", failure: { kind: "publish_failed" } },
    round: { n: 1, open: 1 },
    loop: "open",
    findings: [{ id: "F1", status: "open", posted: false }],
  });
  // GitHub still refuses: the check can't be completed yet. Once it answers a poll again, it is.
  await time.advance(MIN);
  expect(host.view({ repo: SANDBOX, number: 1 }).checks.map((c) => c.status)).toEqual(["in_progress"]);
  host.down = false;
  await time.advance(MIN);
  expect(host.view({ repo: SANDBOX, number: 1 }).checks).toMatchObject([
    { status: "completed", conclusion: "neutral" },
  ]);
  expect(host.view({ repo: SANDBOX, number: 1 }).reviews).toEqual([]);
});

test("a run that finds Claude signed out, whose deferral can't be recorded twice, fails the job in its own write and frees Claude", async () => {
  const dir = home();
  const engines = fakeEngines();
  engines.answer({ outcome: "auth_required", text: "" });
  const { service, time } = await start({ home: dir, store: refusingEnds(dir, "deferred", 2), engines });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(events, "run.started");
  expect((await until(events, "job.changed")).at(-1)).toMatchObject({
    job: { ...job1, state: "failed", failure: { kind: "unexpected", detail: "disk I/O error" } },
  });

  // Claude is free: once the sign-out the run found has stopped holding (its health says signed in), the next
  // "Review now" starts a run at once.
  await time.advance(60_000);
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "run.started")).at(-1)).toMatchObject({
    changeId: PLANTED,
    job: { ...job1, id: jobId("id-3"), state: "running" },
  });
});

test("a host that lists the change but won't say what it is when the run asks fails the job, recorded and shown", async () => {
  const { service } = await start({ host: new HostDown({ repo: SANDBOX, bot: BOT, changes: [pr1] }) });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  const seen = [...(await until(events, "run.started")), ...(await until(events, "job.changed"))];
  expect(seen.at(-1)).toMatchObject({
    changeId: PLANTED,
    job: { id: "id-1", state: "failed", failure: { kind: "host_failed", detail: "unavailable" } },
  });
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.run).toBeNull();
});

test("a host that lists the change but refuses to say how to fetch it fails the job as the host's failure", async () => {
  const { service } = await start({ host: new FetchRefused({ repo: SANDBOX, bot: BOT, changes: [pr1] }) });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  const seen = [...(await until(events, "run.started")), ...(await until(events, "job.changed"))];
  expect(seen.at(-1)).toMatchObject({
    changeId: PLANTED,
    job: { id: "id-1", state: "failed", failure: { kind: "host_failed", detail: "unauthorized" } },
  });
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.run).toBeNull();
});

test("a prepare that fails fails the job as a prepare that failed, in retrieval's words", async () => {
  const retrieval = new ScriptedRetrieval();
  retrieval.refuse(
    new RetrievalError(
      "fetch_failed",
      "no credentials from the host: unauthorized: The host refused the credentials (401)",
    ),
  );
  const { service } = await start({ retrieval });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  let ended: Event | undefined;
  while (!ended) {
    const seen = await until(events, "job.changed");
    ended = seen.find(
      (e) => e.type === "job.changed" && e.job.state !== "queued" && e.job.state !== "running",
    );
  }
  expect(ended).toMatchObject({
    changeId: PLANTED,
    job: {
      state: "failed",
      failure: {
        kind: "prepare_failed",
        detail:
          "fetch_failed: no credentials from the host: unauthorized: The host refused the credentials (401)",
      },
    },
  });
});
