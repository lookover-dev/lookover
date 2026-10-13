// The round a finished run makes (ADR 0029, ADR 0039): the service builds it here.
import { expect, test } from "bun:test";
import { commitSha, findingId, type Round } from "@lookover/contracts";
import { reconcile, roundOf } from "./index.ts";

const SHA = commitSha("b2c3d4e");

test("a round counts what the round raised, verified fixed and left open on the pull request, with the run's facts", () => {
  const candidate = (meaning: string, severity: "blocking" | "consider", line: number) => ({
    severity,
    category: "Correctness",
    title: meaning,
    body: meaning,
    location: { path: "src/app.ts", side: "head" as const, line, endLine: null },
    lineText: null,
    anchoring: "reported" as const,
    foundBy: "claude" as const,
    defectKey: meaning,
    suggestion: null,
    preExisting: false,
    rule: null,
    fingerprints: { location: `src/app.ts:${line}`, meaning },
  });
  const first = reconcile(
    [],
    {
      sha: commitSha("a1b2c3d"),
      earlier: [],
      candidates: [candidate("a", "blocking", 1), candidate("b", "blocking", 2)],
    },
    { round: 1, settings: { strictness: "recommended" }, rules: [] },
  );
  // Round 2: F1 is gone, F2 still there; a new blocking finding and a new Consider (kept off the pull request).
  const second = reconcile(
    first.findings,
    {
      sha: SHA,
      earlier: [
        { id: findingId("F1"), verdict: "gone", why: "" },
        { id: findingId("F2"), verdict: "present", why: "" },
      ],
      candidates: [candidate("c", "blocking", 3), candidate("d", "consider", 4)],
    },
    { round: 2, settings: { strictness: "everything" }, rules: [] },
  );
  const steps: Round["steps"] = [
    { step: "preparing", ms: 1_000 },
    { step: "finding", ms: 60_000 },
    { step: "publishing", ms: 2_000 },
  ];
  const confirm = {
    secondFind: null,
    confirmer: "claude",
    confirmFallback: { reason: "not-ready", engine: "codex", state: "signed-out" },
    confirmFailure: null,
    ruledOut: [],
  } as const satisfies Partial<Round>;
  const sessions: Round["sessions"] = [
    { pass: "find", engine: "claude", ms: 58_000, usage: { inputTokens: 21_000, outputTokens: 1_600 } },
  ];
  const round = roundOf(
    { n: 2, sha: SHA, reviewer: "claude", ...confirm, startedAt: 1_000, endedAt: 64_000, steps, sessions },
    second,
  );
  expect(round).toEqual({
    n: 2,
    sha: SHA,
    reviewer: "claude",
    secondFind: null,
    confirmer: "claude",
    confirmFallback: { reason: "not-ready", engine: "codex", state: "signed-out" },
    confirmFailure: null,
    ruledOut: [],
    startedAt: 1_000,
    endedAt: 64_000,
    raised: 2,
    verifiedFixed: 1,
    open: 2,
    steps,
    sessions,
  });
});
