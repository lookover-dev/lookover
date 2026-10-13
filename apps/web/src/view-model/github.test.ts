// What the simulated GitHub page says: the check, the summary comment, each thread, the agent's terminal.
// It must tell the same story GitHub would (ADR 0021, ADR 0029), so the demo never shows what cannot happen.
import { expect, test } from "bun:test";
import {
  type Change,
  changeId,
  commitSha,
  emptyReview,
  type Finding,
  type FindingStatus,
  findingId,
  jobId,
  type Repository,
  type ResolvedSettings,
  type Review,
  type Round,
  repositoryId,
  runId,
} from "@lookover/contracts";
import { agentLine, checkOf, quotedLines, summaryComment, summaryFooter, threadOf } from "./github.ts";
import type { ChangeReview } from "./select.ts";

const NOW = Date.UTC(2026, 9, 3, 10, 0, 0);
const MIN = 60_000;
// A whole commit SHA, as GitHub gives it: what the pull request shows is its first seven characters.
const ROUND_SHA = commitSha("a1f9c2e0b4d6f8a1c3e5b7d9f1a3c5e7b9d1f3a5");

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
  const id = changeId("app#7");
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

// ---- the summary comment ----

test("the summary comment points at the first thing to fix", () => {
  expect(summaryComment(item([finding("key-in-log", "open")]))).toBe(
    "Looked over a1f9c2e. Found by Codex, double-checked by Claude. One thing to fix, starting with rateLimit.ts line 42. The rest can go.",
  );
});

test("the summary comment starts with what matters most, as publish lists it: blocking before should fix", () => {
  const minor = finding("units", "open", { severity: "should_fix", file: "src/invoices.ts", line: 10 });
  const major = finding("eval", "open", { severity: "blocking", file: "src/rules.ts", line: 17 });
  expect(summaryComment(item([minor, major]))).toContain("starting with rules.ts line 17.");
});

test("the summary comment's footer counts the findings verified fixed only once there is one", () => {
  expect(summaryFooter(item([finding("key-in-log", "open")]).review)).toBe(
    "Round 1 · one comment, updated after every round",
  );
  expect(summaryFooter(item([finding("key-in-log", "verified_fixed")]).review)).toBe(
    "Round 1 · verified fixed so far: 1 · one comment, updated after every round",
  );
});

test("a review with no round has no summary comment yet: nothing to say", () => {
  const it = item([]);
  expect(summaryComment({ ...it, review: { ...it.review, rounds: [] } })).toBe("");
});

test("the summary comment names an old line or a range as the pull request does", () => {
  const old = finding("removed-guard", "open", { side: "base", line: 12, endLine: 13 });
  expect(summaryComment(item([old]))).toBe(
    "Looked over a1f9c2e. Found by Codex, double-checked by Claude. One thing to fix, starting with rateLimit.ts old lines 12 to 13. The rest can go.",
  );
});

test("the summary comment says how many findings stay in the app, and then never that the rest can go (ADR 0042)", () => {
  const kept = finding("page-size", "open", { severity: "consider", posted: false, raisedIn: 2 });
  expect(summaryComment(item([finding("key-in-log", "open"), kept]))).toBe(
    "Looked over a1f9c2e. Found by Codex, double-checked by Claude. One thing to fix, starting with rateLimit.ts line 42. One finding stays in Lookover, not on the pull request.",
  );
  const two = [kept, { ...kept, id: findingId("names"), fingerprints: { location: "x", meaning: "names" } }];
  expect(summaryComment(item([finding("key-in-log", "verified_fixed"), ...two]))).toBe(
    "Looked over a1f9c2e. Found by Codex, double-checked by Claude. Nothing to fix. 2 findings stay in Lookover, not on the pull request.",
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

test("a dispute in the summary comment still says how many findings stay in the app", () => {
  const kept = finding("page-size", "open", { severity: "consider", posted: false, raisedIn: 2 });
  expect(summaryComment(item([finding("key-in-log", "escalated"), kept]))).toBe(
    "Looked over a1f9c2e. Found by Codex, double-checked by Claude. The author and the reviewer disagree on rateLimit.ts line 42: only the owner can settle it. One finding stays in Lookover, not on the pull request.",
  );
});

test("a finding only the owner can settle is not one more thing to fix in the summary comment", () => {
  expect(summaryComment(item([finding("key-in-log", "escalated")]))).toBe(
    "Looked over a1f9c2e. Found by Codex, double-checked by Claude. The author and the reviewer disagree on rateLimit.ts line 42: only the owner can settle it.",
  );
});

test("the summary comment names who found the last round and who double-checked it, as on the pull request (ADR 0055)", () => {
  // Every case is contracts' `foundAndCheckedText`; here, the sentence it makes in the comment.
  const said = (round: Partial<Round>, findings = [finding("key-in-log", "open")]) => {
    const it = item(findings);
    const [first] = it.review.rounds;
    if (!first) throw new Error("one round");
    return summaryComment({ ...it, review: { ...it.review, rounds: [{ ...first, ...round }] } });
  };
  expect(said({ secondFind: { engine: "codex", failure: null }, confirmer: "codex" })).toBe(
    "Looked over a1f9c2e. Found by Codex in two sessions, double-checked by Codex in a new session. One thing to fix, starting with rateLimit.ts line 42. The rest can go.",
  );
  expect(said({ confirmer: null })).toBe(
    "Looked over a1f9c2e. Found by Codex, not double-checked. One thing to fix, starting with rateLimit.ts line 42. The rest can go.",
  );
  expect(said({ confirmer: null, raised: 0 }, [])).toBe(
    "Looked over a1f9c2e. Found by Codex, nothing new to double-check. Nothing to fix. The rest can go.",
  );
});

// ---- threads ----

test("the reviewer never resolves a thread: the agent's lookover wait resolves the ones verified fixed", () => {
  const thread = threadOf(
    item([finding("key-in-log", "verified_fixed")]).change,
    finding("k", "verified_fixed"),
  );
  expect(thread).toEqual({
    resolved: true,
    label: "Resolved",
    note: "Verified fixed in c40a7b9. sam resolved the thread with lookover wait.",
  });
});

test("on a pull request no agent waits on, a verified fixed thread stays open for its author", () => {
  const change = item([], { author: "you", writtenBy: null }).change;
  expect(threadOf(change, finding("k", "verified_fixed"))).toEqual({
    resolved: false,
    label: "Verified fixed",
    note: "Verified fixed in c40a7b9. The thread is yours to resolve.",
  });
});

test("on another author's pull request an agent wrote, no lookover wait of the owner's resolves the thread", () => {
  const change = item([], { author: "other", writtenBy: "claude" }).change;
  expect(threadOf(change, finding("k", "verified_fixed"))).toEqual({
    resolved: false,
    label: "Verified fixed",
    note: "Verified fixed in c40a7b9. The thread is yours to resolve.",
  });
});

test("an open thread has no label and no note", () => {
  const change = item([]).change;
  expect(threadOf(change, finding("k", "open"))).toEqual({ resolved: false, label: null, note: null });
});

test("an escalated thread stays open, labelled as the owner's to settle (ADR 0052)", () => {
  const change = item([]).change;
  expect(threadOf(change, finding("k", "escalated", { kept: 2 }))).toEqual({
    resolved: false,
    label: "Needs the owner",
    note: null,
  });
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
        skip: null,
        cancel: null,
        failure: null,
        turn: null,
      },
    },
  );
  expect(agentLine(waiting)).toBe("Waiting: Codex is signed out. The review starts by itself…");
});
