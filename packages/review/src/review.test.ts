// The review through its entry (ADR 0033): what one find pass makes of the engine's answer. The engine is
// `FakeEngines`, scripted per test; the expected values are written by hand from the scripted answer. The
// expected fingerprints were computed with Python's own FNV-1a loop over the same text, not with the code.
import { expect, test } from "bun:test";
import {
  commitSha,
  findingId,
  jobId,
  type Prepared,
  type PromptRulesFile,
  type ReviewJob,
} from "@lookover/contracts";
import { FakeEngines } from "@lookover/testkit";
import { createReview, type EarlierFinding, type ReviewPolicy } from "./index.ts";

const job: ReviewJob = {
  id: jobId("job-1"),
  sha: commitSha("3c1d9a0"),
  trigger: "manual",
  state: "running",
  deferral: null,
  stepIn: null,
  skip: null,
  cancel: null,
  failure: null,
  turn: null,
};

const prepared: Prepared = {
  cwd: "/tmp/lookover/worktrees/job-1",
  diff: [
    "diff --git a/src/total.ts b/src/total.ts",
    "--- a/src/total.ts",
    "+++ b/src/total.ts",
    "@@ -1,3 +1,3 @@",
    " export function total(items: number[]) {",
    "-  return items.reduce((a, b) => a + b, 0);",
    "+  return items.reduce((a, b) => a + b);",
    " }",
    // git ends a diff with a newline: one without reads as cut short.
    "",
  ].join("\n"),
};

const policy: ReviewPolicy = {
  engine: "claude",
  round: 1,
  earlier: [],
  timeoutMs: 60_000,
  pass: "find",
  artefactsDir: "/tmp/lookover/runs/run-1",
  rules: [],
};

const signal = () => new AbortController().signal;

/** Free notes, then the one JSON block the prompt asks for. */
function answer(notes: string, block: string): string {
  return `${notes}\n\n\`\`\`json\n${block}\n\`\`\`\n`;
}

const GOOD = {
  path: "src/total.ts",
  side: "head",
  line: 2,
  end_line: 2,
  severity: "blocking",
  category: "correctness",
  title: "total() throws on an empty list",
  body: "When `items` is empty, `reduce` without an initial value throws, because there is no first element.",
  defect_key: "reduce_without_initial_value",
  suggestion: "return items.reduce((a, b) => a + b, 0);",
  pre_existing: false,
};

const ONE_FINDING = JSON.stringify({ findings: [GOOD], earlier: [] });

test("a good answer becomes a round with its candidate findings, each with both fingerprints", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: answer("I read the diff. One real problem.", ONE_FINDING) });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toEqual({
    kind: "reviewed",
    round: {
      sha: commitSha("3c1d9a0"),
      engine: "claude",
      notes: "I read the diff. One real problem.",
      earlier: [],
      emptyReason: null,
      problems: [],
      sessions: [{ pass: "find", engine: "claude", ms: 0, usage: null }],
      candidates: [
        {
          severity: "blocking",
          category: "correctness",
          title: "total() throws on an empty list",
          body: "When `items` is empty, `reduce` without an initial value throws, because there is no first element.",
          location: { path: "src/total.ts", side: "head", line: 2, endLine: null },
          lineText: null,
          anchoring: "reported",
          foundBy: "claude",
          defectKey: "reduce_without_initial_value",
          suggestion: "return items.reduce((a, b) => a + b, 0);",
          preExisting: false,
          rule: null,
          // FNV-1a 64 of "correctness|src/total.ts|head|2" and "correctness|src/total.ts|reduce_without_initial_value".
          fingerprints: { location: "04179658a032be7c", meaning: "dbf20875ebb84180" },
        },
      ],
    },
  });
});

/** One pass on `found`, the first candidate it gives. */
async function firstCandidate(found: Record<string, unknown>) {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: answer("", JSON.stringify({ findings: [found] })) });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  if (result.kind !== "reviewed") throw new Error(`not reviewed: ${result.reason}`);
  return result.round.candidates[0];
}

test("a finding one line off moves to the line whose text it quotes, its end line shifted as much (I-158)", async () => {
  const c = await firstCandidate({
    ...GOOD,
    line: 1,
    end_line: 2,
    line_text: "return items.reduce((a, b) => a + b);",
  });
  expect([c?.location, c?.lineText, c?.anchoring]).toEqual([
    { path: "src/total.ts", side: "head", line: 2, endLine: 3 },
    "return items.reduce((a, b) => a + b);",
    "moved",
  ]);
});

test("a finding whose text matches no line of the diff stays where it was reported, unmatched: the summary's", async () => {
  const c = await firstCandidate({ ...GOOD, line_text: "return items.length;" });
  expect([c?.location, c?.lineText, c?.anchoring]).toEqual([
    { path: "src/total.ts", side: "head", line: 2, endLine: null },
    "return items.length;",
    "unmatched",
  ]);
});

test("an answer without line_text still reads: the line as reported, no text to check", async () => {
  const c = await firstCandidate({ ...GOOD, line: 3, end_line: null });
  expect([c?.location.line, c?.lineText, c?.anchoring]).toEqual([3, null, "reported"]);
});

test("in a diff cut short, a text not found may lie past the cut: the reported line stands", async () => {
  const engines = new FakeEngines();
  const found = { ...GOOD, line: 9, end_line: null, line_text: "return items.length;" };
  engines.answer({ outcome: "ok", text: answer("", JSON.stringify({ findings: [found] })) });
  const cut = { ...prepared, diff: prepared.diff.slice(0, -4) };
  const result = await createReview({ engines }).run(job, cut, policy, signal());
  const c = result.kind === "reviewed" ? result.round.candidates[0] : undefined;
  expect([c?.location.line, c?.anchoring]).toEqual([9, "reported"]);
});

test("in a diff cut short in a later file, a text not found in a complete file is unmatched", async () => {
  const engines = new FakeEngines();
  const found = { ...GOOD, line: 2, end_line: null, line_text: "return items.length;" };
  engines.answer({ outcome: "ok", text: answer("", JSON.stringify({ findings: [found] })) });
  const later = [
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,3 +1,3 @@",
    " one",
  ];
  const cut = { ...prepared, diff: `${prepared.diff}${later.join("\n")}\n` };
  const result = await createReview({ engines }).run(job, cut, policy, signal());
  const c = result.kind === "reviewed" ? result.round.candidates[0] : undefined;
  expect([c?.location.line, c?.anchoring]).toEqual([2, "unmatched"]);
});

test("each candidate is found by the engine the pass ran on (ADR 0044)", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: answer("One problem.", ONE_FINDING) });
  const result = await createReview({ engines }).run(job, prepared, { ...policy, engine: "codex" }, signal());
  expect(result.kind === "reviewed" && result.round.candidates.map((c) => c.foundBy)).toEqual(["codex"]);
});

test("the run is a spec the port understands: the prompt, the worktree and the policy's limits", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: answer("Fine.", ONE_FINDING) });
  await createReview({ engines }).run(job, prepared, policy, signal());
  expect(engines.runs).toMatchObject([
    {
      engine: "claude",
      cwd: "/tmp/lookover/worktrees/job-1",
      timeoutMs: 60_000,
      artefactsDir: "/tmp/lookover/runs/run-1",
    },
  ]);
  expect(engines.runs[0]?.prompt).toContain(prepared.diff);
});

test("what the engine does while it runs reaches the policy's listener, in order (ADR 0055)", async () => {
  const engines = new FakeEngines();
  engines.answer({
    outcome: "ok",
    text: answer("Fine.", ONE_FINDING),
    tookMs: 20,
    activity: [
      { afterMs: 1, activity: { kind: "search", pattern: "reduce" } },
      { afterMs: 5, activity: { kind: "read", path: "src/total.ts" } },
    ],
  });
  const heard: unknown[] = [];
  await createReview({ engines }).run(
    job,
    prepared,
    { ...policy, onActivity: (a) => heard.push(a) },
    signal(),
  );
  expect(heard).toEqual([
    { kind: "search", pattern: "reduce" },
    { kind: "read", path: "src/total.ts" },
  ]);
});

test("an answer with no block and no JSON fails the run as missing_block, the text kept", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: "Looks fine to me, nothing to report." });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toEqual({
    kind: "failed",
    reason: "missing_block",
    problems: [],
    text: "Looks fine to me, nothing to report.",
    session: { pass: "find", engine: "claude", ms: 0, usage: null },
  });
});

test("a pass that failed after its engine answered keeps what the session used (ADR 0055)", async () => {
  const engines = new FakeEngines();
  const usage = { inputTokens: 21_000, outputTokens: 1_600 };
  engines.answer({ outcome: "ok", text: "Looks fine to me.", usage, tookMs: 5 });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({
    kind: "failed",
    reason: "missing_block",
    session: { pass: "find", engine: "claude", ms: 5, usage },
  });
});

test("the session is named by the policy's pass and engine: Deep's second find (ADR 0055)", async () => {
  const engines = new FakeEngines();
  const usage = { inputTokens: 900, outputTokens: 90 };
  engines.answer({ outcome: "ok", text: answer("Nothing.", '{"findings": [], "earlier": []}'), usage });
  const result = await createReview({ engines }).run(
    job,
    prepared,
    { ...policy, engine: "codex", pass: "find-2" },
    signal(),
  );
  expect(result).toMatchObject({
    kind: "reviewed",
    round: { sessions: [{ pass: "find-2", engine: "codex", ms: 0, usage }] },
  });
});

test("a block that is not JSON fails the run as malformed_block, with the parser's problem", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: answer("Notes.", '{"findings": [}') });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({ kind: "failed", reason: "malformed_block" });
  if (result.kind !== "failed") throw new Error("not failed");
  expect(result.problems).toHaveLength(1);
});

test("JSON that is not a block of lists fails the run as invalid_block", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: answer("Notes.", '{"findings": "none"}') });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({
    kind: "failed",
    reason: "invalid_block",
    problems: [expect.stringMatching(/^findings: /)],
  });
});

test("a finding in the wrong shape is set aside as problems; the round keeps the others", async () => {
  const engines = new FakeEngines();
  const bad = { path: "src/total.ts", line: 0, severity: "nit", title: "x", body: "y", defect_key: "k" };
  engines.answer({ outcome: "ok", text: answer("Notes.", JSON.stringify({ findings: [GOOD, bad] })) });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({ kind: "reviewed", round: { candidates: [{ title: GOOD.title }] } });
  if (result.kind !== "reviewed") throw new Error("not reviewed");
  expect(result.round.problems.map((p) => p.split(":")[0])).toEqual([
    "findings.1.line",
    "findings.1.severity",
    "findings.1.category",
  ]);
});

test("a finding whose range ends before its line is a problem, not a candidate", async () => {
  const engines = new FakeEngines();
  const backwards = { ...GOOD, line: 5, end_line: 2 };
  engines.answer({ outcome: "ok", text: answer("Notes.", JSON.stringify({ findings: [backwards] })) });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: { candidates: [], problems: ["findings.0.end_line: ends before its line"] },
  });
});

test("the side and the range are passed on as the engine reported them; a range of one line is one line", async () => {
  const engines = new FakeEngines();
  const removed = { ...GOOD, side: "base", line: 7, end_line: null, defect_key: "dropped_guard" };
  const range = { ...GOOD, line: 3, end_line: 5, defect_key: "leaky_loop" };
  const noSide = { ...GOOD, side: undefined, end_line: undefined, defect_key: "no_side" };
  const block = JSON.stringify({ findings: [removed, range, GOOD, noSide] });
  engines.answer({ outcome: "ok", text: answer("Notes.", block) });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  if (result.kind !== "reviewed") throw new Error("not reviewed");
  expect(result.round.candidates.map((c) => c.location)).toEqual([
    { path: "src/total.ts", side: "base", line: 7, endLine: null },
    { path: "src/total.ts", side: "head", line: 3, endLine: 5 },
    // `end_line` equal to `line`: one line, not a range.
    { path: "src/total.ts", side: "head", line: 2, endLine: null },
    // Neither given: the head side, one line.
    { path: "src/total.ts", side: "head", line: 2, endLine: null },
  ]);
});

test("an empty review is a round with no candidate and the engine's reason", async () => {
  const engines = new FakeEngines();
  const empty = JSON.stringify({ findings: [], empty_reason: "The change only renames a local variable." });
  engines.answer({ outcome: "ok", text: answer("Read it twice.", empty) });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: { candidates: [], earlier: [], emptyReason: "The change only renames a local variable." },
  });
});

test("the engine's own failure is the run's reason, with nothing read into it", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "auth_required", text: "Not logged in" });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toEqual({
    kind: "failed",
    reason: "auth_required",
    problems: [],
    text: "Not logged in",
    session: { pass: "find", engine: "claude", ms: 0, usage: null },
  });
});

test("at the plan's limit, the failed run says when it resets, or what the engine said of it (ADR 0055)", async () => {
  const engines = new FakeEngines();
  const until = Date.UTC(2026, 9, 14, 8, 11);
  engines.answer(
    { outcome: "quota_exhausted", text: "", limitUntil: until },
    { outcome: "quota_exhausted", text: "", limitSaid: "You've hit your usage limit." },
  );
  const review = createReview({ engines });
  expect(await review.run(job, prepared, policy, signal())).toEqual({
    kind: "failed",
    reason: "quota_exhausted",
    problems: [],
    text: "",
    limitUntil: until,
    session: { pass: "find", engine: "claude", ms: 0, usage: null },
  });
  expect(await review.run(job, prepared, policy, signal())).toEqual({
    kind: "failed",
    reason: "quota_exhausted",
    problems: [],
    text: "",
    limitSaid: "You've hit your usage limit.",
    session: { pass: "find", engine: "claude", ms: 0, usage: null },
  });
});

test("the last block is the answer; an earlier one, tagged or not, is part of the notes", async () => {
  const engines = new FakeEngines();
  const text = `${answer("The config", '{"not": "the answer"}')}Then:\n\`\`\`ts\nconst x = 1;\n\`\`\`\nSo, nothing.\n\n\`\`\`json\n{"findings": []}\n\`\`\``;
  engines.answer({ outcome: "ok", text });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({ kind: "reviewed", round: { candidates: [] } });
  if (result.kind !== "reviewed") throw new Error("not reviewed");
  expect(result.round.notes).toEndWith("So, nothing.");
});

test("an untagged last fence counts as the block", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: `Nothing.\n\n\`\`\`\n${ONE_FINDING}\n\`\`\`\n` });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: { notes: "Nothing.", candidates: [{ title: GOOD.title }] },
  });
});

test("an answer that is the JSON alone, with no fence, is the block, and there are no notes", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: `\n${ONE_FINDING}\n` });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: { notes: "", candidates: [{ title: GOOD.title }] },
  });
});

test("with no block in the text, a structured-output run's JSON is the answer", async () => {
  const engines = new FakeEngines();
  engines.answer({
    outcome: "ok",
    text: "Nothing to report.",
    json: { findings: [], empty_reason: "Docs only." },
  });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: { notes: "Nothing to report.", candidates: [], emptyReason: "Docs only." },
  });
});

test("a cut-off answer, its fence never closed, is malformed_block rather than missing_block", async () => {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: 'Notes.\n\n```json\n{"findings": [{"path": "src/to' });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({ kind: "failed", reason: "malformed_block" });
});

const earlier: EarlierFinding[] = [
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
  {
    id: findingId("F2"),
    severity: "should_fix",
    category: "tests",
    title: "No test covers the empty list",
    body: "The new test only sums three numbers.",
    file: "src/total.test.ts",
    side: "head",
    line: 4,
    endLine: null,
    claim: null,
  },
];
const round2: ReviewPolicy = { ...policy, round: 2, earlier };

test("round 2 says, for each earlier open finding, whether it is still present or gone", async () => {
  const engines = new FakeEngines();
  const block = JSON.stringify({
    findings: [],
    earlier: [
      { id: "F1", present: false, why: "The initial value is back." },
      { id: "F2", present: true, why: "The test still sums three numbers only." },
    ],
  });
  engines.answer({ outcome: "ok", text: answer("Checked both.", block) });
  const result = await createReview({ engines }).run(job, prepared, round2, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: {
      candidates: [],
      problems: [],
      earlier: [
        { id: "F1", verdict: "gone", why: "The initial value is back." },
        { id: "F2", verdict: "present", why: "The test still sums three numbers only." },
      ],
    },
  });
});

test("an earlier finding the answer skips gets an unknown verdict and a problem line; the round stands", async () => {
  const engines = new FakeEngines();
  const block = JSON.stringify({ findings: [], earlier: [{ id: "F2", present: true, why: "Still there." }] });
  engines.answer({ outcome: "ok", text: answer("Checked one.", block) });
  const result = await createReview({ engines }).run(job, prepared, round2, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: {
      earlier: [
        { id: "F2", verdict: "present", why: "Still there." },
        { id: "F1", verdict: "unknown", why: "" },
      ],
      problems: ["earlier: no verdict on F1"],
    },
  });
});

test("a verdict on a finding that was never asked about fails the run as invalid_block", async () => {
  const engines = new FakeEngines();
  const block = JSON.stringify({
    findings: [],
    earlier: [
      { id: "F1", present: false, why: "Fixed." },
      { id: "F2", present: true, why: "Still." },
      { id: "F9", present: true, why: "Never asked." },
    ],
  });
  engines.answer({ outcome: "ok", text: answer("Checked.", block) });
  const result = await createReview({ engines }).run(job, prepared, round2, signal());
  expect(result).toMatchObject({
    kind: "failed",
    reason: "invalid_block",
    problems: ["earlier: F9 was not asked about"],
  });
});

/** Round 2 with F2's author disputing it on its thread. */
const disputedRound: ReviewPolicy = {
  ...round2,
  earlier: earlier.map((f) =>
    f.id === "F2"
      ? {
          ...f,
          claim: {
            kind: "disputed",
            text: "Not a bug: the empty list is tested in total.spec.ts.",
            by: "dana",
            at: "2026-10-09T08:00:00Z",
            commentId: 7001,
          },
        }
      : f,
  ),
};

test("a disputed finding answered `wrong` gets the verdict wrong, its why the reason to reply with", async () => {
  const engines = new FakeEngines();
  const block = JSON.stringify({
    findings: [],
    earlier: [
      { id: "F1", present: true, why: "Still no initial value." },
      { id: "F2", present: true, wrong: true, why: "total.spec.ts does test the empty list." },
    ],
  });
  engines.answer({ outcome: "ok", text: answer("Checked.", block) });
  const result = await createReview({ engines }).run(job, prepared, disputedRound, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: {
      problems: [],
      earlier: [
        { id: "F1", verdict: "present", why: "Still no initial value." },
        { id: "F2", verdict: "wrong", why: "total.spec.ts does test the empty list." },
      ],
    },
  });
});

test("a dispute rejected, `wrong` false, is read as present or gone", async () => {
  const engines = new FakeEngines();
  const block = JSON.stringify({
    findings: [],
    earlier: [
      { id: "F1", present: false, why: "Fixed." },
      { id: "F2", present: true, wrong: false, why: "total.spec.ts sums three numbers only." },
    ],
  });
  engines.answer({ outcome: "ok", text: answer("Checked.", block) });
  const result = await createReview({ engines }).run(job, prepared, disputedRound, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: {
      problems: [],
      earlier: [
        { id: "F1", verdict: "gone", why: "Fixed." },
        { id: "F2", verdict: "present", why: "total.spec.ts sums three numbers only." },
      ],
    },
  });
});

test("`wrong` on a finding nobody disputed is not read: present or gone stands, with a problem line", async () => {
  const engines = new FakeEngines();
  const block = JSON.stringify({
    findings: [],
    earlier: [
      { id: "F1", present: true, wrong: true, why: "Looks fine to me." },
      { id: "F2", present: false, why: "Tested now." },
    ],
  });
  engines.answer({ outcome: "ok", text: answer("Checked.", block) });
  const result = await createReview({ engines }).run(job, prepared, disputedRound, signal());
  expect(result).toMatchObject({
    kind: "reviewed",
    round: {
      problems: ["earlier: F1 answered wrong, but nobody disputed it"],
      earlier: [
        { id: "F1", verdict: "present", why: "Looks fine to me." },
        { id: "F2", verdict: "gone", why: "Tested now." },
      ],
    },
  });
});

test("`wrong` on a finding never asked about fails the run as invalid_block, as any verdict would", async () => {
  const engines = new FakeEngines();
  const block = JSON.stringify({
    findings: [],
    earlier: [
      { id: "F1", present: true, why: "Still." },
      { id: "F2", present: true, wrong: true, why: "It is tested." },
      { id: "F9", present: true, wrong: true, why: "Never asked." },
    ],
  });
  engines.answer({ outcome: "ok", text: answer("Checked.", block) });
  const result = await createReview({ engines }).run(job, prepared, disputedRound, signal());
  expect(result).toMatchObject({
    kind: "failed",
    reason: "invalid_block",
    problems: ["earlier: F9 was not asked about"],
  });
});

test("round 1 fails as invalid_block when the answer gives verdicts on findings that were never asked about", async () => {
  const engines = new FakeEngines();
  const block = JSON.stringify({ findings: [], earlier: [{ id: "F1", present: true, why: "Still there." }] });
  engines.answer({ outcome: "ok", text: answer("Checked.", block) });
  const result = await createReview({ engines }).run(job, prepared, policy, signal());
  expect(result).toMatchObject({
    kind: "failed",
    reason: "invalid_block",
    problems: ["earlier: F1 was not asked about"],
  });
});

test("fingerprints: a moved line keeps the meaning, a different defect on the same line keeps the location", async () => {
  const engines = new FakeEngines();
  const at = (line: number, defect_key: string) =>
    JSON.stringify({ findings: [{ ...GOOD, line, end_line: null, defect_key }] });
  engines.answer(
    { outcome: "ok", text: answer("", at(2, "reduce_without_initial_value")) },
    { outcome: "ok", text: answer("", at(7, "Reduce without initial value")) },
    { outcome: "ok", text: answer("", at(2, "off_by_one")) },
  );
  const review = createReview({ engines });
  const prints = async () => {
    const result = await review.run(job, prepared, policy, signal());
    if (result.kind !== "reviewed") throw new Error("not reviewed");
    return result.round.candidates[0]?.fingerprints;
  };
  const [first, moved, other] = [await prints(), await prints(), await prints()];
  expect(moved?.meaning).toBe("dbf20875ebb84180");
  expect(moved?.location).not.toBe("04179658a032be7c");
  expect(other?.location).toBe("04179658a032be7c");
  expect(other?.meaning).not.toBe("dbf20875ebb84180");
  expect(first).toEqual({ location: "04179658a032be7c", meaning: "dbf20875ebb84180" });
});

test("with its line's text, the location fingerprint hashes the text, whitespace aside, not the number (ADR 0044)", async () => {
  const text = "return items.reduce((a, b) => a + b);";
  const prints = async (line: number, line_text: string) =>
    (await firstCandidate({ ...GOOD, line, end_line: null, line_text }))?.fingerprints.location;
  // FNV-1a 64 of "correctness|src/total.ts|head|return items.reduce((a, b) => a + b);".
  expect(await prints(2, text)).toBe("131b19c25dc85c99");
  expect(await prints(2, `    ${text.replace(" => ", "  =>  ")}`)).toBe("131b19c25dc85c99");
  expect(await prints(1, text)).toBe("131b19c25dc85c99");
  expect(await prints(1, "export function total(items: number[]) {")).not.toBe("131b19c25dc85c99");
});

// The repository's rules (ADR 0048): the finder cites one by its label in the prompt; the round carries the rule.
const RULES: PromptRulesFile[] = [
  {
    file: "REVIEW.md",
    commit: commitSha("5d0c2e7a"),
    cut: null,
    rules: [
      {
        label: "R1",
        id: "a1",
        file: "REVIEW.md",
        line: 3,
        text: "Every amount is in integer cents.",
        section: [],
        parents: [],
      },
      {
        label: "R2",
        id: "b2",
        file: "REVIEW.md",
        line: 5,
        text: "An empty list is valid input.",
        section: [],
        parents: [],
      },
    ],
    context: [],
  },
];

/** One pass on `found`, with the rules above in the prompt: the round it gives. */
async function withRules(found: Record<string, unknown>) {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: answer("", JSON.stringify({ findings: [found] })) });
  const result = await createReview({ engines }).run(job, prepared, { ...policy, rules: RULES }, signal());
  if (result.kind !== "reviewed") throw new Error(`not reviewed: ${result.reason}`);
  return result.round;
}

test("a finding citing a rule's label carries that rule: its id, its file and its line", async () => {
  const round = await withRules({ ...GOOD, category: "repo_rule", rule: "R2" });
  expect(round.candidates.map((c) => [c.category, c.rule])).toEqual([
    ["repo_rule", { id: "b2", file: "REVIEW.md", line: 5 }],
  ]);
  expect(round.problems).toEqual([]);
});

test("a label in another case or with spaces around it still cites its rule", async () => {
  for (const label of ["r1", " R1", "r1 "]) {
    const round = await withRules({ ...GOOD, category: "repo_rule", rule: label });
    expect(round.candidates.map((c) => c.rule)).toEqual([{ id: "a1", file: "REVIEW.md", line: 3 }]);
    expect(round.problems).toEqual([]);
  }
});

test("a finding citing a label the prompt never gave keeps the finding, drops the citation, says so", async () => {
  const round = await withRules({ ...GOOD, category: "repo_rule", rule: "R9" });
  expect(round.candidates.map((c) => [c.title, c.category, c.rule])).toEqual([
    ["total() throws on an empty list", "maintainability", null],
  ]);
  expect(round.problems).toEqual(["findings.0.rule: R9 is not one of the rules given"]);
});

test("a repo_rule finding citing no rule is maintainability; any other category keeps its own", async () => {
  const engines = new FakeEngines();
  const findings = [
    { ...GOOD, category: "repo_rule" },
    { ...GOOD, category: "repo_rule", rule: null },
    { ...GOOD, category: "correctness", rule: "R1" },
  ];
  engines.answer({ outcome: "ok", text: answer("", JSON.stringify({ findings })) });
  const result = await createReview({ engines }).run(job, prepared, { ...policy, rules: RULES }, signal());
  const round = result.kind === "reviewed" ? result.round : undefined;
  expect(round?.candidates.map((c) => [c.category, c.rule])).toEqual([
    ["maintainability", null],
    ["maintainability", null],
    ["correctness", { id: "a1", file: "REVIEW.md", line: 3 }],
  ]);
  expect(round?.problems).toEqual([]);
});
