// What the app says of the confirm pass (ADR 0044): a finding's "Checked by", its severity once lowered for want of
// a confirmation, and who found and who confirmed a round, with how many candidates were ruled out.
import { expect, test } from "bun:test";
import {
  type CandidateFinding,
  type ConfirmFallback,
  changeId,
  commitSha,
  type Engine,
  type EngineId,
  emptyReview,
  type Finding,
  findingId,
  type Review,
  type Round,
  type Run,
  runId,
} from "@lookover/contracts";
import { checkedBy, confirmDetails, findersOf, foundByLine, severityLabel } from "./confirm.ts";

function finding(extra: Partial<Finding> = {}): Finding {
  return {
    id: findingId("F1"),
    fingerprints: { location: "l", meaning: "m" },
    severity: "blocking",
    category: "security",
    title: "listInvoices logs every apiKey",
    file: "src/invoices.ts",
    side: "head",
    line: 9,
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
    ...extra,
  };
}

const CANDIDATE: CandidateFinding = {
  severity: "consider",
  category: "tests",
  title: "No tests for unpaid()",
  body: "",
  location: { path: "src/invoices.ts", side: "head", line: 13, endLine: null },
  lineText: null,
  anchoring: "reported",
  foundBy: "claude",
  defectKey: "missing_tests",
  suggestion: null,
  preExisting: false,
  rule: null,
  fingerprints: { location: "l3", meaning: "m3" },
};

function round(extra: Partial<Round> = {}): Round {
  return {
    n: 1,
    sha: commitSha("703205d"),
    reviewer: "claude",
    secondFind: null,
    confirmer: "claude",
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
    ...extra,
  };
}

const reviewWith = (rounds: Round[], findings: Finding[] = []): Review => ({
  ...emptyReview(changeId("app#1"), 0),
  rounds,
  findings,
});

test("a blocking finding lowered for want of a confirmation reads Should fix, unconfirmed", () => {
  expect(severityLabel(finding())).toBe("Blocking");
  expect(
    severityLabel(
      finding({ severity: "should_fix", confirmation: { verdict: "not_checked", demoted: true } }),
    ),
  ).toBe("Should fix, unconfirmed");
  expect(
    severityLabel(
      finding({
        severity: "should_fix",
        confirmation: { verdict: "unsure", by: "claude", reason: "", evidence: [], demoted: true },
      }),
    ),
  ).toBe("Should fix, unconfirmed");
  expect(
    severityLabel(
      finding({
        severity: "should_fix",
        confirmation: { verdict: "unsure", by: "claude", reason: "", evidence: [], demoted: false },
      }),
    ),
  ).toBe("Should fix");
});

test("Checked by names the confirmer, its verdict, its reason and its evidence", () => {
  const confirmed = finding({
    confirmation: {
      verdict: "confirmed",
      by: "codex",
      reason: "Every apiKey reaches the log.",
      evidence: ["src/invoices.ts:9", "src/invoices.ts:5"],
    },
  });
  expect(checkedBy(reviewWith([round()]), confirmed)).toEqual({
    head: "Checked by:",
    text: "Codex, confirmed. Every apiKey reaches the log.",
    evidence: ["src/invoices.ts:9", "src/invoices.ts:5"],
  });
  const unsure = finding({
    confirmation: {
      verdict: "unsure",
      by: "claude",
      reason: "It depends on the callers.",
      evidence: [],
      demoted: false,
    },
  });
  expect(checkedBy(reviewWith([round()]), unsure)).toEqual({
    head: "Checked by:",
    text: "Claude, unconfirmed. It depends on the callers.",
    evidence: [],
  });
});

test("a finding nobody checked says so, and why when its round's confirm gave no answer", () => {
  expect(checkedBy(reviewWith([round()]), finding())).toEqual({
    head: "Not double-checked.",
    text: "",
    evidence: [],
  });
  expect(checkedBy(reviewWith([round({ confirmFailure: "timeout" })]), finding())).toEqual({
    head: "Not double-checked.",
    text: "Claude ran out of time, so it shows as found.",
    evidence: [],
  });
});

test("the details say who found, who double-checked and what was ruled out, from the last round", () => {
  const ruledOut = [
    { candidate: CANDIDATE, by: "claude" as const, reason: "Nothing less tested.", evidence: [] },
  ];
  expect(confirmDetails(reviewWith([round({ ruledOut })]))).toEqual({
    found: "Claude",
    checked: "Claude, in a new session",
    ruledOut: [{ title: "No tests for unpaid()", reason: "Nothing less tested." }],
    count: "1 ruled out",
  });
  expect(confirmDetails(reviewWith([round({ confirmer: "codex" })]))).toMatchObject({
    checked: "Codex",
    ruledOut: [],
    count: null,
  });
  expect(confirmDetails(reviewWith([round({ confirmFailure: "crashed" })]))).toMatchObject({
    checked: "Claude stopped before it answered",
    count: null,
  });
  expect(confirmDetails(reviewWith([round({ confirmer: null, raised: 0 })]))).toMatchObject({
    checked: "Nobody: nothing new to double-check",
    count: null,
  });
  // Quick, or only Consider findings after round 1: "not double-checked" on the pull request too.
  expect(confirmDetails(reviewWith([round({ confirmer: null, raised: 1 })]))).toMatchObject({
    checked: "Nobody: its new findings are not double-checked",
    count: null,
  });
  expect(confirmDetails(reviewWith([]))).toBeNull();
});

test("a Deep round's details name both finders, or the one that answered and why the second didn't", () => {
  const found = (secondFind: Round["secondFind"]) =>
    confirmDetails(reviewWith([round({ secondFind })]))?.found;
  expect([
    found({ engine: "codex", failure: null }),
    found({ engine: "claude", failure: null }),
    found({ engine: "codex", failure: "auth_required" }),
    found({ engine: "claude", failure: "timeout" }),
  ]).toEqual([
    "Claude and Codex",
    "Claude in two sessions",
    "Claude alone: Codex is signed out",
    "Claude, in one session: Claude ran out of time",
  ]);
});

test("How this review ran: one finder with its CLI and version; a Deep round's both finders (ADR 0055)", () => {
  const engine = (id: EngineId, name: string, version: string | null): Engine => ({
    id,
    name,
    cli: id,
    version,
    state: "ready",
    detail: "",
    unusable: null,
    since: 0,
    limitUntil: null,
    signingIn: false,
  });
  const engines = { claude: engine("claude", "Claude", "2.4.1"), codex: engine("codex", "Codex", null) };
  const deep = reviewWith([round({ secondFind: { engine: "codex", failure: null } })]);
  expect(foundByLine(reviewWith([round()]), engines)).toBe("Claude, claude 2.4.1");
  expect(foundByLine(reviewWith([round({ reviewer: "codex" })]), engines)).toBe("Codex, codex");
  expect(foundByLine(deep, engines)).toBe("Claude and Codex");
  // A round running names its own finder, not the last round's.
  const run: Run = {
    id: runId("run-2"),
    reviewer: "codex",
    secondFinder: null,
    confirmer: null,
    confirmFallback: null,
    sha: commitSha("8e1f0aa"),
    preview: false,
    startedAt: 0,
    step: "finding",
    stepAt: 0,
    steps: [],
    activities: [],
    posting: null,
  };
  const running = { ...deep, run };
  expect(foundByLine(running, engines)).toBe("Codex, codex");
  // A Deep round running names both its finders, as the round will once done.
  expect(foundByLine({ ...deep, run: { ...run, secondFinder: "claude" } }, engines)).toBe("Codex and Claude");
  expect(foundByLine({ ...deep, run: { ...run, secondFinder: "codex" } }, engines)).toBe(
    "Codex in two sessions",
  );
  expect(foundByLine(reviewWith([]), engines)).toBe("");
});

test("the summary of How this review ran: the finders as Found by words them, without CLI or version", () => {
  const deep = reviewWith([round({ secondFind: { engine: "codex", failure: null } })]);
  expect(findersOf(reviewWith([round()]))).toBe("Claude");
  expect(findersOf(deep)).toBe("Claude and Codex");
  expect(findersOf(reviewWith([round({ secondFind: { engine: "codex", failure: "timeout" } })]))).toBe(
    "Claude",
  );
  expect(findersOf(reviewWith([]))).toBeNull();
});

test("the finder double-checking in a new session says why the other engine didn't", () => {
  const checked = (confirmFallback: ConfirmFallback, reviewer: EngineId = "claude") =>
    confirmDetails(reviewWith([round({ reviewer, confirmer: reviewer, confirmFallback })]))?.checked;
  expect([
    checked({ reason: "not-ready", engine: "codex", state: "signed-out" }),
    checked({ reason: "not-ready", engine: "codex", state: "missing" }),
    checked({ reason: "not-ready", engine: "codex", state: "limit" }),
    checked({ reason: "not-ready", engine: "codex", state: "failed-self-test" }),
    checked({ reason: "not-ready", engine: "claude", state: "signed-out" }, "codex"),
    checked({ reason: "not-own", engine: "codex" }),
    checked({ reason: "settings", engine: "codex" }),
    checked({ reason: "settings", engine: "claude" }, "codex"),
  ]).toEqual([
    "Claude, in a new session: Codex is signed out",
    "Claude, in a new session: Codex is not installed",
    "Claude, in a new session: Codex reached its limit",
    "Claude, in a new session: Codex didn't pass Lookover's safety check",
    "Codex, in a new session: Claude is signed out",
    "Claude, in a new session: only Claude may review this change",
    "Claude, in a new session: only Claude reviews this repository",
    "Codex, in a new session: only Codex reviews this repository",
  ]);
  // A confirm that gave no answer says that instead.
  expect(
    confirmDetails(
      reviewWith([
        round({
          confirmFallback: { reason: "not-ready", engine: "codex", state: "signed-out" },
          confirmFailure: "timeout",
        }),
      ]),
    )?.checked,
  ).toBe("Claude ran out of time");
});
