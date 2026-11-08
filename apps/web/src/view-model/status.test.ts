// The one display status of a change, derived from its review job, run and loop (ADR 0029). The cases are the
// combinations the demo scenarios reach, plus the job states no scenario reaches yet.
import { expect, test } from "bun:test";
import {
  changeId,
  commitSha,
  type Deferral,
  emptyReview,
  type FailureCause,
  type Finding,
  findingId,
  type JobFailure,
  type JobFailureKind,
  type JobState,
  jobId,
  type LoopState,
  type Review,
  type RunStep,
  runId,
} from "@lookover/contracts";
import {
  cancelSentence,
  type DisplayStatus,
  detailsShown,
  displayStatus,
  failedWords,
  outcomeEyes,
  retryNote,
} from "./status.ts";

const ID = changeId("sam/app#1");
const SHA = commitSha("a1f9c2e");
const ROUND = {
  n: 1,
  sha: SHA,
  base: null,
  reviewer: "codex" as const,
  secondFind: null,
  confirmer: null,
  confirmFallback: null,
  confirmFailure: null,
  ruledOut: [],
  startedAt: 0,
  endedAt: 1,
  raised: 1,
  verifiedFixed: 0,
  open: 1,
  steps: [],
  sessions: [],
};

/** A review whose latest job is `job`, with `rounds` finished rounds, its loop, and a run when it runs. */
function review(
  job: JobState | null,
  {
    loop = null,
    rounds = 0,
    deferral = null,
    step = "finding",
  }: {
    loop?: LoopState | null;
    rounds?: number;
    deferral?: Deferral | null;
    step?: RunStep;
  } = {},
): Review {
  const base = emptyReview(ID, 0);
  return {
    ...base,
    job: job && {
      id: jobId("job-1"),
      sha: SHA,
      trigger: "opened",
      state: job,
      deferral,
      stepIn: null,
      askedBy: null,
      skip: job === "skipped" ? "not-yours" : null,
      cancel: job === "cancelled" ? "closed" : null,
      failure:
        job === "failed"
          ? { kind: "service_stopped", detail: "", engine: null, cause: null, limitMs: null }
          : null,
      turn: null,
    },
    run:
      job === "running"
        ? {
            id: runId("run-1"),
            reviewer: "codex",
            secondFinder: null,
            confirmer: null,
            confirmFallback: null,
            sha: SHA,
            preview: false,
            startedAt: 0,
            step,
            stepAt: 0,
            activities: [],
            posting: null,
            steps: [],
          }
        : null,
    loop,
    rounds: Array.from({ length: rounds }, (_, i) => ({ ...ROUND, n: i + 1 })),
  };
}

const FIXED: Finding = {
  id: findingId("f"),
  fingerprints: { location: "src/app.ts:1", meaning: "f" },
  severity: "blocking",
  category: "Correctness",
  title: "f",
  file: "src/app.ts",
  side: "head",
  line: 1,
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
  status: "verified_fixed",
  posted: true,
  commented: false,
  raisedIn: 1,
  anchoredIn: 1,
  closedIn: 2,
  verifiedSha: SHA,
  closedWhy: null,
  claim: null,
  kept: 0,
};

const SIGNED_OUT: Deferral = { reason: "engine-signed-out", engine: "claude" };

test("a change shows one status from its job, run and loop", () => {
  const cases: [string, Review, DisplayStatus][] = [
    ["opened before setup, never asked", review(null), { kind: "not-asked" }],
    ["skipped", review("skipped"), { kind: "skipped", reason: "not-yours" }],
    ["queued behind a busy AI", review("queued"), { kind: "waiting", deferral: null, turn: null }],
    [
      "deferred: paused",
      review("deferred", { deferral: { reason: "paused" } }),
      { kind: "waiting", deferral: { reason: "paused" }, turn: null },
    ],
    [
      "deferred: the AI is signed out",
      review("deferred", { deferral: SIGNED_OUT }),
      { kind: "waiting", deferral: SIGNED_OUT, turn: null },
    ],
    [
      "deferred after rounds with findings open: waiting wins",
      review("deferred", { deferral: SIGNED_OUT, loop: "open", rounds: 1 }),
      { kind: "waiting", deferral: SIGNED_OUT, turn: null },
    ],
    [
      "round 1 running",
      review("running", { step: "preparing" }),
      { kind: "running", round: 1, step: "preparing" },
    ],
    [
      "round 2 running while findings are open",
      review("running", { loop: "open", rounds: 1 }),
      { kind: "running", round: 2, step: "finding" },
    ],
    ["done, findings open", review("done", { loop: "open", rounds: 1 }), { kind: "to-fix" }],
    ["done, a finding escalated", review("done", { loop: "needs_owner", rounds: 4 }), { kind: "needs-you" }],
    ["done, nothing found", review("done", { loop: "settled", rounds: 1 }), { kind: "settled", clean: true }],
    [
      "done, every finding settled",
      { ...review("done", { loop: "settled", rounds: 2 }), findings: [FIXED] },
      { kind: "settled", clean: false },
    ],
    ["cancelled before any round, and why", review("cancelled"), { kind: "cancelled", reason: "closed" }],
    [
      "cancelled after a round: the loop says",
      review("cancelled", { loop: "open", rounds: 1 }),
      { kind: "to-fix" },
    ],
    [
      "failed before any round: why, as the service said",
      review("failed"),
      {
        kind: "failed",
        failure: { kind: "service_stopped", detail: "", engine: null, cause: null, limitMs: null },
      },
    ],
    // The pill keeps following the loop (ADR 0029); the review screen says the failure above the round.
    [
      "failed after a round: the loop says",
      review("failed", { loop: "open", rounds: 1 }),
      { kind: "to-fix" },
    ],
  ];
  for (const [name, r, status] of cases) expect([name, displayStatus(r)]).toEqual([name, status]);
});

test("a failed review says its cause, and what would change it where another try can't help (ADR 0081)", () => {
  const failure = (
    kind: JobFailure["kind"],
    cause: FailureCause | null,
    more: Partial<JobFailure> = {},
  ): JobFailure => ({ kind, detail: "", engine: null, cause, limitMs: null, ...more });

  // A stall, worth another try: the cause alone, the page's one primary button saying "Try again".
  expect(failedWords(failure("prepare_failed", "git_silent", { limitMs: 120_000 }))).toEqual({
    sentence: "Git sent nothing for 2 minutes while Lookover got the code ready.",
    next: null,
  });
  expect(failedWords(failure("review_failed", "engine_answer", { engine: "codex" }))).toEqual({
    sentence: "Codex gave no usable review.",
    next: null,
  });
  // A time limit fails the same way again: what would change it.
  expect(failedWords(failure("prepare_failed", "git_time_limit", { limitMs: 600_000 }))).toEqual({
    sentence: "Getting the code ready ran past its 10-minute limit.",
    next: "The repository or the change is too large to get ready in that time.",
  });
  expect(
    failedWords(failure("review_failed", "engine_time_limit", { engine: "claude", limitMs: 1_200_000 })),
  ).toEqual({
    sentence: "Claude ran past its 20-minute limit.",
    next: "A smaller pull request fits in the time.",
  });
  // No cause known: the status block's sentence by the kind, and another try.
  expect(failedWords(failure("service_stopped", null))).toEqual({
    sentence: "Lookover stopped before it finished.",
    next: null,
  });
  // A job that failed before the service said why (an older record).
  expect(failedWords(null)).toEqual({ sentence: "Something went wrong in Lookover.", next: null });
});

test("why a review was cancelled is said as its check says it", () => {
  expect(cancelSentence("closed")).toBe("The pull request was closed.");
  expect(cancelSentence("replaced")).toBe("A newer review took its place.");
  expect(cancelSentence(null)).toBe("");
});

test("a preview with findings open is the owner's to read; its other states read as before (ADR 0072)", () => {
  const preview = (r: Review): Review => ({ ...r, preview: true });
  const cases: [string, Review, DisplayStatus][] = [
    ["a preview, findings open", preview(review("done", { loop: "open", rounds: 1 })), { kind: "preview" }],
    [
      "a preview, a finding escalated",
      preview(review("done", { loop: "needs_owner", rounds: 1 })),
      { kind: "needs-you" },
    ],
    [
      "a preview, nothing found",
      preview(review("done", { loop: "settled", rounds: 1 })),
      { kind: "settled", clean: true },
    ],
    [
      "a preview running",
      preview(review("running", { step: "preparing" })),
      { kind: "running", round: 1, step: "preparing" },
    ],
  ];
  for (const [name, r, status] of cases) expect([name, displayStatus(r)]).toEqual([name, status]);
});

test("a review's Details show once a round ran or runs, and before any only when the review failed", () => {
  const logged = (r: Review): Review => ({
    ...r,
    timeline: [{ at: 0, sha: SHA, kind: "queued", trigger: "opened", by: null }],
  });
  const cases: [string, Review, boolean][] = [
    ["failed before any round, its log kept", logged(review("failed")), true],
    ["failed before any round, nothing logged", review("failed"), false],
    ["skipped", logged(review("skipped")), false],
    ["waiting", logged(review("queued")), false],
    ["deferred", logged(review("deferred", { deferral: SIGNED_OUT })), false],
    ["cancelled before any round", logged(review("cancelled")), false],
    ["running its first round", logged(review("running")), true],
    ["settled after a round", logged(review("done", { loop: "settled", rounds: 1 })), true],
    ["cancelled after a round", logged(review("cancelled", { loop: "open", rounds: 1 })), true],
  ];
  for (const [name, r, shown] of cases) expect([name, detailsShown(r)]).toEqual([name, shown]);
});

test("every outcome's card opens with the eyes, in its tone: looked over, open, cancelled alike", () => {
  const cases: [DisplayStatus, ReturnType<typeof outcomeEyes>][] = [
    [{ kind: "settled", clean: true }, "ok"],
    [{ kind: "settled", clean: false }, "ok"],
    [{ kind: "to-fix" }, "fix"],
    [{ kind: "preview" }, "fix"],
    // Ended without an outcome of its own: the eyes still, quiet.
    [{ kind: "cancelled", reason: null }, "quiet"],
    [{ kind: "skipped", reason: "not-yours" }, "quiet"],
    [{ kind: "not-asked" }, "quiet"],
    // Not an outcome: the running round and a wait have blocks of their own.
    [{ kind: "running", round: 1, step: "preparing" }, null],
    [{ kind: "waiting", deferral: null, turn: null }, null],
    // Where the person is needed, the escalated banner and the failed notice carry their own eyes: no verdict card.
    [{ kind: "needs-you" }, null],
    [{ kind: "failed", failure: null }, null],
  ];
  for (const [s, tone] of cases) expect([s.kind, outcomeEyes(s)]).toEqual([s.kind, tone]);
});

test("a failed review says how likely another try works only for a cause it is known for, else nothing", () => {
  const failure = (kind: JobFailureKind, cause: FailureCause | null) => ({
    kind,
    detail: "",
    engine: "codex" as const,
    cause,
    limitMs: null,
  });
  const cases: [string, ReturnType<typeof failure> | null, string | null][] = [
    // A stall, GitHub out of reach, an answer that couldn't be read: another try is known to help.
    ["git silent", failure("prepare_failed", "git_silent"), "Another try usually gets through."],
    ["network", failure("host_failed", "network"), "Another try usually gets through."],
    [
      "engine answer",
      failure("review_failed", "engine_answer"),
      "It stopped, or sent an answer Lookover couldn't read. Another try usually works.",
    ],
    // With no cause known, nothing promised: "Try again" above is the way, the log says the rest.
    ["no failure said", null, null],
    ["unexpected", failure("unexpected", null), null],
    ["publish failed", failure("publish_failed", null), null],
    ["service stopped", failure("service_stopped", null), null],
    ["host failed, rate-limited", failure("host_failed", null), null],
    ["review failed, cancelled or signed out", failure("review_failed", null), null],
    ["prepare failed", failure("prepare_failed", null), null],
    // A cause another try can't cure has its remedy instead (`failedWords`), never a try's odds.
    ["git time limit", failure("prepare_failed", "git_time_limit"), null],
    ["engine time limit", failure("review_failed", "engine_time_limit"), null],
    ["base not found", failure("prepare_failed", "base_not_found"), null],
    ["path too long", failure("prepare_failed", "path_too_long"), null],
    ["git missing", failure("prepare_failed", "git_missing"), null],
  ];
  for (const [name, f, note] of cases) expect([name, retryNote(f)]).toEqual([name, note]);
});
