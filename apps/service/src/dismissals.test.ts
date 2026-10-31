// "This finding is wrong" (ADR 0052), through the service's entry, on fakes only: round 1 posts a blocking finding
// and a should-fix one; the owner dismisses the blocking one from "Too noisy?". Lookover says so on its thread,
// rewrites the summary and, when the round is on the change's head, its check (the verdict and the result included),
// then minimizes the thread's root; a later round never raises it again.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type ChangeRef,
  changeId,
  type ReviewResult,
  readResult,
  reviewResultV1,
  type State,
} from "@lookover/contracts";
import { type FakeEngines, ScriptedRetrieval, type ScriptedRun } from "@lookover/testkit";
import {
  BOT,
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
async function roundOne(options: { home?: string; engines?: FakeEngines } = {}) {
  const engines = options.engines ?? fakeEngines();
  engines.answer(...ROUND_ONE);
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = TOTAL_ADDED;
  const { host, time, service } = await start({
    changes: [],
    engines,
    retrieval,
    ...(options.home ? { home: options.home } : {}),
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

/** The summary comment as the host shows it. */
const summaryOf = (w: Awaited<ReturnType<typeof roundOne>>) =>
  w.host.view(PR1).comments.find((c) => c.author.id === BOT.id)?.body ?? "";

test("a finding dismissed as wrong is said on its thread, the summary and the round's check say so, and its root is minimized", async () => {
  const w = await roundOne();
  const check = w.host.posts.findLast((p) => p.kind === "check.completed");
  expect(w.result().verdict).toMatchObject({ value: "blocking", conclusion: "neutral" });
  const before = w.host.posts.length;

  expect(await w.wrong()).toEqual({ status: 200, body: { ok: true } });
  await w.time.advance(1_000);

  expect(sentSince(w.host.posts, before)).toEqual([
    "reply",
    "summary.edited",
    "check.completed",
    "minimized",
  ]);
  const reply = w.host.posts.find((p) => p.kind === "reply");
  expect(reply).toMatchObject({ commentId: w.root.commentId });
  expect(reply?.kind === "reply" && reply.body).toStartWith(
    "Dismissed by the owner.\n\nIt won't be raised again on this pull request.\n\n",
  );
  expect(summaryOf(w)).toContain("F1 · The total skips the last invoice · dismissed by the owner");
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
    resolution: { kind: "dismissed", round: 1 },
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
  expect(review?.timeline.at(-1)).toMatchObject({ kind: "dismissed", findingIds: ["F1"] });
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

test("once the head moved, the round's check is left as it was: the thread and the summary say it", async () => {
  const w = await roundOne();
  // A push the owner doesn't review: the round's check is on a commit that is no longer the head.
  w.host.push(PR1, SHA1_PUSHED, pr1.diff);
  await w.time.advance(MIN);
  const before = w.host.posts.length;
  await w.wrong();
  await w.time.advance(1_000);
  expect(sentSince(w.host.posts, before)).toEqual(["reply", "summary.edited", "minimized"]);
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

  // The thread and the summary say it; round 2's check still says its posts failed.
  expect(sentSince(w.host.posts, before)).toEqual(["reply", "summary.edited", "minimized"]);
  expect(w.host.posts.findLast((p) => p.kind === "check.completed")).toBe(failed);
});

test("a service stopped while a dismissal waits to be sent again resumes its posts after the restart: each once", async () => {
  const dir = home();
  const w = await roundOne({ home: dir });
  // GitHub refuses the summary's edit for a moment; the service stops during the wait.
  w.host.refuseNext("unavailable", { post: "summary" });
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
    "summary.edited",
    "check.completed",
    "minimized",
  ]);
  expect(w.result().verdict).toMatchObject({ value: "pass" });
});

test("a round asked while a dismissal's posts are owed waits until they end, then posts after them", async () => {
  const w = await roundOne();
  // GitHub asks to wait a minute before the summary's edit: the dismissal's posts are owed that long.
  w.host.refuseNext("rate_limited", { post: "summary" });
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
  expect(sentSince(w.host.posts, before)).toEqual(["reply"]);

  // The wait over, the dismissal's posts end; round 2 runs and posts after them.
  await w.time.advance(2 * MIN);
  expect(w.engines.runs.length).toBe(runs + 1);
  expect(sentSince(w.host.posts, before)).toEqual([
    "reply",
    "summary.edited",
    "check.completed",
    "minimized",
    // Round 2: its review, the summary, its check, and the `/lookover review` it answered minimized.
    "review",
    "summary.edited",
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
    host.posts.slice(from).filter((p) => p.kind === "summary.edited" && p.number === n).length;
  const before = host.posts.length;
  // #1's summary waits a minute at GitHub's word; #3's dismissal, saved after, is sent meanwhile.
  host.refuseNext("rate_limited", { post: "summary" });
  expect((await wrong("sasensi/lookover-sandbox#1")).status).toBe(200);
  expect((await wrong("sasensi/lookover-sandbox#3")).status).toBe(200);
  await time.advance(1_000);
  expect([summariesOf(1, before), summariesOf(3, before)]).toEqual([0, 1]);
  await time.advance(2 * MIN);
  expect([summariesOf(1, before), summariesOf(3, before)]).toEqual([1, 1]);
});
