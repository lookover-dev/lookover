// The five setups built from a case's sessions (ADR 0050), as the service builds a round: the finds merged (Claude
// then Codex), the new candidates confirmed, the policy applied, reconciled at the default strictness. The answers
// are written by hand in the format the prompts ask for; every expected finding is written by hand from them.
import { expect, test } from "bun:test";
import { commitSha, type Finding } from "@lookover/contracts";
import {
  buildSetups,
  type CaseInputs,
  SESSIONS,
  type SessionName,
  type SessionRecord,
  type SetupResult,
} from "./index.ts";

const inputs: CaseInputs = {
  head: commitSha("6d3a5dbf54b0f0be40b104b4f764b8b254640cfd"),
  diff: [
    "diff --git a/src/total.ts b/src/total.ts",
    "--- a/src/total.ts",
    "+++ b/src/total.ts",
    "@@ -1,3 +1,5 @@",
    " export function total(items: number[]) {",
    "-  return items.reduce((a, b) => a + b, 0);",
    "+  console.log(items);",
    "+  const sum = items.reduce((a, b) => a + b);",
    "+  return sum / 100;",
    " }",
    "",
  ].join("\n"),
  rules: [
    {
      path: "REVIEW.md",
      text: "- Never log what a user sends.\n",
      commit: commitSha("f413a347cd3ff269a7c9013ce1dd6d80fc54bd07"),
    },
  ],
};

/** A finding as the find prompt asks for it. */
const found = (
  line: number,
  severity: string,
  category: string,
  title: string,
  key: string,
  rule?: string,
) => ({
  path: "src/total.ts",
  side: "head",
  line,
  end_line: line,
  severity,
  category,
  title,
  body: `${title}, at line ${line}.`,
  defect_key: key,
  suggestion: null,
  pre_existing: false,
  ...(rule === undefined ? {} : { rule }),
});

const REDUCE = found(
  3,
  "blocking",
  "correctness",
  "total() throws on an empty list",
  "reduce_without_initial_value",
);
const LOGGED = found(2, "should_fix", "repo_rule", "total() logs what the user sends", "items_logged", "R1");
const CENTS = found(4, "should_fix", "correctness", "total() divides cents", "cents_divided");

/** Free notes, then the one JSON block the prompts ask for. */
const answer = (block: unknown) => `I read the diff.\n\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\`\n`;
const finds = (...findings: unknown[]) => answer({ findings, earlier: [] });
const verdicts = (...said: [string, "confirmed" | "refuted" | "unsure", string][]) =>
  answer({
    verdicts: said.map(([id, verdict, severity]) => ({
      id,
      verdict,
      reason: `${id} read.`,
      evidence: [],
      severity,
    })),
  });

/** A session the engine answered `ok` and `review` read. */
function read(session: SessionName, text: string): SessionRecord {
  const engine = SESSIONS[session].engine;
  return {
    session,
    outcome: "ok",
    failure: null,
    text,
    json: null,
    usage: { inputTokens: 100, outputTokens: 10 },
    wallMs: 1000,
    cli: { name: engine, version: null, model: null },
  };
}

/** The worked example: every session read. */
const ALL: Record<SessionName, SessionRecord> = {
  "claude-find": read("claude-find", finds(REDUCE, LOGGED)),
  "codex-find": read("codex-find", finds({ ...REDUCE, title: "An empty list throws" }, CENTS)),
  "claude-confirms-claude": read(
    "claude-confirms-claude",
    verdicts(["C1", "confirmed", "blocking"], ["C2", "refuted", "should_fix"]),
  ),
  "codex-confirms-claude": read(
    "codex-confirms-claude",
    verdicts(["C1", "unsure", "blocking"], ["C2", "confirmed", "should_fix"]),
  ),
  "codex-confirms-both": read(
    "codex-confirms-both",
    verdicts(
      ["C1", "confirmed", "blocking"],
      ["C2", "refuted", "should_fix"],
      ["C3", "confirmed", "should_fix"],
    ),
  ),
};

/** A finding, by what the scorer and the report read of it. */
const seen = (f: Finding) => [f.id, f.title, f.severity, f.foundBy, f.confirmation.verdict, f.posted];

function complete(result: SetupResult) {
  if (result.kind !== "complete") throw new Error(`missing: ${result.session} ${result.reason}`);
  return result;
}

test("Quick keeps the find's candidates, not checked: a blocking one demoted", async () => {
  const quick = complete((await buildSetups(inputs, ALL)).quick);
  expect(quick.kept.map(seen)).toEqual([
    ["F1", "total() throws on an empty list", "should_fix", "claude", "not_checked", true],
    ["F2", "total() logs what the user sends", "should_fix", "claude", "not_checked", true],
  ]);
  expect(quick.kept.map((f) => f.confirmation)).toEqual([
    { verdict: "not_checked", demoted: true },
    { verdict: "not_checked", demoted: false },
  ]);
  expect([quick.judged, quick.ruledOut, quick.confirmer, quick.sessions]).toEqual([
    [],
    [],
    null,
    ["claude-find"],
  ]);
});

test("Quick on Codex keeps Codex's find", async () => {
  const quick = complete((await buildSetups(inputs, ALL))["quick-codex"]);
  expect(quick.kept.map(seen)).toEqual([
    ["F1", "An empty list throws", "should_fix", "codex", "not_checked", true],
    ["F2", "total() divides cents", "should_fix", "codex", "not_checked", true],
  ]);
  expect(quick.sessions).toEqual(["codex-find"]);
});

test("Standard on one engine: a confirmed candidate keeps its severity, a refuted one leaves the findings", async () => {
  const standard = complete((await buildSetups(inputs, ALL))["standard-one"]);
  expect(standard.kept.map(seen)).toEqual([
    ["F1", "total() throws on an empty list", "blocking", "claude", "confirmed", true],
  ]);
  expect(standard.all.map(seen)).toEqual(standard.kept.map(seen));
  expect(standard.ruledOut.map((r) => [r.candidate.title, r.by, r.reason])).toEqual([
    ["total() logs what the user sends", "claude", "C2 read."],
  ]);
  expect(standard.judged.map((j) => [j.candidate.title, j.verdict.verdict])).toEqual([
    ["total() throws on an empty list", "confirmed"],
    ["total() logs what the user sends", "refuted"],
  ]);
  expect([standard.confirmer, standard.sessions]).toEqual([
    "claude",
    ["claude-find", "claude-confirms-claude"],
  ]);
});

test("Standard cross-model: a blocking finding left unsure is demoted; a confirmed rule finding says its rule", async () => {
  const standard = complete((await buildSetups(inputs, ALL))["standard-cross"]);
  expect(standard.kept.map(seen)).toEqual([
    ["F1", "total() throws on an empty list", "should_fix", "claude", "unsure", true],
    ["F2", "total() logs what the user sends", "should_fix", "claude", "confirmed", true],
  ]);
  expect(standard.kept[0]?.confirmation).toEqual({
    verdict: "unsure",
    by: "codex",
    reason: "C1 read.",
    evidence: [],
    demoted: true,
  });
  // The rule parsed from REVIEW.md, switched on: the finding cites it and says its text as why.
  expect([
    standard.kept[1]?.rule?.file,
    standard.kept[1]?.rule?.line,
    standard.kept[1]?.why.ruleText,
  ]).toEqual(["REVIEW.md", 1, "Never log what a user sends."]);
  expect([standard.confirmer, standard.sessions]).toEqual([
    "codex",
    ["claude-find", "codex-confirms-claude"],
  ]);
});

test("the order of the composition: Deep merges Claude's find then Codex's, confirms the merge, then reconciles", async () => {
  const deep = complete((await buildSetups(inputs, ALL)).deep);
  // Merged: C1 the empty list (as Claude named it), C2 the log (Claude's), C3 the cents (Codex's). C2 refuted.
  expect(deep.kept.map(seen)).toEqual([
    ["F1", "total() throws on an empty list", "blocking", "claude", "confirmed", true],
    ["F2", "total() divides cents", "should_fix", "codex", "confirmed", true],
  ]);
  expect(deep.ruledOut.map((r) => r.candidate.title)).toEqual(["total() logs what the user sends"]);
  expect([deep.confirmer, deep.sessions]).toEqual([
    "codex",
    ["claude-find", "codex-find", "codex-confirms-both"],
  ]);
});

test("reconciled at the default strictness: a consider is raised, not kept", async () => {
  const consider = found(2, "consider", "maintainability", "total() could name its sum", "sum_named");
  const setups = await buildSetups(inputs, {
    ...ALL,
    "claude-find": read("claude-find", finds(REDUCE, consider)),
  });
  const quick = complete(setups.quick);
  expect(quick.kept.map((f) => f.title)).toEqual(["total() throws on an empty list"]);
  expect(quick.all.map(seen)).toEqual([
    ["F1", "total() throws on an empty list", "should_fix", "claude", "not_checked", true],
    ["F2", "total() could name its sum", "consider", "claude", "not_checked", false],
  ]);
});

test("a failed session makes every setup that needs it missing, with its failure; the others are built", async () => {
  const failed: SessionRecord = {
    session: "codex-find",
    outcome: "timeout",
    failure: "timeout",
    text: "",
    json: null,
    usage: null,
    wallMs: 5,
    cli: { name: "codex", version: null, model: null },
  };
  const setups = await buildSetups(inputs, { ...ALL, "codex-find": failed });
  expect([setups["quick-codex"], setups.deep]).toEqual([
    { kind: "missing", session: "codex-find", reason: "timeout" },
    { kind: "missing", session: "codex-find", reason: "timeout" },
  ]);
  expect([setups.quick.kind, setups["standard-one"].kind, setups["standard-cross"].kind]).toEqual([
    "complete",
    "complete",
    "complete",
  ]);
});

test("an answer review can't read is that session's failure; a session never run is `not_run`", async () => {
  const { "claude-confirms-claude": _, ...rest } = ALL;
  const setups = await buildSetups(inputs, {
    ...rest,
    "codex-confirms-claude": read("codex-confirms-claude", "No block at all."),
  });
  expect(setups["standard-one"]).toEqual({
    kind: "missing",
    session: "claude-confirms-claude",
    reason: "not_run",
  });
  expect(setups["standard-cross"]).toEqual({
    kind: "missing",
    session: "codex-confirms-claude",
    reason: "unreadable",
  });
});

test("a confirm with no candidate asked is a success with no session, whatever its record", async () => {
  const empty = finds();
  const setups = await buildSetups(inputs, {
    "claude-find": read("claude-find", empty),
    "codex-find": read("codex-find", empty),
    "claude-confirms-claude": { session: "claude-confirms-claude", outcome: "no_candidates" },
    "codex-confirms-both": { session: "codex-confirms-both", outcome: "no_candidates" },
  });
  expect(setups["standard-one"]).toEqual({
    kind: "complete",
    kept: [],
    all: [],
    judged: [],
    ruledOut: [],
    confirmer: null,
    sessions: ["claude-find"],
  });
  expect(setups["standard-cross"]).toEqual({ ...setups["standard-one"] });
  expect(complete(setups.deep).sessions).toEqual(["claude-find", "codex-find"]);
});

test("a failed Claude find makes the four setups built on it missing; Quick on Codex is built", async () => {
  const crashed: SessionRecord = {
    session: "claude-find",
    outcome: "crashed",
    failure: "crashed",
    text: "",
    json: null,
    usage: null,
    wallMs: 5,
    cli: { name: "claude", version: null, model: null },
  };
  const setups = await buildSetups(inputs, { ...ALL, "claude-find": crashed });
  const missing: SetupResult = { kind: "missing", session: "claude-find", reason: "crashed" };
  expect([setups.quick, setups["standard-one"], setups["standard-cross"], setups.deep]).toEqual([
    missing,
    missing,
    missing,
    missing,
  ]);
  expect(complete(setups["quick-codex"]).sessions).toEqual(["codex-find"]);
});

test("a stored confirm that timed out makes its setup missing, with the timeout", async () => {
  const timedOut: SessionRecord = {
    session: "codex-confirms-both",
    outcome: "timeout",
    failure: "timeout",
    text: "",
    json: null,
    usage: null,
    wallMs: 5,
    cli: { name: "codex", version: null, model: null },
  };
  const setups = await buildSetups(inputs, { ...ALL, "codex-confirms-both": timedOut });
  expect(setups.deep).toEqual({ kind: "missing", session: "codex-confirms-both", reason: "timeout" });
  expect(setups["standard-cross"].kind).toBe("complete");
});
