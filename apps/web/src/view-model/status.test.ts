// The one display status of a change, derived from its review job, run and loop (ADR 0029). The cases are the
// combinations the demo scenarios reach, plus the job states no scenario reaches yet.
import { expect, test } from "bun:test";
import {
  changeId,
  commitSha,
  type Deferral,
  emptyReview,
  type Finding,
  findingId,
  type JobState,
  jobId,
  type LoopState,
  type Review,
  type RunStep,
  runId,
} from "@lookover/contracts";
import { cancelSentence, type DisplayStatus, displayStatus, failureSentence, failureText } from "./status.ts";

const ID = changeId("sam/app#1");
const SHA = commitSha("a1f9c2e");
const ROUND = {
  n: 1,
  sha: SHA,
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
      skip: job === "skipped" ? "not-yours" : null,
      cancel: job === "cancelled" ? "closed" : null,
      failure: job === "failed" ? { kind: "service_stopped", detail: "", engine: null } : null,
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
      { kind: "failed", failure: { kind: "service_stopped", detail: "", engine: null } },
    ],
  ];
  for (const [name, r, status] of cases) expect([name, displayStatus(r)]).toEqual([name, status]);
});

test("why a review did not run is said once, as a phrase and as a sentence", () => {
  expect(failureSentence({ kind: "service_stopped", detail: "", engine: null })).toBe(
    "The service stopped before the review finished.",
  );
  expect(failureText({ kind: "service_stopped", engine: null })).toBe(
    "the service stopped before the review finished",
  );
  expect(failureSentence({ kind: "prepare_failed", detail: "fetch_failed", engine: null })).toBe(
    "The code could not be fetched.",
  );
  // The engine that gave no review is named, as the check on GitHub names it.
  expect(failureSentence({ kind: "review_failed", detail: "crashed", engine: "codex" })).toBe(
    "Codex gave no review.",
  );
  expect(failureSentence({ kind: "review_failed", detail: "crashed", engine: "claude" })).toBe(
    "Claude gave no review.",
  );
  expect(failureSentence({ kind: "publish_failed", detail: "too_large", engine: null })).toBe(
    "GitHub refused the review.",
  );
  expect(failureSentence({ kind: "host_failed", detail: "unavailable", engine: null })).toBe(
    "GitHub did not answer.",
  );
  expect(failureSentence({ kind: "unexpected", detail: "", engine: null })).toBe("The review could not run.");
  // A job that failed before the service said why (an older record).
  expect(failureSentence(null)).toBe("The review could not run.");
});

test("why a review was cancelled is said as its check says it", () => {
  expect(cancelSentence("closed")).toBe("The pull request was closed.");
  expect(cancelSentence("replaced")).toBe("A newer review took its place.");
  expect(cancelSentence(null)).toBe("");
});
