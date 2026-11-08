// What the simulated GitHub page says: the check, the status block in the description, each review and thread,
// Lookover's replies, the agent's terminal.
// It must tell the same story GitHub would (ADR 0021, ADR 0029), so the demo never shows what cannot happen.
import { expect, test } from "bun:test";
import {
  type Change,
  type CommitSha,
  changeId,
  commitSha,
  dayText,
  emptyReview,
  type Finding,
  type FindingClaim,
  type FindingStatus,
  findingId,
  jobId,
  type Repository,
  type ResolvedSettings,
  type Review,
  type ReviewJob,
  type Run,
  repositoryId,
  runId,
  shortSha,
} from "@lookover/contracts";
import type { Words } from "./format.ts";
import {
  type Around,
  agentLine,
  checkOf,
  postedAs,
  quotedLines,
  replyOf,
  statusBlock,
  threadOf,
  timelineOf,
} from "./github.ts";
import type { ChangeReview } from "./select.ts";

const NOW = Date.UTC(2026, 9, 3, 10, 0, 0);
const MIN = 60_000;
// A whole commit SHA, as GitHub gives it: what the pull request shows is its first seven characters.
const ROUND_SHA = commitSha("a1f9c2e0b4d6f8a1c3e5b7d9f1a3c5e7b9d1f3a5");
const NEXT_SHA = commitSha("2f6d9e3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d");
const BASE_SHA = commitSha("9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d");

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

const REPO: Repository = {
  id: repositoryId("sam/app"),
  owner: "sam",
  name: "app",
  enabled: true,
  settings: DEFAULTS,
};

function finding(id: string, status: FindingStatus, extra: Partial<Finding> = {}): Finding {
  return {
    id: findingId(id),
    fingerprints: { location: `src/app.ts:1:${id}`, meaning: id },
    severity: "blocking",
    category: "Security",
    title: id,
    file: "src/middleware/rateLimit.ts",
    side: "head",
    line: 42,
    endLine: null,
    lineText: null,
    anchoring: "reported",
    foundBy: "claude",
    confirmation: { verdict: "not_checked", demoted: false },
    body: "",
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    suggestion: null,
    status,
    posted: true,
    commented: false,
    raisedIn: 1,
    anchoredIn: 1,
    closedIn: status === "open" || status === "escalated" ? null : 2,
    verifiedSha: status === "verified_fixed" ? commitSha("c40a7b9e2d4f6a8b0c2e4f6a8b0c2d4e6f8a0b2c") : null,
    closedWhy: null,
    claim: null,
    kept: 0,
    ...extra,
  };
}

/** A change after one finished, posted round on `ROUND_SHA`, with `findings` and the loop they give. */
function item(findings: Finding[], change: Partial<Change> = {}, review: Partial<Review> = {}): ChangeReview {
  const id = changeId("sam/app#7");
  const loop = findings.some((f) => f.status === "escalated")
    ? "needs_owner"
    : findings.some((f) => f.status === "open")
      ? "open"
      : "settled";
  return {
    repo: REPO,
    change: {
      id,
      repoId: REPO.id,
      number: 7,
      title: "Add rate limiting",
      openedBy: "sam",
      author: "agent",
      writtenBy: "claude",
      headSha: ROUND_SHA,
      openedAt: NOW - 60 * MIN,
      draft: false,
      fork: false,
      newCommits: 0,
      ...change,
    },
    review: {
      ...emptyReview(id, NOW - 10 * MIN),
      job: {
        id: jobId("job-1"),
        sha: ROUND_SHA,
        trigger: "opened",
        state: "done",
        deferral: null,
        stepIn: null,
        askedBy: null,
        skip: null,
        cancel: null,
        failure: null,
        turn: null,
      },
      loop,
      findings,
      rounds: [
        {
          n: 1,
          sha: ROUND_SHA,
          base: BASE_SHA,
          reviewer: "codex",
          secondFind: null,
          confirmer: "claude",
          confirmFallback: null,
          confirmFailure: null,
          ruledOut: [],
          startedAt: NOW - 13 * MIN,
          endedAt: NOW - 10 * MIN,
          raised: findings.length,
          verifiedFixed: 0,
          open: 0,
          steps: [],
          sessions: [],
        },
      ],
      ...review,
    },
  };
}

// ---- the check ----

test("a finished round's check sits on the commit it reviewed", () => {
  expect(checkOf(item([finding("key-in-log", "open")]))).toEqual({
    tone: "fail",
    title: "Changes needed",
    text: "1 blocking finding",
  });
});

test("a finished preview made no check, and the agent reads that nothing was posted (ADR 0072)", () => {
  const cases = [
    ["findings open", [finding("key-in-log", "open")]],
    ["a finding escalated", [finding("key-in-log", "escalated")]],
    ["nothing left open", [finding("key-in-log", "verified_fixed")]],
    ["nothing found", []],
  ] as const;
  for (const [name, findings] of cases) {
    const preview = item([...findings], {}, { preview: true });
    expect([name, checkOf(preview), agentLine(preview)]).toEqual([
      name,
      null,
      "No review on GitHub: the owner's preview posted nothing.",
    ]);
  }
});

test("a preview that failed made no check either: keyed on the preview, whatever its status (ADR 0072)", () => {
  const job: Review["job"] = {
    id: jobId("job-1"),
    sha: ROUND_SHA,
    trigger: "opened",
    state: "failed",
    deferral: null,
    stepIn: null,
    askedBy: null,
    skip: null,
    cancel: null,
    failure: null,
    turn: null,
  };
  const failed = item([], {}, { preview: true, loop: null, rounds: [], job });
  expect(checkOf(failed)).toBeNull();
  // The same failure on a review that posts has its check.
  expect(checkOf(item([], {}, { loop: null, rounds: [], job }))?.title).toBe("Failed");
});

test("a review asked after a preview has its check while it waits: the preview was the last run, not this job", () => {
  const job: Review["job"] = {
    id: jobId("job-2"),
    sha: ROUND_SHA,
    trigger: "manual",
    state: "queued",
    deferral: null,
    stepIn: null,
    askedBy: null,
    skip: null,
    cancel: null,
    failure: null,
    turn: null,
  };
  const after = item([finding("key-in-log", "open")], {}, { preview: true, job });
  expect(checkOf(after)?.title).toBe("Queued");
});

test("commits pushed after the last round have no check until a review is asked for", () => {
  const pushed = item([finding("key-in-log", "open")], {
    headSha: commitSha("2f6d9e3"),
    newCommits: 2,
  });
  expect(checkOf(pushed)).toBeNull();
});

test("a finding kept off the pull request is not in the check's count, and the agent reads the same number", () => {
  // Only posted findings count (I-152): the check and `lookover wait` agree, with the unposted one left out.
  const it = item([
    finding("key-in-log", "open"),
    finding("page-size", "open", { severity: "consider", posted: false, raisedIn: 2 }),
  ]);
  expect(checkOf(it)).toEqual({ tone: "fail", title: "Changes needed", text: "1 blocking finding" });
  expect(agentLine(it)).toBe("Round 1 done: 1 finding (1 blocking). Run `lookover feedback` to read it.");
});

test("while a round runs, the agent reads the commit it waits on by its first seven characters", () => {
  const done = item([]);
  const job = done.review.job ? { ...done.review.job, state: "running" as const } : null;
  const run = {
    id: runId("run-2"),
    reviewer: "codex" as const,
    secondFinder: null,
    confirmer: "claude" as const,
    confirmFallback: null,
    sha: ROUND_SHA,
    preview: false,
    startedAt: NOW,
    step: "finding" as const,
    stepAt: NOW,
    steps: [],
    activities: [],
    posting: null,
  };
  expect(agentLine({ ...done, review: { ...done.review, job, run } })).toBe(
    "Waiting for the review of a1f9c2e (round 2)…",
  );
});

test("before its run starts, the agent reads the round it waits on, with no gap where the commit would be", () => {
  const done = item([]);
  const job = done.review.job ? { ...done.review.job, state: "running" as const } : null;
  expect(agentLine({ ...done, review: { ...done.review, job, run: null } })).toBe(
    "Waiting for the review (round 2)…",
  );
});

test("with nothing to fix and a finding kept in the app, the check passes and says how many stay (ADR 0042)", () => {
  const kept = finding("page-size", "open", { severity: "consider", posted: false, raisedIn: 2 });
  expect(checkOf(item([finding("key-in-log", "verified_fixed"), kept]))).toEqual({
    tone: "ok",
    title: "Passed",
    text: "Nothing to fix. One finding stays in Lookover, not on the pull request.",
  });
  expect(checkOf(item([finding("key-in-log", "verified_fixed")]))).toEqual({
    tone: "ok",
    title: "Passed",
    text: "No open findings",
  });
});

// ---- the status block in the description (ADR 0074) ----

/** The block's words as one line of text, a commit as its first seven characters in backticks. */
const said = (words: Words) =>
  words.map((w) => (typeof w === "string" ? w : `\`${shortSha(w.commit)}\``)).join("");
const AROUND: Around = { now: NOW, engines: { claude: { limitUntil: null }, codex: { limitUntil: null } } };
const block = (it: ChangeReview, around = AROUND) => {
  const shown = statusBlock(it, around);
  return shown && { head: said(shown.head), line: said(shown.line), items: shown.items };
};
const job = (state: ReviewJob["state"], more: Partial<ReviewJob> = {}): ReviewJob => ({
  id: jobId("job-2"),
  sha: NEXT_SHA,
  trigger: "push",
  state,
  deferral: null,
  stepIn: null,
  askedBy: null,
  skip: null,
  cancel: null,
  failure: null,
  turn: null,
  ...more,
});
const running = (sha: CommitSha, preview = false): Run => ({
  id: runId("run-2"),
  reviewer: "codex",
  secondFinder: null,
  confirmer: "claude",
  confirmFallback: null,
  sha,
  preview,
  startedAt: NOW,
  step: "finding",
  stepAt: NOW,
  steps: [],
  activities: [],
  posting: null,
});

test("a posted round's block counts what is left to fix, under the round and its commit", () => {
  const shown = block(item([finding("Key in the log", "open", { commented: true })]));
  expect(shown && { head: shown.head, line: shown.line }).toEqual({
    head: "One thing to fix",
    line: "Round 1 · `a1f9c2e`",
  });
  expect(shown?.items.map(({ finding: f, ...rest }) => ({ id: f.id, ...rest }))).toEqual([
    {
      id: findingId("Key in the log"),
      severity: "Blocking",
      linked: true,
      place: "line 42",
      note: null,
      permalink: null,
    },
  ]);
  expect(block(item([finding("a", "open", { commented: true }), finding("b", "open")]))?.head).toBe(
    "2 things to fix",
  );
  expect(block(item([finding("a", "verified_fixed")]))?.head).toBe("Nothing to fix");
});

test("the round's line says what was fixed and withdrawn on the pull request, the owner's dismissals among them", () => {
  const findings = [
    finding("a", "verified_fixed"),
    finding("b", "withdrawn"),
    finding("c", "dismissed"),
    finding("d", "withdrawn", { posted: false }),
  ];
  expect(block(item(findings))?.line).toBe("Round 1 · `a1f9c2e` · 1 fixed, 2 withdrawn");
  expect(block(item([finding("b", "withdrawn")]))?.line).toBe("Round 1 · `a1f9c2e` · 1 withdrawn");
});

test("a finding only the owner can settle heads the block, its second line saying why", () => {
  const wontFix = finding("Retries forever", "escalated", {
    commented: true,
    kept: 2,
    claim: { kind: "wont_fix", text: "Won't fix: it is the retry we want.", by: "sam", at: "", commentId: 9 },
  });
  // A dispute the finder still calls wrong reads so however often it was kept.
  const disputed = finding("Unbounded page", "escalated", {
    commented: true,
    severity: "should_fix",
    kept: 2,
    claim: { kind: "disputed", text: "Not a bug.", by: "sam", at: "", commentId: 10 },
  });
  const unclaimed = finding("No limit", "escalated", { commented: true, severity: "consider", kept: 2 });
  const open = finding("Key in the log", "open", { commented: true });
  const shown = block(item([open, unclaimed, disputed, wontFix]));
  expect(shown?.head).toBe("Needs your look");
  expect(shown?.items.map((i) => [i.finding.id, i.note])).toEqual([
    [findingId("Retries forever"), "Said won't fix twice, kept twice: the owner decides on the thread."],
    [
      findingId("Unbounded page"),
      "Disputed, and the finder still calls it wrong: the owner decides on the thread.",
    ],
    [findingId("No limit"), "Kept twice: the owner decides on the thread."],
    [findingId("Key in the log"), null],
  ]);
});

test("the open findings are listed most urgent first, and none kept off the pull request", () => {
  const consider = finding("Name it", "open", { severity: "consider", commented: true });
  const should = finding("Units", "open", { severity: "should_fix", commented: true });
  const blocking = finding("Key in the log", "open", { commented: true });
  const kept = finding("Page size", "open", { severity: "consider", posted: false });
  expect(block(item([consider, kept, should, blocking]))?.items.map((i) => i.finding.id)).toEqual([
    findingId("Key in the log"),
    findingId("Units"),
    findingId("Name it"),
  ]);
});

test("a finding with no line comment says it is not in the diff, and shows its lines through a permalink", () => {
  const off = finding("Key in the log", "open", {
    body: "The key is logged in full.",
    file: "src/log/request.ts",
    line: 12,
    endLine: 14,
    confirmation: { verdict: "unsure", by: "claude", reason: "", evidence: [], demoted: true },
  });
  const [shown] = block(item([off]))?.items ?? [];
  expect(shown && { ...shown, finding: shown.finding.id }).toEqual({
    finding: findingId("Key in the log"),
    severity: "Blocking, unconfirmed",
    linked: false,
    place: "lines 12 to 14",
    note: "Not in the diff: the key is logged in full.",
    permalink: {
      url: `https://github.com/sam/app/blob/${ROUND_SHA}/src/log/request.ts#L12-L14`,
      sha: ROUND_SHA,
    },
  });
  // On the base side, its lines are on the merge base the last round was taken from, as publish shows them.
  const base = finding("Guard removed", "open", { side: "base", body: "x", file: "src/guard.ts", line: 3 });
  expect(block(item([base]))?.items[0]?.permalink).toEqual({
    url: `https://github.com/sam/app/blob/${BASE_SHA}/src/guard.ts#L3`,
    sha: BASE_SHA,
  });
});

test("while a round runs the block names its commit and its round, with no list", () => {
  const done = item([finding("Key in the log", "open", { commented: true })]);
  const next = { ...done, review: { ...done.review, job: job("running"), run: running(NEXT_SHA) } };
  expect(block(next)).toEqual({ head: "Looking over `2f6d9e3`", line: "Round 2", items: [] });
  // The same commit as the last round: looked over again.
  const again = { ...done, review: { ...done.review, job: job("running"), run: running(ROUND_SHA) } };
  expect(block(again)?.head).toBe("Looking over `a1f9c2e` again");
});

test("a waiting review says why and when it starts, in the machine's time; past round 1 under its round", () => {
  const limit = { reason: "engine-limit", engine: "claude" } as const;
  const first = item([], {}, { rounds: [], loop: null, job: job("deferred", { deferral: limit }) });
  const at = new Date(NOW + 140 * MIN);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const until = { ...AROUND, engines: { ...AROUND.engines, claude: { limitUntil: NOW + 140 * MIN } } };
  expect(block(first, until)).toEqual({
    head: "Waiting to look over `2f6d9e3`",
    line: `Claude reached its usage limit. The review starts when it resets, at ${time}.`,
    items: [],
  });
  expect(block(first)?.line).toBe("Claude reached its usage limit. The review starts when it resets.");
  // A reset on another day names its day.
  const later3 = new Date(NOW + 3 * 24 * 60 * MIN);
  const day = dayText(new Date(Date.UTC(later3.getFullYear(), later3.getMonth(), later3.getDate())));
  const clock3 = `${String(later3.getHours()).padStart(2, "0")}:${String(later3.getMinutes()).padStart(2, "0")}`;
  const nextDays = { ...AROUND, engines: { ...AROUND.engines, claude: { limitUntil: later3.getTime() } } };
  expect(block(first, nextDays)?.line).toBe(
    `Claude reached its usage limit. The review starts when it resets, on ${day} at ${clock3}.`,
  );
  const later = item(
    [finding("Key in the log", "open", { commented: true })],
    {},
    { job: job("deferred", { deferral: { reason: "paused" } }) },
  );
  const shown = block(later);
  expect(shown?.line).toBe("Round 2 · Reviews are paused. The review starts once the owner resumes reviews.");
  // The round posted before stays listed while the next one waits.
  expect(shown?.items.map((i) => i.finding.id)).toEqual([findingId("Key in the log")]);
  const turn = item([], {}, { rounds: [], loop: null, job: job("queued") });
  expect(block(turn)?.line).toBe("The review starts once the reviews before it are done.");
});

test("a failed review says what stopped and how to try again", () => {
  const failure = {
    kind: "review_failed",
    detail: "",
    engine: "claude",
    cause: null,
    limitMs: null,
  } as const;
  const failed = item([], {}, { rounds: [], loop: null, job: job("failed", { failure }) });
  expect(block(failed)).toEqual({
    head: "Couldn't look over `2f6d9e3`",
    line: "Claude stopped before it finished. Push again, or comment `/lookover review`, to try again.",
    items: [],
  });
  const host = { kind: "host_failed", detail: "", engine: null, cause: null, limitMs: null } as const;
  const later = item([], {}, { job: job("failed", { failure: host }) });
  expect(block(later)?.line).toBe(
    "Round 2 · GitHub didn't answer. Push again, or comment `/lookover review`, to try again.",
  );
});

test("a failed review's cause is said as GitHub says it, and to try again only where it helps (ADR 0081)", () => {
  const AGAIN = "Push again, or comment `/lookover review`, to try again.";
  const idle = {
    kind: "prepare_failed",
    detail: "fetch_failed: git took too long (idle)",
    engine: "claude",
    cause: "git_silent",
    limitMs: 120_000,
  } as const;
  const stalled = item([], {}, { rounds: [], loop: null, job: job("failed", { failure: idle }) });
  expect(checkOf(stalled)).toEqual({
    tone: "neutral",
    title: "Failed",
    text: "Git sent nothing for 2 minutes while Lookover got the code ready",
  });
  expect(block(stalled)?.line).toBe(
    `Git sent nothing for 2 minutes while Lookover got the code ready. ${AGAIN}`,
  );
  expect(agentLine(stalled)).toBe(
    "The review failed: git sent nothing for 2 minutes while Lookover got the code ready.",
  );

  const late = {
    ...idle,
    kind: "review_failed",
    detail: "timeout",
    cause: "engine_time_limit",
    limitMs: 1_200_000,
  } as const;
  const timedOut = item([], {}, { rounds: [], loop: null, job: job("failed", { failure: late }) });
  expect(checkOf(timedOut)?.text).toBe("Claude ran past its 20-minute limit");
  expect(block(timedOut)?.line).toBe(
    "Claude ran past its 20-minute limit. A smaller pull request fits in the time.",
  );
  expect(agentLine(timedOut)).toBe("The review failed: Claude ran past its 20-minute limit.");
});

test("no block where Lookover writes none: before any job, on a skipped pull request, after a preview", () => {
  expect(block(item([], {}, { rounds: [], loop: null, job: null }))).toBeNull();
  const skipped = job("skipped", { skip: "draft" });
  expect(block(item([], {}, { rounds: [], loop: null, job: skipped }))).toBeNull();
  expect(block(item([finding("Key in the log", "open")], {}, { preview: true }))).toBeNull();
  const previewing = item(
    [],
    {},
    { rounds: [], loop: null, job: job("running"), run: running(NEXT_SHA, true) },
  );
  expect(block(previewing)).toBeNull();
});

// ---- the reviews on the timeline ----

test("each round that left line comments is one review on the timeline, in time with the pushes", () => {
  const it = item([
    finding("a", "open", { commented: true }),
    finding("b", "open"),
    finding("c", "open", { commented: true, posted: false }),
  ]);
  const pushed = { at: NOW - 5 * MIN, sha: NEXT_SHA, kind: "pushed", by: "agent", commits: 1 } as const;
  const opened = { at: NOW - 60 * MIN, sha: ROUND_SHA, kind: "opened", by: "sam" } as const;
  const shown = timelineOf({ ...it, review: { ...it.review, timeline: [pushed, opened] } }.review);
  expect(
    shown.map((e) =>
      e.kind === "review" ? [e.kind, e.round.n, e.findings.map((f) => f.id)] : [e.kind, e.entry.kind],
    ),
  ).toEqual([
    ["event", "opened"],
    ["review", 1, [findingId("a")]],
    ["event", "pushed"],
  ]);
  // A round with no line comment posts no review.
  expect(timelineOf(item([finding("b", "open")]).review).filter((e) => e.kind === "review")).toEqual([]);
});

// ---- threads ----

test("the reviewer never resolves a thread: the agent's lookover wait resolves the ones verified fixed", () => {
  const thread = threadOf(
    item([finding("key-in-log", "verified_fixed")]).change,
    finding("k", "verified_fixed"),
  );
  expect(thread).toEqual({
    resolved: true,
    hidden: false,
    label: "Resolved",
    note: "Verified fixed in c40a7b9. sam resolved the thread with lookover wait.",
  });
});

test("on a pull request no agent waits on, a verified fixed thread stays open for its author", () => {
  const change = item([], { author: "you", writtenBy: null }).change;
  expect(threadOf(change, finding("k", "verified_fixed"))).toEqual({
    resolved: false,
    hidden: false,
    label: "Verified fixed",
    note: "Verified fixed in c40a7b9. The thread is yours to resolve.",
  });
});

test("on another author's pull request an agent wrote, no lookover wait of the owner's resolves the thread", () => {
  const change = item([], { author: "other", writtenBy: "claude" }).change;
  expect(threadOf(change, finding("k", "verified_fixed"))).toEqual({
    resolved: false,
    hidden: false,
    label: "Verified fixed",
    note: "Verified fixed in c40a7b9. The thread is yours to resolve.",
  });
});

test("an open thread has no label and no note", () => {
  const change = item([]).change;
  expect(threadOf(change, finding("k", "open"))).toEqual({
    resolved: false,
    hidden: false,
    label: null,
    note: null,
  });
});

test("an escalated thread stays open, labelled as the owner's to settle (ADR 0052)", () => {
  const change = item([]).change;
  expect(threadOf(change, finding("k", "escalated", { kept: 2 }))).toEqual({
    resolved: false,
    hidden: false,
    label: "Needs your look",
    note: null,
  });
});

test("a withdrawn or dismissed comment is hidden by Lookover; the agent's lookover wait resolves its thread (ADR 0074)", () => {
  const agent = item([]).change;
  expect(threadOf(agent, finding("k", "withdrawn"))).toEqual({
    resolved: true,
    hidden: true,
    label: "Resolved",
    note: "Withdrawn. sam resolved the thread with lookover wait.",
  });
  expect(threadOf(agent, finding("k", "dismissed"))).toEqual({
    resolved: true,
    hidden: true,
    label: "Resolved",
    note: "Dismissed by the owner. sam resolved the thread with lookover wait.",
  });
  const own = item([], { author: "you", writtenBy: null }).change;
  expect(threadOf(own, finding("k", "withdrawn"))).toEqual({
    resolved: false,
    hidden: true,
    label: "Withdrawn",
    note: "The thread is yours to resolve.",
  });
});

test("Lookover's reply on a thread says what the round decided, as publish words it", () => {
  const claim = (kind: FindingClaim["kind"]): FindingClaim => ({
    kind,
    text: "",
    by: "sam",
    at: "",
    commentId: 9,
  });
  expect(
    replyOf(finding("k", "withdrawn", { claim: claim("disputed"), closedWhy: "The guard is there." })),
  ).toEqual({
    kind: "Withdrawn",
    said: ["The guard is there."],
  });
  expect(replyOf(finding("k", "open", { claim: claim("wont_fix"), kept: 1 }))).toEqual({
    kind: "Kept",
    said: ["If it is kept again, the owner decides."],
  });
  expect(replyOf(finding("k", "escalated", { claim: claim("wont_fix"), kept: 2 }))).toEqual({
    kind: "The owner decides this one",
    said: ['Kept twice against "won\'t fix". Fix it, or resolve this thread to keep the code as it is.'],
  });
  expect(replyOf(finding("k", "escalated", { claim: claim("disputed"), kept: 0 }))).toEqual({
    kind: "The owner decides this one",
    said: [],
  });
  expect(replyOf(finding("k", "escalated", { claim: claim("wont_fix"), kept: 3 }))).toEqual({
    kind: "Kept. The owner decides",
    said: [],
  });
  expect(replyOf(finding("k", "dismissed"))).toEqual({
    kind: "Dismissed by the owner",
    said: ["It won't be raised again on this pull request."],
  });
  // No claim answered, no reply: an open finding, one verified fixed.
  expect(replyOf(finding("k", "open"))).toBeNull();
  expect(replyOf(finding("k", "verified_fixed", { claim: claim("claimed_fixed") }))).toBeNull();
});

test("a thread quotes the lines its place names, each by its number: the range, not the marked line alone (#61)", () => {
  const snippet = { start: 10, lines: ["a", "b", "c", "d", "e"], mark: 11 };
  expect(quotedLines(finding("k", "open", { line: 11, snippet }))).toEqual([{ number: 11, text: "b" }]);
  // "old lines 11 to 13": the three lines of the file before the change, numbered as the header says them.
  const range = finding("k", "open", { side: "base", line: 11, endLine: 13, snippet });
  expect(quotedLines(range)).toEqual([
    { number: 11, text: "b" },
    { number: 12, text: "c" },
    { number: 13, text: "d" },
  ]);
  // A range past the snippet quotes what it holds; no snippet, nothing.
  expect(quotedLines(finding("k", "open", { line: 13, endLine: 20, snippet })).map((l) => l.number)).toEqual([
    13, 14,
  ]);
  expect(quotedLines(finding("k", "open"))).toEqual([]);
});

// ---- the agent's terminal ----

test("an agent waiting on paused reviews is not told the review starts by itself", () => {
  const waiting = item(
    [],
    {},
    {
      rounds: [],
      loop: "open",
      job: {
        id: jobId("job-1"),
        sha: ROUND_SHA,
        trigger: "opened",
        state: "deferred",
        deferral: { reason: "paused" },
        stepIn: null,
        askedBy: null,
        skip: null,
        cancel: null,
        failure: null,
        turn: null,
      },
    },
  );
  expect(agentLine(waiting)).toBe("Waiting: reviews are paused. The review starts when they resume…");
});

test("an agent waiting on a signed-out AI is told the review starts by itself", () => {
  const waiting = item(
    [],
    {},
    {
      rounds: [],
      loop: "open",
      job: {
        id: jobId("job-1"),
        sha: ROUND_SHA,
        trigger: "opened",
        state: "deferred",
        deferral: { reason: "engine-signed-out", engine: "codex" },
        stepIn: null,
        askedBy: null,
        skip: null,
        cancel: null,
        failure: null,
        turn: null,
      },
    },
  );
  expect(agentLine(waiting)).toBe("Waiting: Codex is signed out. The review starts by itself…");
});

test("Lookover posts as the person signed in (ADR 0066, ADR 0073): named by their login, never a bot", () => {
  expect(postedAs({ person: { id: 7, login: "sasensi" } })).toBe("sasensi");
  // Nobody signed in now (signed out since): the posts are still the person's own, whoever they were.
  expect(postedAs({ person: null })).toBe("you");
});
