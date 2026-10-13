// The loop (ADR 0029): where the back-and-forth stands, and what the owner's dismissal does to a change's
// findings. No round cap: nothing here counts rounds.
import { expect, test } from "bun:test";
import {
  type Finding,
  type FindingStatus,
  findingId,
  type LoopState,
  type Reconciled,
  type Severity,
} from "@lookover/contracts";
import { findingsAfterDismissal, loopState, standing } from "./index.ts";

function finding(
  id: string,
  status: FindingStatus,
  severity: Severity = "should_fix",
  { posted = true }: { posted?: boolean } = {},
): Finding {
  return {
    id: findingId(id),
    fingerprints: { location: `src/app.ts:1:${id}`, meaning: id },
    severity,
    category: "Correctness",
    title: id,
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
    status,
    posted,
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

const statusOf = (findings: Finding[]) => findings.map((f) => [String(f.id), f.status]);

test("the loop is settled with nothing open, open while the author has work, and needs the owner once a finding is escalated", () => {
  const cases: [FindingStatus[], LoopState][] = [
    [[], "settled"],
    [["verified_fixed", "withdrawn", "dismissed", "acknowledged", "obsolete"], "settled"],
    [["open", "verified_fixed"], "open"],
    [["escalated"], "needs_owner"],
    [["open", "escalated"], "needs_owner"],
  ];
  for (const [statuses, loop] of cases) {
    expect([statuses, loopState(statuses.map((s, i) => finding(`f${i}`, s)))]).toEqual([statuses, loop]);
  }
});

test("only posted findings count (I-152): one kept off the pull request never keeps the loop open", () => {
  const kept = finding("kept", "open", "should_fix", { posted: false });
  const posted = finding("posted", "open", "blocking");
  const fixed = finding("fixed", "verified_fixed", "blocking");
  expect(loopState([kept])).toBe("settled");
  expect(loopState([kept, fixed])).toBe("settled");
  expect(loopState([kept, posted])).toBe("open");
});

test("the owner settles an unsettled finding by dismissing it; a settled one stays as it was", () => {
  const after = findingsAfterDismissal(
    [finding("escalated-one", "escalated", "blocking"), finding("fixed-one", "verified_fixed")],
    [findingId("escalated-one"), findingId("fixed-one")],
    3,
  );
  expect(statusOf(after)).toEqual([
    ["escalated-one", "dismissed"],
    ["fixed-one", "verified_fixed"],
  ]);
  // The owner gives no reason: the words are the app's and GitHub's, never the ledger's.
  expect(after[0]).toMatchObject({ closedIn: 3, closedWhy: null });
  expect(loopState(after)).toBe("settled");
});

test("a round restated over the ledger after a dismissal: where the change stands now, what the round did kept", () => {
  const blocking = finding("F1", "open", "blocking");
  const other = finding("F2", "open", "should_fix");
  const kept = finding("F3", "open", "consider", { posted: false });
  const round: Reconciled = {
    findings: [blocking, other, kept],
    raised: [blocking, other, kept],
    post: [blocking, other],
    loop: "open",
    verdict: "blocking",
    nextAction: "fix",
    actionBy: [
      { id: findingId("F1"), by: "agent" },
      { id: findingId("F2"), by: "agent" },
      { id: findingId("F3"), by: "none" },
    ],
    conclusion: "neutral",
    open: 2,
    keptInApp: 1,
    counts: {
      open: { blocking: 1, should_fix: 1, consider: 0 },
      escalated: 0,
      verified_fixed: 0,
      acknowledged: 0,
      withdrawn: 0,
      dismissed: 0,
      obsolete: 0,
    },
    verifiedFixed: 0,
    replies: [{ findingId: findingId("F2"), kind: "kept", why: "Still there." }],
  };
  const ledger = findingsAfterDismissal(round.findings, [findingId("F1")], 1);
  expect(standing(round, ledger)).toEqual({
    findings: ledger,
    raised: round.raised,
    post: round.post,
    loop: "open",
    verdict: "pass",
    nextAction: "fix",
    actionBy: [
      { id: findingId("F1"), by: "none" },
      { id: findingId("F2"), by: "agent" },
      { id: findingId("F3"), by: "none" },
    ],
    conclusion: "success",
    open: 1,
    keptInApp: 1,
    counts: {
      open: { blocking: 0, should_fix: 1, consider: 0 },
      escalated: 0,
      verified_fixed: 0,
      acknowledged: 0,
      withdrawn: 0,
      dismissed: 1,
      obsolete: 0,
    },
    verifiedFixed: 0,
    replies: round.replies,
  });
  const none = findingsAfterDismissal(ledger, [findingId("F2")], 1);
  expect(standing(round, none)).toMatchObject({
    loop: "settled",
    verdict: "clean",
    nextAction: "stop",
    conclusion: "success",
    open: 0,
  });
});
