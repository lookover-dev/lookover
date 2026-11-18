// "This finding is wrong" (ADR 0052), through the service's entry, on fakes only: round 1 posts a blocking finding
// and a should-fix one; the owner dismisses the blocking one from "Too noisy?". Lookover says so on its thread,
// rewrites the status block and, when the round is on the change's head, its check (the verdict and the result included),
// then minimizes the thread's root; a later round never raises it again. "Accept as is" (ADR 0100) goes the same way,
// its reason one line, never minimizing the root. Both are the room's one command, `settle` (ADR 0101), which keeps a
// dismissal's reason too.
import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  type ChangeRef,
  changeId,
  findingId,
  type OwnerDecision,
  type ReviewResult,
  readResult,
  repositoryId,
  reviewResultV1,
  type SettleText,
  type State,
  settleComment,
  statusOf,
  withoutWordmark,
} from "@lookover/contracts";
import { openStore, type Store } from "@lookover/store";
import { type FakeEngines, type FakeGitHost, ScriptedRetrieval, type ScriptedRun } from "@lookover/testkit";
import {
  fakeEngines,
  home,
  OWNER,
  openApp,
  post,
  pr1,
  SANDBOX,
  SHA1_PUSHED,
  snapshot,
  start,
  startRoom,
  stopAll,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const PR1: ChangeRef = { repo: SANDBOX, number: 1 };
const ID = changeId("sasensi/lookover-sandbox#1");

/** A block as the engine writes it. */
const answered = (block: unknown): ScriptedRun => ({
  outcome: "ok",
  text: ["```json", JSON.stringify(block), "```"].join("\n"),
});

const SKIPS_LAST = {
  path: "src/total.ts",
  line: 12,
  severity: "blocking",
  category: "correctness",
  title: "The total skips the last invoice",
  body: "The loop stops one short, so the last invoice is never added.",
  defect_key: "total-skips-last-invoice",
};
const TAX_TWICE = {
  path: "src/total.ts",
  line: 20,
  severity: "should_fix",
  category: "correctness",
  title: "The tax is added twice",
  body: "The tax is added in the loop and again after it.",
  defect_key: "tax-added-twice",
};

/** Round 1's find pass and confirm pass: F1 blocking on line 12, F2 should fix on line 20, both confirmed. */
const ROUND_ONE: ScriptedRun[] = [
  answered({ findings: [SKIPS_LAST, TAX_TWICE] }),
  answered({
    verdicts: [
      {
        id: "C1",
        verdict: "confirmed",
        reason: "Read.",
        evidence: ["src/total.ts:12"],
        severity: "blocking",
      },
      {
        id: "C2",
        verdict: "confirmed",
        reason: "Read.",
        evidence: ["src/total.ts:20"],
        severity: "should_fix",
      },
    ],
  }),
];

/** `src/total.ts`, its 40 lines added: every finding's line takes a comment. */
const TOTAL_ADDED = [
  "diff --git a/src/total.ts b/src/total.ts",
  "--- /dev/null",
  "+++ b/src/total.ts",
  "@@ -0,0 +1,40 @@",
  ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
  "",
].join("\n");

/** The service with round 1 posted on #1, and the owner's app open on it. */
async function roundOne(options: { home?: string; engines?: FakeEngines; store?: Store } = {}) {
  const engines = options.engines ?? fakeEngines();
  engines.answer(...ROUND_ONE);
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = TOTAL_ADDED;
  const { host, time, service, logged } = await start({
    changes: [],
    engines,
    retrieval,
    ...(options.home ? { home: options.home } : {}),
    ...(options.store ? { store: options.store } : {}),
  });
  host.open(pr1);
  await time.advance(MIN);
  const cookie = await openApp(service);
  const threads = await host.threads(PR1);
  const root = threads.find((t) => String(t.findingId) === "F1");
  if (!root) throw new Error("round 1 posted no thread for F1");
  return {
    engines,
    host,
    time,
    service,
    retrieval,
    logged,
    cookie,
    root,
    /** "This finding is wrong" on `finding`, as "Too noisy?" sends it: the service's answer. */
    wrong: async (finding = "F1") => {
      const res = await post(service, cookie, {
        type: "noise.apply",
        choice: { kind: "wrong", changeId: ID, findingId: finding },
      });
      return { status: res.status, body: await res.json() };
    },
    /** "Accept as is" on `finding`, as its card sends it: the service's answer. */
    accept: async (reason?: string, finding = "F1") => {
      const res = await post(service, cookie, {
        type: "finding.accept",
        changeId: ID,
        findingId: finding,
        ...(reason === undefined ? {} : { reason }),
      });
      return { status: res.status, body: await res.json() };
    },
    /** The owner's `/lookover review`, picked up by the poll; the round it leads to runs on `runs`. */
    ask: async (...runs: ScriptedRun[]) => {
      engines.answer(...runs);
      host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
      await time.advance(MIN);
    },
    state: async (): Promise<State> => snapshot(service, cookie),
    /** The result on the last check completed, valid against the schema. */
    result(): ReviewResult {
      const last = host.posts.findLast((p) => p.kind === "check.completed");
      if (last?.kind !== "check.completed") throw new Error("no check completed");
      const read = readResult(last.output.text);
      expect(reviewResultV1.safeParse(read).success).toBe(true);
      if (read === null) throw new Error("no result on the check");
      return read;
    },
  };
}

/** What the host was sent since `from`, but reactions and checks following their jobs. */
const sentSince = (posts: { kind: string }[], from: number) =>
  posts
    .slice(from)
    .map((p) => p.kind)
    .filter((kind) => kind !== "reaction" && kind !== "check.created" && kind !== "check.updated");

/** The status block in the description as the host shows it (ADR 0074). */
const blockOf = (w: Awaited<ReturnType<typeof roundOne>>) => statusOf(w.host.view(PR1).description) ?? "";

test("a finding dismissed as wrong is said on its thread, the status block and the round's check say so, and its root is minimized", async () => {
  const w = await roundOne();
  const check = w.host.posts.findLast((p) => p.kind === "check.completed");
  expect(w.result().verdict).toMatchObject({ value: "blocking", conclusion: "neutral" });
  const before = w.host.posts.length;

  expect(await w.wrong()).toEqual({ status: 200, body: { ok: true } });
  await w.time.advance(1_000);

  expect(sentSince(w.host.posts, before)).toEqual([
    "reply",
    "status.written",
    "check.completed",
    "minimized",
  ]);
  const reply = w.host.posts.find((p) => p.kind === "reply");
  expect(reply).toMatchObject({ commentId: w.root.commentId });
  expect(reply?.kind === "reply" && withoutWordmark(reply.body)).toStartWith(
    "Dismissed by the owner\n\nIt won't be raised again on this pull request.\n\n",
  );
  expect(blockOf(w)).toContain(" · 1 withdrawn\n\n- **Should fix** · ");
  expect(blockOf(w)).not.toContain("The total skips the last invoice");
  // The round's own check, rewritten: F2 alone is open, below blocking.
  const rewritten = w.host.posts.findLast((p) => p.kind === "check.completed");
  expect(rewritten?.kind === "check.completed" && check?.kind === "check.completed").toBe(true);
  if (rewritten?.kind === "check.completed" && check?.kind === "check.completed")
    expect(rewritten.checkId).toBe(check.checkId);
  const result = w.result();
  expect(result.verdict).toMatchObject({ value: "pass", conclusion: "success" });
  expect(result.findings.find((f) => f.id === "F1")).toMatchObject({
    status: "dismissed",
    needs_action_by: "none",
    resolution: { kind: "dismissed", round: 1, via: "app" },
  });
  const root = w.host
    .view(PR1)
    .reviews.flatMap((r) => r.comments)
    .find((c) => c.id === String(w.root.commentId));
  expect(root?.minimized).toBe("resolved");

  // The app follows: the finding is done, the loop still open on F2, and the history says what the owner did.
  const state = await w.state();
  const review = state.reviews[ID];
  expect(review?.findings.map((f) => [String(f.id), f.status])).toEqual([
    ["F1", "dismissed"],
    ["F2", "open"],
  ]);
  expect(review?.loop).toBe("open");
  expect(review?.timeline.at(-1)).toMatchObject({ kind: "dismissed", findingIds: ["F1"], via: "app" });
});

test("a dismissal after a preview rewrites the round's check from that round's ledger, never the preview's", async () => {
  const w = await roundOne();
  // A preview of the same commit says F1 is gone: it posts nothing, so the round's check still has F1 to fix.
  w.engines.answer(answered({ findings: [], earlier: [{ id: "F1", present: false, why: "Not there." }] }));
  const preview = await post(w.service, w.cookie, { type: "setup.firstReview", changeId: ID, preview: true });
  expect(preview.status).toBe(200);
  await w.time.advance(MIN);
  expect((await w.state()).reviews[ID]).toMatchObject({ preview: true, job: { state: "done" } });
  expect((await w.state()).reviews[ID]?.findings.find((f) => String(f.id) === "F1")?.status).not.toBe("open");

  expect(await w.wrong("F2")).toEqual({ status: 200, body: { ok: true } });
  await w.time.advance(1_000);
  expect(w.result().verdict).toMatchObject({ value: "blocking", conclusion: "neutral" });
  expect(blockOf(w)).toContain("The total skips the last invoice");
});

test("a dismissed finding is never raised again: the next round's finder isn't given it, and its candidate counts for nothing", async () => {
  const w = await roundOne();
  await w.wrong();
  await w.time.advance(1_000);
  // Round 2 reports the same bug again, and F2 still there.
  await w.ask(
    answered({ findings: [SKIPS_LAST], earlier: [{ id: "F2", present: true, why: "Still added twice." }] }),
  );
  const prompt = w.engines.runs.at(-1)?.prompt ?? "";
  expect(prompt).toContain("- F2 (should_fix");
  expect(prompt).not.toContain("The total skips the last invoice");
  // No third finding: the bug reported again is F1, dismissed. The result lists what is open first.
  const result = w.result();
  expect(result.loop).toMatchObject({ round: 2 });
  expect(result.findings.map((f) => [f.id, f.status])).toEqual([
    ["F2", "open"],
    ["F1", "dismissed"],
  ]);
  expect(result.verdict).toMatchObject({ value: "pass" });
});

test("a dismissal is refused while a round of the change runs, and nothing is posted for it", async () => {
  const w = await roundOne();
  // Round 2's find pass takes ten minutes.
  w.engines.answer({ ...answered({ findings: [] }), tookMs: 10 * MIN });
  w.host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  await w.time.advance(MIN);
  expect((await w.state()).reviews[ID]?.run).not.toBeNull();
  const before = w.host.posts.length;

  expect(await w.wrong()).toEqual({
    status: 409,
    body: { error: "a round of the change is running", refused: "reviewing" },
  });
  expect(w.host.posts.slice(before).filter((p) => p.kind === "reply" || p.kind === "minimized")).toEqual([]);
  expect((await w.state()).reviews[ID]?.findings[0]?.status).toBe("open");
});

test("a finding settled, kept off the pull request or not the change's is refused", async () => {
  const w = await roundOne();
  await w.wrong();
  await w.time.advance(1_000);
  expect(await w.wrong()).toEqual({
    status: 409,
    body: { error: "the finding is settled or not on the pull request", refused: "settled" },
  });
  expect(await w.wrong("F9")).toEqual({
    status: 404,
    body: { error: "no such finding", refused: "no_such_finding" },
  });
});

test("once the head moved, the round's check is left as it was: the thread and the status block say it", async () => {
  const w = await roundOne();
  // A push the owner doesn't review: the round's check is on a commit that is no longer the head.
  w.host.push(PR1, SHA1_PUSHED, pr1.diff);
  await w.time.advance(MIN);
  const before = w.host.posts.length;
  await w.wrong();
  await w.time.advance(1_000);
  expect(sentSince(w.host.posts, before)).toEqual(["reply", "status.written", "minimized"]);
});

test("a dismissal after a later job was skipped still rewrites the status block: the finding gone, counted withdrawn", async () => {
  const w = await roundOne();
  // "Review now" while the repository is off: the change's newest job is a skip, round 1 still its last posted.
  const repoId = repositoryId(`${SANDBOX.owner}/${SANDBOX.name}`);
  await post(w.service, w.cookie, { type: "repo.setEnabled", repoId, enabled: false });
  await post(w.service, w.cookie, { type: "review.request", changeId: ID });
  await w.time.advance(0);
  expect((await w.state()).reviews[ID]?.job).toMatchObject({ state: "skipped", skip: "repo-off" });
  await post(w.service, w.cookie, { type: "repo.setEnabled", repoId, enabled: true });
  const before = w.host.posts.length;

  expect(await w.wrong()).toEqual({ status: 200, body: { ok: true } });
  await w.time.advance(1_000);

  expect(sentSince(w.host.posts, before)).toContain("status.written");
  expect(blockOf(w)).toContain(" · 1 withdrawn\n\n- **Should fix** · ");
  expect(blockOf(w)).not.toContain("The total skips the last invoice");
});

test("after a round whose review GitHub refused, a dismissal leaves that round's failed check as it is", async () => {
  const w = await roundOne();
  // Round 2, on the same head, still sees F1 and F2 and finds a new blocking defect; GitHub refuses its review.
  w.host.refuseNext("unauthorized", { post: "review" });
  await w.ask(
    answered({
      findings: [
        {
          path: "src/total.ts",
          line: 30,
          severity: "blocking",
          category: "correctness",
          title: "The discount is never applied",
          body: "The discount is computed and then dropped.",
          defect_key: "discount-dropped",
        },
      ],
      earlier: [
        { id: "F1", present: true, why: "Still skips it." },
        { id: "F2", present: true, why: "Still added twice." },
      ],
    }),
    answered({
      verdicts: [
        {
          id: "C1",
          verdict: "confirmed",
          reason: "Read.",
          evidence: ["src/total.ts:30"],
          severity: "blocking",
        },
      ],
    }),
  );
  const failed = w.host.posts.findLast((p) => p.kind === "check.completed");
  expect((await w.state()).reviews[ID]?.job).toMatchObject({
    state: "failed",
    failure: { kind: "publish_failed" },
  });
  const before = w.host.posts.length;

  expect(await w.wrong()).toEqual({ status: 200, body: { ok: true } });
  await w.time.advance(1_000);

  // The thread and the status block say it; round 2's check still says its posts failed.
  expect(sentSince(w.host.posts, before)).toEqual(["reply", "status.written", "minimized"]);
  expect(w.host.posts.findLast((p) => p.kind === "check.completed")).toBe(failed);
});

test("a service stopped while a dismissal waits to be sent again resumes its posts after the restart: each once", async () => {
  const dir = home();
  const w = await roundOne({ home: dir });
  // GitHub refuses the status block's write for a moment; the service stops during the wait.
  w.host.refuseNext("unavailable", { post: "status" });
  const before = w.host.posts.length;
  await w.wrong();
  await w.time.advance(1_000);
  expect(sentSince(w.host.posts, before)).toEqual(["reply"]);
  await w.service.stop();

  await start({
    home: dir,
    host: w.host,
    engines: w.engines,
    retrieval: w.retrieval,
    time: w.time,
    idsFrom: 100,
    changes: [],
  });
  await w.time.advance(MIN);
  expect(sentSince(w.host.posts, before)).toEqual([
    "reply",
    "status.written",
    "check.completed",
    "minimized",
  ]);
  expect(w.result().verdict).toMatchObject({ value: "pass" });
});

test("a round asked while a dismissal's posts are owed waits until they end, then posts after them", async () => {
  const w = await roundOne();
  // GitHub asks to wait a minute before the status block's write: the dismissal's posts are owed that long.
  w.host.refuseNext("rate_limited", { post: "status" });
  const before = w.host.posts.length;
  await w.wrong();
  await w.time.advance(1_000);
  expect(sentSince(w.host.posts, before)).toEqual(["reply"]);

  // The owner asks for round 2 meanwhile: the poll picks it up, and it waits.
  const runs = w.engines.runs.length;
  w.engines.answer(
    answered({ findings: [], earlier: [{ id: "F2", present: true, why: "Still added twice." }] }),
  );
  w.host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  await w.time.advance(20_000);
  const waiting = (await w.state()).reviews[ID];
  expect([waiting?.job?.state, waiting?.run, w.engines.runs.length]).toEqual(["queued", null, runs]);
  // Behind the change's own posts, it writes no block (ADR 0074): the dismissal's is still owed.
  expect(sentSince(w.host.posts, before)).toEqual(["reply"]);

  // The wait over, the dismissal's posts end; round 2 runs and posts after them.
  await w.time.advance(2 * MIN);
  expect(w.engines.runs.length).toBe(runs + 1);
  expect(sentSince(w.host.posts, before)).toEqual([
    "reply",
    "status.written",
    "check.completed",
    "minimized",
    // Round 2: Looking over as it runs (ADR 0074).
    "status.written",
    // Round 2: no new line comment, so no review (ADR 0074); the status block, its check, and the `/lookover review` it
    // answered minimized.
    "status.written",
    "check.completed",
    "minimized",
  ]);
  expect(w.result().loop).toMatchObject({ round: 2 });
});

test("a dismissal stuck on one change doesn't hold another change's", async () => {
  const pr3: typeof pr1 = { ...pr1, number: 3, url: "https://github.com/sasensi/lookover-sandbox/pull/3" };
  const engines = fakeEngines();
  engines.answer(...ROUND_ONE, ...ROUND_ONE);
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = TOTAL_ADDED;
  const { host, time, service } = await start({ changes: [], engines, retrieval });
  host.open(pr1);
  host.open(pr3);
  await time.advance(MIN);
  await time.advance(MIN);
  const cookie = await openApp(service);
  const wrong = (change: string) =>
    post(service, cookie, {
      type: "noise.apply",
      choice: { kind: "wrong", changeId: changeId(change), findingId: "F1" },
    });
  /** The summaries of `n` edited since `from`. */
  const summariesOf = (n: number, from: number) =>
    host.posts.slice(from).filter((p) => p.kind === "status.written" && p.number === n).length;
  const before = host.posts.length;
  // #1's status block waits a minute at GitHub's word; #3's dismissal, saved after, is sent meanwhile.
  host.refuseNext("rate_limited", { post: "status" });
  expect((await wrong("sasensi/lookover-sandbox#1")).status).toBe(200);
  expect((await wrong("sasensi/lookover-sandbox#3")).status).toBe(200);
  await time.advance(1_000);
  expect([summariesOf(1, before), summariesOf(3, before)]).toEqual([0, 1]);
  await time.advance(2 * MIN);
  expect([summariesOf(1, before), summariesOf(3, before)]).toEqual([1, 1]);
});

test("a finding accepted as is is said on its thread with the reason, one line; the block and the check count it accepted, its root left", async () => {
  const w = await roundOne();
  const before = w.host.posts.length;

  expect(await w.accept("  Accepted\n  deploy-window   gap  ")).toEqual({ status: 200, body: { ok: true } });
  await w.time.advance(1_000);

  expect(sentSince(w.host.posts, before)).toEqual(["reply", "status.written", "check.completed"]);
  const reply = w.host.posts.find((p) => p.kind === "reply");
  expect(reply?.kind === "reply" && withoutWordmark(reply.body)).toStartWith(
    "Accepted by the owner\n\nAccepted deploy-window gap\n\nIt won't be raised again on this pull request.\n\n",
  );
  expect(blockOf(w)).toContain(" · 1 accepted\n\n- **Should fix** · ");
  const result = w.result();
  expect(result.verdict).toMatchObject({ value: "pass", conclusion: "success" });
  expect(result.counts).toMatchObject({ accepted: 1, dismissed: 0 });
  expect(result.findings.find((f) => f.id === "F1")).toMatchObject({
    status: "accepted",
    resolution: { kind: "accepted", round: 1, explanation: "Accepted deploy-window gap", via: "app" },
  });

  // The app follows: the reason is the finding's own why, and the log says what the owner did.
  const review = (await w.state()).reviews[ID];
  expect(review?.findings.find((f) => String(f.id) === "F1")).toMatchObject({
    status: "accepted",
    closedWhy: "Accepted deploy-window gap",
    decidedVia: "app",
  });
  expect(review?.timeline.at(-1)).toMatchObject({ kind: "accepted", findingIds: ["F1"], via: "app" });
});

test("an acceptance with only spaces says no reason; one over 200 characters once collapsed is refused, nothing saved", async () => {
  const w = await roundOne();
  expect(await w.accept("x".repeat(201))).toEqual({
    status: 409,
    body: { error: "the reason is longer than 200 characters", accept: "reason_too_long" },
  });
  expect((await w.state()).reviews[ID]?.findings.map((f) => f.status)).toEqual(["open", "open"]);

  expect(await w.accept("   ")).toEqual({ status: 200, body: { ok: true } });
  // 206 characters as typed, 200 once its spaces are one: kept.
  const long = `${"x".repeat(198)}       y`;
  expect(await w.accept(long, "F2")).toEqual({ status: 200, body: { ok: true } });
  await w.time.advance(1_000);
  const findings = (await w.state()).reviews[ID]?.findings;
  expect(findings?.map((f) => [f.status, f.closedWhy])).toEqual([
    ["accepted", null],
    ["accepted", `${"x".repeat(198)} y`],
  ]);
  const replies = w.host.posts.filter((p) => p.kind === "reply");
  expect(replies.map((p) => p.kind === "reply" && withoutWordmark(p.body).split("\n\n").slice(0, 2))).toEqual(
    [
      ["Accepted by the owner", "It won't be raised again on this pull request."],
      ["Accepted by the owner", `${"x".repeat(198)} y`],
    ],
  );
});

test("an acceptance is refused while a round of the change runs, for a finding settled, or one the change hasn't", async () => {
  const w = await roundOne();
  w.engines.answer({ ...answered({ findings: [] }), tookMs: 10 * MIN });
  w.host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  await w.time.advance(MIN);
  const before = w.host.posts.length;
  expect(await w.accept("Accepted deploy-window gap")).toEqual({
    status: 409,
    body: { error: "a round of the change is running", refused: "reviewing" },
  });
  expect(w.host.posts.slice(before).filter((p) => p.kind === "reply")).toEqual([]);
  expect((await w.state()).reviews[ID]?.findings[0]?.status).toBe("open");

  const w2 = await roundOne();
  await w2.wrong();
  await w2.time.advance(1_000);
  expect(await w2.accept()).toEqual({
    status: 409,
    body: { error: "the finding is settled or not on the pull request", refused: "settled" },
  });
  expect(await w2.accept(undefined, "F9")).toEqual({
    status: 404,
    body: { error: "no such finding", refused: "no_such_finding" },
  });
  // On a change no watched repository has: no such change.
  const elsewhere = await post(w2.service, w2.cookie, {
    type: "finding.accept",
    changeId: changeId("sasensi/elsewhere#1"),
    findingId: "F1",
  });
  expect({ status: elsewhere.status, body: await elsewhere.json() }).toEqual({
    status: 404,
    body: { error: "no such change" },
  });
  // "This finding is wrong" on one accepted is refused the same way: the owner decides once.
  expect(await w2.accept(undefined, "F2")).toEqual({ status: 200, body: { ok: true } });
  expect((await w2.wrong("F2")).body).toMatchObject({ refused: "settled" });
});

test("a service stopped while an acceptance waits to be sent again resumes it after the restart, still an acceptance", async () => {
  const dir = home();
  const w = await roundOne({ home: dir });
  w.host.refuseNext("unavailable", { post: "status" });
  const before = w.host.posts.length;
  await w.accept("Accepted deploy-window gap");
  await w.time.advance(1_000);
  expect(sentSince(w.host.posts, before)).toEqual(["reply"]);
  await w.service.stop();

  await start({
    home: dir,
    host: w.host,
    engines: w.engines,
    retrieval: w.retrieval,
    time: w.time,
    idsFrom: 100,
    changes: [],
  });
  await w.time.advance(MIN);
  // No minimize: the resumed posts are an acceptance's.
  expect(sentSince(w.host.posts, before)).toEqual(["reply", "status.written", "check.completed"]);
  expect(blockOf(w)).toContain(" · 1 accepted\n\n");
  expect(w.result().findings.find((f) => f.id === "F1")).toMatchObject({
    status: "accepted",
    resolution: { kind: "accepted", explanation: "Accepted deploy-window gap" },
  });
});

/** Round 1 posted on #1, on the room alone: what the poller's settle will reach. */
async function roomRoundOne() {
  const engines = fakeEngines();
  engines.answer(...ROUND_ONE);
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = TOTAL_ADDED;
  const { room, host, time } = await startRoom({ changes: [], engines, retrieval });
  host.open(pr1);
  await time.advance(MIN);
  const threads = await host.threads(PR1);
  /** Lookover's last reply, when it is on `finding`'s thread, without its wordmark. */
  const replyOn = (finding: string) => {
    const reply = host.posts.findLast((p) => p.kind === "reply");
    const root = threads.find((t) => String(t.findingId) === finding)?.commentId;
    return reply?.kind === "reply" && reply.commentId === root ? withoutWordmark(reply.body) : null;
  };
  const result = (): ReviewResult => {
    const last = host.posts.findLast((p) => p.kind === "check.completed");
    const read = last?.kind === "check.completed" ? readResult(last.output.text) : null;
    if (read === null) throw new Error("no result on the check");
    return read;
  };
  return { room, host, time, replyOn, result };
}

test("the room's one command settles a finding wrong through the agent, the reason kept as its why and said harmless on its thread (ADR 0056, ADR 0101)", async () => {
  const { room, host, time, replyOn, result } = await roomRoundOne();
  const before = host.posts.length;

  expect(
    await room.settle(
      ID,
      findingId("F1"),
      "wrong",
      "  The cache is cleared\n  on logout, @octocat <b>now</b> ",
      "agent",
      null,
    ),
  ).toBe("ok");
  await time.advance(1_000);

  expect(sentSince(host.posts, before)).toEqual(["reply", "status.written", "check.completed", "minimized"]);
  expect(replyOn("F1")).toStartWith(
    "Dismissed on the owner's word, through their coding agent\n\n" +
      "The cache is cleared on logout, @​octocat <​b>now<​/b>\n\n" +
      "It won't be raised again on this pull request.\n\n",
  );
  const review = room.snapshot().reviews[ID];
  expect(review?.findings.map((f) => [String(f.id), f.status, f.closedWhy, f.decidedVia])).toEqual([
    ["F1", "dismissed", "The cache is cleared on logout, @octocat <b>now</b>", "agent"],
    ["F2", "open", null, null],
  ]);
  expect(review?.timeline.at(-1)).toMatchObject({ kind: "dismissed", findingIds: ["F1"], via: "agent" });
  expect(result().findings.find((f) => f.id === "F1")?.resolution).toEqual({
    kind: "dismissed",
    round: 1,
    explanation: "The cache is cleared on logout, @​octocat <​b>now<​/b>",
    via: "agent",
  });
  // Refused as the app's commands are: the reason's limit, a finding settled, one the change hasn't, another change.
  expect(await room.settle(ID, findingId("F2"), "wrong", "x".repeat(201), "agent", null)).toBe(
    "reason_too_long",
  );
  expect(await room.settle(ID, findingId("F1"), "accepted", "Fine", "agent", null)).toBe("settled");
  expect(await room.settle(ID, findingId("F9"), "wrong", "Fine", "agent", null)).toBe("no_such_finding");
  expect(
    await room.settle(changeId("sasensi/elsewhere#1"), findingId("F1"), "wrong", "Fine", "agent", null),
  ).toBe("no_such_change");
});

test("a finding accepted through the agent says so on its thread, its reason's mention and markup made harmless (ADR 0056)", async () => {
  const { room, host, time, replyOn, result } = await roomRoundOne();
  const before = host.posts.length;

  expect(
    await room.settle(ID, findingId("F1"), "accepted", "Keep it simple, @octocat <b>now</b>", "agent", null),
  ).toBe("ok");
  await time.advance(1_000);

  // Accepted stays readable: no minimize.
  expect(sentSince(host.posts, before)).toEqual(["reply", "status.written", "check.completed"]);
  expect(replyOn("F1")).toStartWith(
    "Accepted on the owner's word, through their coding agent\n\n" +
      "Keep it simple, @​octocat <​b>now<​/b>\n\n" +
      "It won't be raised again on this pull request.\n\n",
  );
  const review = room.snapshot().reviews[ID];
  expect(review?.findings.find((f) => String(f.id) === "F1")).toMatchObject({
    status: "accepted",
    closedWhy: "Keep it simple, @octocat <b>now</b>",
    decidedVia: "agent",
  });
  expect(review?.timeline.at(-1)).toMatchObject({ kind: "accepted", findingIds: ["F1"], via: "agent" });
  expect(result().findings.find((f) => f.id === "F1")?.resolution).toMatchObject({
    kind: "accepted",
    via: "agent",
  });
});

// The coding agent's settle on the owner's word (ADR 0101): a `/lookover settle` comment the owner's login posted, read
// by the poll as a request is, settled through the room's one command, answered with 🚀 once posted or 😕 refused.

/** The reactions on comment `id` of #1. */
const reactionsOn = (host: FakeGitHost, id: string) =>
  host.view(PR1).comments.find((c) => c.id === id)?.reactions;

/** The settle comment the agent's verb writes, posted on #1 by `author` (the owner's login by default). */
const settleOn = (host: FakeGitHost, settle: SettleText, author = OWNER) =>
  host.seedComment(PR1, { author, body: settleComment(settle) });

const settleOf = (finding: string, decision: OwnerDecision, reason: string): SettleText => ({
  finding: findingId(finding),
  decision,
  reason,
});

/** The service started again on the same folder, host and clock. */
const restarted = (w: Awaited<ReturnType<typeof roundOne>>, dir: string) =>
  start({
    home: dir,
    host: w.host,
    engines: w.engines,
    retrieval: w.retrieval,
    time: w.time,
    idsFrom: 100,
    changes: [],
  });

test("a settle comment accepts the finding through the agent: the reply, the block, the check, then 🚀 on the comment", async () => {
  const w = await roundOne();
  const before = w.host.posts.length;
  const comment = settleOn(w.host, settleOf("F1", "accepted", "Keep the loop simple,\nas agreed"));
  await w.time.advance(MIN);
  await w.time.advance(1_000);

  expect(w.host.posts.slice(before).map((p) => p.kind)).toEqual([
    "reply",
    "status.written",
    "check.completed",
    "reaction",
  ]);
  expect(w.host.posts.at(-1)).toEqual({ kind: "reaction", commentId: comment, reaction: "rocket" });
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 1, confused: 0 });
  const reply = w.host.posts.find((p) => p.kind === "reply");
  expect(reply?.kind === "reply" && withoutWordmark(reply.body)).toStartWith(
    "Accepted on the owner's word, through their coding agent\n\nKeep the loop simple, as agreed\n\n",
  );
  const review = (await w.state()).reviews[ID];
  expect(review?.findings.find((f) => String(f.id) === "F1")).toMatchObject({
    status: "accepted",
    closedWhy: "Keep the loop simple, as agreed",
    decidedVia: "agent",
  });
  expect(review?.timeline.at(-1)).toMatchObject({ kind: "accepted", findingIds: ["F1"], via: "agent" });
  expect(w.result().findings.find((f) => f.id === "F1")?.resolution).toMatchObject({
    kind: "accepted",
    via: "agent",
  });

  // Answered once: the next polls leave it.
  await w.time.advance(MIN);
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 1, confused: 0 });
});

test("a settle comment marking a finding wrong minimizes its root, then puts 🚀 on the comment", async () => {
  const w = await roundOne();
  const before = w.host.posts.length;
  const comment = settleOn(w.host, settleOf("F1", "wrong", "The loop runs to the end"));
  await w.time.advance(MIN);
  await w.time.advance(1_000);

  expect(sentSince(w.host.posts, before)).toEqual([
    "reply",
    "status.written",
    "check.completed",
    "minimized",
  ]);
  expect(w.host.posts.at(-1)).toEqual({ kind: "reaction", commentId: comment, reaction: "rocket" });
  expect((await w.state()).reviews[ID]?.findings.find((f) => String(f.id) === "F1")).toMatchObject({
    status: "dismissed",
    closedWhy: "The loop runs to the end",
    decidedVia: "agent",
  });
});

test("another person's settle comment, a command written by hand, one on a closed pull request: nothing at all", async () => {
  const w = await roundOne();
  const before = w.host.posts.length;
  settleOn(w.host, settleOf("F1", "accepted", "Fine by me"), { id: 583231, login: "octocat" });
  w.host.seedComment(PR1, { author: OWNER, body: "/lookover settle F1 accepted" });
  await w.time.advance(MIN);
  await w.time.advance(1_000);
  expect(w.host.posts.slice(before)).toEqual([]);
  expect((await w.state()).reviews[ID]?.findings.map((f) => f.status)).toEqual(["open", "open"]);

  w.host.close(PR1);
  await w.time.advance(MIN);
  settleOn(w.host, settleOf("F1", "accepted", "Fine by me"));
  await w.time.advance(MIN);
  await w.time.advance(1_000);
  expect(w.host.posts.slice(before)).toEqual([]);
});

test("a settle of a finding the round hasn't, one settled already, or with a reason too long gets 😕, nothing posted", async () => {
  const w = await roundOne();
  const settled = settleOn(w.host, settleOf("F1", "wrong", "The loop runs to the end"));
  await w.time.advance(MIN);
  await w.time.advance(1_000);
  const before = w.host.posts.length;

  const unknown = settleOn(w.host, settleOf("F9", "accepted", "Fine"));
  const again = settleOn(w.host, settleOf("F1", "accepted", "Fine"));
  const long = settleOn(w.host, settleOf("F2", "accepted", "x".repeat(201)));
  await w.time.advance(MIN);
  await w.time.advance(1_000);

  // Each answered as its refusal comes: in no order of their own.
  expect(w.host.posts.slice(before)).toHaveLength(3);
  expect(w.host.posts.slice(before)).toEqual(
    expect.arrayContaining([
      { kind: "reaction", commentId: unknown, reaction: "confused" },
      { kind: "reaction", commentId: again, reaction: "confused" },
      { kind: "reaction", commentId: long, reaction: "confused" },
    ]),
  );
  expect(reactionsOn(w.host, settled)).toEqual({ eyes: 0, rocket: 1, confused: 0 });
  expect((await w.state()).reviews[ID]?.findings.map((f) => f.status)).toEqual(["dismissed", "open"]);
  // Sent once: the next poll leaves them.
  await w.time.advance(MIN);
  expect(w.host.posts.slice(before)).toHaveLength(3);
});

test("a settle of a finding kept off the pull request gets 😕, logged as kept off it", async () => {
  const w = await roundOne();
  // Round 2 raises a new Consider: a later round keeps it off the pull request (ADR 0042).
  const RENAME = {
    path: "src/total.ts",
    line: 30,
    severity: "consider",
    category: "readability",
    title: "The sum could be named total",
    body: "The name sum hides that it is the invoice total.",
    defect_key: "sum-named-total",
  };
  await w.ask(
    answered({
      findings: [RENAME],
      earlier: [
        { id: "F1", present: true, why: "Still skipped." },
        { id: "F2", present: true, why: "Still added twice." },
      ],
    }),
    answered({
      verdicts: [
        {
          id: "C1",
          verdict: "confirmed",
          reason: "Read.",
          evidence: ["src/total.ts:30"],
          severity: "consider",
        },
      ],
    }),
  );
  await w.time.advance(1_000);
  expect(w.result().findings.find((f) => f.id === "F3")).toMatchObject({ posted: false });
  const before = w.host.posts.length;

  const kept = settleOn(w.host, settleOf("F3", "accepted", "Fine"));
  await w.time.advance(MIN);

  expect(w.host.posts.slice(before)).toEqual([{ kind: "reaction", commentId: kept, reaction: "confused" }]);
  expect(w.logged.filter((l) => l.includes("the settle of"))).toEqual([
    "sasensi/lookover-sandbox#1: the settle of F3 your coding agent asked for was refused: F3 was kept off the pull request",
  ]);
});

test("a settle read while a round of the change runs gets 😕, nothing posted for it", async () => {
  const w = await roundOne();
  w.engines.answer({ ...answered({ findings: [] }), tookMs: 10 * MIN });
  w.host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  await w.time.advance(MIN);
  expect((await w.state()).reviews[ID]?.run).not.toBeNull();
  const before = w.host.posts.length;

  const comment = settleOn(w.host, settleOf("F1", "accepted", "Fine"));
  await w.time.advance(MIN);
  expect(w.host.posts.slice(before).filter((p) => p.kind === "reaction" || p.kind === "reply")).toEqual([
    { kind: "reaction", commentId: comment, reaction: "confused" },
  ]);
  expect((await w.state()).reviews[ID]?.findings[0]?.status).toBe("open");
});

test("a 😕 GitHub refuses goes to the log, and is sent again at the next send, once", async () => {
  const w = await roundOne();
  w.host.refuseNext("unavailable", { post: "reaction" });
  const comment = settleOn(w.host, settleOf("F9", "accepted", "Fine"));
  // The poll's own send after it reads the comments is the next send.
  await w.time.advance(MIN);
  expect(w.logged.filter((l) => l.includes("settle") || l.includes("confused"))).toEqual([
    "sasensi/lookover-sandbox#1: the settle of F9 your coding agent asked for was refused: Lookover raised no F9 on it",
    `the confused reaction on comment ${comment} was not sent: The host could not be reached`,
  ]);
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 0, confused: 1 });
  // The polls after leave it.
  await w.time.advance(MIN);
  await w.time.advance(MIN);
  expect(w.host.posts.filter((p) => p.kind === "reaction")).toEqual([
    { kind: "reaction", commentId: comment, reaction: "confused" },
  ]);
});

test("a 😕 owed when the service stopped is sent after the restart, once", async () => {
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  /** Whether the first service may send what it owes: no, as if it stopped before each send. */
  let sends = false;
  const stopsFirst: Store = {
    ...store,
    requests: { ...store.requests, unreacted: () => (sends ? store.requests.unreacted() : []) },
  };
  const w = await roundOne({ home: dir, store: stopsFirst });
  const comment = settleOn(w.host, settleOf("F9", "accepted", "Fine"));
  await w.time.advance(MIN);
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 0, confused: 0 });
  await w.service.stop();
  sends = true;

  const again = await restarted(w, dir);
  await w.time.advance(MIN);
  await w.time.advance(MIN);
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 0, confused: 1 });
  expect(w.host.posts.filter((p) => p.kind === "reaction")).toEqual([
    { kind: "reaction", commentId: comment, reaction: "confused" },
  ]);
  // Refused once, by the first service: the restart only sends what it owed.
  expect(again.logged.filter((l) => l.includes("the settle of"))).toEqual([]);
});

test("a settle whose 🚀 was owed when the service stopped gets it after the restart, once", async () => {
  const dir = home();
  const w = await roundOne({ home: dir });
  // GitHub asks to wait before the 🚀; the service stops meanwhile.
  w.host.refuseNext("rate_limited", { post: "reaction" });
  const comment = settleOn(w.host, settleOf("F1", "accepted", "Fine"));
  await w.time.advance(MIN);
  await w.time.advance(1_000);
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 0, confused: 0 });
  await w.service.stop();

  await restarted(w, dir);
  await w.time.advance(MIN);
  await w.time.advance(MIN);
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 1, confused: 0 });
  expect(w.host.posts.filter((p) => p.kind === "reply")).toHaveLength(1);
});

test("a settle written while the service was stopped is settled at the next start, its posts and 🚀 each once", async () => {
  const dir = home();
  const w = await roundOne({ home: dir });
  await w.service.stop();
  const before = w.host.posts.length;
  const comment = settleOn(w.host, settleOf("F1", "wrong", "The loop runs to the end"));

  await restarted(w, dir);
  await w.time.advance(MIN);
  await w.time.advance(MIN);
  expect(sentSince(w.host.posts, before)).toEqual([
    "reply",
    "status.written",
    "check.completed",
    "minimized",
  ]);
  expect(w.host.posts.filter((p) => p.kind === "reaction")).toEqual([
    { kind: "reaction", commentId: comment, reaction: "rocket" },
  ]);
});

test("a settle written while stopped, on a change whose job the last service left running and recovery fails, is settled: 🚀, not 😕", async () => {
  const dir = home();
  const w = await roundOne({ home: dir });
  // Round 2 runs when the service stops: its job is left running, interrupted once already, so the recovery fails it.
  w.engines.answer({ ...answered({ findings: [] }), tookMs: 10 * MIN });
  w.host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  await w.time.advance(MIN);
  expect((await w.state()).reviews[ID]?.run).not.toBeNull();
  await w.service.stop();
  const db = new Database(join(dir, "lookover.sqlite"), { strict: true });
  expect(db.query("UPDATE jobs SET retries = 1 WHERE state = 'running'").run().changes).toBe(1);
  db.close();
  const comment = settleOn(w.host, settleOf("F1", "accepted", "Fine"));

  const again = await restarted(w, dir);
  await w.time.advance(MIN);
  await w.time.advance(MIN);
  expect(again.logged).toContain(
    "sasensi/lookover-sandbox#1 review failed: the service stopped before the review finished",
  );
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 1, confused: 0 });
  expect(again.logged.filter((l) => l.includes("the settle of"))).toEqual([]);
  const cookie = await openApp(again.service);
  expect((await snapshot(again.service, cookie)).reviews[ID]?.findings[0]).toMatchObject({
    status: "accepted",
    decidedVia: "agent",
  });
});

test("a stop between the settle saved and the poll's bookkeeping never reads it again: no second answer", async () => {
  const dir = home();
  const w = await roundOne({ home: dir });
  const comment = settleOn(w.host, settleOf("F1", "accepted", "Fine"));
  await w.time.advance(MIN);
  await w.time.advance(1_000);
  await w.service.stop();
  // As if the service had stopped right after the save: the poll never wrote that it saw the comment.
  const db = new Database(join(dir, "lookover.sqlite"), { strict: true });
  expect(db.query("DELETE FROM comments WHERE id = ?").run(comment).changes).toBe(1);
  db.close();
  const before = w.host.posts.length;

  await restarted(w, dir);
  await w.time.advance(MIN);
  await w.time.advance(MIN);
  expect(w.host.posts.slice(before).filter((p) => p.kind === "reaction" || p.kind === "reply")).toEqual([]);
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 1, confused: 0 });
});

test("a settle is saved, its comment with it, before the poll marks the comment seen", async () => {
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  let comment: string | null = null;
  /** Whether a saved dismissal named the settle comment as the poll marked it seen. */
  const savedAtSeen: boolean[] = [];
  const watching: Store = {
    ...store,
    requests: {
      ...store.requests,
      seen(repo, comments, place) {
        const id = comment;
        if (id !== null && comments.some((c) => c.id === id))
          savedAtSeen.push(store.requests.handled(repo, [id]).has(id));
        store.requests.seen(repo, comments, place);
      },
    },
  };
  const w = await roundOne({ home: dir, store: watching });
  comment = settleOn(w.host, settleOf("F1", "accepted", "Fine"));
  await w.time.advance(MIN);
  await w.time.advance(1_000);
  expect(savedAtSeen).toEqual([true]);
  expect(reactionsOn(w.host, comment)).toEqual({ eyes: 0, rocket: 1, confused: 0 });
});

test("a settle whose save throws stays pending and is settled at the next poll; the ones before it answered once", async () => {
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  /** The settles saved so far: the second's save throws once, as a busy database would. */
  let saves = 0;
  const flaky: Store = {
    ...store,
    dismissals: {
      ...store.dismissals,
      saved(dismissal) {
        saves += 1;
        if (saves === 2) throw new Error("database is locked");
        return store.dismissals.saved(dismissal);
      },
    },
  };
  const w = await roundOne({ home: dir, store: flaky });
  const before = w.host.posts.length;
  // Oldest first: a refusal, a settle saved, then the one whose save throws.
  const refused = settleOn(w.host, settleOf("F9", "accepted", "Fine"));
  const saved = settleOn(w.host, settleOf("F1", "accepted", "Fine"));
  const unsaved = settleOn(w.host, settleOf("F2", "accepted", "Fine too"));
  // The poll that met the throw, then the next, which reads the unsaved one again and saves it.
  await w.time.advance(MIN);
  await w.time.advance(1_000);
  await w.time.advance(MIN);
  expect(saves).toBe(3);
  // Thrown to the poll, which logs it as it does a request's handing over that throws.
  expect(w.logged.filter((l) => l.includes("database is locked"))).toEqual([
    "the pull requests could not be listed: database is locked",
  ]);
  expect((await w.state()).reviews[ID]?.findings.map((f) => f.status)).toEqual(["accepted", "accepted"]);
  expect(reactionsOn(w.host, refused)).toEqual({ eyes: 0, rocket: 0, confused: 1 });
  expect(reactionsOn(w.host, saved)).toEqual({ eyes: 0, rocket: 1, confused: 0 });
  expect(reactionsOn(w.host, unsaved)).toEqual({ eyes: 0, rocket: 1, confused: 0 });
  const answers = w.host.posts
    .slice(before)
    .flatMap((p) =>
      p.kind === "reaction" ? [`${p.reaction} on ${p.commentId}`] : p.kind === "reply" ? [p.kind] : [],
    );
  // The refusal's 😕 once; one reply for each settle saved.
  expect(answers.filter((a) => a === `confused on ${refused}`)).toHaveLength(1);
  expect(answers.filter((a) => a === "reply")).toHaveLength(2);
});

test("two settles of one change across a restart post in the order they were saved: the owed one first", async () => {
  const dir = home();
  const w = await roundOne({ home: dir });
  // GitHub asks to wait before the first settle's 🚀; the service stops meanwhile.
  w.host.refuseNext("rate_limited", { post: "reaction" });
  const first = settleOn(w.host, settleOf("F1", "accepted", "Fine"));
  await w.time.advance(MIN);
  await w.time.advance(1_000);
  await w.service.stop();
  // The second, written while the service was stopped, is saved by the next start's first poll.
  const second = settleOn(w.host, settleOf("F2", "accepted", "Fine too"));
  const before = w.host.posts.length;

  await restarted(w, dir);
  await w.time.advance(MIN);
  await w.time.advance(MIN);
  const sent = w.host.posts
    .slice(before)
    .flatMap((p) =>
      p.kind === "reaction" ? [`${p.reaction} on ${p.commentId}`] : p.kind === "reply" ? [p.kind] : [],
    );
  expect(sent).toEqual([`rocket on ${first}`, "reply", `rocket on ${second}`]);
});
