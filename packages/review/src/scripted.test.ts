// The review on the scripted engines (ADR 0046): a find pass and a confirm pass, their prompts built by this
// module, reach the answers scripted for the commit's worktree (the scripted retrieval's path) and each pass,
// and what comes back is read as the real engines' answers are. The expected values are written by hand from
// the script; the fingerprints are left to `review.test.ts`.
import { expect, test } from "bun:test";
import { commitSha, findingId, jobId, type Prepared, type ReviewJob } from "@lookover/contracts";
import { DemoClock, ScriptedEngines, ScriptedRetrieval } from "@lookover/testkit";
import { createConfirm, createReview } from "./index.ts";

const SHA = commitSha("3c1d9a0");

const job: ReviewJob = {
  id: jobId("job-1"),
  sha: SHA,
  trigger: "manual",
  state: "running",
  deferral: null,
  stepIn: null,
  skip: null,
  cancel: null,
  failure: null,
  turn: null,
};

const retrieval = new ScriptedRetrieval({ root: "worktrees" });

const prepared: Prepared = {
  cwd: retrieval.worktreeOf(1, SHA),
  diff: [
    "diff --git a/src/total.ts b/src/total.ts",
    "--- a/src/total.ts",
    "+++ b/src/total.ts",
    "@@ -1,3 +1,3 @@",
    " export function total(items: number[]) {",
    "-  return items.reduce((a, b) => a + b, 0);",
    "+  return items.reduce((a, b) => a + b);",
    " }",
    "",
  ].join("\n"),
};

const signal = () => new AbortController().signal;

function scripted() {
  const engines = new ScriptedEngines({ timers: new DemoClock({ at: 0 }) });
  engines.setHealth("claude", { installed: true, version: "2.1.290", signedIn: true });
  engines.scriptFind(prepared.cwd, {
    notes: "I read the diff. One real problem.",
    findings: [
      {
        path: "src/total.ts",
        line: 2,
        lineText: "  return items.reduce((a, b) => a + b);",
        severity: "blocking",
        category: "correctness",
        title: "total() throws on an empty list",
        body: "When `items` is empty, `reduce` without an initial value throws, because there is no first element.",
        defectKey: "reduce_without_initial_value",
        suggestion: "return items.reduce((a, b) => a + b, 0);",
      },
    ],
    usage: { inputTokens: 1200, outputTokens: 300 },
  });
  engines.scriptConfirm(prepared.cwd, {
    notes: "C1 is real.",
    verdicts: [
      {
        id: "C1",
        verdict: "confirmed",
        reason: "reduce without a seed throws on an empty array.",
        evidence: ["src/total.ts:2"],
        severity: "blocking",
      },
    ],
  });
  return engines;
}

test("a scripted find pass comes back through review as the scripted findings, anchored by their line text", async () => {
  const engines = scripted();
  const result = await createReview({ engines }).run(
    job,
    prepared,
    {
      engine: "claude",
      round: 1,
      earlier: [],
      timeoutMs: 60_000,
      pass: "find",
      artefactsDir: "/tmp/runs/run-1",
      rules: [],
    },
    signal(),
  );
  expect(result.kind).toBe("reviewed");
  if (result.kind !== "reviewed") return;
  expect(result.round).toMatchObject({
    sha: SHA,
    engine: "claude",
    notes: "I read the diff. One real problem.",
    earlier: [],
    emptyReason: null,
    problems: [],
    sessions: [{ pass: "find", engine: "claude", ms: 0, usage: { inputTokens: 1200, outputTokens: 300 } }],
  });
  expect(result.round.candidates).toHaveLength(1);
  expect(result.round.candidates[0]).toMatchObject({
    severity: "blocking",
    category: "correctness",
    title: "total() throws on an empty list",
    body: "When `items` is empty, `reduce` without an initial value throws, because there is no first element.",
    location: { path: "src/total.ts", side: "head", line: 2, endLine: null },
    lineText: "  return items.reduce((a, b) => a + b);",
    anchoring: "reported",
    foundBy: "claude",
    defectKey: "reduce_without_initial_value",
    suggestion: "return items.reduce((a, b) => a + b, 0);",
    preExisting: false,
    rule: null,
  });
});

test("a round-2 answer's verdicts on the earlier findings come back as review reads them, nothing set aside", async () => {
  const engines = scripted();
  engines.scriptFind(prepared.cwd, {
    notes: "The empty-list bug is fixed; nothing new.",
    findings: [],
    earlier: [{ id: "F1", present: false, why: "reduce now has its initial value." }],
    emptyReason: "The change fixes the one problem and adds nothing else.",
  });
  const result = await createReview({ engines }).run(
    job,
    prepared,
    {
      engine: "claude",
      round: 2,
      earlier: [
        {
          id: findingId("F1"),
          severity: "blocking",
          category: "correctness",
          title: "total() throws on an empty list",
          body: "When `items` is empty, `reduce` without an initial value throws.",
          file: "src/total.ts",
          side: "head",
          line: 2,
          endLine: null,
          claim: null,
        },
      ],
      timeoutMs: 60_000,
      pass: "find",
      artefactsDir: "/tmp/runs/run-3",
      rules: [],
    },
    signal(),
  );
  expect(result).toEqual({
    kind: "reviewed",
    round: {
      sha: SHA,
      engine: "claude",
      notes: "The empty-list bug is fixed; nothing new.",
      candidates: [],
      earlier: [{ id: findingId("F1"), verdict: "gone", why: "reduce now has its initial value." }],
      emptyReason: "The change fixes the one problem and adds nothing else.",
      problems: [],
      sessions: [{ pass: "find", engine: "claude", ms: 0, usage: null }],
    },
  });
});

test("a scripted answer can say a disputed finding was wrong, and review reads it as the verdict wrong", async () => {
  const engines = scripted();
  engines.scriptFind(prepared.cwd, {
    findings: [],
    earlier: [{ id: "F1", present: true, wrong: true, why: "The caller never passes an empty list." }],
  });
  const result = await createReview({ engines }).run(
    job,
    prepared,
    {
      engine: "claude",
      round: 2,
      earlier: [
        {
          id: findingId("F1"),
          severity: "should_fix",
          category: "correctness",
          title: "total() throws on an empty list",
          body: "When `items` is empty, `reduce` without an initial value throws.",
          file: "src/total.ts",
          side: "head",
          line: 2,
          endLine: null,
          claim: {
            kind: "disputed",
            text: "Not a bug: checkout never calls total() with an empty cart.",
            by: "dana",
            at: "2026-10-09T08:00:00Z",
            commentId: 7001,
          },
        },
      ],
      timeoutMs: 60_000,
      pass: "find",
      artefactsDir: "/tmp/runs/run-4",
      rules: [],
    },
    signal(),
  );
  expect(result).toMatchObject({
    kind: "reviewed",
    round: {
      problems: [],
      earlier: [{ id: findingId("F1"), verdict: "wrong", why: "The caller never passes an empty list." }],
    },
  });
});

test("the confirm pass on those candidates reaches the confirm script of the same worktree", async () => {
  const engines = scripted();
  const found = await createReview({ engines }).run(
    job,
    prepared,
    {
      engine: "claude",
      round: 1,
      earlier: [],
      timeoutMs: 60_000,
      pass: "find",
      artefactsDir: "/tmp/runs/run-1",
      rules: [],
    },
    signal(),
  );
  if (found.kind !== "reviewed") throw new Error(`the find pass failed: ${found.reason}`);
  const confirmed = await createConfirm({ engines }).run(
    job,
    prepared,
    found.round.candidates,
    { engine: "claude", round: 1, timeoutMs: 60_000, artefactsDir: "/tmp/runs/run-1/confirm", rules: [] },
    signal(),
  );
  expect(confirmed.failure).toBeNull();
  expect(confirmed.notes).toBe("C1 is real.");
  expect(confirmed.judged.map((j) => j.verdict)).toEqual([
    {
      verdict: "confirmed",
      by: "claude",
      reason: "reduce without a seed throws on an empty array.",
      evidence: ["src/total.ts:2"],
      severity: "blocking",
    },
  ]);
  // Two runs, one per pass, both in the commit's worktree.
  expect(engines.runs.map((r) => r.cwd)).toEqual([prepared.cwd, prepared.cwd]);
});

test("a commit the script doesn't know fails the find pass with the fake's own words, never a default round", async () => {
  const engines = scripted();
  const other = { ...prepared, cwd: retrieval.worktreeOf(1, commitSha("9f0e1d2")) };
  const result = await createReview({ engines }).run(
    { ...job, sha: commitSha("9f0e1d2") },
    other,
    {
      engine: "claude",
      round: 1,
      earlier: [],
      timeoutMs: 60_000,
      pass: "find",
      artefactsDir: "/tmp/runs/run-2",
      rules: [],
    },
    signal(),
  );
  expect(result).toEqual({
    kind: "failed",
    reason: "crashed",
    problems: [],
    text: `Nothing scripted for the find pass in ${other.cwd}`,
    session: { pass: "find", engine: "claude", ms: 0, usage: null },
  });
});

test("a round's session says how long the scripted pass took on the clock, and a timed-out one its limit", async () => {
  const clock = new DemoClock({ at: 0 });
  const engines = new ScriptedEngines({ timers: clock });
  engines.setHealth("claude", { installed: true, version: "2.1.290", signedIn: true });
  const usage = { inputTokens: 1200, outputTokens: 300 };
  engines.scriptFind(prepared.cwd, { notes: "Nothing to fix.", findings: [], usage, tookMs: 90_000 });
  const policy = (timeoutMs: number) => ({
    engine: "claude" as const,
    round: 1,
    earlier: [],
    timeoutMs,
    pass: "find" as const,
    artefactsDir: "/tmp/runs/run-5",
    rules: [],
  });
  const review = createReview({ engines });

  const done = review.run(job, prepared, policy(600_000), signal());
  await clock.advance(90_000);
  const reviewed = await done;
  expect(reviewed.kind === "reviewed" && reviewed.round.sessions).toEqual([
    { pass: "find", engine: "claude", ms: 90_000, usage },
  ]);

  const late = review.run(job, prepared, policy(60_000), signal());
  await clock.advance(60_000);
  const timedOut = await late;
  expect(timedOut.kind === "failed" && timedOut.session).toEqual({
    pass: "find",
    engine: "claude",
    ms: 60_000,
    usage: null,
  });
});
