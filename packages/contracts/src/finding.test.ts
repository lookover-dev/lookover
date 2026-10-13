// The finding vocabulary of ADR 0030: seven statuses, of which only `open` and `escalated` are unsettled,
// and three severities. What a round or a dismissal does to findings is `core`'s, and tested there.
import { expect, test } from "bun:test";
import {
  bySeverity,
  type Finding,
  type FindingStatus,
  findingId,
  fingerprintWord,
  isCounted,
  isUnsettled,
  type Severity,
} from "./index.ts";

// `satisfies` fails to compile on a missing or an extra value: these lists are the whole vocabulary.
const STATUSES = {
  open: "unsettled",
  escalated: "unsettled",
  verified_fixed: "settled",
  acknowledged: "settled",
  withdrawn: "settled",
  dismissed: "settled",
  obsolete: "settled",
} as const satisfies Record<FindingStatus, "settled" | "unsettled">;
const SEVERITIES = { blocking: 1, should_fix: 2, consider: 3 } as const satisfies Record<Severity, number>;

function finding(status: FindingStatus, posted = true): Finding {
  return {
    id: findingId("f"),
    fingerprints: { location: "src/app.ts:1", meaning: "f" },
    severity: "should_fix",
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

test("only open and escalated findings are unsettled", () => {
  const all: FindingStatus[] = [
    "open",
    "escalated",
    "verified_fixed",
    "acknowledged",
    "withdrawn",
    "dismissed",
    "obsolete",
  ];
  expect(all.filter((status) => isUnsettled(finding(status)))).toEqual(["open", "escalated"]);
  expect(all.map((status) => STATUSES[status])).toEqual([
    "unsettled",
    "unsettled",
    "settled",
    "settled",
    "settled",
    "settled",
    "settled",
  ]);
  expect(Object.keys(SEVERITIES)).toEqual(["blocking", "should_fix", "consider"]);
});

test("a category or a kind key compares case and spacing aside", () => {
  expect(fingerprintWord("  Data   Safety ")).toBe("data_safety");
  expect(fingerprintWord("missing_null_check")).toBe("missing_null_check");
});

test("a finding counts on the pull request only while unsettled and posted (I-152)", () => {
  expect(isCounted(finding("open"))).toBe(true);
  expect(isCounted(finding("escalated"))).toBe(true);
  expect(isCounted(finding("open", false))).toBe(false);
  expect(isCounted(finding("verified_fixed"))).toBe(false);
});

test("findings are listed blocking, should fix, consider, the given order kept within a severity", () => {
  const items: { id: string; severity: Severity }[] = [
    { id: "a", severity: "consider" },
    { id: "b", severity: "should_fix" },
    { id: "c", severity: "blocking" },
    { id: "d", severity: "should_fix" },
  ];
  expect(bySeverity(items, (i) => i.severity).map((i) => i.id)).toEqual(["c", "b", "d", "a"]);
  expect(items.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
});
