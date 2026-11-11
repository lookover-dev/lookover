// The fork rule (ADR 0048), through the service's entry, on fakes only: a pull request whose head is in another
// repository than its base is never reviewed by itself, whoever wrote it. The person's says why on its check; a
// teammate's gets nothing at all (ADR 0078). Asked by hand, Claude alone reviews it: Codex never finds it, confirms it
// or steps in on it.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, commitSha, type Event } from "@lookover/contracts";
import type { FakeChange, FakeGitHost, ScriptedRun } from "@lookover/testkit";
import {
  api,
  blockOn,
  fakeEngines,
  heldRuns,
  home,
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
const NO_FINDINGS: ScriptedRun = { outcome: "ok", text: '```json\n{"findings": []}\n```' };
/** A block as the engine writes it. */
const answered = (block: unknown): ScriptedRun => ({
  outcome: "ok",
  text: ["```json", JSON.stringify(block), "```"].join("\n"),
});
const FOUND = answered({
  findings: [
    {
      path: "src/total.ts",
      line: 12,
      severity: "blocking",
      category: "correctness",
      title: "The total skips the last invoice",
      body: "When it runs, skips_last breaks.",
      defect_key: "skips_last",
    },
  ],
});
const CONFIRMED = answered({
  verdicts: [
    {
      id: "C1",
      verdict: "confirmed",
      reason: "The loop stops at length - 1.",
      evidence: ["src/total.ts:12"],
      severity: "blocking",
    },
  ],
});
/** Codex wrote it: on the owner's own change from the repository itself, Claude would find and Codex confirm. */
const CODEX_CODE = "Fix the total\n\nCo-Authored-By: Codex <noreply@openai.com>";

/** The owner's own pull request, from a fork, written by Codex. */
const fork: FakeChange = {
  ...pr1,
  number: 7,
  title: "Fix the total, from my fork",
  url: pr1.url.replace(/\/1$/, "/7"),
  head: { ref: "fork-7", sha: commitSha("7".repeat(40)) },
  messages: ["Start the filter", CODEX_CODE],
  fork: true,
};
const FORK = { repo: SANDBOX, number: 7 };
const id = changeId("sasensi/lookover-sandbox#7");

/** Claude and Codex both signed in and ready. */
function bothEngines(...claude: ScriptedRun[]) {
  const engines = fakeEngines();
  engines.setHealth("codex", { installed: true, version: "0.162.1", signedIn: true });
  engines.answerFor("claude", ...(claude.length > 0 ? claude : [NO_FINDINGS]));
  engines.answerFor("codex", NO_FINDINGS);
  return engines;
}

/** The commit as the block links it. */
const commit = (sha: string) =>
  `[\`${sha.slice(0, 7)}\`](https://github.com/${SANDBOX.owner}/${SANDBOX.name}/pull/7/commits/${sha})`;
/** The block's heading on the fork's pull request, past the wordmark. */
const heading = (host: FakeGitHost) => blockOn(host, FORK).split("\n")[0]?.split(" · ").slice(1).join(" · ");
/** The block's line under its heading. */
const line = (host: FakeGitHost) => blockOn(host, FORK).split("\n\n")[1];
/** The line of a request a push ended, as the person reads it (ADR 0092). */
const ENDED =
  "A newer commit was pushed after the request. Comment `/lookover review` to look over the newest one.";

const startedBy = (events: Event[]) =>
  events.flatMap((e) => (e.type === "run.started" ? [e.run.reviewer] : []));

test("a fork opened, even the owner's, is skipped with its reason on the check; nothing runs", async () => {
  const engines = bothEngines();
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(fork);
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: { skip: "fork" } });
  await time.advance(0);
  expect(host.view(FORK).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`)).toEqual([
    "completed skipped: Not reviewed: it comes from a fork",
  ]);
  expect(host.view(FORK).checks[0]?.output.summary).toContain("To ask, comment `/lookover review` on it");
  expect((await snapshot(service, cookie)).changes[id]).toMatchObject({ fork: true, author: "you" });
  expect(engines.runs).toEqual([]);
});

test("a fork opened where only Codex may review says to let Claude review, in Settings: a request would be skipped too", async () => {
  const engines = bothEngines();
  const { host, time } = await start({ changes: [pr1], engines, repositorySettings: { reviewers: "codex" } });

  host.open(fork);
  await time.advance(MIN);
  await time.advance(0);
  expect(host.view(FORK).checks.map((c) => c.output.summary)).toEqual([
    "Lookover did not look over 7777777: it reviews a pull request from a fork only when the owner asks, and with Claude only, and only Codex may review here. To have it reviewed, the owner lets Claude review too, in Lookover's Settings.",
  ]);
  expect(engines.runs).toEqual([]);
});

test("a fork asked for by hand is found and confirmed by Claude alone, though Codex would find the owner's change", async () => {
  const engines = bothEngines(FOUND, CONFIRMED);
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  const events = await until(stream, "round.finished");
  expect(startedBy(events)).toEqual(["claude"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude", "claude"]);
  expect(events.at(-1)).toMatchObject({
    round: { confirmer: "claude", confirmFallback: { reason: "not-own", engine: "codex" } },
  });
});

test("a fork's request waiting when the fork is pushed ends cancelled on its commit: the new head was asked by nobody", async () => {
  const engines = fakeEngines({ signedIn: false });
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const checks = (on: typeof fork.head.sha) =>
    host.view(FORK, on).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`);

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  // Claude is signed out: the owner's request waits on the fork's head.
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { trigger: "comment", skip: null, sha: fork.head.sha },
  });

  const pushed = commitSha("8".repeat(40));
  host.push(FORK, pushed, []);
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(MIN);
  await time.advance(MIN);
  await time.advance(0);
  const jobs = (await snapshot(service, cookie)).reviews[id]?.job;
  expect(jobs).toMatchObject({ state: "cancelled", cancel: "pushed", id: "id-2", sha: fork.head.sha });
  // Its check ends on the commit it was asked for, saying to ask again; the new head has none: nothing asked for it.
  expect(checks(fork.head.sha)).toEqual([
    "completed skipped: Not reviewed: it comes from a fork",
    "completed skipped: A newer commit was pushed after the request",
  ]);
  expect(checks(pushed)).toEqual([]);
  expect(engines.runs).toEqual([]);
  // No round ever posted to put back: the block says the request ended, and how to ask again (ADR 0092).
  expect(heading(host)).toBe(`Didn't look over ${commit(fork.head.sha)}`);
  expect(line(host)).toBe(ENDED);
});

test("the person's own fork, reviewed after every push: the fork skip the push records on the new head leaves the ended request's block (ADR 0092)", async () => {
  const engines = fakeEngines({ signedIn: false });
  const { service, host, time } = await start({
    changes: [pr1],
    engines,
    repositorySettings: { onPush: true },
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const checks = (on: typeof fork.head.sha) =>
    host.view(FORK, on).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`);

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { trigger: "comment", skip: null, sha: fork.head.sha },
  });
  expect(heading(host)).toBe(`Waiting to look over ${commit(fork.head.sha)}`);

  const pushed = commitSha("8".repeat(40));
  host.push(FORK, pushed, []);
  await time.advance(MIN);
  await time.advance(MIN);
  await time.advance(0);
  // The push's own review is skipped on the new head, after the request ended: the newest job is that skip.
  expect((await snapshot(service, cookie)).reviews[id]?.job).toMatchObject({
    state: "skipped",
    skip: "fork",
    sha: pushed,
  });
  expect(checks(fork.head.sha)).toContain("completed skipped: A newer commit was pushed after the request");
  expect(checks(pushed)).toEqual(["completed skipped: Not reviewed: it comes from a fork"]);
  expect(heading(host)).toBe(`Didn't look over ${commit(fork.head.sha)}`);
  expect(line(host)).toBe(ENDED);
});

test("the person's own fork, its review running when a push ends the request behind it: the app's page and GitHub's block say the same, running then failed (ADR 0092)", async () => {
  const engines = fakeEngines();
  engines.answerFor("claude", { outcome: "crashed", text: "" });
  const held = heldRuns(engines);
  const { service, host, time } = await start({
    changes: [pr1],
    engines: held.engines,
    repositorySettings: { onPush: true },
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const app = async () => (await snapshot(service, cookie)).reviews[id];

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await until(stream, "run.started");
  // A second request waits behind the running review; a push ends it. No fork skip is recorded on the new head: a
  // job of the change is pending (core's `skipOutcome`).
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  const pushed = commitSha("8".repeat(40));
  host.push(FORK, pushed, []);
  await time.advance(MIN);
  await time.advance(0);
  expect(heading(host)).toBe(`Looking over ${commit(fork.head.sha)}`);
  expect(await app()).toMatchObject({
    job: { state: "running", sha: fork.head.sha },
    described: { state: "running", sha: fork.head.sha },
  });

  // The review fails: GitHub's block says the request ended, and so does the app's page, the request sent after it.
  held.release();
  await until(stream, "job.changed");
  await time.advance(0);
  await time.advance(0);
  expect(heading(host)).toBe(`Didn't look over ${commit(fork.head.sha)}`);
  const ended = { state: "cancelled", cancel: "pushed", sha: fork.head.sha };
  expect(await app()).toMatchObject({ job: ended, described: ended });
  // The fork pushed again, its review's skip recorded now: both still say the request ended.
  host.push(FORK, commitSha("9".repeat(40)), []);
  await time.advance(MIN);
  await time.advance(0);
  expect(heading(host)).toBe(`Didn't look over ${commit(fork.head.sha)}`);
  expect(await app()).toMatchObject({ job: { state: "skipped", skip: "fork" }, described: ended });
});

test("the person's own fork, its review deferred at Claude's limit after a push ended the request behind it: the review still due decides both blocks, not the ended request (ADR 0092)", async () => {
  const engines = fakeEngines();
  engines.answerFor("claude", { outcome: "quota_exhausted", text: "" });
  const held = heldRuns(engines);
  const { service, host, time } = await start({ changes: [pr1], engines: held.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const app = async () => (await snapshot(service, cookie)).reviews[id];

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await until(stream, "run.started");
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  host.push(FORK, commitSha("8".repeat(40)), []);
  await time.advance(MIN);
  await time.advance(0);

  // Claude at its limit: the review waits to run again, and the request a push ended is sent after it.
  held.release();
  await until(stream, "job.changed");
  await time.advance(0);
  await time.advance(0);
  expect(heading(host)).not.toStartWith("Didn't look over");
  expect(line(host)).not.toBe(ENDED);
  const due = { state: "deferred", sha: fork.head.sha, deferral: { reason: "engine-limit" } };
  expect(await app()).toMatchObject({ job: { state: "cancelled", cancel: "pushed" }, described: due });
});

test("the person's own fork, its review deferred behind a request a push ended, then a second push ends that review: both blocks say the request ended, never Waiting (ADR 0092)", async () => {
  const engines = fakeEngines();
  engines.answerFor("claude", { outcome: "quota_exhausted", text: "" });
  const held = heldRuns(engines);
  const { service, host, time } = await start({ changes: [pr1], engines: held.engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const app = async () => (await snapshot(service, cookie)).reviews[id];

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await until(stream, "run.started");
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  host.push(FORK, commitSha("8".repeat(40)), []);
  await time.advance(MIN);
  await time.advance(0);
  held.release();
  await until(stream, "job.changed");
  await time.advance(0);
  await time.advance(0);
  expect(line(host)).not.toBe(ENDED);
  const request = (await app())?.job;
  const review = (await app())?.described;
  expect(request).toMatchObject({ state: "cancelled", cancel: "pushed" });
  expect(review).toMatchObject({ state: "deferred" });

  // A second push ends the deferred review too: nothing is due any more, and both blocks say the newer request, the
  // one the first push ended, ended.
  host.push(FORK, commitSha("9".repeat(40)), []);
  await time.advance(MIN);
  await time.advance(0);
  await time.advance(0);
  expect(heading(host)).toBe(`Didn't look over ${commit(fork.head.sha)}`);
  expect(line(host)).toBe(ENDED);
  expect(await app()).toMatchObject({
    job: request ?? {},
    described: request ?? {},
  });
});

test("the person's own fork, its review back in the queue after a restart, a push having ended the request behind it: the review still due decides both blocks (ADR 0092)", async () => {
  const dir = home();
  const first = await start({ home: dir, changes: [pr1], engines: heldRuns(fakeEngines()).engines });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));

  first.host.open(fork);
  await first.time.advance(MIN);
  await until(stream, "job.changed");
  first.host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await first.time.advance(MIN);
  await until(stream, "run.started");
  first.host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await first.time.advance(MIN);
  first.host.push(FORK, commitSha("8".repeat(40)), []);
  await first.time.advance(MIN);
  await first.time.advance(0);
  await first.service.stop();

  // Started again with Claude signed out: the review is back in the queue, waiting, and still due.
  const second = await start({
    home: dir,
    host: first.host,
    time: first.time,
    idsFrom: 100,
    engines: fakeEngines({ signedIn: false }),
  });
  await second.time.advance(0);
  await second.time.advance(0);
  expect(heading(second.host)).not.toStartWith("Didn't look over");
  expect(line(second.host)).not.toBe(ENDED);
  const again = await openApp(second.service);
  const due = {
    id: "id-2",
    state: "deferred",
    deferral: { reason: "engine-signed-out" },
    sha: fork.head.sha,
  };
  expect((await snapshot(second.service, again)).reviews[id]).toMatchObject({ described: due });
});

test("a teammate's fork gets nothing; the person's request on it waiting when it is pushed ends on the asked commit only (ADR 0078)", async () => {
  const engines = fakeEngines({ signedIn: false });
  const { service, host, time } = await start({
    changes: [pr1],
    engines,
    repositorySettings: { onPush: true },
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const checks = (on: typeof fork.head.sha) =>
    host.view(FORK, on).checks.map((c) => `${c.status} ${c.conclusion}: ${c.output.title}`);

  const teammate = { id: 583231, login: "octocat" };
  host.open({ ...fork, author: teammate });
  await time.advance(MIN);
  await until(stream, "change.opened");
  const before = commitSha("6".repeat(40));
  host.push(FORK, before, []);
  await time.advance(MIN);
  // The teammate's own `/lookover review` is ignored too.
  host.seedComment(FORK, { author: teammate, body: "/lookover review" });
  await time.advance(MIN);
  expect((await snapshot(service, cookie)).reviews[id]?.job).toBeNull();
  expect(host.posts).toEqual([]);

  // Claude is signed out: the person's request waits on the fork's head.
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({
    job: { trigger: "comment", skip: null, sha: before },
  });
  const pushed = commitSha("8".repeat(40));
  host.push(FORK, pushed, []);
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(MIN);
  await time.advance(MIN);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[id]?.job).toMatchObject({
    state: "cancelled",
    cancel: "pushed",
    sha: before,
  });
  // Its end on the commit asked for, and nothing else: no fork skip, nothing on the new head.
  expect(checks(fork.head.sha)).toEqual([]);
  expect(checks(before)).toEqual(["completed skipped: A newer commit was pushed after the request"]);
  expect(checks(pushed)).toEqual([]);
  expect(engines.runs).toEqual([]);
  // The line speaks to the person, in a teammate's description too (ADR 0092).
  expect(heading(host)).toBe(`Didn't look over ${commit(before)}`);
  expect(line(host)).toBe(ENDED);
});

test("a fork's second request waiting when the fork is pushed puts the block of the round that posted back", async () => {
  const engines = bothEngines(FOUND, CONFIRMED);
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await until(stream, "round.finished");
  const posted = blockOn(host, FORK);
  expect(heading(host)).toBe("One thing to fix");

  // Claude signed out: the owner's second request waits, listing round 1's finding; then the fork is pushed.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: false });
  host.seedComment(FORK, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  expect(heading(host)).toBe(`Waiting to look over ${commit(fork.head.sha)}`);
  host.push(FORK, commitSha("8".repeat(40)), []);
  await time.advance(MIN);
  await time.advance(0);
  expect((await snapshot(service, cookie)).reviews[id]?.job).toMatchObject({
    state: "cancelled",
    cancel: "pushed",
  });
  expect(blockOn(host, FORK)).toBe(posted);
});

test('"Review now" on a fork reviews it with Claude alone, as a comment does', async () => {
  const engines = bothEngines();
  const { service, host, time } = await start({ changes: [pr1], engines });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.open(fork);
  await time.advance(MIN);
  await until(stream, "job.changed");
  expect((await post(service, cookie, { type: "review.request", changeId: id })).status).toBe(200);
  const events = await until(stream, "round.finished");
  expect(startedBy(events)).toEqual(["claude"]);
  expect(engines.runs.map((r) => r.engine)).toEqual(["claude"]);
});
