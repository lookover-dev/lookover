// The confirm pass's rules in `core` (ADR 0044): which candidates the confirm session checks, and what each verdict
// makes of a candidate. Expected values are written by hand from the record's policy, never recomputed the way the
// code does it.
import { expect, test } from "bun:test";
import {
  type CandidateFinding,
  type CandidateVerdict,
  type Confirmation,
  type Finding,
  findingId,
  type Severity,
} from "@lookover/contracts";
import { confirmPolicy, type ReconcileInput, toConfirm, unconfirmed } from "./index.ts";

/** A candidate named after its defect, on `line` of `src/app.ts`, with that line's text: two of them differ. */
function candidate(
  meaning: string,
  severity: Severity = "should_fix",
  extra: { line?: number; path?: string } = {},
): CandidateFinding {
  const { line = 1, path = "src/app.ts" } = extra;
  return {
    severity,
    category: "correctness",
    title: `Title of ${meaning}`,
    body: `Body of ${meaning}`,
    location: { path, side: "head", line, endLine: null },
    lineText: `text of ${meaning}`,
    anchoring: "reported",
    foundBy: "claude",
    defectKey: meaning,
    suggestion: null,
    preExisting: false,
    rule: null,
    fingerprints: { location: `correctness|${path}|text of ${meaning}`, meaning },
  };
}

/** `c` as the ledger keeps it once raised in round 1 as `F<n>`. */
function inLedger(n: number, c: CandidateFinding): Finding {
  return {
    id: findingId(`F${n}`),
    fingerprints: c.fingerprints,
    severity: c.severity,
    category: c.category,
    title: c.title,
    file: c.location.path,
    side: c.location.side,
    line: c.location.line,
    endLine: c.location.endLine,
    lineText: c.lineText,
    anchoring: c.anchoring,
    body: c.body,
    foundBy: c.foundBy,
    confirmation: { verdict: "not_checked", demoted: false },
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    status: "open",
    posted: true,
    commented: false,
    raisedIn: 1,
    anchoredIn: 1,
    closedIn: null,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
  };
}

const input = (round: number): Pick<ReconcileInput, "round" | "rules"> => ({ round, rules: [] });

test("round 1 confirms every candidate, each finding once", () => {
  const a = candidate("a", "blocking", { line: 3 });
  const b = candidate("b", "consider", { line: 8 });
  const again = { ...a };
  expect(toConfirm([], [a, b, again], input(1))).toEqual([a, b]);
});

test("a candidate that is a ledger finding reported again is not confirmed: its verdict stays with the find pass", () => {
  const old = candidate("old", "blocking", { line: 3 });
  const fresh = candidate("fresh", "should_fix", { line: 9 });
  expect(toConfirm([inLedger(1, old)], [old, fresh], input(2))).toEqual([fresh]);
});

test("from round 2, a new consider is not confirmed: it is never posted", () => {
  const blocking = candidate("b", "blocking", { line: 2 });
  const fix = candidate("f", "should_fix", { line: 4 });
  const consider = candidate("c", "consider", { line: 6 });
  expect(toConfirm([], [blocking, fix, consider], input(2))).toEqual([blocking, fix]);
  expect(toConfirm([], [consider], input(1))).toEqual([consider]);
});

/** One candidate of `severity` judged so: what the policy makes of it. */
function judged(severity: Severity, verdict: CandidateVerdict) {
  const c = candidate("x", severity);
  return { c, applied: confirmPolicy([c], [{ candidate: c, verdict }]) };
}

const by = "claude" as const;
const proof = ["src/app.ts:1"];

/** A confirmation in the table's words. */
function words(c: Confirmation | undefined): string {
  if (c?.verdict === "confirmed") return "confirmed";
  const demoted = c?.demoted ? ", demoted" : "";
  return c?.verdict === "unsure" ? `unsure${demoted}` : `not checked${demoted}`;
}

test("the policy: each verdict on each severity, the confirmer's severity first (ADR 0044)", () => {
  // [finder's severity, verdict, confirmer's severity] → [final severity, confirmation, ruled out]
  const table: [Severity, CandidateVerdict["verdict"], Severity | null, Severity | null, string][] = [
    ["blocking", "confirmed", "blocking", "blocking", "confirmed"],
    ["should_fix", "confirmed", "blocking", "blocking", "confirmed"],
    ["blocking", "confirmed", "consider", "consider", "confirmed"],
    ["blocking", "unsure", "blocking", "should_fix", "unsure, demoted"],
    ["should_fix", "unsure", "blocking", "should_fix", "unsure, demoted"],
    ["blocking", "unsure", "should_fix", "should_fix", "unsure"],
    ["consider", "unsure", "consider", "consider", "unsure"],
    ["blocking", "not_checked", null, "should_fix", "not checked, demoted"],
    ["should_fix", "not_checked", null, "should_fix", "not checked"],
    ["consider", "not_checked", null, "consider", "not checked"],
    ["blocking", "refuted", "blocking", null, "ruled out"],
    ["consider", "refuted", "consider", null, "ruled out"],
  ];
  const seen = table.map(([severity, verdict, rated]) => {
    const v: CandidateVerdict =
      verdict === "not_checked"
        ? { verdict }
        : { verdict, by, reason: "Because.", evidence: proof, severity: rated ?? severity };
    const { applied } = judged(severity, v);
    const [kept] = applied.candidates;
    if (!kept) return [severity, verdict, rated, null, applied.ruledOut.length === 1 ? "ruled out" : "lost"];
    return [severity, verdict, rated, kept.severity, words(kept.confirmation)];
  });
  expect(seen).toEqual(table);
});

test("a confirmed or unsure verdict names its confirmer, its reason and its evidence on the finding", () => {
  expect(
    judged("should_fix", {
      verdict: "confirmed",
      by: "codex",
      reason: "It throws.",
      evidence: proof,
      severity: "should_fix",
    }).applied.candidates[0]?.confirmation,
  ).toEqual({ verdict: "confirmed", by: "codex", reason: "It throws.", evidence: proof });
  expect(
    judged("blocking", {
      verdict: "unsure",
      by: "claude",
      reason: "Can't tell.",
      evidence: [],
      severity: "blocking",
    }).applied.candidates[0]?.confirmation,
  ).toEqual({ verdict: "unsure", by: "claude", reason: "Can't tell.", evidence: [], demoted: true });
});

test("a refuted candidate is no finding: the round keeps it, with who refuted it and why", () => {
  const { c, applied } = judged("blocking", {
    verdict: "refuted",
    by: "claude",
    reason: "The caller checks it first.",
    evidence: ["src/caller.ts:4"],
    severity: "consider",
  });
  expect(applied).toEqual({
    candidates: [],
    ruledOut: [
      { candidate: c, by: "claude", reason: "The caller checks it first.", evidence: ["src/caller.ts:4"] },
    ],
  });
});

test("a candidate the find pass reported twice takes the verdict its first report was given", () => {
  const first = candidate("dup", "blocking", { line: 4 });
  const again = { ...candidate("dup", "blocking", { line: 4 }), title: "Said again" };
  const asked = toConfirm([], [first, again], input(1));
  expect(asked).toEqual([first]);
  const refuted = confirmPolicy(
    [first, again],
    asked.map((c) => ({
      candidate: c,
      verdict: {
        verdict: "refuted" as const,
        by,
        reason: "Not real.",
        evidence: [],
        severity: "blocking" as const,
      },
    })),
  );
  // Refuted once: no finding left, one candidate ruled out.
  expect([refuted.candidates, refuted.ruledOut.map((r) => r.candidate.title)]).toEqual([
    [],
    ["Title of dup"],
  ]);
  const confirmed = confirmPolicy(
    [first, again],
    asked.map((c) => ({
      candidate: c,
      verdict: {
        verdict: "confirmed" as const,
        by,
        reason: "Real.",
        evidence: [],
        severity: "should_fix" as const,
      },
    })),
  );
  expect(confirmed.candidates.map((c) => [c.title, c.severity, c.confirmation?.verdict])).toEqual([
    ["Title of dup", "should_fix", "confirmed"],
    ["Said again", "should_fix", "confirmed"],
  ]);
});

test("a candidate the confirm pass wasn't given is kept as found, not checked and not demoted, in its place", () => {
  const first = candidate("first", "blocking", { line: 1 });
  const old = candidate("old", "blocking", { line: 5 });
  const last = candidate("last", "consider", { line: 9 });
  const applied = confirmPolicy(
    [first, old, last],
    [
      {
        candidate: first,
        verdict: { verdict: "confirmed", by, reason: "Real.", evidence: proof, severity: "blocking" },
      },
      {
        candidate: last,
        verdict: { verdict: "refuted", by, reason: "Not real.", evidence: [], severity: "consider" },
      },
    ],
  );
  expect(applied.candidates.map((c) => [c.defectKey, c.severity, c.confirmation])).toEqual([
    ["first", "blocking", { verdict: "confirmed", by, reason: "Real.", evidence: proof }],
    ["old", "blocking", { verdict: "not_checked", demoted: false }],
  ]);
  expect(applied.ruledOut.map((r) => r.candidate.defectKey)).toEqual(["last"]);
});

test("no confirm pass (Quick): each candidate it would have checked is not checked, a blocking one demoted; the others as found", () => {
  const fresh = candidate("fresh", "blocking", { line: 1 });
  const old = candidate("old", "blocking", { line: 5 });
  const minor = candidate("minor", "consider", { line: 9 });
  const applied = unconfirmed([fresh, old, minor], [fresh, minor]);
  expect(applied.candidates.map((c) => [c.defectKey, c.severity, c.confirmation])).toEqual([
    ["fresh", "should_fix", { verdict: "not_checked", demoted: true }],
    ["old", "blocking", { verdict: "not_checked", demoted: false }],
    ["minor", "consider", { verdict: "not_checked", demoted: false }],
  ]);
  expect(applied.ruledOut).toEqual([]);
});
