// One round against the ledger (ADR 0006, ADR 0025, ADR 0029, ADR 0032, ADR 0039): the findings with their
// statuses, the loop, the check's verdict and what to post. Expected values are written by hand from the
// decisions, never recomputed the way the code does it.
import { expect, test } from "bun:test";
import {
  type CheckConclusion,
  type CitedRule,
  type ClaimKind,
  type Confirmation,
  commitSha,
  type EarlierVerdict,
  type Finding,
  type FindingStatus,
  findingId,
  isUnsettled,
  type LoopState,
  type NextAction,
  type RoundOutcome,
  type Severity,
  type Strictness,
  type Verdict,
} from "@lookover/contracts";
import {
  mergeFinds,
  type ReconcileCandidate,
  type ReconcileInput,
  type RoundOutcomeInput,
  reconcile,
  type ThreadReading,
} from "./index.ts";

const SHA_1 = commitSha("a1b2c3d");
const SHA_2 = commitSha("b2c3d4e");

/**
 * A candidate named after the defect it reports, on line `line` of `src/app.ts`. Its meaning fingerprint is
 * its name. Its location fingerprint stands for the hash of its category, its path and its line's text, `text`
 * (ADR 0044), or of its line number when it has none: two candidates are the same finding only when a test says so.
 */
function candidate(
  meaning: string,
  severity: Severity = "should_fix",
  extra: Partial<ReconcileCandidate> & { line?: number; path?: string; text?: string } = {},
): ReconcileCandidate {
  const { line = 1, path = "src/app.ts", text, ...rest } = extra;
  const category = rest.category ?? "Correctness";
  const location = rest.location ?? { path, side: "head", line, endLine: null };
  const where = `${category}|${location.path}|${location.side}`;
  return {
    severity,
    category,
    title: `Title of ${meaning}`,
    body: `Body of ${meaning}`,
    location,
    lineText: text ?? null,
    anchoring: "reported",
    foundBy: "claude",
    defectKey: meaning,
    suggestion: null,
    preExisting: false,
    rule: null,
    fingerprints: {
      // As `review` hashes it: whitespace aside.
      location: `${where}|${text === undefined ? location.line : text.trim()}`,
      meaning,
    },
    ...rest,
  };
}

/** The rule of REVIEW.md a candidate follows, by its id. */
function cites(id: string): CitedRule {
  return { id, file: "REVIEW.md", line: 4 };
}

/** The finding `candidate(meaning, severity, extra)` becomes when raised as `F<n>` in round `round`. */
function raised(
  n: number,
  meaning: string,
  severity: Severity,
  posted: boolean,
  round: number,
  extra: Parameters<typeof candidate>[2] = {},
): Finding {
  const c = candidate(meaning, severity, extra);
  return {
    id: findingId(`F${n}`),
    fingerprints: c.fingerprints,
    severity,
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
    confirmation: c.confirmation ?? { verdict: "not_checked", demoted: false },
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    status: "open",
    posted,
    commented: false,
    raisedIn: round,
    anchoredIn: round,
    closedIn: null,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
  };
}

/** A finding the ledger already has, numbered `F<n>`, raised in round 1 on line `n`. */
function earlier(
  n: number,
  meaning: string,
  status: FindingStatus,
  severity: Severity = "should_fix",
  extra: Partial<Finding> = {},
): Finding {
  return { ...raised(n, meaning, severity, true, 1, { line: n }), status, ...extra };
}

function outcome(extra: Partial<RoundOutcomeInput> = {}): RoundOutcomeInput {
  return { sha: SHA_1, candidates: [], earlier: [], ...extra };
}

/** Every earlier unsettled finding reported still there: the round changes no status. */
function stillThere(prior: Finding[]): RoundOutcomeInput {
  return outcome({
    earlier: prior
      .filter(isUnsettled)
      .map((f): EarlierVerdict => ({ id: f.id, verdict: "present", why: "Still there." })),
  });
}

/** The check's verdict on `F<n>`, with the finder's reason "Why of F<n>.". */
function said(n: number, verdict: EarlierVerdict["verdict"]): EarlierVerdict {
  return { id: findingId(`F${n}`), verdict, why: `Why of F${n}.` };
}

/** Every earlier unsettled finding reported still there, each with the finder's reason "Why of F<n>.". */
function stillThereBecause(prior: Finding[]): RoundOutcomeInput {
  return outcome({
    earlier: prior.filter(isUnsettled).map((f) => ({ id: f.id, verdict: "present", why: `Why of ${f.id}.` })),
  });
}

/** A claim read on `F<n>`'s thread, as `readThreads` gives it: the author's reply, its id `100 + n`. */
function claim(n: number, kind: ClaimKind, text = `${kind} on F${n}`): ThreadReading["claims"][number] {
  return {
    findingId: findingId(`F${n}`),
    kind,
    text,
    by: "author",
    at: "2026-10-10T10:00:00Z",
    commentId: 100 + n,
  };
}

function round(
  prior: Finding[],
  found: RoundOutcomeInput,
  over: Partial<Omit<ReconcileInput, "settings">> & { strictness?: Strictness } = {},
) {
  const { strictness = "recommended", ...input } = over;
  return reconcile(prior, found, {
    round: prior.length === 0 ? 1 : 2,
    settings: { strictness },
    rules: [
      { id: "secrets", enabled: true, text: "Never log a secret." },
      { id: "names", enabled: false, text: "Names are whole words." },
    ],
    ...input,
  });
}

/** Each finding as [id, status, posted]. */
const ledgerAs = (findings: Finding[]) => findings.map((f) => [String(f.id), f.status, f.posted]);
const ids = (findings: Finding[]) => findings.map((f) => String(f.id));

test("round 1: every candidate is raised, numbered in order, open, and posted by strictness", () => {
  const found = outcome({
    candidates: [
      candidate("retry_forever", "blocking", { line: 41 }),
      candidate("no_timeout", "should_fix", { line: 30 }),
      candidate("rename", "consider", { line: 12 }),
    ],
  });
  const r = round([], found);
  expect(r.findings).toEqual([
    raised(1, "retry_forever", "blocking", true, 1, { line: 41 }),
    raised(2, "no_timeout", "should_fix", true, 1, { line: 30 }),
    raised(3, "rename", "consider", false, 1, { line: 12 }),
  ]);
  expect(ids(r.raised)).toEqual(["F1", "F2", "F3"]);
  expect(ids(r.post)).toEqual(["F1", "F2"]);
  expect(r.loop).toBe("open");
  expect(r.conclusion).toBe("neutral");
  expect(r.open).toBe(2);
});

test("a raised finding keeps who found it and its line's text; with no confirm, it is not checked (ADR 0044)", () => {
  const confirmed: Confirmation = {
    verdict: "confirmed",
    by: "claude",
    reason: "Only 5xx sets done.",
    evidence: ["src/app.ts:44"],
  };
  const r = round(
    [],
    outcome({
      candidates: [
        candidate("retry_forever", "blocking", { line: 41, foundBy: "codex", lineText: "while (!done) {" }),
        candidate("no_timeout", "should_fix", { line: 30, confirmation: confirmed }),
      ],
    }),
  );
  expect(r.findings.map((f) => [f.id, f.foundBy, f.lineText, f.confirmation])).toEqual([
    ["F1", "codex", "while (!done) {", { verdict: "not_checked", demoted: false }],
    ["F2", "claude", null, confirmed],
  ]);
});

test("what the review doesn't say takes the app's defaults; a candidate's rule is kept, its text the why", () => {
  const r = round(
    [],
    outcome({
      candidates: [
        candidate("a", "blocking", { path: "src/export/csv.ts", line: 3 }),
        candidate("b", "blocking", { rule: cites("secrets") }),
      ],
    }),
  );
  expect(r.findings[0]).toMatchObject({
    file: "src/export/csv.ts",
    line: 3,
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
  });
  expect(r.findings[1]).toMatchObject({
    rule: cites("secrets"),
    why: { ruleText: "Never log a secret." },
    snippet: null,
    fix: null,
  });
});

test("round 2: one verified fixed, one still present, one new blocking and one new Should fix posted (ADR 0042)", () => {
  const prior = [earlier(1, "retry_forever", "open", "blocking"), earlier(2, "no_timeout", "open")];
  const found = outcome({
    sha: SHA_2,
    earlier: [
      { id: findingId("F1"), verdict: "gone", why: "4xx now breaks out of the loop." },
      { id: findingId("F2"), verdict: "present", why: "Still no timeout on the call." },
    ],
    candidates: [
      // Reported again, on another line after the push: the same finding, not raised twice.
      candidate("no_timeout", "should_fix", { line: 35 }),
      candidate("sql_injection", "blocking", { line: 9 }),
      candidate("n_plus_one", "should_fix", { line: 12 }),
    ],
  });
  const r = round(prior, found);
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "verified_fixed", true],
    ["F2", "open", true],
    ["F3", "open", true],
    ["F4", "open", true],
  ]);
  expect(r.findings[0]).toMatchObject({ closedIn: 2, verifiedSha: "b2c3d4e" });
  expect(r.findings[1]).toEqual(prior[1]);
  expect(r.findings[2]).toEqual(raised(3, "sql_injection", "blocking", true, 2, { line: 9 }));
  expect(r.findings[3]).toEqual(raised(4, "n_plus_one", "should_fix", true, 2, { line: 12 }));
  expect(ids(r.raised)).toEqual(["F3", "F4"]);
  expect(ids(r.post)).toEqual(["F3", "F4"]);
  expect(r.loop).toBe("open");
  expect(r.conclusion).toBe("neutral");
  expect(r.open).toBe(3);
  expect(r.keptInApp).toBe(0);
  expect(r.verifiedFixed).toBe(1);
});

test("a finding an earlier round withheld (its review never landed) is posted by the next round, and counts", () => {
  // Round 1 raised F1 to post; GitHub refused the review for an hour, so the ledger holds it not posted.
  const withheld = earlier(1, "secret_logged", "open", "blocking", { posted: false });
  const fixedMeanwhile = earlier(2, "no_timeout", "open", "should_fix", { posted: false });
  const found = outcome({
    sha: SHA_2,
    earlier: [
      { id: findingId("F1"), verdict: "present", why: "The key is still logged." },
      { id: findingId("F2"), verdict: "gone", why: "The call has a timeout now." },
    ],
    candidates: [candidate("secret_logged", "blocking", { line: 1 })],
  });
  const r = round([withheld, fixedMeanwhile], found, { withheld: [findingId("F1"), findingId("F2")] });
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "open", true],
    // Fixed before it ever reached the pull request: it stays off it.
    ["F2", "verified_fixed", false],
  ]);
  expect(ids(r.post)).toEqual(["F1"]);
  expect(r.verdict).toBe("blocking");
  expect(r.nextAction).toBe("fix");
  expect(r.open).toBe(1);
  expect(r.keptInApp).toBe(0);
  expect(r.actionBy.map((a) => [String(a.id), a.by])).toEqual([
    ["F1", "agent"],
    ["F2", "none"],
  ]);
});

test("a finding kept in the app (not withheld) stays off the pull request in the next round", () => {
  const kept = earlier(1, "magic_number", "open", "consider", { posted: false });
  const r = round([kept], stillThere([kept]));
  expect(ledgerAs(r.findings)).toEqual([["F1", "open", false]]);
  expect(r.post).toEqual([]);
  expect(r.verdict).toBe("clean");
});

test("from round 2 a new Should fix is posted and a new Consider stays in the app, strictness on top (ADR 0042)", () => {
  const prior = [earlier(1, "old", "open", "blocking")];
  const found = {
    ...stillThere(prior),
    candidates: [
      candidate("b", "blocking", { line: 2 }),
      candidate("s", "should_fix", { line: 3 }),
      candidate("c", "consider", { line: 4 }),
    ],
  };
  // [strictness, posted this round, open on the pull request, kept in the app]
  const cases: [Strictness, string[], number, number][] = [
    ["recommended", ["F2", "F3"], 3, 1],
    ["blocking", ["F2"], 2, 2],
    // Everything posts a Consider in round 1 only: later rounds stay quiet.
    ["everything", ["F2", "F3"], 3, 1],
  ];
  for (const [strictness, post, open, kept] of cases) {
    const r = round(prior, found, { strictness });
    expect([strictness, ids(r.post), r.open, r.keptInApp]).toEqual([strictness, post, open, kept]);
  }
});

test("strictness decides what round 1 posts and drops nothing; what it hides never holds the loop open (ADR 0025, I-152)", () => {
  const found = outcome({
    candidates: [
      candidate("b", "blocking", { line: 1 }),
      candidate("s", "should_fix", { line: 2 }),
      candidate("c", "consider", { line: 3 }),
    ],
  });
  const cases: [Strictness, string[], number][] = [
    ["recommended", ["F1", "F2"], 2],
    ["blocking", ["F1"], 1],
    ["everything", ["F1", "F2", "F3"], 3],
  ];
  for (const [strictness, post, open] of cases) {
    const r = round([], found, { strictness });
    expect([strictness, ids(r.findings), ids(r.post), r.open]).toEqual([
      strictness,
      ["F1", "F2", "F3"],
      post,
      open,
    ]);
  }
  // Only a Consider, hidden: it stays in the app, nothing is posted, the loop is settled and the check succeeds.
  const hidden = round([], outcome({ candidates: [candidate("c", "consider")] }));
  expect(ledgerAs(hidden.findings)).toEqual([["F1", "open", false]]);
  expect(hidden).toMatchObject({ post: [], loop: "settled", conclusion: "success", open: 0, keptInApp: 1 });
});

test("the check succeeds with no open blocking finding and is neutral otherwise (ADR 0006)", () => {
  const cases: [string, Finding[], CheckConclusion][] = [
    ["nothing", [], "success"],
    ["an open Should fix", [earlier(1, "s", "open")], "success"],
    ["an open blocking finding", [earlier(1, "b", "open", "blocking")], "neutral"],
    ["an escalated blocking finding", [earlier(1, "b", "escalated", "blocking")], "neutral"],
    ["a dismissed blocking finding", [earlier(1, "b", "dismissed", "blocking")], "success"],
    [
      "a blocking finding kept off the pull request",
      [earlier(1, "b", "open", "blocking", { posted: false })],
      "success",
    ],
  ];
  for (const [name, prior, conclusion] of cases) {
    expect([name, round(prior, stillThere(prior)).conclusion]).toEqual([name, conclusion]);
  }
  // The round that verifies the last blocking finding fixed turns the check green and settles the loop.
  const fixed = round(
    [earlier(1, "b", "open", "blocking")],
    outcome({ sha: SHA_2, earlier: [{ id: findingId("F1"), verdict: "gone", why: "Gone." }] }),
  );
  expect(fixed).toMatchObject({
    conclusion: "success",
    loop: "settled",
    open: 0,
    verifiedFixed: 1,
    raised: [],
    post: [],
  });
});

test("a settled finding is never raised again nor settled twice; one reported again is still present, whatever the verdict says", () => {
  const prior = [
    earlier(1, "fixed", "verified_fixed", "blocking", { closedIn: 2, verifiedSha: SHA_1 }),
    earlier(2, "dismissed", "dismissed", "blocking", {
      closedIn: 2,
      closedWhy: "You marked this finding as wrong",
    }),
    earlier(3, "withdrawn", "withdrawn", "should_fix", { closedIn: 2, closedWhy: "Intended." }),
    earlier(4, "still_there", "open", "blocking"),
    earlier(5, "unasked", "open", "blocking"),
  ];
  const r = round(
    prior,
    outcome({
      sha: SHA_2,
      // Without line text, reported again by meaning, whatever the line.
      candidates: [
        candidate("fixed", "blocking", { line: 40 }),
        candidate("dismissed", "blocking", { line: 42 }),
        candidate("withdrawn", "should_fix", { line: 30 }),
        candidate("still_there", "blocking", { line: 14 }),
      ],
      earlier: [
        { id: findingId("F1"), verdict: "present", why: "" },
        { id: findingId("F2"), verdict: "gone", why: "" },
        { id: findingId("F3"), verdict: "gone", why: "" },
        { id: findingId("F4"), verdict: "gone", why: "" },
        // Not answered: stays as it was.
        { id: findingId("F5"), verdict: "unknown", why: "" },
      ],
    }),
    { round: 3, threads: { claims: [claim(1, "disputed"), claim(3, "wont_fix"), claim(5, "question")] } },
  );
  expect(r.findings).toEqual(prior);
  expect(r).toMatchObject({
    raised: [],
    post: [],
    loop: "open",
    conclusion: "neutral",
    open: 2,
    verifiedFixed: 0,
  });
});

test("a new finding is numbered past the highest id the ledger holds, even when a finding was dropped", () => {
  const prior = [earlier(1, "a", "verified_fixed"), earlier(3, "c", "open")];
  const r = round(prior, outcome({ candidates: [candidate("d", "blocking", { line: 9 })] }), { round: 3 });
  expect(ids(r.raised)).toEqual(["F4"]);
});

test("a candidate from a switched-off rule is dropped; the numbering skips nothing", () => {
  const found = outcome({
    candidates: [
      candidate("rule_off", "blocking", { rule: cites("names") }),
      candidate("rule_on", "blocking", { rule: cites("secrets") }),
      candidate("kept", "blocking", { path: "test/app.test.ts", line: 7 }),
    ],
  });
  const r = round([], found);
  expect(r.findings.map((f) => [String(f.id), f.fingerprints.meaning])).toEqual([
    ["F1", "rule_on"],
    ["F2", "kept"],
  ]);
  expect(r).toMatchObject({ loop: "open", conclusion: "neutral", open: 2 });
});

test("a candidate without a rule field, as an older producer may send it, is kept and cites no rule", () => {
  // JSON drops a field set to undefined: the candidate as data without the field.
  const bare: ReconcileCandidate = JSON.parse(
    JSON.stringify({ ...candidate("bare", "blocking"), rule: undefined }),
  );
  expect("rule" in bare).toBe(false);
  const found = outcome({ candidates: [bare] });
  const r = round([], found, { rules: [{ id: "names", enabled: false, text: "Names are whole words." }] });
  expect(r.findings.map((f) => [String(f.id), f.rule])).toEqual([["F1", null]]);
});

test("claimed fixed: the round's check decides; gone is verified fixed, present is kept, no verdict leaves it unread", () => {
  const prior = [earlier(1, "a", "open"), earlier(2, "b", "open"), earlier(3, "c", "open")];
  const r = round(
    prior,
    outcome({ sha: SHA_2, earlier: [said(1, "gone"), said(2, "present"), said(3, "unknown")] }),
    {
      threads: { claims: [claim(1, "claimed_fixed"), claim(2, "claimed_fixed"), claim(3, "claimed_fixed")] },
    },
  );
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "verified_fixed", true],
    ["F2", "open", true],
    ["F3", "open", true],
  ]);
  expect(r.findings[0]).toMatchObject({
    closedIn: 2,
    verifiedSha: "b2c3d4e",
    kept: 0,
    claim: { kind: "claimed_fixed", text: "claimed_fixed on F1", by: "author", commentId: 101 },
  });
  expect(r.findings[1]).toMatchObject({ kept: 1, claim: { kind: "claimed_fixed", commentId: 102 } });
  // Not answered: the next round reads it again.
  expect(r.findings[2]).toEqual(prior[2]);
  expect(r.replies).toEqual([{ findingId: findingId("F2"), kind: "kept", why: "Why of F2." }]);
});

test("a dispute the finder says is wrong: withdrawn on should_fix and consider, escalated on blocking", () => {
  const prior = [
    earlier(1, "a", "open", "should_fix"),
    earlier(2, "b", "open", "consider"),
    earlier(3, "c", "open", "blocking"),
  ];
  const r = round(prior, outcome({ earlier: [said(1, "wrong"), said(2, "wrong"), said(3, "wrong")] }), {
    threads: { claims: [claim(1, "disputed"), claim(2, "disputed"), claim(3, "disputed")] },
  });
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "withdrawn", true],
    ["F2", "withdrawn", true],
    ["F3", "escalated", true],
  ]);
  expect(r.findings[0]).toMatchObject({ closedIn: 2, closedWhy: "Why of F1.", claim: { kind: "disputed" } });
  expect(r.findings[2]).toMatchObject({ closedIn: null, kept: 0, claim: { kind: "disputed" } });
  expect(r.replies).toEqual([
    { findingId: findingId("F1"), kind: "withdrawn", why: "Why of F1." },
    { findingId: findingId("F2"), kind: "withdrawn", why: "Why of F2." },
    { findingId: findingId("F3"), kind: "escalated", why: "Why of F3." },
  ]);
  // A well-argued reply alone never removes a blocking finding: the owner settles it.
  expect(r).toMatchObject({ loop: "needs_owner", nextAction: "ask_human", conclusion: "neutral", open: 1 });
  expect(r.actionBy.map((a) => a.by)).toEqual(["none", "none", "human"]);
});

test("`wrong` without a dispute is ignored; a dispute on a finding reported again with no verdict is rejected", () => {
  const prior = [
    earlier(1, "a", "open"),
    earlier(2, "b", "open", "blocking"),
    earlier(3, "c", "open"),
    earlier(4, "d", "open", "blocking"),
  ];
  const r = round(
    prior,
    outcome({
      candidates: [candidate("d", "blocking", { line: 4 })],
      earlier: [said(1, "wrong"), said(2, "wrong"), said(3, "wrong")],
    }),
    { threads: { claims: [claim(2, "wont_fix"), claim(3, "claimed_fixed"), claim(4, "disputed")] } },
  );
  // F1 has no claim; F2's won't fix and F3's fix claim wait for a verdict the finder didn't give.
  expect(r.findings.slice(0, 3)).toEqual(prior.slice(0, 3));
  expect(r.findings[3]).toMatchObject({ status: "open", kept: 1, claim: { kind: "disputed" } });
  expect(r.replies).toEqual([{ findingId: findingId("F4"), kind: "kept", why: "Body of d" }]);
});

test("a dispute the finder says is wrong is answered so even when it reports the finding again: the verdict answers the dispute", () => {
  const prior = [earlier(1, "a", "open", "should_fix"), earlier(2, "b", "open", "blocking")];
  const r = round(
    prior,
    outcome({
      candidates: [candidate("a", "should_fix", { line: 1 }), candidate("b", "blocking", { line: 2 })],
      earlier: [said(1, "wrong"), said(2, "wrong")],
    }),
    { threads: { claims: [claim(1, "disputed"), claim(2, "disputed")] } },
  );
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "withdrawn", true],
    ["F2", "escalated", true],
  ]);
  expect(r.findings[1]).toMatchObject({ kept: 0, claim: { kind: "disputed" } });
  expect(r.raised).toEqual([]);
  expect(r.replies).toEqual([
    { findingId: findingId("F1"), kind: "withdrawn", why: "Why of F1." },
    { findingId: findingId("F2"), kind: "escalated", why: "Why of F2." },
  ]);
});

test("won't fix, deferred or a rejected dispute: acknowledged on a non-blocking finding, kept on a blocking one", () => {
  const prior = [
    earlier(1, "a", "open", "should_fix"),
    earlier(2, "b", "open", "consider"),
    earlier(3, "c", "open", "should_fix"),
    earlier(4, "d", "open", "blocking"),
    earlier(5, "e", "open", "blocking"),
    earlier(6, "f", "open", "blocking"),
  ];
  const r = round(prior, stillThereBecause(prior), {
    threads: {
      claims: [
        claim(1, "wont_fix", "Won't fix: the proxy needs it."),
        claim(2, "deferred"),
        claim(3, "disputed"),
        claim(4, "wont_fix"),
        claim(5, "deferred"),
        claim(6, "disputed"),
      ],
    },
  });
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "acknowledged", true],
    ["F2", "acknowledged", true],
    ["F3", "acknowledged", true],
    ["F4", "open", true],
    ["F5", "open", true],
    ["F6", "open", true],
  ]);
  // The author's call: their reply is why it settled.
  expect(r.findings[0]).toMatchObject({ closedIn: 2, closedWhy: "Won't fix: the proxy needs it.", kept: 0 });
  expect(r.findings.map((f) => f.kept)).toEqual([0, 0, 0, 1, 1, 1]);
  // Acknowledged is the summary's to say, never a reply.
  expect(r.replies).toEqual([
    { findingId: findingId("F4"), kind: "kept", why: "Why of F4." },
    { findingId: findingId("F5"), kind: "kept", why: "Why of F5." },
    { findingId: findingId("F6"), kind: "kept", why: "Why of F6." },
  ]);
  expect(r).toMatchObject({ loop: "open", nextAction: "fix", open: 3 });
});

test("won't fix on a blocking finding over two rounds: kept, then escalated to the owner", () => {
  const prior = [earlier(1, "a", "open", "blocking")];
  const two = round(prior, stillThereBecause(prior), {
    round: 2,
    threads: { claims: [claim(1, "wont_fix")] },
  });
  expect(two.findings[0]).toMatchObject({ status: "open", kept: 1 });
  expect(two.replies.map((r) => r.kind)).toEqual(["kept"]);
  const again = { ...claim(1, "wont_fix", "Won't fix, really."), commentId: 201 };
  const three = round(two.findings, stillThereBecause(two.findings), {
    round: 3,
    threads: { claims: [again] },
  });
  expect(three.findings[0]).toMatchObject({
    status: "escalated",
    kept: 2,
    closedIn: null,
    claim: { kind: "wont_fix", text: "Won't fix, really.", commentId: 201 },
  });
  expect(three.replies).toEqual([{ findingId: findingId("F1"), kind: "escalated", why: "Why of F1." }]);
  expect(three).toMatchObject({
    loop: "needs_owner",
    nextAction: "ask_human",
    conclusion: "neutral",
    open: 1,
  });
  expect(three.actionBy).toEqual([{ id: findingId("F1"), by: "human" }]);
});

test("the keep count survives a newer claim of another kind; a finding already escalated stays so", () => {
  const prior = [
    earlier(1, "a", "open", "should_fix", { kept: 1 }),
    earlier(2, "b", "escalated", "blocking", { kept: 2 }),
  ];
  const r = round(prior, stillThereBecause(prior), {
    round: 4,
    threads: { claims: [claim(1, "claimed_fixed"), claim(2, "wont_fix")] },
  });
  expect(r.findings.map((f) => [String(f.id), f.status, f.kept])).toEqual([
    ["F1", "escalated", 2],
    ["F2", "escalated", 3],
  ]);
  expect(r.replies.map((x) => [String(x.findingId), x.kind])).toEqual([
    ["F1", "escalated"],
    ["F2", "kept"],
  ]);
});

test("a question is answered and kept, never counted: it never escalates", () => {
  let ledger = [earlier(1, "a", "open", "blocking")];
  for (const n of [2, 3, 4]) {
    const r = round(ledger, stillThereBecause(ledger), {
      round: n,
      threads: { claims: [{ ...claim(1, "question", `Why, round ${n}?`), commentId: 100 * n }] },
    });
    expect(r.replies).toEqual([{ findingId: findingId("F1"), kind: "answered", why: "Why of F1." }]);
    expect(r.loop).toBe("open");
    ledger = r.findings;
  }
  expect(ledger[0]).toMatchObject({
    status: "open",
    kept: 0,
    claim: { kind: "question", text: "Why, round 4?" },
  });
});

test("a Deep round where one pass says gone and the other wrong: verified fixed, disputed or not", () => {
  const pass = (verdicts: EarlierVerdict[]): RoundOutcome => ({
    sha: SHA_2,
    engine: "claude",
    notes: "",
    candidates: [],
    earlier: verdicts,
    emptyReason: null,
    problems: [],
    sessions: [],
  });
  const prior = [earlier(1, "a", "open", "blocking"), earlier(2, "b", "open")];
  const merged = mergeFinds([
    pass([said(1, "wrong"), said(2, "gone")]),
    pass([said(1, "gone"), said(2, "wrong")]),
  ]);
  const r = round(prior, merged, { threads: { claims: [claim(1, "disputed")] } });
  expect(r.findings.map((f) => [String(f.id), f.status, f.verifiedSha])).toEqual([
    ["F1", "verified_fixed", "b2c3d4e"],
    ["F2", "verified_fixed", "b2c3d4e"],
  ]);
  expect(r.replies).toEqual([]);
});

test("a reply never goes out without a reason: the finder's, else the report it made again, else the finding's", () => {
  const prior = [earlier(1, "a", "open", "blocking"), earlier(2, "b", "open"), earlier(3, "c", "open")];
  const r = round(
    prior,
    outcome({
      // F1 reported again with no verdict; F2 and F3 present without a reason.
      candidates: [{ ...candidate("a", "blocking", { line: 1 }), body: "Line 1 still retries forever." }],
      earlier: [
        { id: findingId("F2"), verdict: "present", why: "  " },
        { id: findingId("F3"), verdict: "present", why: "" },
      ],
    }),
    { threads: { claims: [claim(1, "wont_fix"), claim(2, "claimed_fixed"), claim(3, "question")] } },
  );
  expect(r.replies).toEqual([
    { findingId: findingId("F1"), kind: "kept", why: "Line 1 still retries forever." },
    { findingId: findingId("F2"), kind: "kept", why: "Body of b" },
    { findingId: findingId("F3"), kind: "answered", why: "Body of c" },
  ]);
});

test("`full`: a round past the first posts a new Consider, as a first round would", () => {
  const prior = [earlier(1, "a", "open")];
  const found = { ...stillThereBecause(prior), candidates: [candidate("polish", "consider", { line: 9 })] };
  const quiet = round(prior, found, { strictness: "everything" });
  const full = round(prior, found, { strictness: "everything", full: true });
  expect(ledgerAs(quiet.raised)).toEqual([["F2", "open", false]]);
  expect(ledgerAs(full.raised)).toEqual([["F2", "open", true]]);
  expect(ids(full.post)).toEqual(["F2"]);
  // Strictness still filters: `full` lifts only the later-round rule.
  expect(ledgerAs(round(prior, found, { full: true }).raised)).toEqual([["F2", "open", false]]);
});

test("a raised finding carries no claim and was never kept; a round replies on no thread yet (ADR 0052)", () => {
  const r = round([earlier(1, "a", "open")], outcome({ sha: SHA_2, candidates: [candidate("b")] }), {
    round: 2,
    full: true,
  });
  expect(r.raised.map((f) => [String(f.id), f.claim, f.kept])).toEqual([["F2", null, 0]]);
  expect(r.replies).toEqual([]);
});

// A finding's identity (ADR 0044, #63): the same when the meanings match and the locations match, or when either
// has no line text; in one round, also the same category on the same line.

test("two bugs of the same kind in one file, on two lines, are two findings (#63)", () => {
  const r = round(
    [],
    outcome({
      candidates: [
        candidate("missing_null_check", "blocking", { line: 3, text: "return user.name;" }),
        candidate("missing_null_check", "blocking", { line: 8, text: "return order.total;" }),
      ],
    }),
  );
  expect(r.findings.map((f) => [String(f.id), f.line])).toEqual([
    ["F1", 3],
    ["F2", 8],
  ]);
});

/** Round 1's two null checks of `src/app.ts`, open on the pull request. */
const TWO_OF_A_KIND = [
  raised(1, "missing_null_check", "blocking", true, 1, { line: 3, text: "return user.name;" }),
  raised(2, "missing_null_check", "blocking", true, 1, { line: 8, text: "return order.total;" }),
];

test("fixing one of two bugs of a kind verifies that one fixed and keeps the other open, though it is reported again (#63)", () => {
  const r = round(
    TWO_OF_A_KIND,
    outcome({
      sha: SHA_2,
      // The fix moved F2 up a line; the reviewer lists it again anyway.
      candidates: [candidate("missing_null_check", "blocking", { line: 7, text: "return order.total;" })],
      earlier: [
        { id: findingId("F1"), verdict: "gone", why: "Checked now." },
        { id: findingId("F2"), verdict: "present", why: "Still unchecked." },
      ],
    }),
  );
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "verified_fixed", true],
    ["F2", "open", true],
  ]);
  expect(r.raised).toEqual([]);
});

test("a new bug of the same kind in round 2 is raised, and doesn't keep a fixed one open (#63)", () => {
  const r = round(
    TWO_OF_A_KIND,
    outcome({
      sha: SHA_2,
      candidates: [candidate("missing_null_check", "blocking", { line: 12, text: "return cart.items;" })],
      earlier: [
        { id: findingId("F1"), verdict: "gone", why: "Checked now." },
        { id: findingId("F2"), verdict: "gone", why: "Checked now." },
      ],
    }),
  );
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "verified_fixed", true],
    ["F2", "verified_fixed", true],
    ["F3", "open", true],
  ]);
  expect(r.findings[2]).toMatchObject({ line: 12, lineText: "return cart.items;", raisedIn: 2 });
});

test("a finding keeps its identity when lines are added above it: reported again, it is neither new nor fixed", () => {
  const r = round(
    TWO_OF_A_KIND,
    outcome({
      sha: SHA_2,
      candidates: [candidate("missing_null_check", "blocking", { line: 13, text: "return user.name;" })],
      earlier: [
        { id: findingId("F1"), verdict: "gone", why: "Looked at the old line." },
        { id: findingId("F2"), verdict: "present", why: "Still unchecked." },
      ],
    }),
  );
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "open", true],
    ["F2", "open", true],
  ]);
  expect(r.raised).toEqual([]);
});

test("a finding raised without its line's text, given it in round 2, stays the same finding in round 3", () => {
  const first = round(
    [],
    outcome({ candidates: [candidate("missing_null_check", "blocking", { line: 3 })] }),
  );
  const quoted = (line: number) =>
    candidate("missing_null_check", "blocking", { line, text: "return user.name;" });
  const second = reconcile(first.findings, outcome({ sha: SHA_2, candidates: [quoted(5)] }), {
    round: 2,
    settings: { strictness: "recommended" },
    rules: [],
  });
  // Its location fingerprint follows the text it took.
  expect(second.findings[0]?.fingerprints).toEqual(quoted(5).fingerprints);
  const third = reconcile(second.findings, outcome({ sha: SHA_2, candidates: [quoted(7)] }), {
    round: 3,
    settings: { strictness: "recommended" },
    rules: [],
  });
  expect(third.findings.map((f) => [String(f.id), f.status, f.line])).toEqual([["F1", "open", 7]]);
  expect(third.raised).toEqual([]);
});

test("an earlier finding reported again with its line's text names the line it is on now", () => {
  const r = round(
    TWO_OF_A_KIND,
    outcome({
      sha: SHA_2,
      // Ten lines added above F1: the reviewer quotes its line, now 13 to 14, re-indented.
      candidates: [
        candidate("missing_null_check", "blocking", {
          line: 13,
          text: "  return user.name;",
          location: { path: "src/app.ts", side: "head", line: 13, endLine: 14 },
          anchoring: "moved",
        }),
      ],
      earlier: [{ id: findingId("F2"), verdict: "present", why: "Still unchecked." }],
    }),
  );
  expect(r.findings[0]).toMatchObject({
    id: "F1",
    status: "open",
    file: "src/app.ts",
    line: 13,
    endLine: 14,
    lineText: "  return user.name;",
    anchoring: "moved",
    raisedIn: 1,
    // Line 13 is a line of round 2's commit, not of the one it was raised on.
    anchoredIn: 2,
  });
  // The one not reported again stays where it was.
  expect(r.findings[1]).toEqual(TWO_OF_A_KIND[1]);
});

/** Two lines holding the same text, each with its own null check missing. */
const SAME_TEXT = (line: number) =>
  candidate("missing_null_check", "blocking", { line, text: "return null;" });

test("two bugs of a kind on two lines holding the same text are two findings, and each keeps its own (#63)", () => {
  const first = round([], outcome({ candidates: [SAME_TEXT(5), SAME_TEXT(20)] }));
  expect(first.findings.map((f) => [String(f.id), f.line])).toEqual([
    ["F1", 5],
    ["F2", 20],
  ]);
  // Round 2: one line added above both; both reported again, each pairs with the nearer stored line.
  const second = round(first.findings, outcome({ sha: SHA_2, candidates: [SAME_TEXT(21), SAME_TEXT(6)] }));
  expect(second.findings.map((f) => [String(f.id), f.status, f.line])).toEqual([
    ["F1", "open", 6],
    ["F2", "open", 21],
  ]);
  expect(second.raised).toEqual([]);
});

test("fixing one of two bugs on lines holding the same text verifies that one fixed, though the other is reported again (#63)", () => {
  const prior = round([], outcome({ candidates: [SAME_TEXT(5), SAME_TEXT(20)] })).findings;
  const r = round(
    prior,
    outcome({
      sha: SHA_2,
      // The fix removed two lines above F2, and the reviewer lists it again.
      candidates: [SAME_TEXT(18)],
      earlier: [
        { id: findingId("F1"), verdict: "gone", why: "Checked now." },
        { id: findingId("F2"), verdict: "present", why: "Still unchecked." },
      ],
    }),
  );
  expect(r.findings.map((f) => [String(f.id), f.status, f.line])).toEqual([
    ["F1", "verified_fixed", 5],
    ["F2", "open", 18],
  ]);
  expect(r.raised).toEqual([]);
});

test("a candidate a switched-off rule drops never hides one on the same line", () => {
  const r = round(
    [],
    outcome({
      candidates: [
        candidate("names_rule", "blocking", { line: 3, text: "return user.name;", rule: cites("names") }),
        candidate("missing_null_check", "blocking", { line: 3, text: "return user.name;" }),
      ],
    }),
  );
  expect(r.findings.map((f) => [String(f.id), f.fingerprints.meaning])).toEqual([
    ["F1", "missing_null_check"],
  ]);
});

test("the same category on an earlier finding's line, under another key, is that finding: still reported, not new", () => {
  const r = round(
    TWO_OF_A_KIND,
    outcome({
      sha: SHA_2,
      candidates: [candidate("null_dereference", "blocking", { line: 4, text: "return user.name;" })],
      earlier: [
        { id: findingId("F1"), verdict: "gone", why: "" },
        { id: findingId("F2"), verdict: "present", why: "" },
      ],
    }),
  );
  expect(ledgerAs(r.findings)).toEqual([
    ["F1", "open", true],
    ["F2", "open", true],
  ]);
  expect(r.raised).toEqual([]);
});

test("in one round, the same defect reported twice on its line is one finding, and so is the same category on one line, whatever its key", () => {
  const r = round(
    [],
    outcome({
      candidates: [
        candidate("missing_null_check", "blocking", { line: 3, text: "return user.name;" }),
        candidate("missing_null_check", "should_fix", { line: 3, text: "return user.name;" }),
        candidate("null_dereference", "blocking", { line: 3, text: "return user.name;" }),
        // Another category on that line is another finding.
        candidate("leaks_pii", "blocking", { line: 3, text: "return user.name;", category: "Security" }),
      ],
    }),
  );
  expect(r.findings.map((f) => [String(f.id), f.fingerprints.meaning, f.severity])).toEqual([
    ["F1", "missing_null_check", "blocking"],
    ["F2", "leaks_pii", "blocking"],
  ]);
});

test("without its line's text, a finding is known by its meaning alone: reported twice in a round, it is raised once", () => {
  const r = round(
    [],
    outcome({
      candidates: [
        candidate("same_defect", "blocking", { line: 3 }),
        candidate("same_defect", "should_fix", { line: 8, text: "return order.total;" }),
        candidate("other_defect", "should_fix", { line: 5 }),
      ],
    }),
  );
  expect(r.findings.map((f) => [String(f.id), f.fingerprints.meaning, f.line])).toEqual([
    ["F1", "same_defect", 3],
    ["F2", "other_defect", 5],
  ]);
});

// The loop's facts for the round's posts and result (ADR 0039): decided here, read as they are by `publish`.

test("the verdict reads only the findings that count on the pull request: clean, pass or blocking", () => {
  const cases: [string, Finding[], Verdict][] = [
    ["nothing", [], "clean"],
    ["an open Should fix", [earlier(1, "s", "open")], "pass"],
    [
      "an open Consider and an escalated Should fix",
      [earlier(1, "c", "open", "consider"), earlier(2, "s", "escalated")],
      "pass",
    ],
    ["an open blocking finding", [earlier(1, "s", "open"), earlier(2, "b", "open", "blocking")], "blocking"],
    ["an escalated blocking finding", [earlier(1, "b", "escalated", "blocking")], "blocking"],
    ["a verified fixed blocking finding", [earlier(1, "b", "verified_fixed", "blocking")], "clean"],
    [
      "a blocking finding kept off the pull request",
      [earlier(1, "b", "open", "blocking", { posted: false })],
      "clean",
    ],
    [
      "an open Should fix beside a blocking finding kept off the pull request",
      [earlier(1, "s", "open"), earlier(2, "b", "open", "blocking", { posted: false })],
      "pass",
    ],
  ];
  for (const [name, prior, verdict] of cases) {
    expect([name, round(prior, stillThere(prior)).verdict]).toEqual([name, verdict]);
  }
});

test("the agent's next action follows the loop: fix what is open, ask the owner on an escalation, stop when settled", () => {
  const cases: [string, Finding[], LoopState, NextAction][] = [
    ["an open finding", [earlier(1, "s", "open")], "open", "fix"],
    [
      "an escalated finding beside an open one",
      [earlier(1, "s", "open"), earlier(2, "b", "escalated", "blocking")],
      "needs_owner",
      "ask_human",
    ],
    [
      "only settled findings",
      [earlier(1, "s", "verified_fixed"), earlier(2, "d", "dismissed")],
      "settled",
      "stop",
    ],
    [
      "only a finding kept off the pull request",
      [earlier(1, "c", "open", "consider", { posted: false })],
      "settled",
      "stop",
    ],
  ];
  for (const [name, prior, loop, nextAction] of cases) {
    const r = round(prior, stillThere(prior));
    expect([name, r.loop, r.nextAction]).toEqual([name, loop, nextAction]);
  }
});

test("who must act on each finding: the agent on one open on the pull request, the owner on an escalated one, nobody on the rest", () => {
  const prior = [
    earlier(1, "open", "open", "blocking"),
    earlier(2, "escalated", "escalated", "blocking"),
    earlier(3, "hidden", "open", "consider", { posted: false }),
    earlier(4, "fixed", "verified_fixed", "blocking", { closedIn: 1, verifiedSha: SHA_1 }),
    earlier(5, "dismissed", "dismissed", "should_fix", { closedIn: 1, closedWhy: "Not ours." }),
    earlier(6, "withdrawn", "withdrawn", "should_fix", { closedIn: 1, closedWhy: "Intended." }),
  ];
  // Round 2 raises a new blocking finding (posted) and a new Consider (kept in the app by the later-round rule).
  const r = round(prior, {
    ...stillThere(prior),
    candidates: [candidate("new_blocking", "blocking", { line: 20 }), candidate("new_consider", "consider")],
  });
  expect(r.actionBy.map((a) => [String(a.id), a.by])).toEqual([
    ["F1", "agent"],
    ["F2", "human"],
    ["F3", "none"],
    ["F4", "none"],
    ["F5", "none"],
    ["F6", "none"],
    ["F7", "agent"],
    ["F8", "none"],
  ]);
});

test("the counts cover the posted findings only: the open ones by severity, every other status by itself (ADR 0039)", () => {
  const prior = [
    earlier(1, "b1", "open", "blocking"),
    earlier(2, "s1", "open"),
    earlier(3, "s2", "open"),
    earlier(4, "c1", "open", "consider"),
    earlier(5, "esc", "escalated", "blocking"),
    earlier(6, "fixed", "verified_fixed", "blocking", { closedIn: 1, verifiedSha: SHA_1 }),
    earlier(7, "wd", "withdrawn", "should_fix", { closedIn: 1, closedWhy: "Intended." }),
    earlier(8, "ack", "acknowledged", "should_fix", { closedIn: 1, closedWhy: "Later." }),
    earlier(9, "dis", "dismissed", "should_fix", { closedIn: 1, closedWhy: "Not ours." }),
    earlier(10, "obs", "obsolete", "should_fix", { closedIn: 1 }),
    // Kept off the pull request: in no count, whatever its status.
    earlier(11, "hidden_open", "open", "blocking", { posted: false }),
    earlier(12, "hidden_fixed", "verified_fixed", "consider", { posted: false, closedIn: 1 }),
  ];
  const r = round(prior, stillThere(prior));
  expect(r.counts).toEqual({
    open: { blocking: 1, should_fix: 2, consider: 1 },
    escalated: 1,
    verified_fixed: 1,
    withdrawn: 1,
    acknowledged: 1,
    dismissed: 1,
    obsolete: 1,
  });
  // The check's count is the same findings: open and escalated on the pull request.
  expect(r.open).toBe(5);
  // Kept in the app: unsettled and off the pull request, whatever its severity.
  expect(r.keptInApp).toBe(1);
});

test("a finding keeps the side and the range it was reported with, round after round", () => {
  // One on a removed line (the old file's line 42), one over head lines 10 to 14.
  const removed = candidate("dropped_check", "blocking", {
    location: { path: "src/app.ts", side: "base", line: 42, endLine: null },
  });
  const range = candidate("leaky_loop", "should_fix", {
    location: { path: "src/app.ts", side: "head", line: 10, endLine: 14 },
  });
  const where = (findings: Finding[]) =>
    findings.map((f) => `${f.id} ${f.side} ${f.line}-${f.endLine ?? "none"}`);
  const first = round([], outcome({ candidates: [removed, range] }));
  expect(where(first.findings)).toEqual(["F1 base 42-none", "F2 head 10-14"]);
  // Round 2 still sees both, and reports the range again: neither moves.
  const second = round(first.findings, { ...stillThere(first.findings), candidates: [range] });
  expect(where(second.findings)).toEqual(["F1 base 42-none", "F2 head 10-14"]);
});
