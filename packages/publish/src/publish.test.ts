// Publishing through its entry (ADR 0033), against `FakeGitHost`: what the host received, in which order, and
// what it shows afterwards. The expected texts and results are written by hand from the worked example below
// (one pull request, round 1 then a push and round 2), never from the renderer.
import { expect, test } from "bun:test";
import {
  type ActionBy,
  CHECK_OUTPUT_MAX_BYTES,
  COMMENT_MAX_BYTES,
  type Confirmation,
  commitSha,
  FINDING_MARKER,
  type Finding,
  type FindingCounts,
  type FindingId,
  findingId,
  HostError,
  type HostThreadReply,
  jobId,
  REPLY_MARKER,
  RESULT_MARKER,
  REVIEW_MARKER,
  REVIEW_MAX_COMMENTS,
  type Reconciled,
  type RepositoryRef,
  type ReviewResult,
  readResult,
  reviewResultV1,
  runId,
  SUMMARY_MARKER,
  utf8Bytes,
} from "@lookover/contracts";
import { FakeGitHost, type HostPost } from "@lookover/testkit";
import {
  createPublisher,
  type DismissalOutbox,
  type DismissalPostKind,
  type DismissalToPost,
  dismissalPostsOf,
  type Outbox,
  type PostKind,
  type RoundToPost,
  type SavedDismissalPost,
  type SavedPost,
} from "./index.ts";

/** The check's final output, as the host received it. */
function completed(posts: HostPost[]) {
  const post = posts.findLast((p) => p.kind === "check.completed");
  if (post?.kind !== "check.completed") throw new Error("The check was not completed");
  return post;
}

const repo: RepositoryRef = { owner: "sasensi", name: "demo-app" };
const change = { repo, number: 42 };
const URL = "https://github.com/sasensi/demo-app/pull/42";

/** Counts with nothing in them; a test sets what its round has. */
const NO_COUNTS: FindingCounts = {
  open: { blocking: 0, should_fix: 0, consider: 0 },
  escalated: 0,
  verified_fixed: 0,
  withdrawn: 0,
  acknowledged: 0,
  dismissed: 0,
  obsolete: 0,
};

const by = (findings: Finding[], who: ActionBy) => findings.map((f) => ({ id: f.id, by: who }));
const bot = { id: 9001, login: "lookover-demo[bot]" };
/** The person Lookover posts for: their id is in each check's external id (ADR 0066). */
const PERSON = 1;
const person = () => PERSON;
const BASE = commitSha("0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3");
const ROUND_1 = commitSha("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");

/** `src/queue/send.ts`: head lines 40 to 45 are in the hunk (42 to 44 added), base line 42 was removed. */
const DIFF_1 = [
  "diff --git a/src/queue/send.ts b/src/queue/send.ts",
  "--- a/src/queue/send.ts",
  "+++ b/src/queue/send.ts",
  "@@ -40,4 +40,6 @@ export async function sendWithRetry(msg: Message) {",
  "   let done = false;",
  "   while (!done) {",
  "-    const res = await send(msg);",
  '+    const res = await fetch(url, { method: "POST", body: msg.body });',
  "+    if (res.status >= 500) continue;",
  "+    done = res.ok;",
  "   }",
  "",
].join("\n");
const COMMENTABLE_1 = [
  { path: "src/queue/send.ts", side: "head" as const, from: 40, to: 45 },
  { path: "src/queue/send.ts", side: "base" as const, from: 42, to: 42 },
];

function host(commentable = COMMENTABLE_1, signedIn?: { id: number; login: string }): FakeGitHost {
  return new FakeGitHost({
    repo,
    bot,
    ...(signedIn === undefined ? {} : { person: signedIn }),
    changes: [
      {
        number: 42,
        title: "Retry sends through fetch",
        url: "https://github.com/sasensi/demo-app/pull/42",
        author: { login: "sasensi", id: 1 },
        draft: false,
        head: { ref: "retry-fetch", sha: ROUND_1 },
        base: { ref: "main", sha: BASE },
        diff: commentable,
      },
    ],
  });
}

/** The host as the shared App's person signed in sees it: Lookover posts as them (ADR 0066). */
const hostAs = (signedIn: { id: number; login: string }) => host(COMMENTABLE_1, signedIn);

function finding(id: string, overrides: Partial<Finding>): Finding {
  return {
    id: findingId(id),
    severity: "blocking",
    category: "correctness",
    title: "Retry loop never stops on 4xx",
    file: "src/queue/send.ts",
    side: "head",
    line: 43,
    endLine: null,
    lineText: null,
    anchoring: "reported",
    foundBy: "claude",
    confirmation: { verdict: "not_checked", demoted: false },
    body: "When the upstream returns a 4xx, `sendWithRetry` retries forever, because only a 5xx is skipped and `res.ok` is false.",
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    status: "open",
    posted: true,
    commented: true,
    raisedIn: 1,
    anchoredIn: 1,
    closedIn: null,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
    fingerprints: { location: `loc:${id}`, meaning: `sem:${id}` },
    ...overrides,
  };
}

const F1 = finding("F1", {});
/** Outside the diff: the file is not in it. */
const F2 = finding("F2", {
  severity: "should_fix",
  category: "reliability",
  title: "Missing timeout on fetch",
  file: "src/http/client.ts",
  line: 12,
  body: "When the upstream hangs, the request stays open forever, because the shared client sets no timeout.",
});
/** Kept off the pull request by strictness. */
const F3 = finding("F3", {
  severity: "consider",
  category: "maintainability",
  title: "Magic number for retry delay",
  line: 44,
  body: "`250` appears twice; a named constant would make the backoff easier to tune.",
  posted: false,
});

/** Round 1 as `core` reconciled it: F1 and F2 open on the pull request, F3 kept off it. */
const reconciled1: Reconciled = {
  findings: [F1, F2, F3],
  raised: [F1, F2, F3],
  post: [F1, F2],
  loop: "open",
  verdict: "blocking",
  nextAction: "fix",
  actionBy: [
    { id: F1.id, by: "agent" },
    { id: F2.id, by: "agent" },
    { id: F3.id, by: "none" },
  ],
  conclusion: "neutral",
  open: 2,
  keptInApp: 1,
  counts: { ...NO_COUNTS, open: { blocking: 1, should_fix: 1, consider: 0 } },
  verifiedFixed: 0,
  replies: [],
};

const round1: RoundToPost = {
  change: { ...change, host: "github", url: URL },
  sha: ROUND_1,
  base: BASE,
  diff: DIFF_1,
  round: 1,
  rounds: [],
  run: {
    id: runId("run-1"),
    job: jobId("job-1"),
    trigger: "manual",
    engine: "claude",
    secondFind: null,
    confirmer: null,
    confirmFailure: null,
    ruledOut: 0,
    startedAt: Date.UTC(2026, 8, 30, 10, 12, 5),
    completedAt: Date.UTC(2026, 8, 30, 10, 14, 41),
  },
  reconciled: reconciled1,
  checkId: null,
};

/** The last line of round 1's review: the hidden marker naming its run and number (ADR 0044). */
const MARKED_1 = `${REVIEW_MARKER}{"v":1,"run":"run-1","n":1} -->`;

const ROUND_2 = commitSha("c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2");

/** The fix: head lines 40 to 46 are in the hunk (42 to 45 added). */
const DIFF_2 = [
  "diff --git a/src/queue/send.ts b/src/queue/send.ts",
  "--- a/src/queue/send.ts",
  "+++ b/src/queue/send.ts",
  "@@ -40,4 +40,7 @@ export async function sendWithRetry(msg: Message) {",
  "   let done = false;",
  "   while (!done) {",
  "-    const res = await send(msg);",
  '+    const res = await fetch(url, { method: "POST", body: msg.body });',
  "+    if (res.status >= 500) continue;",
  "+    if (res.status >= 400) break;",
  "+    done = res.ok;",
  "   }",
  "",
].join("\n");
const COMMENTABLE_2 = [
  { path: "src/queue/send.ts", side: "head" as const, from: 40, to: 46 },
  { path: "src/queue/send.ts", side: "base" as const, from: 42, to: 42 },
];

/** Found in the fix. */
const F4 = finding("F4", {
  title: "Fix drops the last batch item",
  line: 44,
  body: "When a 4xx arrives, the new `break` runs before the final `ack()`, because it leaves the loop first; the last message is redelivered.",
  raisedIn: 2,
  anchoredIn: 2,
});
const F1_FIXED: Finding = { ...F1, status: "verified_fixed", closedIn: 2, verifiedSha: ROUND_2 };

const round2: RoundToPost = {
  ...round1,
  sha: ROUND_2,
  diff: DIFF_2,
  round: 2,
  rounds: [{ n: 1, sha: ROUND_1 }],
  run: {
    id: runId("run-2"),
    job: jobId("job-2"),
    trigger: "push",
    engine: "claude",
    secondFind: null,
    confirmer: null,
    confirmFailure: null,
    ruledOut: 0,
    startedAt: Date.UTC(2026, 8, 30, 10, 40, 0),
    completedAt: Date.UTC(2026, 8, 30, 10, 42, 30),
  },
  // F1 verified fixed; F2 still open; F4 new and blocking, posted.
  reconciled: {
    findings: [F1_FIXED, F2, F3, F4],
    raised: [F4],
    post: [F4],
    loop: "open",
    verdict: "blocking",
    nextAction: "fix",
    actionBy: [
      { id: F1.id, by: "none" },
      { id: F2.id, by: "agent" },
      { id: F3.id, by: "none" },
      { id: F4.id, by: "agent" },
    ],
    conclusion: "neutral",
    open: 2,
    keptInApp: 1,
    counts: { ...NO_COUNTS, open: { blocking: 1, should_fix: 1, consider: 0 }, verified_fixed: 1 },
    verifiedFixed: 1,
    replies: [],
  },
};

test("round 2 edits the summary comment instead of adding one, and posts its own review", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  await publisher.publish(round1);
  github.push(change, ROUND_2, COMMENTABLE_2);
  await publisher.publish(round2);
  expect(github.posts.map((p) => p.kind)).toEqual([
    "check.created",
    "review",
    "summary.created",
    "check.completed",
    "check.created",
    "review",
    "summary.edited",
    "check.completed",
  ]);
  const { reviews, comments } = github.view(change);
  expect(reviews).toHaveLength(2);
  expect(reviews[1]?.sha).toBe(ROUND_2);
  expect(reviews[1]?.comments.map((c) => c.line)).toEqual([44]);
  expect(comments).toHaveLength(1);
  expect(comments[0]?.body).toContain("verified fixed in c3d4e5f");
  expect(comments[0]?.body).toContain("Fix drops the last batch item");
});

test("a round given its job's check completes that check: no other is created", async () => {
  const github = host();
  const checkId = await github.createCheck(
    repo,
    ROUND_1,
    "in_progress",
    {
      title: "Looking over a1b2c3d",
      summary: "Round 1 is running.",
      text: "The check is completed when the review ends.",
    },
    "job-1",
  );
  const outbox = memoryOutbox();
  const published = await createPublisher({ writer: github, person }).publish({ ...round1, checkId }, outbox);
  expect(published.checkId).toBe(checkId);
  expect(outbox.saved[0]).toEqual({ kind: "check", hostId: checkId, tries: 1 });
  expect(github.posts.map((p) => p.kind)).toEqual([
    "check.created",
    "review",
    "summary.created",
    "check.completed",
  ]);
  expect(github.view(change).checks).toMatchObject([
    { id: checkId, status: "completed", conclusion: "neutral" },
  ]);
});

test("one review per round holds every inline comment; a finding outside the diff goes into the summary", async () => {
  const github = host();
  await createPublisher({ writer: github, person }).publish(round1);
  const { reviews, comments } = github.view(change);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.comments.map((c) => [c.path, c.side, c.line])).toEqual([
    ["src/queue/send.ts", "head", 43],
  ]);
  expect(reviews[0]?.comments[0]?.body).toContain("Retry loop never stops on 4xx");
  expect(reviews[0]?.body).toContain("One finding is on a line outside the diff");
  expect(comments).toHaveLength(1);
  expect(comments[0]?.body).toContain("Missing timeout on fetch");
  expect(comments[0]?.body).toContain("the file is not in the diff");
  // Kept off the pull request: nowhere on it.
  expect(JSON.stringify([reviews, comments])).not.toContain("Magic number");
});

/** Round 1 posting exactly `findings`, all open on the pull request for the agent. */
function posting(findings: Finding[]): RoundToPost {
  return {
    ...round1,
    reconciled: {
      ...reconciled1,
      findings,
      raised: findings,
      post: findings,
      actionBy: by(findings, "agent"),
      open: findings.length,
      keptInApp: 0,
    },
  };
}

/** On base line 42, the line the change removed. */
const REMOVED = finding("F1", {
  side: "base",
  line: 42,
  title: "The removed send acked the message",
  body: "When the send succeeds, nothing acks the message any more, because the removed `send` did it.",
});
/** Over head lines 42 to 44, the new loop body. */
const RANGE = finding("F2", {
  line: 42,
  endLine: 44,
  title: "Retry loop never stops on 4xx",
});

test("a finding on a removed line goes inline on the base side, and a range covers its lines", async () => {
  const github = host();
  await createPublisher({ writer: github, person }).publish(posting([REMOVED, RANGE]));
  const [review] = github.view(change).reviews;
  expect(review?.comments.map((c) => [c.path, c.side, c.line, c.endLine])).toEqual([
    ["src/queue/send.ts", "base", 42, null],
    ["src/queue/send.ts", "head", 42, 44],
  ]);
  expect(review?.body).toBe(
    `Lookover · Looked over a1b2c3d. 2 things to fix, starting with send.ts old line 42. The rest can go.\n\n${MARKED_1}`,
  );
  const summary = github.view(change).comments[0]?.body;
  expect(summary).toContain(
    "- F1 · Blocking · `src/queue/send.ts` old line 42 · The removed send acked the message",
  );
  expect(summary).toContain(
    "- F2 · Blocking · `src/queue/send.ts` lines 42 to 44 · Retry loop never stops on 4xx",
  );
  // The result read back says where each finding is, its side and its range, and where its comment went.
  const read = readResult(completed(github.posts).output.text);
  expect(read?.findings.map((f) => [f.id, f.placement, f.location])).toEqual([
    ["F1", "inline", { path: "src/queue/send.ts", start_line: 42, end_line: 42, side: "base", sha: ROUND_1 }],
    ["F2", "inline", { path: "src/queue/send.ts", start_line: 42, end_line: 44, side: "head", sha: ROUND_1 }],
  ]);
  expect(read?.findings.map((f) => f.placed)).toEqual([
    { path: "src/queue/send.ts", start_line: 42, end_line: 42, side: "base" },
    { path: "src/queue/send.ts", start_line: 42, end_line: 44, side: "head" },
  ]);
});

test("a range the host would refuse goes on its first line, else its last; an old line the diff doesn't show goes into the summary", async () => {
  const github = host();
  // Head lines 44 to 47 and 38 to 41: the hunk holds head lines 40 to 45. Base line 41: a line both sides
  // keep, not a removed one.
  const leaving = finding("F1", { line: 44, endLine: 47 });
  const kept = finding("F2", { side: "base", line: 41, title: "Loop flag never reset" });
  const entering = finding("F3", { line: 38, endLine: 41, title: "Flag set before the loop" });
  await createPublisher({ writer: github, person }).publish(posting([leaving, kept, entering]));
  const { reviews, comments } = github.view(change);
  expect(reviews[0]?.comments.map((c) => [c.side, c.line, c.endLine])).toEqual([
    ["head", 44, null],
    ["head", 41, null],
  ]);
  expect(comments[0]?.body).toContain(
    "- F2 · Blocking · `src/queue/send.ts` old line 41 · Loop flag never reset",
  );
  expect(comments[0]?.body).toContain("No comment on the line: the line is not in the diff.");
  // The result keeps each finding's range as `review` anchored it; an inline one's `placed` says where its
  // comment went, the one line the host took. A finding in the summary went on no line.
  const read = readResult(completed(github.posts).output.text);
  const lines = (at: { start_line: number; end_line: number } | null | undefined) =>
    at ? `${at.start_line}-${at.end_line}` : null;
  expect(read?.findings.map((f) => [f.id, f.placement, lines(f.location), lines(f.placed)])).toEqual([
    ["F1", "inline", "44-47", "44-44"],
    ["F2", "summary", "41-41", null],
    ["F3", "inline", "38-41", "41-41"],
  ]);
});

test("a finding whose line's text is in no line of the diff goes into the summary, even on a line the diff shows (ADR 0044)", async () => {
  const github = host();
  // Head line 43 is in the hunk, but the text the engine quoted is not.
  const unmatched = finding("F1", { line: 43, lineText: "await sleep(backoff);", anchoring: "unmatched" });
  await createPublisher({ writer: github, person }).publish(posting([unmatched]));
  const { reviews, comments } = github.view(change);
  expect(reviews[0]?.comments ?? []).toEqual([]);
  expect(comments[0]?.body).toContain("No comment on the line: the code it names is not in the diff.");
});

test("an earlier round's finding is placed again against the new diff, with its side", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  await publisher.publish(posting([REMOVED]));
  // The fix puts the removed line back: the new diff only adds a line, so base line 42 is no longer removed.
  const restored = [
    "diff --git a/src/queue/send.ts b/src/queue/send.ts",
    "--- a/src/queue/send.ts",
    "+++ b/src/queue/send.ts",
    "@@ -40,4 +40,5 @@ export async function sendWithRetry(msg: Message) {",
    "   let done = false;",
    "   while (!done) {",
    "     const res = await send(msg);",
    "+    if (res.status >= 400) break;",
    "   }",
    "",
  ].join("\n");
  github.push(change, ROUND_2, [{ path: "src/queue/send.ts", side: "head", from: 40, to: 44 }]);
  await publisher.publish({
    ...posting([REMOVED]),
    sha: ROUND_2,
    diff: restored,
    round: 2,
    rounds: [{ n: 1, sha: ROUND_1 }],
    reconciled: { ...posting([REMOVED]).reconciled, raised: [], post: [] },
  });
  const read = readResult(completed(github.posts).output.text);
  expect(read?.findings.map((f) => [f.id, f.placement])).toEqual([["F1", "summary"]]);
  expect(github.view(change).comments[0]?.body).toContain("**Not on a line**\n- F1 ·");
});

test("a finding kept in the app is counted in the summary and the check, and nothing says the rest can go (ADR 0042)", async () => {
  const github = host();
  // Round 1: F1 and F2 open on the pull request, F3 a Consider kept in the app.
  await createPublisher({ writer: github, person }).publish(round1);
  const { reviews, comments } = github.view(change);
  expect(reviews[0]?.body).toBe(
    `Lookover · Looked over a1b2c3d. 2 things to fix, starting with send.ts line 43.\n\nOne finding is on a line outside the diff: it is in the summary comment.\n\n${MARKED_1}`,
  );
  const kept = "One finding stays in Lookover, not on the pull request.";
  expect(comments[0]?.body).toContain(`2 things to fix, starting with send.ts line 43.\n\n${kept}`);
  const { summary } = completed(github.posts).output;
  expect(summary.split("\n").slice(0, 2)).toEqual(["2 things to fix, starting with send.ts line 43.", kept]);
  expect(JSON.stringify(github.posts)).not.toContain("The rest can go");
});

test("with nothing on the pull request and findings kept in the app, it says how many, and not that the rest can go", async () => {
  const github = host();
  const quiet = [F3, finding("F4", { severity: "consider", title: "Long function", posted: false })];
  await createPublisher({ writer: github, person }).publish({
    ...round1,
    reconciled: {
      ...reconciled1,
      findings: quiet,
      raised: quiet,
      post: [],
      loop: "settled",
      verdict: "clean",
      nextAction: "stop",
      actionBy: by(quiet, "none"),
      conclusion: "success",
      open: 0,
      keptInApp: 2,
      counts: NO_COUNTS,
    },
  });
  expect(github.view(change).reviews[0]?.body).toBe(
    `Lookover · Looked over a1b2c3d. Nothing to fix.\n\n${MARKED_1}`,
  );
  const { title, summary } = completed(github.posts).output;
  expect(title).toBe("Looked over a1b2c3d: nothing to fix");
  expect(summary).toBe("Nothing to fix.\n2 findings stay in Lookover, not on the pull request.");
  expect(github.view(change).comments[0]?.body).toContain(
    "Nothing to fix.\n\n2 findings stay in Lookover, not on the pull request.",
  );
  expect(readResult(completed(github.posts).output.text)?.verdict.headline).toBe("Nothing to fix.");
});

test("a round posts in the fixed order: check in progress, review, summary, check completed", async () => {
  const github = host();
  await createPublisher({ writer: github, person }).publish(round1);
  expect(github.posts.map((p) => p.kind)).toEqual([
    "check.created",
    "review",
    "summary.created",
    "check.completed",
  ]);
});

// The outbox (ADR 0044): a round's posts, saved before the first is sent, each marked sent with the host's id.

/** The service stopped: what a crash does to `publish`, here thrown by the outbox. */
class Crash extends Error {}

/**
 * An outbox kept in memory, as the store keeps it on disk: the posts `from` saved (every post owed when none).
 * `crashAfter` stops the process once that post is marked sent, before the next one is begun; `lostAnswer`, once
 * the host took that post, before it is marked sent (the host holds it, and nothing says so). `degraded`: the round's
 * findings were sent in the summary before.
 */
function memoryOutbox(
  options: { from?: SavedPost[]; crashAfter?: PostKind; lostAnswer?: PostKind; degraded?: boolean } = {},
): Outbox & {
  saved: SavedPost[];
  commented: readonly FindingId[] | null;
  waits: Parameters<Outbox["waiting"]>[0][];
} {
  const saved = (options.from ?? []).map((p) => ({ ...p }));
  const waits: Parameters<Outbox["waiting"]>[0][] = [];
  let commented: readonly FindingId[] | null = null;
  const of = (kind: PostKind): SavedPost => {
    const found = saved.find((p) => p.kind === kind);
    if (found) return found;
    const post: SavedPost = { kind, hostId: null, tries: 0 };
    saved.push(post);
    return post;
  };
  let crashed = false;
  let degraded = options.degraded ?? false;
  return {
    saved,
    waits,
    posts: saved.map((p) => ({ ...p })),
    get degraded() {
      return degraded;
    },
    degrade() {
      degraded = true;
    },
    sending(kind) {
      if (crashed) throw new Crash(`stopped before ${kind}`);
      of(kind).tries++;
    },
    get commented() {
      return commented;
    },
    sent(kind, hostId, ids) {
      if (kind === options.lostAnswer) throw new Crash(`stopped before ${kind} was marked sent`);
      of(kind).hostId = hostId;
      if (kind === "review") commented = ids ?? [];
      if (kind === options.crashAfter) crashed = true;
    },
    waiting(wait) {
      waits.push(wait);
    },
  };
}

for (const crashAfter of ["check", "review", "summary"] as const) {
  test(`a crash once the ${crashAfter} post is saved resumes with the next post: none is sent twice`, async () => {
    const github = host();
    const publisher = createPublisher({ writer: github, person });
    const stopped = memoryOutbox({ crashAfter });
    await expect(publisher.publish(round1, stopped)).rejects.toBeInstanceOf(Crash);
    await publisher.publish(round1, memoryOutbox({ from: stopped.saved }));
    expect(github.posts.map((p) => p.kind)).toEqual([
      "check.created",
      "review",
      "summary.created",
      "check.completed",
    ]);
  });
}

test("a review the host took before the service stopped is found by its marker and not posted again", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  const stopped = memoryOutbox({ lostAnswer: "review" });
  await expect(publisher.publish(round1, stopped)).rejects.toBeInstanceOf(Crash);
  const resumed = memoryOutbox({ from: stopped.saved });
  const published = await publisher.publish(round1, resumed);
  const { reviews } = github.view(change);
  expect(reviews).toHaveLength(1);
  expect(published.reviewId).toBe(reviews[0]?.id ?? "no review");
  expect(resumed.saved.find((p) => p.kind === "review")).toEqual({
    kind: "review",
    hostId: reviews[0]?.id ?? "no review",
    tries: 1,
  });
});

test("a check the host created before the service stopped is found by the job's id and completed, not created again", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  const stopped = memoryOutbox({ lostAnswer: "check" });
  await expect(publisher.publish(round1, stopped)).rejects.toBeInstanceOf(Crash);
  await publisher.publish(round1, memoryOutbox({ from: stopped.saved }));
  expect(github.posts.map((p) => p.kind)).toEqual([
    "check.created",
    "review",
    "summary.created",
    "check.completed",
  ]);
  expect(github.view(change).checks.map((c) => c.status)).toEqual(["completed"]);
});

test("a round's check carries its job's id and the person's, and is looked for by both (ADR 0066)", async () => {
  const github = host();
  const { checkId } = await createPublisher({ writer: github, person }).publish(round1);
  expect(await github.findCheck(repo, round1.sha, `${round1.run.job}@${PERSON}`)).toBe(checkId);
  expect(await github.findCheck(repo, round1.sha, round1.run.job)).toBeNull();
});

test("a check another person's Lookover made for a job of the same id is never taken for the round's", async () => {
  const github = host();
  const output = { title: "Looking over", summary: "Round 1 is running.", text: "" };
  const theirs = await github.createCheck(repo, round1.sha, "in_progress", output, `${round1.run.job}@7`);
  const publisher = createPublisher({ writer: github, person });
  const stopped = memoryOutbox({ lostAnswer: "check" });
  await expect(publisher.publish(round1, stopped)).rejects.toBeInstanceOf(Crash);
  const { checkId } = await publisher.publish(round1, memoryOutbox({ from: stopped.saved }));
  expect(checkId).not.toBe(theirs);
  expect(github.view(change).checks.map((c) => [c.id, c.status])).toEqual([
    [theirs, "in_progress"],
    [checkId, "completed"],
  ]);
});

test("a round's review is found on the host by its marker; none before it was posted, nor another round's", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  expect(await publisher.findReview(round1, false)).toBeNull();
  const { reviewId } = await publisher.publish(round1);
  // F1 has its comment; F2 is outside the diff, in the summary.
  expect(await publisher.findReview(round1, false)).toEqual({ reviewId, commented: [F1.id] });
  expect(await publisher.findReview(round1, true)).toEqual({ reviewId, commented: [] });
  expect(await publisher.findReview(round2, false)).toBeNull();
});

test("a review begun but never taken by the host is posted when sent again", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  const begun: SavedPost[] = [
    { kind: "check", hostId: null, tries: 0 },
    { kind: "review", hostId: null, tries: 1 },
  ];
  await publisher.publish(round1, memoryOutbox({ from: begun }));
  expect(github.view(change).reviews).toHaveLength(1);
});

// The result (ADR 0032, ADR 0039): the last line of the check's text, valid against the schema.

const EXPECTED_1: ReviewResult = {
  schema: "lookover.review-result/v1",
  change: {
    host: "github",
    repository: "sasensi/demo-app",
    number: 42,
    url: "https://github.com/sasensi/demo-app/pull/42",
    head_sha: ROUND_1,
    base_sha: BASE,
  },
  run: {
    id: "run-1",
    state: "done",
    trigger: "manual",
    engine: { finder: "claude", confirmer: null },
    ruled_out: 0,
    started_at: "2026-09-30T10:12:05.000Z",
    completed_at: "2026-09-30T10:14:41.000Z",
  },
  verdict: {
    value: "blocking",
    conclusion: "neutral",
    headline: "2 things to fix, starting with send.ts line 43.",
  },
  loop: { state: "open", round: 1, next_action: "fix" },
  counts: {
    open: { blocking: 1, should_fix: 1, consider: 0 },
    escalated: 0,
    verified_fixed: 0,
    withdrawn: 0,
    acknowledged: 0,
    dismissed: 0,
    obsolete: 0,
    kept_in_app: 1,
  },
  findings: [
    {
      id: "F1",
      fingerprints: { location: "loc:F1", meaning: "sem:F1" },
      status: "open",
      posted: true,
      placement: "inline",
      needs_action_by: "agent",
      severity: "blocking",
      category: "correctness",
      title: "Retry loop never stops on 4xx",
      body: "When the upstream returns a 4xx, `sendWithRetry` retries forever, because only a 5xx is skipped and `res.ok` is false.",
      location: { path: "src/queue/send.ts", start_line: 43, end_line: 43, side: "head", sha: ROUND_1 },
      placed: { path: "src/queue/send.ts", start_line: 43, end_line: 43, side: "head" },
      rule: null,
      raised: { round: 1, sha: ROUND_1 },
      last_checked: { round: 1, sha: ROUND_1 },
      resolution: null,
      confirmation: { verdict: "not_checked", demoted: false },
    },
    {
      id: "F2",
      fingerprints: { location: "loc:F2", meaning: "sem:F2" },
      status: "open",
      posted: true,
      placement: "summary",
      needs_action_by: "agent",
      severity: "should_fix",
      category: "reliability",
      title: "Missing timeout on fetch",
      body: "When the upstream hangs, the request stays open forever, because the shared client sets no timeout.",
      location: { path: "src/http/client.ts", start_line: 12, end_line: 12, side: "head", sha: ROUND_1 },
      placed: null,
      rule: null,
      raised: { round: 1, sha: ROUND_1 },
      last_checked: { round: 1, sha: ROUND_1 },
      resolution: null,
      confirmation: { verdict: "not_checked", demoted: false },
    },
    {
      id: "F3",
      fingerprints: { location: "loc:F3", meaning: "sem:F3" },
      status: "open",
      posted: false,
      placement: "check_only",
      needs_action_by: "none",
      severity: "consider",
      category: "maintainability",
      title: "Magic number for retry delay",
      body: "`250` appears twice; a named constant would make the backoff easier to tune.",
      location: { path: "src/queue/send.ts", start_line: 44, end_line: 44, side: "head", sha: ROUND_1 },
      placed: null,
      rule: null,
      raised: { round: 1, sha: ROUND_1 },
      last_checked: { round: 1, sha: ROUND_1 },
      resolution: null,
      confirmation: { verdict: "not_checked", demoted: false },
    },
  ],
  truncated: false,
};

test("the posted result is the last line of the check's text, valid against the schema, with every finding", async () => {
  const github = host();
  const published = await createPublisher({ writer: github, person }).publish(round1);
  const { output, conclusion } = completed(github.posts);
  expect(conclusion).toBe("neutral");
  const read = readResult(output.text);
  expect(reviewResultV1.safeParse(read).success).toBe(true);
  expect(read).toEqual(EXPECTED_1);
  expect(published.result).toEqual(EXPECTED_1);
  expect(output.text.split("\n").at(-1)?.startsWith(RESULT_MARKER)).toBe(true);
  expect(output.title).toBe("Looked over a1b2c3d: 2 things to fix");
  // Story 26: the check's count and the result's counts agree.
  const { open, escalated } = EXPECTED_1.counts;
  expect(open.blocking + open.should_fix + open.consider + escalated).toBe(round1.reconciled.open);
});

test("the result says who confirmed the round and what the confirm said of each finding (ADR 0044)", async () => {
  const github = host();
  const confirmation: Confirmation = {
    verdict: "confirmed",
    by: "codex",
    reason: "Only a 5xx is skipped.",
    evidence: ["src/queue/send.ts:43"],
  };
  const [first, ...rest] = round1.reconciled.findings;
  if (!first) throw new Error("round 1 has findings");
  const findings = [{ ...first, confirmation }, ...rest];
  const confirmed: RoundToPost = {
    ...round1,
    run: { ...round1.run, confirmer: "codex", ruledOut: 2 },
    reconciled: { ...round1.reconciled, findings },
  };
  await createPublisher({ writer: github, person }).publish(confirmed);
  const read = readResult(completed(github.posts).output.text);
  expect(read?.run.engine).toEqual({ finder: "claude", confirmer: "codex" });
  // The candidates the confirmer refuted are no findings: the result says how many (ADR 0044).
  expect(read?.run.ruled_out).toBe(2);
  expect(read?.findings.map((f) => [f.id, f.confirmation])).toEqual([
    ["F1", confirmation],
    ["F2", { verdict: "not_checked", demoted: false }],
    ["F3", { verdict: "not_checked", demoted: false }],
  ]);
});

test("a blocking finding lowered for want of a confirmation says so: its comment, the summary and the check (ADR 0044)", async () => {
  const github = host();
  const lowered = finding("F1", {
    severity: "should_fix",
    confirmation: { verdict: "unsure", by: "claude", reason: "Can't tell.", evidence: [], demoted: true },
  });
  const unsure = finding("F2", {
    title: "Missing timeout on fetch",
    line: 44,
    severity: "should_fix",
    confirmation: { verdict: "unsure", by: "claude", reason: "Maybe.", evidence: [], demoted: false },
  });
  await createPublisher({ writer: github, person }).publish(posting([lowered, unsure]));
  const { reviews, comments } = github.view(change);
  expect(reviews[0]?.comments.map((c) => c.body.split("\n")[0])).toEqual([
    "Lookover · **Retry loop never stops on 4xx** · Should fix, unconfirmed",
    "Lookover · **Missing timeout on fetch** · Should fix",
  ]);
  expect(comments[0]?.body).toContain(
    "- F1 · Should fix, unconfirmed · `src/queue/send.ts` line 43 · Retry loop never stops on 4xx",
  );
  expect(completed(github.posts).output.summary).toContain("- F1 · Should fix, unconfirmed ·");
  expect(comments[0]?.body).not.toContain("Not double-checked");
});

test("a finding following a repository rule names it: its comment, the summary and the result (ADR 0048)", async () => {
  const github = host();
  const rule = { id: "7c1e0a9d3b2f4e58", file: "REVIEW.md" as const, line: 12 };
  const inline = finding("F1", { category: "repo_rule", rule });
  const outside = { ...F2, category: "repo_rule", rule: { ...rule, file: "AGENTS.md" as const, line: 3 } };
  const published = await createPublisher({ writer: github, person }).publish(posting([inline, outside]));
  const { reviews, comments } = github.view(change);
  expect(reviews[0]?.comments[0]?.body).toStartWith(
    `Lookover · **Retry loop never stops on 4xx** · Blocking\n\n${inline.body}\n\nRule: REVIEW.md, line 12.\n\n`,
  );
  expect(comments[0]?.body).toContain(`  ${F2.body}\n  Rule: AGENTS.md, line 3.\n  No comment on the line:`);
  expect(published.result.findings.map((f) => f.rule)).toEqual([
    { id: "7c1e0a9d3b2f4e58", source: "REVIEW.md", line: 12 },
    { id: "7c1e0a9d3b2f4e58", source: "AGENTS.md", line: 3 },
  ]);
});

test("a round whose confirm pass failed says its findings were not double-checked, and why (ADR 0044)", async () => {
  const said = async (confirmFailure: NonNullable<RoundToPost["run"]["confirmFailure"]>) => {
    const github = host();
    await createPublisher({ writer: github, person }).publish({
      ...round1,
      run: { ...round1.run, confirmer: "claude", confirmFailure },
    });
    const summary = github.view(change).comments[0]?.body ?? "";
    expect(completed(github.posts).output.summary).toContain(summary.split("\n\n")[3] ?? "none");
    return summary.split("\n\n")[3];
  };
  expect(await said("timeout")).toBe(
    "Not double-checked: Claude ran out of time, so these findings are posted as found.",
  );
  expect(await said("auth_required")).toBe(
    "Not double-checked: Claude is signed out, so these findings are posted as found.",
  );
  expect(await said("unreadable")).toBe(
    "Not double-checked: Claude's answer could not be read, so these findings are posted as found.",
  );
});

test("the summary's header is followed by who found the round and who double-checked it, never tokens or times (ADR 0055)", async () => {
  const header = async (run: Partial<RoundToPost["run"]>, raised = round1.reconciled.raised) => {
    const github = host();
    await createPublisher({ writer: github, person }).publish({
      ...round1,
      run: { ...round1.run, ...run },
      reconciled: { ...round1.reconciled, raised },
    });
    return (github.view(change).comments[0]?.body ?? "").split("\n\n")[1];
  };
  const lead = "**Lookover** · round 1 · looked over a1b2c3d\n";
  // Every case is `foundAndCheckedText`'s, in contracts; here, what the run gives it.
  expect(await header({ secondFind: { engine: "codex", failure: null }, confirmer: "codex" })).toBe(
    `${lead}Found by Claude and Codex, double-checked by Codex.`,
  );
  expect(await header({ confirmer: "claude" })).toBe(
    `${lead}Found by Claude, double-checked by Claude in a new session.`,
  );
  // No confirm pass: Quick when the round raised findings, else nothing was new.
  expect(await header({ confirmer: null })).toBe(`${lead}Found by Claude, not double-checked.`);
  expect(await header({ confirmer: null }, [])).toBe(`${lead}Found by Claude, nothing new to double-check.`);
});

test("a Deep round whose second find pass failed says it had one find pass, and why (ADR 0044)", async () => {
  const github = host();
  await createPublisher({ writer: github, person }).publish({
    ...round1,
    run: { ...round1.run, secondFind: { engine: "codex", failure: "quota_exhausted" } },
  });
  const summary = github.view(change).comments[0]?.body ?? "";
  expect(summary.split("\n\n")[3]).toBe("One find pass, not two: Codex reached its limit.");
  expect(completed(github.posts).output.summary).toContain(
    "One find pass, not two: Codex reached its limit.",
  );
});

test("round 2's result says what was verified fixed and what the agent should read first", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  await publisher.publish(round1);
  github.push(change, ROUND_2, COMMENTABLE_2);
  await publisher.publish(round2);
  const read = readResult(completed(github.posts).output.text);
  // Open on the pull request first, blocking first; then the unposted one; then the settled one.
  expect(read?.findings.map((f) => f.id)).toEqual(["F4", "F2", "F3", "F1"]);
  expect(read?.counts).toEqual({
    open: { blocking: 1, should_fix: 1, consider: 0 },
    escalated: 0,
    verified_fixed: 1,
    withdrawn: 0,
    acknowledged: 0,
    dismissed: 0,
    obsolete: 0,
    kept_in_app: 1,
  });
  expect(read?.findings.at(-1)).toMatchObject({
    id: "F1",
    status: "verified_fixed",
    needs_action_by: "none",
    raised: { round: 1, sha: ROUND_1 },
    last_checked: { round: 2, sha: ROUND_2 },
    resolution: { kind: "verified_fixed", round: 2 },
  });
  expect(read?.findings[0]).toMatchObject({ id: "F4", raised: { round: 2, sha: ROUND_2 } });
  expect(read?.run).toMatchObject({ id: "run-2", trigger: "push" });
  expect(read?.loop).toEqual({ state: "open", round: 2, next_action: "fix" });
  // Story 26: the check's count and the result's counts agree.
  const open = read?.counts.open;
  expect(
    (open?.blocking ?? 0) + (open?.should_fix ?? 0) + (open?.consider ?? 0) + (read?.counts.escalated ?? 0),
  ).toBe(round2.reconciled.open);
  // The review says what is new and what an earlier round left open; "the rest can go" would be false.
  const review = github.view(change).reviews[1]?.body;
  expect(review).toBe(
    `Lookover · Looked over c3d4e5f. One new thing to fix, send.ts line 44.\n\nOne finding from an earlier round is still open: it is in the summary comment.\n\n${REVIEW_MARKER}{"v":1,"run":"run-2","n":2} -->`,
  );
});

// Claims (ADR 0052): the author answered on the threads, and round 2 answered them.

/** The owner's won't fix on F1's thread, which round 2 kept once. */
const F1_KEPT: Finding = {
  ...F1,
  claim: {
    kind: "wont_fix",
    text: "Won't fix: the upstream never answers a 4xx here.",
    by: "sasensi",
    at: "2026-09-30T10:30:00Z",
    commentId: 100002,
  },
  kept: 1,
  why: { ruleText: null },
};
/** The owner deferred F2, a should_fix: acknowledged, the author's call. */
const F2_ACKNOWLEDGED: Finding = {
  ...F2,
  status: "acknowledged",
  closedIn: 2,
  closedWhy: "Deferred: timeouts come with the client rewrite.\nSee the plan.",
  claim: {
    kind: "deferred",
    text: "Deferred: timeouts come with the client rewrite.\nSee the plan.",
    by: "sasensi",
    at: "2026-09-30T10:31:00Z",
    commentId: 100003,
  },
};

/** Round 2 on the same commit, asked after the owner's replies: F1 kept, F2 acknowledged, F3 unchanged. */
const answering: RoundToPost = {
  ...round1,
  round: 2,
  rounds: [{ n: 1, sha: ROUND_1 }],
  run: { ...round1.run, id: runId("run-2"), job: jobId("job-2"), trigger: "comment" },
  reconciled: {
    ...reconciled1,
    findings: [F1_KEPT, F2_ACKNOWLEDGED, F3],
    raised: [],
    post: [],
    actionBy: [
      { id: F1.id, by: "agent" },
      { id: F2.id, by: "none" },
      { id: F3.id, by: "none" },
    ],
    verdict: "blocking",
    open: 1,
    counts: { ...NO_COUNTS, open: { blocking: 1, should_fix: 0, consider: 0 }, acknowledged: 1 },
    replies: [{ findingId: F1.id, kind: "kept", why: "A 4xx from the proxy\nstill loops forever." }],
  },
};

test("a finding kept after a claim carries its thread, its claim and kept in the result, valid against the schema", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  await publisher.publish(round1);
  await publisher.publish(answering);
  const read = readResult(completed(github.posts).output.text);
  expect(reviewResultV1.safeParse(read).success).toBe(true);
  // F1's comment is the first inline comment the host took; F2 went into the summary, F3 nowhere: no thread.
  expect(read?.findings.find((f) => f.id === "F1")).toMatchObject({
    status: "open",
    needs_action_by: "agent",
    thread: { comment_id: 100001, url: `${URL}#discussion_r100001` },
    claim: {
      kind: "wont_fix",
      text: "Won't fix: the upstream never answers a 4xx here.",
      by: "sasensi",
      at: "2026-09-30T10:30:00.000Z",
      count: 1,
    },
    resolution: { kind: "kept", round: 2, explanation: "A 4xx from the proxy\nstill loops forever." },
  });
  expect(read?.findings.find((f) => f.id === "F2")).toMatchObject({
    status: "acknowledged",
    thread: null,
    claim: { kind: "deferred", by: "sasensi", count: 0 },
    resolution: {
      kind: "acknowledged",
      round: 2,
      explanation: "Deferred: timeouts come with the client rewrite.\nSee the plan.",
    },
  });
  const f3 = read?.findings.find((f) => f.id === "F3");
  expect(f3?.thread).toBeNull();
  expect(f3?.claim).toBeUndefined();
  // The REST read can't tell a resolved thread: the result doesn't say.
  expect(read?.findings.find((f) => f.id === "F1")?.thread?.resolved).toBeUndefined();
});

test("the summary says the claim a finding was kept against and why, and an acknowledged one as acknowledged", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  await publisher.publish(round1);
  await publisher.publish(answering);
  const summary = github.view(change).comments[0]?.body ?? "";
  expect(summary).toContain(
    [
      "**To fix**",
      "- F1 · Blocking · `src/queue/send.ts` line 43 · Retry loop never stops on 4xx",
      "  sasensi said won't fix. Kept: A 4xx from the proxy still loops forever.",
    ].join("\n"),
  );
  expect(summary).toContain(
    "**Done**\n- F2 · Missing timeout on fetch · acknowledged: sasensi said deferred",
  );
});

test("without a threads reader, or when GitHub refuses the read, the result has no thread and the check still completes", async () => {
  const github = host();
  await createPublisher({ writer: github, person }).publish(round1);
  expect(readResult(completed(github.posts).output.text)?.findings[0]?.thread).toBeUndefined();
  const refusing = createPublisher({
    writer: github,
    person,
    threads: () => Promise.reject(new HostError("unauthorized", "no")),
  });
  await refusing.publish(answering);
  const read = readResult(completed(github.posts).output.text);
  expect(read?.findings.find((f) => f.id === "F1")).toMatchObject({ claim: { count: 1 } });
  expect(read?.findings.find((f) => f.id === "F1")?.thread).toBeUndefined();
});

test("the author's words in the result are cut to 2 KB, never inside a character: a claim's text, an acknowledged explanation", async () => {
  // 2 bytes a character, after one byte: a cut at 2048 bytes would split a character without the code-point boundary.
  const long = `x${"é".repeat(1_500)}`;
  const f1 = { ...F1_KEPT, claim: F1_KEPT.claim && { ...F1_KEPT.claim, text: long } };
  const f2 = { ...F2_ACKNOWLEDGED, closedWhy: long };
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  await publisher.publish(round1);
  await publisher.publish({ ...answering, reconciled: { ...answering.reconciled, findings: [f1, f2, F3] } });
  const read = readResult(completed(github.posts).output.text);
  expect(reviewResultV1.safeParse(read).success).toBe(true);
  const text = read?.findings.find((f) => f.id === "F1")?.claim?.text ?? "";
  const explanation = read?.findings.find((f) => f.id === "F2")?.resolution?.explanation ?? "";
  for (const cut of [text, explanation]) {
    expect(utf8Bytes(cut)).toBeLessThanOrEqual(2_048);
    expect(utf8Bytes(cut)).toBeGreaterThan(2_040);
    expect(cut.startsWith("xéé")).toBe(true);
    expect(cut.endsWith("é…")).toBe(true);
    expect(cut).not.toContain("�");
  }
});

// Replies and minimizing (ADR 0052): the round answers on the threads the run read, and tidies what it settled.

/** `round` with the threads of its findings as the run read them, from the host as it is now. */
async function rooted(
  github: FakeGitHost,
  round: RoundToPost,
  requests: string[] = [],
): Promise<RoundToPost> {
  const threads = await github.threads(change);
  return {
    ...round,
    roots: threads.map((t) => ({ findingId: t.findingId, commentId: t.commentId, nodeId: t.nodeId })),
    requests,
  };
}

/** The reply marker `publish` ends a reply with: the run, the finding and the claim it answers. */
const replyMarker = (run: string, finding: string, claim: number) =>
  `${REPLY_MARKER}${JSON.stringify({ v: 1, run, finding, claim })} -->`;

/** Round 2 withdrawing F1 after the owner's dispute: the finder agreed it was wrong. */
const withdrawing: RoundToPost = {
  ...answering,
  reconciled: {
    ...answering.reconciled,
    findings: [
      { ...F1_KEPT, kept: 0, status: "withdrawn", closedIn: 2, closedWhy: "A 4xx never reaches here." },
      F2,
      F3,
    ],
    actionBy: [
      { id: F1.id, by: "none" },
      { id: F2.id, by: "agent" },
      { id: F3.id, by: "none" },
    ],
    replies: [{ findingId: F1.id, kind: "withdrawn", why: "A 4xx never reaches here." }],
  },
};

test("a round replies on the thread of each finding it answered, after its review and before the summary", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  await publisher.publish(round1);
  const before = github.posts.length;
  await publisher.publish(await rooted(github, answering));
  expect(github.posts.slice(before).map((p) => p.kind)).toEqual([
    "check.created",
    "review",
    "reply",
    "summary.edited",
    "check.completed",
  ]);
  const reply = github.posts.find((p) => p.kind === "reply");
  expect(reply).toMatchObject({
    commentId: 100001,
    body: `Kept.\n\nA 4xx from the proxy\nstill loops forever.\n\nIf it is kept again, the owner decides.\n\n${replyMarker("run-2", "F1", 100002)}`,
  });
});

test("a reply whose reason is too long for GitHub is cut at a line and keeps its marker", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  await publisher.publish(round1);
  const why = Array.from({ length: 4_000 }, (_, i) => `Line ${i} of the reason.`).join("\n");
  await publisher.publish(
    await rooted(github, {
      ...answering,
      reconciled: { ...answering.reconciled, replies: [{ findingId: F1.id, kind: "escalated", why }] },
    }),
  );
  const reply = github.posts.find((p) => p.kind === "reply");
  const body = reply?.kind === "reply" ? reply.body : "";
  expect(utf8Bytes(body)).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
  expect(body.startsWith("The owner decides this one.\n\nLine 0 of the reason.\n")).toBe(true);
  expect(body.endsWith(replyMarker("run-2", "F1", 100002))).toBe(true);
});

test("a kept reply cut to fit still ends by saying the owner decides if it is kept again", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  await publisher.publish(round1);
  const why = Array.from({ length: 4_000 }, (_, i) => `Line ${i} of the reason.`).join("\n");
  await publisher.publish(
    await rooted(github, {
      ...answering,
      reconciled: { ...answering.reconciled, replies: [{ findingId: F1.id, kind: "kept", why }] },
    }),
  );
  const reply = github.posts.find((p) => p.kind === "reply");
  const body = reply?.kind === "reply" ? reply.body : "";
  expect(utf8Bytes(body)).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
  expect(body.startsWith("Kept.\n\nLine 0 of the reason.\n")).toBe(true);
  expect(body).toContain("Cut to fit GitHub's limit");
  expect(
    body.endsWith(`\n\nIf it is kept again, the owner decides.\n\n${replyMarker("run-2", "F1", 100002)}`),
  ).toBe(true);
});

test("an answer with no words is never sent: no empty reply on the thread", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  await publisher.publish(round1);
  const before = github.posts.length;
  await publisher.publish(
    await rooted(github, {
      ...answering,
      reconciled: {
        ...answering.reconciled,
        replies: [{ findingId: F1.id, kind: "answered", why: " \n " }],
      },
    }),
  );
  expect(github.posts.slice(before).map((p) => p.kind)).toEqual([
    "check.created",
    "review",
    "summary.edited",
    "check.completed",
  ]);
});

test("a reply GitHub refuses for good, its thread's root deleted, is said in the log and the round goes on", async () => {
  const github = host();
  const lines: string[] = [];
  const publisher = createPublisher({
    writer: github,
    person,
    threads: (c) => github.threads(c),
    log: (line) => lines.push(line),
  });
  await publisher.publish(round1);
  const before = github.posts.length;
  const { checkId } = await publisher.publish({
    ...answering,
    roots: [{ findingId: F1.id, commentId: 999_999, nodeId: "PRRC_gone" }],
  });
  expect(github.posts.slice(before).map((p) => p.kind)).toEqual([
    "check.created",
    "review",
    "summary.edited",
    "check.completed",
  ]);
  expect(github.view(change).checks.find((c) => c.id === checkId)?.status).toBe("completed");
  expect(lines).toEqual([expect.stringContaining("not_found")]);
});

/**
 * Lookover's reply as `core.lookoversReply` tells it with no id kept (ADR 0066): by who posts, holding a reply marker.
 * Written here by hand from the record, so the publisher asks the service's predicate and never its own.
 */
const lookoversBy = (poster: { id: number }) => async () => (r: HostThreadReply) =>
  r.author.id === poster.id && r.body.includes(REPLY_MARKER);

/** The person signed in on the shared App (ADR 0066): Lookover's posts are theirs. */
const SIGNED_IN = { id: 1, login: "sasensi" };
/** A teammate on the repository, who can copy any text Lookover posts but never write as who posts. */
const TEAMMATE = { id: 77, login: "teammate", bot: false };

for (const way of [
  { name: "as the App's bot", github: () => host(), poster: bot },
  { name: "as the person signed in", github: () => hostAs(SIGNED_IN), poster: SIGNED_IN },
]) {
  test(`${way.name}, a reply the host took before the service stopped is found by its marker: sent once, never a teammate's copy`, async () => {
    const github = way.github();
    const lookovers = lookoversBy(way.poster);
    const publisher = createPublisher({
      writer: github,
      person,
      threads: (c) => github.threads(c),
      lookovers,
    });
    await publisher.publish(round1);
    const round = await rooted(github, answering);
    // The marker the round's reply ends with, copied onto the thread by a teammate before it is sent.
    const root = round.roots?.[0];
    const copied = `Same here.\n\n${replyMarker("run-2", "F1", 100002)}`;
    github.seedReply(change, root?.commentId ?? 0, { author: TEAMMATE, body: copied });
    const stopped = memoryOutbox({ lostAnswer: "reply:F1" });
    await expect(publisher.publish(round, stopped)).rejects.toBeInstanceOf(Crash);
    const resumed = memoryOutbox({ from: stopped.saved });
    await publisher.publish(round, resumed);
    const replies = github.posts.filter((p) => p.kind === "reply");
    expect(replies).toHaveLength(1);
    expect(resumed.saved.find((p) => p.kind === "reply:F1")).toEqual({
      kind: "reply:F1",
      hostId: replies[0]?.kind === "reply" ? replies[0].replyId : "no reply",
      tries: 1,
    });
  });
}

test("the review and each of its line comments start with Lookover, as the bot and as the person signed in (ADR 0066)", async () => {
  for (const github of [host(), hostAs(SIGNED_IN)]) {
    await createPublisher({ writer: github, person }).publish(round1);
    const [review] = github.view(change).reviews;
    expect(review?.body).toStartWith("Lookover · Looked over a1b2c3d.");
    expect(review?.comments.length).toBeGreaterThan(0);
    for (const c of review?.comments ?? []) expect(c.body).toStartWith("Lookover · **");
  }
});

test("a reply begun is sent again when only a teammate's copy of its marker is on the thread", async () => {
  const github = hostAs(SIGNED_IN);
  const time = heldTime();
  const lookovers = lookoversBy(SIGNED_IN);
  const publisher = createPublisher({
    writer: github,
    person,
    threads: (c) => github.threads(c),
    lookovers,
    time,
  });
  await publisher.publish(round1);
  const round = await rooted(github, answering);
  const root = round.roots?.[0];
  const copied = `Same here.\n\n${replyMarker("run-2", "F1", 100002)}`;
  const copy = github.seedReply(change, root?.commentId ?? 0, { author: TEAMMATE, body: copied });
  // Refused and never saved: the round is tried again, and looks for its reply first.
  github.refuseNext("unavailable", { post: "reply" });
  const published = publisher.publish(round);
  await time.advance(MINUTE);
  await published;
  const replies = github.posts.filter((p) => p.kind === "reply");
  expect(replies).toHaveLength(1);
  expect(replies[0]?.kind === "reply" ? replies[0].replyId : "no reply").not.toBe(String(copy));
});

test("a reply GitHub saved though it answered with its internal error is not sent again", async () => {
  const github = host();
  const time = heldTime();
  const publisher = createPublisher({
    writer: github,
    person,
    threads: (c) => github.threads(c),
    lookovers: lookoversBy(bot),
    time,
  });
  await publisher.publish(round1);
  github.refuseNext("unavailable", { post: "reply", saved: true });
  const published = publisher.publish(await rooted(github, answering));
  await time.advance(MINUTE);
  await published;
  expect(github.posts.filter((p) => p.kind === "reply")).toHaveLength(1);
});

test("once the check completes, the requests the round answered and the root of each finding withdrawn are minimized", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  await publisher.publish(round1);
  const request = `IC_${github.seedComment(change, { author: { id: 1, login: "sasensi" }, body: "/lookover review" })}`;
  const before = github.posts.length;
  await publisher.publish(await rooted(github, withdrawing, [request]));
  expect(github.posts.slice(before)).toMatchObject([
    { kind: "check.created" },
    { kind: "review" },
    {
      kind: "reply",
      body: `Withdrawn.\n\nA 4xx never reaches here.\n\n${replyMarker("run-2", "F1", 100002)}`,
    },
    { kind: "summary.edited" },
    { kind: "check.completed" },
    { kind: "minimized", nodeId: request, reason: "resolved" },
    { kind: "minimized", nodeId: "PRRC_100001", reason: "resolved" },
  ]);
});

test("a refused minimize never fails the round: it is said in the log, and the rest are still minimized", async () => {
  const github = host();
  const time = heldTime();
  const lines: string[] = [];
  const publisher = createPublisher({
    writer: github,
    person,
    threads: (c) => github.threads(c),
    time,
    log: (line) => lines.push(line),
  });
  await publisher.publish(round1);
  const request = `IC_${github.seedComment(change, { author: { id: 1, login: "sasensi" }, body: "/lookover review" })}`;
  github.refuseNext("unavailable", { post: "minimize" });
  const published = publisher.publish(await rooted(github, withdrawing, [request, "IC_gone"]));
  await time.advance(MINUTE);
  const { checkId } = await published;
  expect(github.view(change).checks.find((c) => c.id === checkId)?.status).toBe("completed");
  expect(
    github.posts.filter((p) => p.kind === "minimized").map((p) => p.kind === "minimized" && p.nodeId),
  ).toEqual([request, "PRRC_100001"]);
  expect(lines).toEqual([expect.stringContaining("IC_gone")]);
});

// The owner's dismissal (ADR 0052): posted outside a round, on the latest round restated over the ledger.

/** Round 1 restated once the owner dismissed F1 (`core.standing`): F2 alone is open, below blocking. */
const DISMISSED_F1: Finding = { ...F1, status: "dismissed", closedIn: 1 };
const dismissedRound: RoundToPost = {
  ...round1,
  reconciled: {
    ...reconciled1,
    findings: [DISMISSED_F1, F2, F3],
    verdict: "pass",
    actionBy: [
      { id: F1.id, by: "none" },
      { id: F2.id, by: "agent" },
      { id: F3.id, by: "none" },
    ],
    conclusion: "success",
    open: 1,
    counts: { ...NO_COUNTS, open: { blocking: 0, should_fix: 1, consider: 0 }, dismissed: 1 },
  },
};

/** The dismissal of F1 on round 1, its check given (null: the head moved, the check is left). */
const dismissal = (checkId: string | null, findingId: FindingId = F1.id): DismissalToPost => ({
  id: "dismissal-1",
  findingId,
  round: dismissedRound,
  degraded: false,
  checkId,
});

/** The marker that ends a dismissal's reply: the dismissal and the finding, apart from any run. */
const dismissalMarker = (finding: string) =>
  `${REPLY_MARKER}${JSON.stringify({ v: 1, dismissal: "dismissal-1", finding })} -->`;

/** A dismissal's outbox in memory, as the store keeps it; `lostAnswer` stops before that post is marked sent. */
function dismissalOutbox(options: { from?: SavedDismissalPost[]; lostAnswer?: DismissalPostKind } = {}) {
  const saved = (options.from ?? []).map((p) => ({ ...p }));
  const of = (kind: DismissalPostKind) => {
    const found = saved.find((p) => p.kind === kind);
    if (found) return found;
    const post: SavedDismissalPost = { kind, hostId: null, tries: 0 };
    saved.push(post);
    return post;
  };
  return {
    saved,
    posts: saved.map((p) => ({ ...p })),
    sending(kind: DismissalPostKind) {
      of(kind).tries++;
    },
    sent(kind: DismissalPostKind, hostId: string) {
      if (kind === options.lostAnswer) throw new Crash(`stopped before ${kind} was marked sent`);
      of(kind).hostId = hostId;
    },
  } satisfies DismissalOutbox & { saved: SavedDismissalPost[] };
}

test("a dismissal replies on its finding's thread, rewrites the summary and the round's check, then minimizes the root", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  const { checkId } = await publisher.publish(round1);
  expect(dismissalPostsOf(checkId)).toEqual(["reply", "summary", "completed", "minimize"]);
  const before = github.posts.length;
  await publisher.dismiss(dismissal(checkId));

  expect(github.posts.slice(before)).toMatchObject([
    {
      kind: "reply",
      commentId: 100001,
      body: `Dismissed by the owner.\n\nIt won't be raised again on this pull request.\n\n${dismissalMarker("F1")}`,
    },
    { kind: "summary.edited" },
    { kind: "check.completed", checkId, conclusion: "success" },
    { kind: "minimized", nodeId: "PRRC_100001", reason: "resolved" },
  ]);
  const summary = github.view(change).comments.find((c) => c.body.includes(SUMMARY_MARKER))?.body ?? "";
  expect(summary).toContain("- F1 · Retry loop never stops on 4xx · dismissed by the owner");
  expect(summary).not.toContain("**To fix**");
  const result = readResult(completed(github.posts).output.text);
  expect(reviewResultV1.safeParse(result).success).toBe(true);
  expect(result?.verdict).toMatchObject({ value: "pass", conclusion: "success" });
  expect(result?.findings.find((f) => f.id === "F1")).toMatchObject({
    status: "dismissed",
    needs_action_by: "none",
    resolution: { kind: "dismissed", round: 1 },
    thread: { comment_id: 100001 },
  });
});

test("a dismissal whose check is left, the head moved since, says it on the thread and the summary only", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  await publisher.publish(round1);
  expect(dismissalPostsOf(null)).toEqual(["reply", "summary", "minimize"]);
  const before = github.posts.length;
  await publisher.dismiss(dismissal(null));
  expect(github.posts.slice(before).map((p) => p.kind)).toEqual(["reply", "summary.edited", "minimized"]);
});

test("a finding in the summary only has no thread: the dismissal rewrites the summary and the check alone", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  const { checkId } = await publisher.publish(round1);
  const before = github.posts.length;
  await publisher.dismiss(dismissal(checkId, F2.id));
  expect(github.posts.slice(before).map((p) => p.kind)).toEqual(["summary.edited", "check.completed"]);
});

for (const way of [
  { name: "as the App's bot", github: () => host(), poster: bot },
  { name: "as the person signed in", github: () => hostAs(SIGNED_IN), poster: SIGNED_IN },
]) {
  test(`${way.name}, a dismissal's reply the host took before the service stopped is found by its marker: sent once`, async () => {
    const github = way.github();
    const publisher = createPublisher({
      writer: github,
      person,
      threads: (c) => github.threads(c),
      lookovers: lookoversBy(way.poster),
    });
    const { checkId } = await publisher.publish(round1);
    const stopped = dismissalOutbox({ lostAnswer: "reply" });
    await expect(publisher.dismiss(dismissal(checkId), stopped)).rejects.toBeInstanceOf(Crash);
    const resumed = dismissalOutbox({ from: stopped.saved });
    await publisher.dismiss(dismissal(checkId), resumed);
    expect(github.posts.filter((p) => p.kind === "reply")).toHaveLength(1);
    expect(resumed.saved.map((p) => [p.kind, p.hostId !== null, p.tries])).toEqual([
      ["reply", true, 1],
      ["summary", true, 1],
      ["completed", true, 1],
      ["minimize", true, 1],
    ]);
  });
}

/** Round 2's diff after a push that added a line above the loop's body: the 5xx line is now head line 44. */
const DIFF_MOVED = [
  "diff --git a/src/queue/send.ts b/src/queue/send.ts",
  "--- a/src/queue/send.ts",
  "+++ b/src/queue/send.ts",
  "@@ -40,4 +40,7 @@ export async function sendWithRetry(msg: Message) {",
  "   let done = false;",
  "   while (!done) {",
  "-    const res = await send(msg);",
  "+    log(msg);",
  '+    const res = await fetch(url, { method: "POST", body: msg.body });',
  "+    if (res.status >= 500) continue;",
  "+    done = res.ok;",
  "   }",
  "",
].join("\n");

/** Round 2 posting F1, which round 1 raised on head line 43 and whose review never landed (withheld). */
function reposting(f1: Finding, sha = ROUND_2, diff = DIFF_MOVED): RoundToPost {
  return {
    ...round2,
    sha,
    diff,
    reconciled: {
      ...reconciled1,
      findings: [f1],
      raised: [],
      post: [f1],
      actionBy: by([f1], "agent"),
      open: 1,
      keptInApp: 0,
    },
  };
}

const WITHHELD_F1 = { ...F1, lineText: "    if (res.status >= 500) continue;" };

test("a withheld finding posted after a push is found again by its line's text: its comment goes on the line now", async () => {
  const github = host(COMMENTABLE_2);
  github.push(change, ROUND_2, COMMENTABLE_2);
  await createPublisher({ writer: github, person }).publish(reposting(WITHHELD_F1));
  expect(github.view(change).reviews[0]?.comments.map((c) => c.line)).toEqual([44]);
});

test("a withheld finding whose line's text is gone, or never known, goes into the summary after a push, not on its old line", async () => {
  for (const f1 of [
    { ...F1, lineText: "    if (res.status >= 599) continue;" },
    { ...F1, lineText: null },
  ]) {
    const github = host(COMMENTABLE_2);
    github.push(change, ROUND_2, COMMENTABLE_2);
    await createPublisher({ writer: github, person }).publish(reposting(f1));
    const { reviews, comments } = github.view(change);
    expect(reviews[0]?.comments).toEqual([]);
    expect(comments[0]?.body).toContain("Retry loop never stops on 4xx");
  }
});

test("a withheld finding posted on the commit it was found on keeps its line", async () => {
  const github = host();
  await createPublisher({ writer: github, person }).publish(
    reposting({ ...F1, lineText: null }, ROUND_1, DIFF_1),
  );
  expect(github.view(change).reviews[0]?.comments.map((c) => c.line)).toEqual([43]);
});

test("a finding moved by a later round is located on that round's commit, and still raised on its own (ADR 0044)", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  await publisher.publish(round1);
  github.push(change, ROUND_2, COMMENTABLE_2);
  // Round 2 reports F2 again, two lines further down: its line is a line of ROUND_2.
  const moved: Finding = { ...F2, line: 14, lineText: "const res = await fetch(url);", anchoredIn: 2 };
  const findings = round2.reconciled.findings.map((f) => (f.id === F2.id ? moved : f));
  await publisher.publish({ ...round2, reconciled: { ...round2.reconciled, findings } });
  const read = readResult(completed(github.posts).output.text);
  expect(read?.findings.find((f) => f.id === "F2")).toMatchObject({
    location: { path: "src/http/client.ts", start_line: 14, end_line: 14, sha: ROUND_2 },
    raised: { round: 1, sha: ROUND_1 },
  });
});

test("the result carries core's verdict, next action, who must act and counts as given: publish decides no loop rule", async () => {
  const github = host();
  // Facts no rule of publish's would give for these findings: only `core` could have said them.
  const given: Reconciled = {
    ...reconciled1,
    verdict: "pass",
    nextAction: "ask_human",
    actionBy: [
      { id: F1.id, by: "human" },
      { id: F2.id, by: "none" },
      { id: F3.id, by: "agent" },
    ],
    counts: { ...NO_COUNTS, open: { blocking: 0, should_fix: 2, consider: 0 }, dismissed: 3 },
    keptInApp: 4,
  };
  await createPublisher({ writer: github, person }).publish({ ...round1, reconciled: given });
  const read = readResult(completed(github.posts).output.text);
  expect(read?.verdict.value).toBe("pass");
  expect(read?.loop).toEqual({ state: "open", round: 1, next_action: "ask_human" });
  expect(read?.findings.map((f) => [f.id, f.needs_action_by])).toEqual([
    ["F1", "human"],
    ["F2", "none"],
    ["F3", "agent"],
  ]);
  expect(read?.counts).toEqual({
    open: { blocking: 0, should_fix: 2, consider: 0 },
    escalated: 0,
    verified_fixed: 0,
    withdrawn: 0,
    acknowledged: 0,
    dismissed: 3,
    obsolete: 0,
    kept_in_app: 4,
  });
});

test("when core says only the owner can settle it, the check's title and headline say so and name the dispute", async () => {
  const github = host();
  const disputed: Finding = { ...F1, status: "escalated" };
  await createPublisher({ writer: github, person }).publish({
    ...round1,
    reconciled: {
      ...reconciled1,
      findings: [disputed, F2, F3],
      loop: "needs_owner",
      nextAction: "ask_human",
      actionBy: [
        { id: F1.id, by: "human" },
        { id: F2.id, by: "agent" },
        { id: F3.id, by: "none" },
      ],
      counts: { ...NO_COUNTS, open: { blocking: 0, should_fix: 1, consider: 0 }, escalated: 1 },
    },
  });
  const { title, summary } = completed(github.posts).output;
  expect(title).toBe("Looked over a1b2c3d: needs the owner");
  expect(summary.split("\n")[0]).toBe(
    "The author and the reviewer disagree on send.ts line 43: only the owner can settle it.",
  );
});

test("a finding core gave nobody to act on is a programming error, thrown before anything is posted", async () => {
  const github = host();
  const missing: Reconciled = { ...reconciled1, actionBy: reconciled1.actionBy.slice(0, 2) };
  await expect(
    createPublisher({ writer: github, person }).publish({ ...round1, reconciled: missing }),
  ).rejects.toThrow("F3 has no entry in actionBy");
  expect(github.posts).toEqual([]);
});

test("a finding's body can't close the result's marker", async () => {
  const github = host();
  const body = "When `a --> b` is read, the comment ends early, because `-->` closes it.";
  await createPublisher({ writer: github, person }).publish({
    ...round1,
    reconciled: { ...reconciled1, findings: [{ ...F1, body }, F2, F3] },
  });
  const read = readResult(completed(github.posts).output.text);
  expect(read?.findings[0]?.body).toBe(body);
});

test("a result too big for the check keeps the first findings that fit, whole, and says so", async () => {
  const github = host();
  // About 120 kB of findings: well over the check's byte limit.
  const big = Array.from({ length: 40 }, (_, i) =>
    finding(`F${i + 3}`, {
      severity: "consider",
      title: `Finding ${i + 3}`,
      body: `é${"x".repeat(2_999)}`,
      posted: false,
      raisedIn: 1,
      anchoredIn: 1,
    }),
  );
  const round: RoundToPost = {
    ...round1,
    reconciled: {
      ...reconciled1,
      findings: [F1, F2, ...big],
      raised: [F1, F2, ...big],
      actionBy: [...by([F1, F2], "agent"), ...by(big, "none")],
    },
  };
  const published = await createPublisher({ writer: github, person }).publish(round);
  const { output } = completed(github.posts);
  expect(utf8Bytes(output.text)).toBeLessThanOrEqual(CHECK_OUTPUT_MAX_BYTES);
  const read = readResult(output.text);
  expect(read).not.toBeNull();
  expect(read?.truncated).toBe(true);
  // What is open on the pull request comes first; every finding that is in is in whole.
  expect(read?.findings.slice(0, 2).map((f) => f.id)).toEqual(["F1", "F2"]);
  expect(read?.findings.length).toBeGreaterThan(2);
  expect(read?.findings.length).toBeLessThan(42);
  for (const f of read?.findings.slice(2) ?? []) expect(f.body).toHaveLength(3_000);
  expect(read?.counts.open).toEqual({ blocking: 1, should_fix: 1, consider: 0 });
  const left = 42 - (read?.findings.length ?? 0);
  expect(output.text).toContain(`${left} findings did not fit the result`);
  expect(read).toEqual(published.result);
});

test("a host refusal propagates, and the posts sent before it are marked sent with the host's ids", async () => {
  const github = host();
  const gone = { ...round1, change: { ...round1.change, number: 99 } };
  const outbox = memoryOutbox();
  await expect(createPublisher({ writer: github, person }).publish(gone, outbox)).rejects.toMatchObject({
    failure: "not_found",
  });
  // The check is on the repository, so it was started; the review on the missing pull request was refused.
  expect(github.posts.map((p) => p.kind)).toEqual(["check.created"]);
  const [check] = github.view(change).checks;
  expect(check?.status).toBe("in_progress");
  expect(outbox.saved).toEqual([
    { kind: "check", hostId: check?.id ?? "no check", tries: 1 },
    { kind: "review", hostId: null, tries: 1 },
  ]);
});

test("the check's summary lists at most 20 findings and says how many more the summary comment has", async () => {
  const github = host();
  const many = Array.from({ length: 25 }, (_, i) =>
    finding(`F${i + 1}`, { title: `Finding ${i + 1}`, line: 40 + (i % 6) }),
  );
  await createPublisher({ writer: github, person }).publish({
    ...round1,
    reconciled: {
      ...reconciled1,
      findings: many,
      raised: many,
      post: many,
      actionBy: by(many, "agent"),
      open: 25,
      keptInApp: 0,
      counts: { ...NO_COUNTS, open: { blocking: 25, should_fix: 0, consider: 0 } },
    },
  });
  const { summary } = completed(github.posts).output;
  expect(summary.split("\n")).toHaveLength(22);
  expect(summary).toContain("F20 ·");
  expect(summary).not.toContain("F21 ·");
  expect(summary.split("\n").at(-1)).toBe("- and 5 more, in the summary comment");
  expect(utf8Bytes(summary)).toBeLessThanOrEqual(CHECK_OUTPUT_MAX_BYTES);
});

// Refusals (ADR 0044): a transient one is tried again on the caller's time, for about an hour; a comment GitHub
// can't place sends the review once more with every finding in the summary.

/** Lets the work a timer started settle: every pending promise reaction runs before the next macrotask. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Time moved by hand: `now` changes only with `advance`, which fires each timer due, in order, at its own time. */
function heldTime(at = Date.UTC(2026, 8, 30, 10, 15, 0)) {
  let pending: { due: number; fire: () => void }[] = [];
  return {
    now: () => at,
    after(ms: number, fire: () => void) {
      const timer = { due: at + ms, fire };
      pending.push(timer);
      return () => {
        pending = pending.filter((t) => t !== timer);
      };
    },
    async advance(ms: number) {
      const until = at + ms;
      for (;;) {
        await settled();
        const next = pending.filter((t) => t.due <= until).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        pending = pending.filter((t) => t !== next);
        at = next.due;
        next.fire();
      }
      at = until;
    },
  };
}

/** Whether `promise` has settled by now: what a test asks between two moves of the clock. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await settled();
  return done;
}

const MINUTE = 60_000;

test("a review GitHub saved though it answered with its internal error is found by its marker: one review", async () => {
  const github = host();
  const time = heldTime();
  github.refuseNext("unavailable", { post: "review", saved: true });
  const outbox = memoryOutbox();
  const published = createPublisher({ writer: github, person, time }).publish(round1, outbox);
  await time.advance(MINUTE);
  const { reviewId } = await published;
  expect(github.view(change).reviews.map((r) => r.id)).toEqual([reviewId]);
  expect(github.posts.map((p) => p.kind)).toEqual([
    "check.created",
    "review",
    "summary.created",
    "check.completed",
  ]);
  expect(outbox.saved.find((p) => p.kind === "review")).toEqual({
    kind: "review",
    hostId: reviewId,
    tries: 1,
  });
});

test("a review refused by a server error is sent again a few seconds later, and lands once", async () => {
  const github = host();
  const time = heldTime();
  github.refuseNext("unavailable", { post: "review" });
  const published = createPublisher({ writer: github, person, time }).publish(round1);
  await time.advance(1_000);
  expect(await settledYet(published)).toBe(false);
  expect(github.view(change).reviews).toHaveLength(0);
  await time.advance(MINUTE);
  await published;
  expect(github.view(change).reviews).toHaveLength(1);
});

test("every post is tried again, the summary and the check's completion too", async () => {
  const github = host();
  const time = heldTime();
  const publisher = createPublisher({ writer: github, person, time });
  github.refuseNext("unavailable", { post: "summary" });
  const first = publisher.publish(round1);
  await time.advance(MINUTE);
  await first;
  expect(github.view(change).comments).toHaveLength(1);
  github.push(change, ROUND_2, COMMENTABLE_2);
  // Round 2's job has its check already: the write refused is the completion.
  const checkId = await github.createCheck(
    repo,
    ROUND_2,
    "in_progress",
    { title: "Looking over c3d4e5f", summary: "Round 2 is running.", text: "Round 2 is running." },
    "job-2",
  );
  github.refuseNext("unavailable", { post: "check" });
  const second = publisher.publish({ ...round2, checkId });
  await time.advance(1_000);
  expect(github.view(change).checks.map((c) => c.status)).toEqual(["in_progress"]);
  await time.advance(MINUTE);
  await second;
  expect(github.view(change).checks).toMatchObject([{ id: checkId, status: "completed" }]);
  expect(github.posts.slice(4).map((p) => p.kind)).toEqual([
    "check.created",
    "review",
    "summary.edited",
    "check.completed",
  ]);
});

test("a secondary limit waits at least a minute before the post is sent again", async () => {
  const github = host();
  const time = heldTime();
  github.refuseNext("rate_limited", { post: "review" });
  const published = createPublisher({ writer: github, person, time }).publish(round1);
  await time.advance(MINUTE - 1);
  expect(github.view(change).reviews).toHaveLength(0);
  await time.advance(1);
  await published;
  expect(github.view(change).reviews).toHaveLength(1);
});

test("a limit waits until the time GitHub gave, past a minute", async () => {
  const github = host();
  const time = heldTime();
  github.refuse("rate_limited", { retryAt: time.now() + 10 * MINUTE });
  const published = createPublisher({ writer: github, person, time }).publish(round1);
  await time.advance(10 * MINUTE - 1);
  github.refuse(null);
  expect(github.posts).toEqual([]);
  await time.advance(1);
  await published;
  expect(github.view(change).reviews).toHaveLength(1);
});

test("a wait is reported as it starts, with until when and the refusal, and once the post lands (ADR 0055)", async () => {
  const github = host();
  const time = heldTime();
  const start = time.now();
  github.refuse("rate_limited", { retryAt: start + 10 * MINUTE });
  const outbox = memoryOutbox();
  const published = createPublisher({ writer: github, person, time }).publish(round1, outbox);
  await time.advance(0);
  expect(outbox.waits).toEqual([{ until: start + 10 * MINUTE, refusal: "rate_limited" }]);
  github.refuse("unavailable");
  await time.advance(10 * MINUTE);
  // Refused again, for another reason: a new wait, from the time it was refused, the first backoff after one try.
  expect(outbox.waits.at(-1)).toEqual({ until: start + 10 * MINUTE + 10_000, refusal: "unavailable" });
  github.refuse(null);
  await time.advance(10_000);
  await published;
  expect(outbox.waits).toEqual([
    { until: start + 10 * MINUTE, refusal: "rate_limited" },
    { until: start + 10 * MINUTE + 10_000, refusal: "unavailable" },
    null,
  ]);
});

test("a post given up after its waits reports the wait over before its refusal propagates", async () => {
  const github = host();
  const time = heldTime();
  github.refuse("unavailable");
  const outbox = memoryOutbox();
  const refused = createPublisher({ writer: github, person, time })
    .publish(round1, outbox)
    .catch((error: unknown) => error);
  await time.advance(65 * MINUTE);
  expect(await refused).toMatchObject({ failure: "unavailable" });
  expect(outbox.waits.at(0)).toEqual({ until: time.now() - 65 * MINUTE + 5_000, refusal: "unavailable" });
  expect(outbox.waits.at(-1)).toBeNull();
});

test("a post refused for good never waits: nothing is reported", async () => {
  const github = host();
  const time = heldTime();
  github.refuseNext("unauthorized", { post: "review" });
  const outbox = memoryOutbox();
  await expect(
    createPublisher({ writer: github, person, time }).publish(round1, outbox),
  ).rejects.toMatchObject({
    failure: "unauthorized",
  });
  expect(outbox.waits).toEqual([]);
});

test("an hour of refusals gives up with the last refusal; the job's check completes neutral once GitHub answers", async () => {
  const github = host();
  const time = heldTime();
  const publisher = createPublisher({ writer: github, person, time });
  const created = await github.createCheck(
    repo,
    ROUND_1,
    "in_progress",
    { title: "Looking over a1b2c3d", summary: "Round 1 is running.", text: "Round 1 is running." },
    "job-1",
  );
  github.refuse("unavailable");
  const published = publisher.publish({ ...round1, checkId: created });
  const refused = published.catch((error: unknown) => error);
  await time.advance(55 * MINUTE);
  expect(await settledYet(published)).toBe(false);
  await time.advance(10 * MINUTE);
  expect(await refused).toMatchObject({ failure: "unavailable" });
  expect(github.view(change).reviews).toHaveLength(0);
  github.refuse(null);
  await publisher.check({
    change: round1.change,
    sha: ROUND_1,
    job: { id: round1.run.job, trigger: "manual" },
    run: { id: round1.run.id, engine: "claude", startedAt: round1.run.startedAt },
    rounds: 0,
    loop: "open",
    standing: { kind: "ended", ended: { kind: "failed", failure: "publish_failed" } },
    onlyCodex: false,
    at: time.now(),
    checkId: created,
  });
  expect(github.view(change).checks).toMatchObject([
    { id: created, status: "completed", conclusion: "neutral" },
  ]);
});

test("a refusal sending again can't change is not tried again: a body too long, a request GitHub finds invalid", async () => {
  for (const failure of ["invalid", "too_large", "not_found"] as const) {
    const time = heldTime();
    const refusing = new (class extends FakeGitHost {
      override publishReview(): Promise<string> {
        return Promise.reject(new HostError(failure, "refused as it is"));
      }
    })({ repo, bot, changes: [] });
    const published = createPublisher({ writer: refusing, person, time }).publish(round1);
    expect(await settledYet(published)).toBe(true);
    await expect(published).rejects.toMatchObject({ failure });
  }
});

/** The host takes comments on head lines 40 to 42 only: our diff places F1 on 43, which GitHub can't place. */
const narrowHost = () => host([{ path: "src/queue/send.ts", side: "head", from: 40, to: 42 }]);

test("a comment GitHub can't place sends the review once more, every finding of the round in the summary", async () => {
  const github = narrowHost();
  const outbox = memoryOutbox();
  const published = await createPublisher({ writer: github, person }).publish(round1, outbox);
  const { reviews, comments } = github.view(change);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.comments).toEqual([]);
  expect(reviews[0]?.body).toContain(
    "GitHub would not place this round's comments on their lines: the findings are in the summary comment.",
  );
  expect(reviews[0]?.body).not.toContain("outside the diff");
  expect(comments[0]?.body).toContain(
    "When the upstream returns a 4xx, `sendWithRetry` retries forever, because only a 5xx is skipped and `res.ok` is false.\n  No comment on the line: GitHub would not place this round's comments.",
  );
  expect(comments[0]?.body).toContain("the file is not in the diff");
  expect(published.result.findings.map((f) => [f.id, f.placement])).toEqual([
    ["F1", "summary"],
    ["F2", "summary"],
    ["F3", "check_only"],
  ]);
  expect(outbox.degraded).toBe(true);
});

test("a round whose review was sent with its findings in the summary keeps them there after a restart", async () => {
  const github = narrowHost();
  const publisher = createPublisher({ writer: github, person });
  const stopped = memoryOutbox({ crashAfter: "review" });
  await expect(publisher.publish(round1, stopped)).rejects.toBeInstanceOf(Crash);
  await publisher.publish(round1, memoryOutbox({ from: stopped.saved, degraded: stopped.degraded }));
  expect(github.view(change).comments[0]?.body).toContain(
    "No comment on the line: GitHub would not place this round's comments.",
  );
});

// Size limits (ADR 0044, #67): every body fits `COMMENT_MAX_BYTES`, which `FakeGitHost` holds as GitHub does; a body
// over it is cut at a line, and says where the rest is.

const CUT =
  "Cut to fit GitHub's limit: the rest is in Lookover, and in the check's result when it fits there.";
/** Lines of a long finding body, 34 bytes each. */
const longBody = (lines: number) =>
  Array.from(
    { length: lines },
    (_, i) => `Line ${String(i + 1).padStart(5, "0")} of the long body here.`,
  ).join("\n");

/**
 * The padding that makes a post exactly `target` bytes: `make` builds the round around the padding, `read` reads the
 * post from the host. Sized once with no padding, so each byte of padding is a byte of the post.
 */
async function padding(
  make: (pad: string) => RoundToPost,
  read: (github: FakeGitHost) => string,
  target = COMMENT_MAX_BYTES,
): Promise<string> {
  const github = host();
  await createPublisher({ writer: github, person }).publish(make(""));
  return "y".repeat(target - utf8Bytes(read(github)));
}

/** `cut` keeps whole lines of `whole` before the pointer: the text up to it is a prefix of `whole` ending at a line. */
function expectCutAtALine(cut: string, whole: string): void {
  const [kept = ""] = cut.split(`\n\n${CUT}`);
  expect(whole.startsWith(kept)).toBe(true);
  expect(whole[kept.length]).toBe("\n");
}

test("a comment at the byte limit is posted whole; one byte over, it is cut at a line and says where the rest is", async () => {
  const body = longBody(1_600);
  const make = (pad: string) => posting([{ ...F1, body: `${body}${pad}` }]);
  const comment = (github: FakeGitHost) => github.view(change).reviews[0]?.comments[0]?.body ?? "";
  const pad = await padding(make, comment);

  const atLimit = host();
  await createPublisher({ writer: atLimit, person }).publish(make(pad));
  expect(utf8Bytes(comment(atLimit))).toBe(COMMENT_MAX_BYTES);
  expect(comment(atLimit)).toContain(`${body}${pad}\n\n`);
  expect(comment(atLimit)).not.toContain(CUT);

  const over = host();
  const published = await createPublisher({ writer: over, person }).publish(make(`${pad}y`));
  const cut = comment(over);
  expect(utf8Bytes(cut)).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
  expect(cut).toContain(CUT);
  expect(cut).toEndWith(
    `${FINDING_MARKER}{"v":1,"id":"F1","fingerprints":{"location":"loc:F1","meaning":"sem:F1"},"severity":"blocking","sha":"${ROUND_1}"} -->`,
  );
  expectCutAtALine(cut, `Lookover · **Retry loop never stops on 4xx** · Blocking\n\n${body}${pad}y`);
  // Too big for the check's result as well: the result says it left a finding out.
  expect(published.result.truncated).toBe(true);
  expect(completed(over.posts).conclusion).toBe("neutral");
});

test("a cut closes the code block it falls in, and cuts a line too long to keep between two characters", async () => {
  // A block opened with four tildes holds a line of backticks, which doesn't close it: only four tildes or more do.
  const fenced = { ...F1, body: `It loops:\n\n~~~~md\n\`\`\`\n~~~\n${longBody(2_000)}\n~~~~` };
  const github = host();
  await createPublisher({ writer: github, person }).publish(posting([fenced]));
  const comment = github.view(change).reviews[0]?.comments[0]?.body ?? "";
  expect(comment).toMatch(/\nLine \d{5} of the long body here\.\n~~~~\n\nCut to fit GitHub's limit/);

  // A block closed before the cut is not closed again.
  const closed = { ...F1, body: `It loops:\n\n\`\`\`ts\nloop();\n\`\`\`\n\n${longBody(2_000)}` };
  const once = host();
  await createPublisher({ writer: once, person }).publish(posting([closed]));
  expect(once.view(change).reviews[0]?.comments[0]?.body).toMatch(
    /\nLine \d{5} of the long body here\.\n\nCut to fit GitHub's limit/,
  );

  // A title of four-byte characters, longer than a comment: no whole line fits.
  const titled = { ...F1, title: "😀".repeat(20_000) };
  const other = host();
  await createPublisher({ writer: other, person }).publish(posting([titled]));
  const cut = other.view(change).reviews[0]?.comments[0]?.body ?? "";
  expect(utf8Bytes(cut)).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
  // No character split: a lone half of a pair would not come back the same through UTF-8.
  expect(new TextDecoder().decode(new TextEncoder().encode(cut))).toBe(cut);
  expect(cut).toStartWith("Lookover · **😀😀");
  expect(cut).toContain(`😀…\n\n${CUT}\n\n${FINDING_MARKER}`);
});

test("a summary at the byte limit is posted whole; one byte over, it is cut at a line and says where the rest is", async () => {
  const body = longBody(1_600);
  // F2's file is not in the diff: its body is in the summary.
  const make = (pad: string) => posting([{ ...F2, body: `${body}${pad}` }]);
  const summary = (github: FakeGitHost) => github.view(change).comments[0]?.body ?? "";
  const pad = await padding(make, summary);

  const atLimit = host();
  await createPublisher({ writer: atLimit, person }).publish(make(pad));
  expect(utf8Bytes(summary(atLimit))).toBe(COMMENT_MAX_BYTES);
  expect(summary(atLimit)).not.toContain(CUT);
  expect(summary(atLimit)).toContain("| Round | Commit | Raised | Verified fixed |");

  const over = host();
  await createPublisher({ writer: over, person }).publish(make(`${pad}y`));
  const cut = summary(over);
  expect(utf8Bytes(cut)).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
  expect(cut.startsWith(SUMMARY_MARKER)).toBe(true);
  expect(cut).toEndWith(`\n\n${CUT}`);
  expectCutAtALine(cut, summary(atLimit).replace(pad, `${pad}y`));
  expect(completed(over.posts).conclusion).toBe("neutral");
});

test("a review body at the byte limit is posted whole; one byte over, it is cut and keeps its marker", async () => {
  // The review's body names the file of the round's first finding: a long name makes it long.
  const make = (pad: string) => posting([{ ...F2, file: `src/http/${"a".repeat(60_000)}${pad}.ts` }]);
  const reviewBody = (github: FakeGitHost) => github.view(change).reviews[0]?.body ?? "";
  const pad = await padding(make, reviewBody);

  const atLimit = host();
  await createPublisher({ writer: atLimit, person }).publish(make(pad));
  expect(utf8Bytes(reviewBody(atLimit))).toBe(COMMENT_MAX_BYTES);
  expect(reviewBody(atLimit)).not.toContain(CUT);

  const over = host();
  const published = await createPublisher({ writer: over, person }).publish(make(`${pad}y`));
  const cut = reviewBody(over);
  expect(utf8Bytes(cut)).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
  expect(cut).toContain(CUT);
  expect(cut).toEndWith(MARKED_1);
  // The result's headline is one sentence: cut short between two characters, with no pointer.
  const headline = published.result.verdict.headline ?? "";
  expect(headline).toStartWith("One thing to fix, aaaa");
  expect(headline).toEndWith("a…");
  expect(headline).not.toContain("\n");
  expect(utf8Bytes(headline)).toBeLessThanOrEqual(1_024);
  // The summary and the check's summary name the file too: cut as well, and every post landed.
  expect(utf8Bytes(over.view(change).comments[0]?.body ?? "")).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
  expect(completed(over.posts).conclusion).toBe("neutral");
});

test("a round with more findings than one review holds posts the most urgent as comments, the rest in the summary, and completes", async () => {
  // 30 findings on lines the diff shows, 7 kB each: more comments than one review takes, and more text than the
  // summary holds.
  const many = Array.from({ length: 30 }, (_, i) =>
    finding(`F${i + 1}`, {
      severity: i < 25 ? "should_fix" : "blocking",
      title: `Finding ${i + 1}`,
      line: 40 + (i % 6),
      body: longBody(200),
    }),
  );
  const github = host();
  const published = await createPublisher({ writer: github, person }).publish(posting(many));
  const { reviews, comments } = github.view(change);
  expect(reviews).toHaveLength(1);
  const commented = reviews[0]?.comments.map((c) => c.body.split(" · ")[1]) ?? [];
  expect(commented).toHaveLength(REVIEW_MAX_COMMENTS);
  // The five blocking findings, and the first 15 that should be fixed, in the ledger's order.
  expect(commented.slice(13, 17)).toEqual([
    "**Finding 14**",
    "**Finding 15**",
    "**Finding 26**",
    "**Finding 27**",
  ]);
  expect(commented.at(-1)).toBe("**Finding 30**");
  expect(reviews[0]?.body).toContain(
    "10 findings did not fit in the review's 20 comments: they are in the summary comment.",
  );
  const summary = comments[0]?.body ?? "";
  expect(summary).toContain("**Not on a line**\n- F16 · Should fix ·");
  expect(summary).toContain("No comment on the line: the review holds 20 comments at most.");
  expect(summary).toEndWith(CUT);
  expect(utf8Bytes(summary)).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
  // The result holds as many whole findings as fit, each placed where the round put it.
  const past = new Set(Array.from({ length: 10 }, (_, i) => `F${i + 16}`));
  expect(published.result.truncated).toBe(true);
  for (const f of published.result.findings)
    expect([f.id, f.placement]).toEqual([f.id, past.has(f.id) ? "summary" : "inline"]);
  expect(completed(github.posts).conclusion).toBe("neutral");
});

/** `n` findings that should be fixed, on lines the diff shows: F1 to F`n`. */
const shouldFix = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    finding(`F${i + 1}`, { severity: "should_fix", title: `Finding ${i + 1}`, line: 40 + (i % 6) }),
  );

/** The ids listed in the summary's section `heading`, in order. */
function listed(summary: string, heading: string): string[] {
  const section = summary.split(`**${heading}**\n`)[1]?.split("\n\n**")[0] ?? "";
  return [...section.matchAll(/^- (F\d+) ·/gm)].map((m) => m[1] ?? "");
}

test("the summary lists every finding without a comment in one list, most urgent first, so a cut drops the least urgent", async () => {
  const big = longBody(1_000);
  // 21 to fix on lines the diff shows (F21 past the review's comments), two outside it, the consider one first.
  const findings = [
    ...shouldFix(21).map((f) => (f.id === "F21" ? { ...f, body: big } : f)),
    finding("F22", {
      severity: "consider",
      file: "src/http/client.ts",
      line: 13,
      title: "Outside, consider",
      body: big,
    }),
    finding("F23", { file: "src/http/client.ts", line: 12, title: "Outside, blocking", body: big }),
  ];
  const github = host();
  await createPublisher({ writer: github, person }).publish(posting(findings));
  const summary = github.view(change).comments[0]?.body ?? "";
  // About 30 kB each: the blocking one whole, the one that should be fixed cut, the one to consider left out.
  expect(listed(summary, "Not on a line")).toEqual(["F23", "F21"]);
  expect(summary).toEndWith(CUT);
  expect(summary).not.toContain("F22 ·");
});

test("a finding past the review's comments is recorded as having none, and round 2 keeps it in the summary", async () => {
  const github = host();
  const outbox = memoryOutbox();
  await createPublisher({ writer: github, person }).publish(posting(shouldFix(21)), outbox);
  expect(outbox.commented).toEqual(shouldFix(20).map((f) => f.id));

  // Round 2 finds nothing new; the ledger is as round 1's review left it.
  github.push(change, ROUND_2, COMMENTABLE_2);
  const ledger = shouldFix(21).map((f) => ({ ...f, commented: f.id !== "F21" }));
  const published = await createPublisher({ writer: github, person }).publish({
    ...round2,
    reconciled: { ...posting(ledger).reconciled, raised: [], post: [] },
  });
  const summary = github.view(change).comments[0]?.body ?? "";
  expect(listed(summary, "To fix")).toEqual(shouldFix(20).map((f) => f.id));
  expect(listed(summary, "Not on a line")).toEqual(["F21"]);
  expect(summary).toContain("No comment on the line: none was posted for it.");
  const f21 = published.result.findings.find((f) => f.id === "F21");
  expect([f21?.placement, f21?.placed]).toEqual(["summary", null]);
});

test("a round over the review's comments that GitHub refuses lists each finding it posts as refused, the withheld one off it", async () => {
  // Line 43 is one GitHub can't place: the first review is refused, and sent again with no comment.
  const many = shouldFix(22);
  const withheld = finding("F23", { severity: "consider", title: "Withheld", posted: false });
  const github = narrowHost();
  const outbox = memoryOutbox();
  const published = await createPublisher({ writer: github, person }).publish(
    {
      ...round1,
      reconciled: {
        ...posting(many).reconciled,
        findings: [...many, withheld],
        actionBy: [...by(many, "agent"), ...by([withheld], "none")],
        keptInApp: 1,
      },
    },
    outbox,
  );
  const { reviews, comments } = github.view(change);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.comments).toEqual([]);
  expect(reviews[0]?.body).toContain(
    "GitHub would not place this round's comments on their lines: the findings are in the summary comment.",
  );
  expect(reviews[0]?.body).not.toContain("did not fit");
  const summary = comments[0]?.body ?? "";
  expect(listed(summary, "Not on a line")).toEqual(many.map((f) => f.id));
  expect(summary.split("No comment on the line: GitHub would not place this round's comments.")).toHaveLength(
    23,
  );
  expect(summary).not.toContain("Withheld");
  expect(published.result.findings.map((f) => [f.id, f.placement])).toEqual([
    ...many.map((f) => [f.id, "summary"]),
    ["F23", "check_only"],
  ]);
  expect(outbox.commented).toEqual([]);
});

// The output filter (ADR 0056, SR-08): what an engine or a person wrote is posted harmless, everywhere it shows.

/** The invisible break the filter puts in (U+200B). */
const Z = "\u{200B}";
const TOKEN = "ghp_a1b2c3d4e5f6a7b8c9d0e1f2";
/** The service's secrets filter, standing in: the one token it knows. */
const tokenRemoved = (text: string) => text.replaceAll(TOKEN, "[redacted]");
const SUGGESTION = "```suggestion\n    if (res.status >= 400) break; // @dana <b>\n```";
/** Inline, on line 43: a token, a mention, a hidden character, two images, a tag and a suggestion. */
const HOSTILE = finding("F1", {
  title: `Leaks ${TOKEN} to @dana`,
  body: `Ask @dana.\u{202E} ![x](https://evil.example/p.png) <img src="https://evil.example/q.png"> <details>\n\n${SUGGESTION}`,
});
/** In the summary: its file is not in the diff. */
const HOSTILE_ELSEWHERE = finding("F2", {
  severity: "should_fix",
  file: "src/http/client.ts",
  line: 12,
  title: "Ping @lee <b>here</b>",
  body: "See ![](https://evil.example/r.png), @lee.",
});
const HOSTILE_TITLE = `Leaks [redacted] to @${Z}dana`;
const HOSTILE_BODY = `Ask @${Z}dana. !${Z}[x](https://evil.example/p.png) <${Z}img src="https://evil.example/q.png"> <${Z}details>`;
const ELSEWHERE_TITLE = `Ping @${Z}lee <${Z}b>here<${Z}/b>`;
const ELSEWHERE_BODY = `See !${Z}[](https://evil.example/r.png), @${Z}lee.`;

test("a hostile finding's comment, summary entry, check and result are all filtered; its suggestion stays as written", async () => {
  const github = host();
  await createPublisher({ writer: github, person, secretsRemoved: tokenRemoved }).publish(
    posting([HOSTILE, HOSTILE_ELSEWHERE]),
  );
  const { reviews, comments } = github.view(change);
  expect(reviews[0]?.comments[0]?.body).toStartWith(
    [`Lookover · **${HOSTILE_TITLE}** · Blocking`, HOSTILE_BODY, SUGGESTION].join("\n\n"),
  );
  const summary = comments[0]?.body ?? "";
  expect(summary).toContain(`- F1 · Blocking · \`src/queue/send.ts\` line 43 · ${HOSTILE_TITLE}`);
  expect(summary).toContain(`- F2 · Should fix · \`src/http/client.ts\` line 12 · ${ELSEWHERE_TITLE}`);
  expect(summary).toContain(ELSEWHERE_BODY);
  const { output } = completed(github.posts);
  for (const text of [summary, output.title, output.summary, output.text]) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("\u{202E}");
    expect(text).not.toContain("![");
    expect(text).not.toContain("<img");
  }
  // The result's text holds the suggestion as written: it is in the result's hidden line.
  for (const text of [summary, output.title, output.summary]) expect(text).not.toMatch(/@[a-z]/);
  const read = readResult(output.text);
  expect(read?.findings.map((f) => [f.title, f.body])).toEqual([
    [HOSTILE_TITLE, `${HOSTILE_BODY}\n\n${SUGGESTION}`],
    [ELSEWHERE_TITLE, ELSEWHERE_BODY],
  ]);
  // What `publish` was given is left as written: the store keeps the raw text.
  expect(HOSTILE.title).toBe(`Leaks ${TOKEN} to @dana`);
});

test("a claim's text, a reply's reason and a reason for closing are filtered too", async () => {
  const github = host();
  const publisher = createPublisher({
    writer: github,
    person,
    threads: (c) => github.threads(c),
    secretsRemoved: tokenRemoved,
  });
  await publisher.publish(round1);
  const claimed: Finding = {
    ...F1_KEPT,
    claim: F1_KEPT.claim && { ...F1_KEPT.claim, text: `Won't fix, ask @dana: ${TOKEN}` },
  };
  const deferred: Finding = { ...F2_ACKNOWLEDGED, closedWhy: "Deferred, see <b>the plan</b>." };
  await publisher.publish(
    await rooted(github, {
      ...answering,
      reconciled: {
        ...answering.reconciled,
        findings: [claimed, deferred, F3],
        replies: [{ findingId: F1.id, kind: "kept", why: "Still loops: ![x](https://evil.example/p.png)" }],
      },
    }),
  );
  const reply = github.posts.find((p) => p.kind === "reply");
  expect(reply?.kind === "reply" && reply.body).toStartWith(
    `Kept.\n\nStill loops: !${Z}[x](https://evil.example/p.png)`,
  );
  const summary = github.view(change).comments[0]?.body ?? "";
  expect(summary).toContain(`Kept: Still loops: !${Z}[x](https://evil.example/p.png)`);
  const read = readResult(completed(github.posts).output.text);
  expect(read?.findings.find((f) => f.id === "F1")).toMatchObject({
    claim: { text: `Won't fix, ask @${Z}dana: [redacted]` },
    resolution: { explanation: `Still loops: !${Z}[x](https://evil.example/p.png)` },
  });
  expect(read?.findings.find((f) => f.id === "F2")?.resolution?.explanation).toBe(
    `Deferred, see <${Z}b>the plan<${Z}/b>.`,
  );
});

test("a reply's reason is filtered after it is trimmed: an indented block the trim undoes lets nothing out (F3)", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  await publisher.publish(round1);
  const why = "\u{200B}    ![x](https://evil.example/p.png) `@dana`";
  await publisher.publish(
    await rooted(github, {
      ...answering,
      reconciled: { ...answering.reconciled, replies: [{ findingId: F1.id, kind: "kept", why }] },
    }),
  );
  const reply = github.posts.find((p) => p.kind === "reply");
  expect(reply?.kind === "reply" && reply.body).toStartWith(
    `Kept.\n\n!${Z}[x](https://evil.example/p.png) \`@${Z}dana\``,
  );
});

test("an engine's text that ends inside a fence has it closed, so Lookover's own lines and marker stay out of the code", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person, threads: (c) => github.threads(c) });
  const rule = { id: "7c1e0a9d3b2f4e58", file: "REVIEW.md" as const, line: 12 };
  const open = finding("F1", { category: "repo_rule", rule, body: "Loops:\n\n  ~~~~ts\n  send(@dana);" });
  await publisher.publish(posting([open]));
  expect(github.view(change).reviews[0]?.comments[0]?.body).toStartWith(
    `Lookover · **Retry loop never stops on 4xx** · Blocking\n\nLoops:\n\n  ~~~~ts\n  send(@dana);\n  ~~~~\n\nRule: REVIEW.md, line 12.\n\n${FINDING_MARKER}`,
  );
  await publisher.publish(
    await rooted(github, {
      ...answering,
      reconciled: {
        ...answering.reconciled,
        replies: [{ findingId: F1.id, kind: "kept", why: "Still:\n```\n@dana" }],
      },
    }),
  );
  const reply = github.posts.find((p) => p.kind === "reply");
  expect(reply?.kind === "reply" && reply.body).toStartWith("Kept.\n\nStill:\n```\n@dana\n```\n\n");
});

test("a dismissal's summary and check show the round's findings filtered", async () => {
  const github = host();
  const publisher = createPublisher({
    writer: github,
    person,
    threads: (c) => github.threads(c),
    secretsRemoved: tokenRemoved,
  });
  const { checkId } = await publisher.publish(posting([HOSTILE, HOSTILE_ELSEWHERE]));
  const dismissed = { ...HOSTILE, status: "dismissed" as const, closedIn: 1 };
  await publisher.dismiss({
    ...dismissal(checkId),
    round: {
      ...dismissedRound,
      reconciled: { ...dismissedRound.reconciled, findings: [dismissed, HOSTILE_ELSEWHERE] },
    },
  });
  const summary = github.view(change).comments.find((c) => c.body.includes(SUMMARY_MARKER))?.body ?? "";
  expect(summary).toContain(`- F1 · ${HOSTILE_TITLE} · dismissed by the owner`);
  const read = readResult(completed(github.posts).output.text);
  // Open first: the dismissed one after.
  expect(read?.findings.map((f) => f.title)).toEqual([ELSEWHERE_TITLE, HOSTILE_TITLE]);
});

test("a finding's category and the confirm pass's reason and evidence are filtered in the result", async () => {
  const github = host();
  const confirmed = finding("F1", {
    category: "ask @dana",
    confirmation: { verdict: "confirmed", by: "codex", reason: "Seen by @lee.", evidence: ["<b>x</b>"] },
  });
  await createPublisher({ writer: github, person, secretsRemoved: tokenRemoved }).publish(
    posting([confirmed]),
  );
  expect(readResult(completed(github.posts).output.text)?.findings[0]).toMatchObject({
    category: `ask @${Z}dana`,
    confirmation: { reason: `Seen by @${Z}lee.`, evidence: [`<${Z}b>x<${Z}/b>`] },
  });
});

test("text put on one line is filtered as that line: a fence the filter left as written is text there", async () => {
  const github = host();
  await createPublisher({ writer: github, person, secretsRemoved: tokenRemoved }).publish(
    posting([
      finding("F1", { title: "Fence\n~~~\n@kim\n~~~" }),
      finding("F2", {
        severity: "should_fix",
        file: "src/http/client.ts",
        line: 12,
        title: "Ping\n\n    @lee",
        body: "Text.\n\n    @dana\n\n```\n@ana",
      }),
    ]),
  );
  const { reviews, comments } = github.view(change);
  const fence = `Fence ${Z}~~~ @${Z}kim ${Z}~~~`;
  expect(reviews[0]?.comments[0]?.body).toStartWith(`Lookover · **${fence}** · Blocking`);
  const summary = comments[0]?.body ?? "";
  expect(summary).toContain(`- F1 · Blocking · \`src/queue/send.ts\` line 43 · ${fence}\n`);
  expect(summary).toContain(
    `- F2 · Should fix · \`src/http/client.ts\` line 12 · Ping @${Z}lee\n  Text. @${Z}dana ${Z}\`\`\` @${Z}ana\n`,
  );
  expect(completed(github.posts).output.summary).toContain(`line 12 · Ping @${Z}lee`);
});

test("a secret in a finding's path is removed wherever the path shows; its comment still goes on its path (F4)", async () => {
  const github = host();
  // The service's filter, standing in: the token, and here a word of a path in the diff too.
  const secretsRemoved = (text: string) => tokenRemoved(text).replaceAll("queue", "[redacted]");
  const unmatched = finding("F2", { severity: "should_fix", file: `src/${TOKEN}/client.ts`, line: 12 });
  await createPublisher({ writer: github, person, secretsRemoved }).publish(
    posting([finding("F1", {}), unmatched]),
  );
  const { reviews, comments } = github.view(change);
  // Placed on the path as the diff names it.
  expect(reviews[0]?.comments.map((c) => c.path)).toEqual(["src/queue/send.ts"]);
  expect(JSON.stringify(github.posts)).not.toContain(TOKEN);
  const summary = comments[0]?.body ?? "";
  expect(summary).toContain("`src/[redacted]/client.ts` line 12");
  expect(summary).toContain("`src/[redacted]/send.ts` line 43");
  const { output } = completed(github.posts);
  for (const text of [summary, reviews[0]?.body ?? "", output.title, output.summary, output.text]) {
    expect(text).not.toContain(TOKEN);
  }
  expect(readResult(output.text)?.findings.map((f) => f.location?.path)).toEqual([
    "src/[redacted]/send.ts",
    "src/[redacted]/client.ts",
  ]);
});

test("a line keeps a code span holding a pipe; a summary entry's body opens no table and no fence", async () => {
  const github = host();
  const outside = { severity: "should_fix" as const, file: "src/http/client.ts", line: 12 };
  await createPublisher({ writer: github, person }).publish(
    posting([
      finding("F1", { title: "Returns `string | null`" }),
      finding("F2", { ...outside, title: "a | b", body: "--- | :---:" }),
      finding("F3", { ...outside, line: 13, body: "~~~ ts" }),
    ]),
  );
  const summary = github.view(change).comments[0]?.body ?? "";
  expect(summary).toContain("line 43 · Returns `string | null`\n");
  expect(summary).toContain("line 12 · a | b\n  \\--- | :---:\n");
  expect(summary).toContain(`line 13 · Retry loop never stops on 4xx\n  ${Z}~~~ ts\n`);
});

test("a reply's reason and a reason for closing, on one line in the summary, are filtered as that line", async () => {
  const github = host();
  const publisher = createPublisher({
    writer: github,
    person,
    threads: (c) => github.threads(c),
    secretsRemoved: tokenRemoved,
  });
  await publisher.publish(round1);
  const deferred: Finding = { ...F2_ACKNOWLEDGED, claim: null, closedWhy: "Later.\n\n    @dana" };
  await publisher.publish(
    await rooted(github, {
      ...answering,
      reconciled: {
        ...answering.reconciled,
        findings: [F1_KEPT, deferred, F3],
        replies: [{ findingId: F1.id, kind: "kept", why: "Still loops:\n```\n@lee" }],
      },
    }),
  );
  const summary = github.view(change).comments[0]?.body ?? "";
  expect(summary).toContain(`Kept: Still loops: ${Z}\`\`\` @${Z}lee`);
  expect(summary).toContain(`acknowledged: Later. @${Z}dana`);
});

test("a dismissal's reason is on one line in the summary, filtered as that line", async () => {
  const github = host();
  const publisher = createPublisher({
    writer: github,
    person,
    threads: (c) => github.threads(c),
    secretsRemoved: tokenRemoved,
  });
  const { checkId } = await publisher.publish(posting([HOSTILE, HOSTILE_ELSEWHERE]));
  const dismissed = {
    ...HOSTILE,
    status: "dismissed" as const,
    closedIn: 1,
    closedWhy: "Fine.\n\n    @dana",
  };
  await publisher.dismiss({
    ...dismissal(checkId),
    round: {
      ...dismissedRound,
      reconciled: { ...dismissedRound.reconciled, findings: [dismissed, HOSTILE_ELSEWHERE] },
    },
  });
  const summary = github.view(change).comments.find((c) => c.body.includes(SUMMARY_MARKER))?.body ?? "";
  expect(summary).toContain(`dismissed by the owner: Fine. @${Z}dana\n`);
});

test("a text cut to fit is filtered once cut, and fits with the filter's breaks", async () => {
  const github = host();
  const publisher = createPublisher({
    writer: github,
    person,
    threads: (c) => github.threads(c),
    secretsRemoved: tokenRemoved,
  });
  await publisher.publish(round1);
  const long = `\`@dana ${"@x ".repeat(25_000)}\``;
  await publisher.publish(
    await rooted(github, {
      ...answering,
      reconciled: {
        ...answering.reconciled,
        replies: [{ findingId: F1.id, kind: "kept", why: long }],
      },
    }),
  );
  const reply = github.posts.find((p) => p.kind === "reply");
  const body = reply?.kind === "reply" ? reply.body : "";
  expect(body).toStartWith(`Kept.\n\n\`@${Z}dana @${Z}x @${Z}x`);
  expect(body).not.toMatch(/@[a-z]/);
  expect(utf8Bytes(body)).toBeLessThanOrEqual(COMMENT_MAX_BYTES);
});

// Approval: the exact texts on the pull request, round 1 and round 2 of the example.

test("what round 1 posts", async () => {
  const github = host();
  await createPublisher({ writer: github, person }).publish(round1);
  expect(github.posts).toMatchSnapshot();
});

test("what round 2 posts", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  await publisher.publish(round1);
  github.push(change, ROUND_2, COMMENTABLE_2);
  await publisher.publish(round2);
  expect(github.posts.slice(4)).toMatchSnapshot();
});
