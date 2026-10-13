// The check follows the job (ADR 0043), through the service's entry, on fakes only: created `queued` on the head
// commit when the job is recorded, saying why it waits; `in_progress` when its run starts; completed by the round;
// or completed without one, `skipped` or `neutral`, never `failure` (ADR 0006), with the result block. A check
// write the host refuses never fails the job: the job's next change sends it again.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, commitSha, HostError, readResult } from "@lookover/contracts";
import { RetrievalError } from "@lookover/retrieval";
import { DemoClock, FakeGitHost, type HostPost, ScriptedRetrieval } from "@lookover/testkit";
import {
  api,
  BOT,
  fakeEngines,
  heldRuns,
  home,
  messages,
  openApp,
  PLANTED,
  post,
  pr1,
  pr2,
  review,
  SANDBOX,
  SHA1,
  SHA1_PUSHED,
  start,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const PR = { repo: SANDBOX, number: 1 };
const SECOND = changeId("lookover-sandbox#2");
const SIGNED_IN = { installed: true, version: "2.4.1", signedIn: true };

/** Each check post as `<kind> <status or conclusion>: <title>`, in the order the host received them. */
const checkPosts = (host: FakeGitHost) =>
  host.posts.flatMap((p: HostPost) => {
    switch (p.kind) {
      case "check.created":
      case "check.updated":
        return [`${p.kind} ${p.status}: ${p.output.title}`];
      case "check.completed":
        return [`${p.kind} ${p.conclusion}: ${p.output.title}`];
      default:
        return [];
    }
  });

/**
 * The sandbox's host on the held clock, refusing the first completion of a check; with `roundOnly`, refusing too
 * every check created before the round's own (its in-progress check, "being posted"), and that first completion as
 * a request it won't take (`invalid`), which `publish` doesn't try again: the round's posts are given up at once.
 */
class Flaky extends FakeGitHost {
  private completions = 0;
  private roundCreated = false;
  private readonly roundOnly: boolean;
  constructor(time: DemoClock, roundOnly = false) {
    super({ repo: SANDBOX, bot: BOT, changes: [pr1, pr2], clock: time });
    this.roundOnly = roundOnly;
  }
  override createCheck(...args: Parameters<FakeGitHost["createCheck"]>): Promise<string> {
    const [, , , output] = args;
    if (output.summary.endsWith("is being posted.")) this.roundCreated = true;
    if (this.roundOnly && !this.roundCreated)
      return Promise.reject(new HostError("unavailable", "No answer"));
    return super.createCheck(...args);
  }
  override completeCheck(...args: Parameters<FakeGitHost["completeCheck"]>): Promise<void> {
    this.completions++;
    if (this.completions === 1)
      return Promise.reject(
        this.roundOnly
          ? new HostError("invalid", "Validation Failed")
          : new HostError("unavailable", "No answer"),
      );
    return super.completeCheck(...args);
  }
}

/** The checks the host shows on a commit, as `<status> <conclusion>: <title>`. */
const shown = (host: FakeGitHost, sha = SHA1) =>
  host.view(PR, sha).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`);

test('"Review now" creates a queued check on the head commit before the run starts; it goes in progress, then the round completes it', async () => {
  const engines = fakeEngines({ reviews: 1 });
  const held = heldRuns(engines);
  const { service, host, time } = await start({ engines: held.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  await time.advance(0);
  expect(checkPosts(host)).toEqual([
    "check.created queued: Waiting for its turn",
    "check.updated in_progress: Looking over a1b2c3d",
  ]);
  expect(shown(host)).toEqual(["in_progress null: Looking over a1b2c3d"]);

  held.release();
  await until(stream, "round.finished");
  await time.advance(0);
  expect(host.posts.map((p) => p.kind)).toEqual([
    "check.created",
    "check.updated",
    "review",
    "summary.created",
    "check.completed",
  ]);
  // One check on the commit, the job's, completed by the round with the result: what asked was "Review now".
  const [check] = host.view(PR).checks;
  expect(check).toMatchObject({ sha: SHA1, status: "completed", conclusion: "success" });
  expect(readResult(check?.output.text ?? "")?.run).toMatchObject({ state: "done", trigger: "manual" });
});

test("a review held on a Codex too old for its model says so on its check, and says what starts it", async () => {
  const engines = fakeEngines({ reviews: 1 });
  const tooOld = { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  engines.setHealth("codex", { installed: false, version: "0.161.0", signedIn: true, why: tooOld });
  const { service, host, time } = await start({ engines, repositorySettings: { reviewers: "codex" } });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");
  await time.advance(0);
  expect(shown(host)).toEqual(["queued null: Waiting: Codex 0.161.0 is too old for gpt-6.1-sol"]);
  expect(host.view(PR).checks[0]?.output.summary).toBe(
    "Lookover looks over a1b2c3d by itself once Codex is updated.",
  );
});

test("a deferred review's check says why it waits, and changes when the reason changes", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const { service, host, time } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");
  await time.advance(0);
  expect(shown(host)).toEqual(["queued null: Waiting: Claude is signed out"]);
  expect(host.view(PR).checks[0]?.output.summary).toBe(
    "Lookover looks over a1b2c3d by itself once the owner signs Claude in.",
  );

  // Claude is gone from the machine: at the next tick the job waits for another reason, and its check says so.
  engines.setHealth("claude", { installed: false, version: null, signedIn: false });
  await time.advance(60_000);
  expect(shown(host)).toEqual(["queued null: Waiting: Claude is not installed"]);

  // A tick with nothing changed sends nothing.
  const posted = host.posts.length;
  await time.advance(60_000);
  expect(host.posts).toHaveLength(posted);

  // Back and signed in: the job starts by itself, and the round completes its one check.
  engines.setHealth("claude", SIGNED_IN);
  await time.advance(60_000);
  await until(stream, "round.finished");
  await time.advance(0);
  expect(checkPosts(host)).toEqual([
    "check.created queued: Waiting for its turn",
    "check.updated queued: Waiting: Claude is signed out",
    "check.updated queued: Waiting: Claude is not installed",
    "check.updated in_progress: Looking over a1b2c3d",
    "check.completed success: Looked over a1b2c3d: nothing to fix",
  ]);
});

test("a review waiting on an engine's limit gives the reset on its check, with the service's offset (ADR 0055)", async () => {
  const engines = fakeEngines();
  // Thu 8 Oct, 10:11: two days and more after T0 (Tue 6 Oct, 08:52).
  const reset = Date.UTC(2026, 9, 8, 10, 11);
  engines.answer({ outcome: "quota_exhausted", text: "", limitUntil: reset });
  const { service, host, time } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "engine.changed");
  await until(stream, "job.changed");
  await time.advance(0);
  expect(shown(host)).toEqual(["queued null: Waiting: Claude reached its limit"]);
  // bun test runs in UTC: the service's offset is none.
  expect(host.view(PR).checks[0]?.output.summary).toBe(
    "Lookover looks over a1b2c3d once the limit resets, on Thu 8 Oct 2026 at 10:11 (UTC).",
  );
});

test("a review waiting on an engine's limit whose reset moves has its check say the new reset, in one write (ADR 0055)", async () => {
  const engines = fakeEngines();
  engines.answer({ outcome: "quota_exhausted", text: "", limitUntil: Date.UTC(2026, 9, 8, 10, 11) });
  const { room, host, time } = await startRoom({ engines });
  const summary = () => host.view(PR).checks[0]?.output.summary;
  expect(await room.review(PLANTED)).toBe("ok");
  for (let i = 0; i < 20 && summary()?.includes("10:11") !== true; i++) await time.advance(0);
  expect(summary()).toBe(
    "Lookover looks over a1b2c3d once the limit resets, on Thu 8 Oct 2026 at 10:11 (UTC).",
  );
  const before = host.posts.length;

  // A later run reads a later reset: the waiting check follows it.
  const later = Date.UTC(2026, 9, 9, 7, 30);
  room.ranInto("claude", "limit", { limitUntil: later });
  await time.advance(0);
  // The same reset read again: nothing new to show.
  room.ranInto("claude", "limit", { limitUntil: later });
  await time.advance(0);
  expect(summary()).toBe(
    "Lookover looks over a1b2c3d once the limit resets, on Fri 9 Oct 2026 at 07:30 (UTC).",
  );
  expect(host.posts.length).toBe(before + 1);
});

test("a review asked for while paused says so on its check, and the resume moves it in progress", async () => {
  const { service, host, time } = await start({ engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await post(service, cookie, { type: "service.pause", for: "forever" })).status).toBe(200);
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");
  await time.advance(0);
  expect(shown(host)).toEqual(["queued null: Waiting: reviews are paused"]);
  expect(host.view(PR).checks[0]?.output.summary).toBe(
    "Lookover looks over a1b2c3d once the owner resumes reviews.",
  );

  expect((await post(service, cookie, { type: "service.resume" })).status).toBe(200);
  await until(stream, "round.finished");
  await time.advance(0);
  expect(checkPosts(host)).toEqual([
    "check.created queued: Waiting for its turn",
    "check.updated queued: Waiting: reviews are paused",
    "check.updated in_progress: Looking over a1b2c3d",
    "check.completed success: Looked over a1b2c3d: nothing to fix",
  ]);
});

test("a waiting job moved to a newer commit completes the old commit's check skipped and creates one on the new commit", async () => {
  const engines = fakeEngines({ signedIn: false });
  const { service, host, time } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");

  // A push while it waits, then "Review now": the same job, on the new head.
  host.push(PR, SHA1_PUSHED, []);
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");
  await time.advance(0);

  expect(shown(host, SHA1)).toEqual(["completed skipped: A newer commit was pushed"]);
  const result = readResult(host.view(PR, SHA1).checks[0]?.output.text ?? "");
  expect(result).toMatchObject({
    change: { head_sha: SHA1 },
    run: { id: "id-1", state: "skipped", state_reason: "newer_commit", trigger: "manual" },
    verdict: { value: "none", conclusion: "skipped" },
    loop: { round: 0, next_action: "wait" },
    findings: [],
  });
  expect(shown(host, SHA1_PUSHED)).toEqual(["queued null: Waiting: Claude is signed out"]);
});

test("a waiting job whose pull request closed completes its check skipped: the pull request was closed", async () => {
  const { service, host, time } = await start({ engines: fakeEngines({ signedIn: false }) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");

  // Closed while it waits: asked again, the change is gone, and the take cancels its job.
  host.close(PR);
  expect((await review(service, cookie)).status).toBe(404);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { state: "cancelled", cancel: "closed" },
  });
  await time.advance(0);
  expect(shown(host)).toEqual(["completed skipped: The pull request was closed"]);
  expect(readResult(host.view(PR).checks[0]?.output.text ?? "")).toMatchObject({
    run: { state: "skipped", state_reason: "closed" },
    loop: { next_action: "stop" },
  });
});

test("a failed review completes its check neutral with the reason, never failure", async () => {
  const retrieval = new ScriptedRetrieval();
  retrieval.refuse(new RetrievalError("fetch_failed", "fatal: could not read from remote repository"));
  const { service, host, time } = await start({ engines: fakeEngines({ reviews: 1 }), retrieval });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { state: "failed", failure: { kind: "prepare_failed" } },
  });
  await time.advance(0);

  expect(checkPosts(host)).toEqual([
    "check.created queued: Waiting for its turn",
    "check.updated in_progress: Looking over a1b2c3d",
    "check.completed neutral: The review failed: the code could not be fetched",
  ]);
  const result = readResult(host.view(PR).checks[0]?.output.text ?? "");
  expect(result).toMatchObject({
    run: { id: "id-2", state: "failed", state_reason: "prepare_failed", engine: { finder: "claude" } },
    verdict: { value: "none", conclusion: "neutral" },
    loop: { next_action: "ask_human" },
  });
});

test("a check write the host refuses doesn't fail the review, and is sent again at the job's next change", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const { service, host, time } = await start({ engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  // GitHub refuses the check writes while the job is recorded and deferred: no check yet, nothing failed.
  host.refuseChecks("unavailable");
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");
  await time.advance(0);
  expect(host.view(PR).checks).toEqual([]);

  // GitHub answers again; Claude signs in: the job's next change, its start, creates its check in progress.
  host.refuseChecks(null);
  engines.setHealth("claude", SIGNED_IN);
  await time.advance(60_000);
  await until(stream, "round.finished");
  await time.advance(0);
  expect(checkPosts(host)).toEqual([
    "check.created in_progress: Looking over a1b2c3d",
    "check.completed success: Looked over a1b2c3d: nothing to fix",
  ]);
});

test("an update of the check the host refuses is logged, and the job's next change sends where it stands then", async () => {
  const engines = fakeEngines({ signedIn: false, reviews: 1 });
  const logged: string[] = [];
  const { service, host, time } = await start({ engines, log: (line) => logged.push(line) });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");
  await time.advance(0);
  expect(shown(host)).toEqual(["queued null: Waiting: Claude is signed out"]);

  // The reason changes while GitHub refuses the update: logged; the check still shows the last one it took.
  host.refuseChecks("unavailable");
  engines.setHealth("claude", { installed: false, version: null, signedIn: false });
  await time.advance(60_000);
  // Each change of the review is in the log too (ADR 0055); the refused update after the one that moved.
  expect(logged).toEqual([
    "lookover-sandbox#1 opened by sasensi: Add unpaid filter and rewrite total",
    "lookover-sandbox#2 opened as a draft by octocat: Bump the dev dependencies",
    "lookover-sandbox#1 review queued (asked in the app) for a1b2c3d",
    "lookover-sandbox#1 review waits: Claude is signed out",
    "Claude is not installed",
    "lookover-sandbox#1 review waits: Claude is not installed",
    "the check of job id-1 was not sent: The host could not be reached",
  ]);
  expect(shown(host)).toEqual(["queued null: Waiting: Claude is signed out"]);

  // GitHub answers again; Claude is back: the job's start updates the same check, then the round completes it.
  host.refuseChecks(null);
  engines.setHealth("claude", SIGNED_IN);
  await time.advance(60_000);
  await until(stream, "round.finished");
  await time.advance(0);
  expect(checkPosts(host)).toEqual([
    "check.created queued: Waiting for its turn",
    "check.updated queued: Waiting: Claude is signed out",
    "check.updated in_progress: Looking over a1b2c3d",
    "check.completed success: Looked over a1b2c3d: nothing to fix",
  ]);
});

/** A review asked for while Claude is signed out, its check queued; then GitHub refuses checks and the PR closes. */
async function endRefused(options: { home?: string } = {}) {
  const logged: string[] = [];
  const started = await start({
    ...options,
    engines: fakeEngines({ signedIn: false }),
    log: (line) => logged.push(line),
  });
  const { service, host, time } = started;
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "job.changed");
  await until(stream, "job.changed");

  // The end is refused: nothing about the job changes again, and its check still says it waits.
  host.refuseChecks("unavailable");
  host.close(PR);
  expect((await review(service, cookie)).status).toBe(404);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { state: "cancelled", cancel: "closed" },
  });
  await time.advance(0);
  // Each change of the review is in the log too (ADR 0055); the refused end after the cancel.
  expect(logged).toEqual([
    "lookover-sandbox#1 opened by sasensi: Add unpaid filter and rewrite total",
    "lookover-sandbox#2 opened as a draft by octocat: Bump the dev dependencies",
    "lookover-sandbox#1 review queued (asked in the app) for a1b2c3d",
    "lookover-sandbox#1 review waits: Claude is signed out",
    "lookover-sandbox#1 closed",
    "lookover-sandbox#1 review cancelled: the pull request was closed",
    "the check of job id-1 was not sent: The host could not be reached",
  ]);
  expect(shown(host)).toEqual(["queued null: Waiting: Claude is signed out"]);
  host.refuseChecks(null);
  return { ...started, cookie };
}

test("an end of the check the host refused is sent again at the next take", async () => {
  const { service, host, time, cookie } = await endRefused();
  // Another pull request asked for: the take sends the refused end again.
  expect((await post(service, cookie, { type: "review.request", changeId: SECOND })).status).toBe(200);
  await time.advance(0);
  expect(shown(host)).toEqual(["completed skipped: The pull request was closed"]);
  // Sent once: the next takes send nothing more for it.
  await time.advance(120_000);
  expect(checkPosts(host).filter((p) => p.includes("was closed"))).toEqual([
    "check.completed skipped: The pull request was closed",
  ]);
});

test("an end of the check the host refused is sent again after a restart", async () => {
  const dir = home();
  const first = await endRefused({ home: dir });
  await first.service.stop();
  await start({ home: dir, host: first.host, time: first.time, idsFrom: 100 });
  await first.time.advance(0);
  expect(shown(first.host)).toEqual(["completed skipped: The pull request was closed"]);
});

test("an end whose check was created and whose completion was refused completes that check at the next take: never a second", async () => {
  const time = new DemoClock({ at: T0 });
  const { service, host } = await start({
    host: new Flaky(time),
    time,
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // Another author's pull request: skipped, its check created and then refused its completion.
  const other = { repo: SANDBOX, number: 6 };
  host.open({
    ...pr1,
    number: 6,
    url: pr1.url.replace(/\/1$/, "/6"),
    author: { id: 583231, login: "octocat" },
    head: { ref: "branch-6", sha: commitSha("6".repeat(40)) },
  });
  await time.advance(60_000);
  await until(stream, "job.changed");
  await time.advance(0);
  expect(host.view(other).checks.map((c) => c.status)).toEqual(["queued"]);

  // The next take sends the end again, to the check it created.
  expect((await post(service, cookie, { type: "review.request", changeId: PLANTED })).status).toBe(200);
  await until(stream, "round.finished");
  await time.advance(0);
  expect(host.view(other).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`)).toEqual([
    "completed skipped: Not your pull request",
  ]);
});

test("a round that created its check, refused before it completed it, completes that check with the failure: never a second", async () => {
  const time = new DemoClock({ at: T0 });
  const { service, host } = await start({
    host: new Flaky(time, true),
    time,
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // No check until the round's own: the queued and in-progress ones are refused, then the round's completion.
  expect((await review(service, cookie)).status).toBe(200);
  await until(stream, "run.started");
  // Its posts given up, the round stays (ADR 0044), sent with the failed job.
  expect((await until(stream, "round.finished")).at(-1)).toMatchObject({
    job: { state: "failed", failure: { kind: "publish_failed" } },
    round: { n: 1 },
  });
  await time.advance(0);
  expect(shown(host)).toEqual(["completed neutral: The review failed: GitHub refused the review"]);
});
