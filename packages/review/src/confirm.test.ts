// The confirm pass through its entry (ADR 0044): the new candidates go to one engine session, and its answer
// becomes one verdict per candidate. The engine is `FakeEngines`, scripted per test; the expected verdicts are
// written by hand from the scripted answer. A confirm that fails is never a failure: every candidate comes back
// not checked, with the reason.
import { expect, test } from "bun:test";
import {
  type CandidateFinding,
  type CandidateVerdict,
  commitSha,
  jobId,
  type Prepared,
  type ReviewJob,
} from "@lookover/contracts";
import { FakeEngines, type ScriptedRun } from "@lookover/testkit";
import { type ConfirmPolicy, type ConfirmRun, createConfirm } from "./index.ts";

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
    "@@ -1,3 +1,4 @@",
    " export function total(items: number[]) {",
    "-  return items.reduce((a, b) => a + b, 0);",
    "+  console.log(items);",
    "+  return items.reduce((a, b) => a + b);",
    " }",
    "",
  ].join("\n"),
};

const policy: ConfirmPolicy = {
  engine: "claude",
  round: 1,
  timeoutMs: 60_000,
  artefactsDir: "/tmp/lookover/runs/run-1/confirm",
  rules: [],
};

function candidate(key: string, line: number, title: string): CandidateFinding {
  return {
    severity: "blocking",
    category: "correctness",
    title,
    body: `When it runs, ${key} breaks, because of line ${line}.`,
    location: { path: "src/total.ts", side: "head", line, endLine: null },
    lineText: null,
    anchoring: "reported",
    foundBy: "claude",
    defectKey: key,
    suggestion: null,
    preExisting: false,
    rule: null,
    fingerprints: { location: `l-${key}`, meaning: `m-${key}` },
  };
}

const REDUCE = candidate("reduce_without_initial_value", 3, "total() throws on an empty list");
const LOGGED = candidate("debug_log_left", 2, "total() logs every list it sums");

/** Free notes, then the one JSON block the prompt asks for. */
const answer = (notes: string, block: unknown) =>
  `${notes}\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;

/** One confirm pass on `candidates`, the engine answering `run`. */
async function confirm(run: ScriptedRun | null, candidates = [REDUCE, LOGGED]) {
  const engines = new FakeEngines();
  if (run) engines.answer(run);
  const result = await createConfirm({ engines }).run(
    job,
    prepared,
    candidates,
    policy,
    new AbortController().signal,
  );
  return { result, engines };
}

const verdictsOf = (r: ConfirmRun) => r.judged.map((j) => [j.candidate, j.verdict]);

test("each verdict comes back on its candidate, with its reason, evidence and severity", async () => {
  const text = answer("I read total.ts.", {
    verdicts: [
      {
        id: "C1",
        verdict: "confirmed",
        reason: "reduce without a seed throws on an empty array.",
        evidence: ["src/total.ts:3"],
        severity: "blocking",
      },
      {
        id: "C2",
        verdict: "unsure",
        reason: "It may be a deliberate trace.",
        evidence: [],
        severity: "consider",
      },
    ],
  });
  const usage = { inputTokens: 10, outputTokens: 5 };
  const { result } = await confirm({ outcome: "ok", text, usage, tookMs: 5 });
  expect(result).toEqual({
    judged: [
      {
        candidate: REDUCE,
        verdict: {
          verdict: "confirmed",
          by: "claude",
          reason: "reduce without a seed throws on an empty array.",
          evidence: ["src/total.ts:3"],
          severity: "blocking",
        },
      },
      {
        candidate: LOGGED,
        verdict: {
          verdict: "unsure",
          by: "claude",
          reason: "It may be a deliberate trace.",
          evidence: [],
          severity: "consider",
        },
      },
    ],
    failure: null,
    notes: "I read total.ts.",
    problems: [],
    session: { pass: "confirm", engine: "claude", ms: 5, usage },
  });
});

test("a refuted candidate comes back refuted, by the confirmer of the policy", async () => {
  const text = answer("", {
    verdicts: [
      {
        id: "C1",
        verdict: "refuted",
        reason: "The list is never empty here.",
        evidence: ["src/a.ts:9"],
        severity: "consider",
      },
    ],
  });
  const { result } = await confirm({ outcome: "ok", text }, [REDUCE]);
  const by = { ...policy, engine: "codex" as const };
  expect(verdictsOf(result)).toEqual([
    [
      REDUCE,
      {
        verdict: "refuted",
        by: "claude",
        reason: "The list is never empty here.",
        evidence: ["src/a.ts:9"],
        severity: "consider",
      },
    ],
  ]);
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text });
  const other = await createConfirm({ engines }).run(
    job,
    prepared,
    [REDUCE],
    by,
    new AbortController().signal,
  );
  expect(other.judged[0]?.verdict).toMatchObject({ verdict: "refuted", by: "codex" });
});

test("a candidate the block leaves out is not checked, and the problems say so", async () => {
  const text = answer("", {
    verdicts: [{ id: "C2", verdict: "confirmed", reason: "It logs.", evidence: [], severity: "should_fix" }],
  });
  const { result } = await confirm({ outcome: "ok", text });
  const notChecked: CandidateVerdict = { verdict: "not_checked" };
  expect(verdictsOf(result)).toEqual([
    [REDUCE, notChecked],
    [
      LOGGED,
      { verdict: "confirmed", by: "claude", reason: "It logs.", evidence: [], severity: "should_fix" },
    ],
  ]);
  expect(result.failure).toBeNull();
  expect(result.problems).toEqual(["verdicts: no verdict on C1"]);
});

test("a verdict in the wrong shape, on an unknown id or twice is set aside as a problem, the rest kept", async () => {
  const good = { id: "C1", verdict: "confirmed", reason: "Real.", evidence: [], severity: "blocking" };
  const text = answer("", {
    verdicts: [good, { ...good, verdict: "maybe" }, { ...good, id: "C9" }, { ...good, verdict: "refuted" }],
  });
  const { result } = await confirm({ outcome: "ok", text });
  expect(verdictsOf(result)).toEqual([
    [REDUCE, { verdict: "confirmed", by: "claude", reason: "Real.", evidence: [], severity: "blocking" }],
    [LOGGED, { verdict: "not_checked" }],
  ]);
  expect(result.problems).toEqual([
    'verdicts.1.verdict: Invalid option: expected one of "confirmed"|"refuted"|"unsure"',
    "verdicts: C9 was not asked about",
    "verdicts: C1 answered twice",
    "verdicts: no verdict on C2",
  ]);
});

const NOT_CHECKED: [CandidateFinding, CandidateVerdict][] = [
  [REDUCE, { verdict: "not_checked" }],
  [LOGGED, { verdict: "not_checked" }],
];

test("an unreadable answer is no failure: every candidate is not checked, the reason unreadable", async () => {
  for (const text of [
    "No block at all.",
    "```json\n{ not json\n```",
    answer("", { findings: [] }),
    answer("", { verdicts: "all fine" }),
  ]) {
    const { result } = await confirm({ outcome: "ok", text });
    expect([verdictsOf(result), result.failure]).toEqual([NOT_CHECKED, "unreadable"]);
  }
});

test("an unreadable answer still counts what its session used (ADR 0055)", async () => {
  const usage = { inputTokens: 4_000, outputTokens: 300 };
  const { result } = await confirm({ outcome: "ok", text: "No block at all.", usage });
  expect([result.failure, result.session]).toEqual([
    "unreadable",
    { pass: "confirm", engine: "claude", ms: 0, usage },
  ]);
});

test("a run that fails is no failure: every candidate is not checked, with the engine's outcome", async () => {
  for (const outcome of ["crashed", "timeout", "invalid_output", "quota_exhausted"] as const) {
    const { result } = await confirm({ outcome, text: "" });
    expect([verdictsOf(result), result.failure, result.problems]).toEqual([NOT_CHECKED, outcome, []]);
  }
});

test("a confirmer at the plan's limit says when it resets, or what the engine said of it (ADR 0055)", async () => {
  const until = Date.UTC(2026, 9, 14, 8, 11);
  const read = await confirm({ outcome: "quota_exhausted", text: "", limitUntil: until });
  expect([read.result.failure, read.result.limitUntil, read.result.limitSaid]).toEqual([
    "quota_exhausted",
    until,
    undefined,
  ]);
  const unread = await confirm({ outcome: "quota_exhausted", text: "", limitSaid: "You've hit your limit" });
  expect([unread.result.limitUntil, unread.result.limitSaid]).toEqual([undefined, "You've hit your limit"]);
});

test("a signed-out confirmer: every candidate not checked, the reason auth_required", async () => {
  const { result } = await confirm({ outcome: "auth_required", text: "Not logged in" });
  expect([verdictsOf(result), result.failure]).toEqual([NOT_CHECKED, "auth_required"]);
});

test("one engine session for every candidate, on the policy's engine, folder and limit, in the worktree", async () => {
  const { engines } = await confirm({ outcome: "ok", text: answer("", { verdicts: [] }) });
  expect(engines.runs).toHaveLength(1);
  const [spec] = engines.runs;
  expect(spec).toMatchObject({
    engine: "claude",
    cwd: "/tmp/lookover/worktrees/job-1",
    timeoutMs: 60_000,
    artefactsDir: "/tmp/lookover/runs/run-1/confirm",
  });
  expect([spec?.prompt.includes("### C1"), spec?.prompt.includes("### C2")]).toEqual([true, true]);
});

test("what the engine does while it confirms reaches the policy's listener, in order (ADR 0055)", async () => {
  const engines = new FakeEngines();
  engines.answer({
    outcome: "ok",
    text: answer("", { verdicts: [] }),
    tookMs: 20,
    activity: [
      { afterMs: 1, activity: { kind: "read", path: "src/total.ts" } },
      { afterMs: 5, activity: { kind: "command", text: "rg -n reduce" } },
    ],
  });
  const heard: unknown[] = [];
  await createConfirm({ engines }).run(
    job,
    prepared,
    [REDUCE],
    { ...policy, onActivity: (a) => heard.push(a) },
    new AbortController().signal,
  );
  expect(heard).toEqual([
    { kind: "read", path: "src/total.ts" },
    { kind: "command", text: "rg -n reduce" },
  ]);
});

test("no candidate: no engine run, nothing judged", async () => {
  const { result, engines } = await confirm(null, []);
  expect([engines.runs.length, result.judged, result.failure, result.session]).toEqual([0, [], null, null]);
});

/** A new file of 20,000 lines of about 70 characters each: one hunk of some 1.4 million characters. */
const HUGE: Prepared = {
  cwd: "/tmp/lookover/worktrees/job-1",
  diff: [
    "diff --git a/src/big.ts b/src/big.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/big.ts",
    "@@ -0,0 +1,20000 @@",
    ...Array.from(
      { length: 20_000 },
      (_, i) => `+export const value${i + 1} = compute(${i + 1}); // padding padding padding`,
    ),
    "",
  ].join("\n"),
};

const inBig = (key: string, line: number): CandidateFinding => ({
  ...candidate(key, line, `Problem at ${line}`),
  location: { path: "src/big.ts", side: "head", line, endLine: null },
});

/** The prompt one confirm pass sends for `candidates` in the huge file, the engine's limit `limit`. */
async function hugePrompt(candidates: CandidateFinding[], limit: number): Promise<string> {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: answer("", { verdicts: [] }) });
  await createConfirm({ engines, inputLimits: { claude: limit } }).run(
    job,
    HUGE,
    candidates,
    policy,
    new AbortController().signal,
  );
  return engines.runs[0]?.prompt ?? "";
}

test("claims in a huge hunk each show the lines around them, never the hunk, within the engine's limit", async () => {
  const prompt = await hugePrompt([inBig("a", 100), inBig("b", 10_000), inBig("c", 19_900)], 300_000);
  expect(prompt.length).toBeLessThan(20_000);
  for (const line of [100, 10_000, 19_900]) {
    expect(prompt).toContain(`+export const value${line} = compute(${line});`);
  }
  // A window, not the hunk: lines far from every claim are not sent.
  expect(prompt).not.toContain("value5000 ");
  expect(prompt).toContain("read the files in the working directory for the rest");
});

test("over the engine's limit, the last claims' code is left to read in the worktree, never the claims", async () => {
  const claims = Array.from({ length: 30 }, (_, i) => inBig(`k${i}`, 300 + i * 600));
  const whole = await hugePrompt(claims, Number.POSITIVE_INFINITY);
  const limit = Math.floor(whole.length / 2);
  const prompt = await hugePrompt(claims, limit);
  expect(prompt.length).toBeLessThanOrEqual(limit);
  for (const [i] of claims.entries()) expect(prompt).toContain(`### C${i + 1}: `);
  expect(prompt).toContain(`+export const value300 = compute(300);`);
  expect(prompt).not.toContain(`+export const value17700 = compute(17700);`);
  expect(prompt).toContain(
    "Its code is not shown here: read `src/big.ts` around line 17700 in the working directory.",
  );
});
