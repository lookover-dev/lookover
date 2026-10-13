// How a review's findings read on screen: "To do" (escalated ones as "Needs you") and "Done" (ADR 0030).
import { expect, test } from "bun:test";
import {
  changeId,
  commitSha,
  emptyReview,
  type Finding,
  type FindingStatus,
  findingId,
  type Review,
  type Rule,
  repositoryId,
  type Severity,
} from "@lookover/contracts";
import {
  doneLine,
  findingGroups,
  findingTabs,
  needsYou,
  noiseChoices,
  onGitHub,
  placeText,
  replyLine,
  SEVERITY_LABEL,
  whyRaised,
} from "./findings.ts";

function finding(id: string, status: FindingStatus, extra: Partial<Finding> = {}): Finding {
  return {
    id: findingId(id),
    fingerprints: { location: `src/app.ts:1:${id}`, meaning: id },
    severity: "should_fix",
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

function review(findings: Finding[]): Review {
  return { ...emptyReview(changeId("app#1"), 0), findings };
}

const ids = (list: Finding[]) => list.map((f) => String(f.id));

test("a finding's place reads as publish words it on GitHub: one line or a range, on the new file or the old", () => {
  expect(placeText(finding("one", "open", { line: 42 }))).toBe("line 42");
  expect(placeText(finding("range", "open", { line: 42, endLine: 44 }))).toBe("lines 42 to 44");
  expect(placeText(finding("same", "open", { line: 42, endLine: 42 }))).toBe("line 42");
  expect(placeText(finding("old", "open", { side: "base", line: 42 }))).toBe("old line 42");
  expect(placeText(finding("old-range", "open", { side: "base", line: 42, endLine: 44 }))).toBe(
    "old lines 42 to 44",
  );
});

test("severities read Blocking, Should fix and Consider", () => {
  const all: Severity[] = ["blocking", "should_fix", "consider"];
  expect(all.map((s) => SEVERITY_LABEL[s])).toEqual(["Blocking", "Should fix", "Consider"]);
});

test("unsettled findings are to do, escalated ones first; every other status is done", () => {
  const groups = findingGroups(
    review([
      finding("a", "open"),
      finding("b", "verified_fixed"),
      finding("c", "escalated"),
      finding("d", "withdrawn"),
      finding("e", "dismissed"),
      finding("f", "acknowledged"),
      finding("g", "obsolete"),
      finding("h", "open"),
    ]),
  );
  expect(ids(groups.todo)).toEqual(["c", "a", "h"]);
  expect(ids(groups.done)).toEqual(["b", "d", "e", "f", "g"]);
});

test("to do lists what matters most first, as the pull request does: blocking, should fix, consider", () => {
  const groups = findingGroups(
    review([
      finding("a", "open", { severity: "consider" }),
      finding("b", "open", { severity: "should_fix" }),
      finding("c", "open", { severity: "blocking" }),
      finding("d", "escalated", { severity: "consider" }),
      finding("e", "open", { severity: "should_fix" }),
    ]),
  );
  // What needs you stays first; within each, the ledger's order.
  expect(ids(groups.todo)).toEqual(["d", "c", "b", "e", "a"]);
});

test("only an escalated finding needs you", () => {
  expect(needsYou(finding("a", "escalated"))).toBe(true);
  expect(needsYou(finding("a", "open"))).toBe(false);
});

test("the tabs are To do and Done, each only when it has findings", () => {
  expect(findingTabs(review([finding("a", "open"), finding("b", "verified_fixed")]))).toEqual([
    { value: "todo", label: "To do", count: 1 },
    { value: "done", label: "Done", count: 1 },
  ]);
  expect(findingTabs(review([finding("b", "withdrawn")]))).toEqual([
    { value: "done", label: "Done", count: 1 },
  ]);
  expect(findingTabs(review([]))).toEqual([]);
});

test("a finding verified fixed says on which commit, by its first seven characters, and in which round", () => {
  const whole = commitSha("9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6");
  const fixed = finding("a", "verified_fixed", { verifiedSha: whole, closedIn: 3 });
  expect(doneLine(fixed)).toEqual({ kind: "verified", sha: "9f8e7d6", round: 3 });
});

test("a finding is on GitHub when it was posted, and never after a preview", () => {
  const posted = finding("a", "open");
  const kept = finding("b", "open", { posted: false });
  expect(onGitHub(review([posted, kept]), posted)).toBe(true);
  expect(onGitHub(review([posted, kept]), kept)).toBe(false);
  expect(onGitHub({ ...review([posted]), preview: true }, posted)).toBe(false);
});

test("any other settled finding says why", () => {
  const why = 'The agent replied: "Intended." The reviewer agreed.';
  expect(doneLine(finding("a", "withdrawn", { closedWhy: why }))).toEqual({ kind: "why", text: why });
  expect(doneLine(finding("a", "obsolete"))).toEqual({ kind: "why", text: "No longer in the code." });
  // The owner gives no reason when dismissing (ADR 0052): the app says what it was.
  expect(doneLine(finding("a", "dismissed"))).toEqual({ kind: "why", text: "You marked it as wrong." });
  expect(doneLine(finding("a", "acknowledged"))).toEqual({
    kind: "why",
    text: "The reviewer accepted the reply.",
  });
});

test("why a finding was raised: the rule it follows, and where that rule is (ADR 0048)", () => {
  const rule = { id: "7c1e0a9d3b2f4e58", file: "REVIEW.md" as const, line: 12 };
  const cites = finding("F1", "open", { rule, why: { ruleText: "Never log a secret." } });
  expect(whyRaised(cites)).toBe("Never log a secret. (REVIEW.md, line 12)");
  // The rule's text not read this round: where it is, still.
  expect(whyRaised(finding("F2", "open", { rule }))).toBe("REVIEW.md, line 12");
  expect(whyRaised(finding("F3", "open"))).toBeNull();
});

test("a reply on a finding's thread reads as the claim a round read: the agent's on its loop, else by its writer's login, with Lookover keeping it once (ADR 0052)", () => {
  const claim = {
    kind: "wont_fix" as const,
    text: "Won't fix: the provider only calls us from its own IP range.",
    by: "sasensi",
    at: "2026-10-10T09:00:00.000Z",
    commentId: 100002,
  };
  const text = "Won't fix: the provider only calls us from its own IP range.";
  const answered = finding("F1", "open", { claim, kept: 1 });
  expect(replyLine({ author: "you", writtenBy: "claude" }, answered)).toEqual({
    head: "Agent's reply:",
    text,
    kept: "Kept once.",
  });
  expect(replyLine({ author: "you", writtenBy: null }, answered)).toEqual({
    head: "Reply from sasensi:",
    text,
    kept: "Kept once.",
  });
  expect(
    replyLine(
      { author: "other", writtenBy: "codex" },
      { ...answered, kept: 0, claim: { ...claim, by: "mira" } },
    ),
  ).toEqual({ head: "Reply from mira:", text, kept: null });
  // The second keep escalates: "Needs you" says it, never "Kept twice".
  const escalated = finding("F1", "escalated", { claim, kept: 2 });
  expect(replyLine({ author: "you", writtenBy: "claude" }, escalated)?.kept).toBeNull();
  expect(replyLine({ author: "you", writtenBy: "claude" }, finding("F2", "open"))).toBeNull();
});

test('"Too noisy?" offers turning off the rule a finding cites and posting only blocking findings, each with what it would have removed from the last reviews (ADR 0049)', () => {
  const cited = { id: "7c1e0a9d3b2f4e58", file: "REVIEW.md" as const, line: 12 };
  const rule: Rule = {
    id: cited.id,
    repoId: repositoryId("sam/app"),
    source: "REVIEW.md",
    line: 12,
    text: "Never log a secret.",
    enabled: true,
    parentOff: false,
    nested: 0,
    raised: 9,
    acted: 4,
  };
  const cites = finding("F1", "open", { rule: cited });
  const on = {
    changeId: changeId("app#1"),
    repo: "my-app",
    strictness: "recommended" as const,
    noise: { reviews: 12, postedBelowBlocking: 7, raisedByRule: { [cited.id]: 3 } },
    rules: [rule],
    onHead: true,
  };
  const [wrong, ...choices] = noiseChoices(on, cites);
  expect(wrong?.choice.kind).toBe("wrong");
  expect(choices.map((c) => [c.label, c.named, c.hint, c.choice])).toEqual([
    [
      "Turn off the rule",
      undefined,
      "3 fewer findings in your last 12 reviews",
      { kind: "rule-off", changeId: changeId("app#1"), findingId: findingId("F1") },
    ],
    [
      "Only post blocking findings in my-app",
      "my-app",
      "7 fewer findings posted in your last 12 reviews",
      { kind: "blocking-only", changeId: changeId("app#1") },
    ],
  ]);
  expect(choices.map((c) => [c.effect, c.saved])).toEqual([
    [
      'From the next review, Lookover stops following "Never log a secret." in my-app. That would have been 3 fewer findings in your last 12 reviews.',
      'Saved. The rule "Never log a secret." is off.',
    ],
    [
      "From the next review, only blocking findings are posted in my-app. The others stay in the check run and here. That would have been 7 fewer findings posted in your last 12 reviews.",
      'Saved. Strictness is now "Only blocking findings" for my-app.',
    ],
  ]);
  // The settings' choices, without "This finding is wrong", which every posted finding still unsettled has.
  const quieter = (o: Parameters<typeof noiseChoices>[0], f: Finding) =>
    noiseChoices(o, f).filter((c) => c.choice.kind !== "wrong");
  // One review counted, the rule raising nothing in it: "1 fewer", "0 fewer", "your last review".
  const one = quieter({ ...on, noise: { reviews: 1, postedBelowBlocking: 1, raisedByRule: {} } }, cites);
  expect(one.map((c) => c.hint)).toEqual([
    "0 fewer findings in your last review",
    "1 fewer finding posted in your last review",
  ]);
  // Not counted yet, or nothing reviewed yet: no number, no sentence about it.
  const { noise: _, ...uncounted } = on;
  const none = { reviews: 0, postedBelowBlocking: 0, raisedByRule: {} };
  for (const choices of [quieter(uncounted, cites), quieter({ ...on, noise: none }, cites)]) {
    expect(choices.map((c) => [c.hint, c.effect])).toEqual([
      [undefined, 'From the next review, Lookover stops following "Never log a secret." in my-app.'],
      [
        undefined,
        "From the next review, only blocking findings are posted in my-app. The others stay in the check run and here.",
      ],
    ]);
  }
  // A rule with rules under it says so: they go off with it, and its count holds theirs (Lookover #156 F4).
  const [parent] = quieter({ ...on, rules: [{ ...rule, nested: 2 }] }, cites);
  expect([parent?.hint, parent?.effect, parent?.saved]).toEqual([
    "3 fewer findings in your last 12 reviews",
    'From the next review, Lookover stops following "Never log a secret." and the rules under it in my-app. That would have been 3 fewer findings in your last 12 reviews.',
    'Saved. The rule "Never log a secret." and the rules under it are off.',
  ]);
  // Off with a rule it sits in: nothing to turn off.
  expect(quieter({ ...on, rules: [{ ...rule, parentOff: true }] }, cites).map((c) => c.choice.kind)).toEqual([
    "blocking-only",
  ]);
  // A blocking finding offers its rule only; at strictness "Only blocking findings", so does any finding.
  const blocking = finding("F2", "open", { severity: "blocking", rule: cited });
  expect(quieter(on, blocking).map((c) => c.choice.kind)).toEqual(["rule-off"]);
  expect(quieter({ ...on, strictness: "blocking" }, cites).map((c) => c.choice.kind)).toEqual(["rule-off"]);
  // A rule already off, or no longer in the rules files, isn't offered; a finding with no choice has none.
  expect(quieter({ ...on, rules: [{ ...rule, enabled: false }] }, cites).map((c) => c.choice.kind)).toEqual([
    "blocking-only",
  ]);
  const settledBlocking = finding("F2", "acknowledged", { severity: "blocking", rule: cited });
  expect(noiseChoices({ ...on, rules: [] }, settledBlocking)).toEqual([]);
  expect(quieter({ ...on, strictness: "everything" }, finding("F3", "open"))).toHaveLength(1);
});

test('"This finding is wrong" is offered on any posted finding still unsettled, blocking ones too, first (ADR 0052)', () => {
  const on = {
    changeId: changeId("app#1"),
    repo: "my-app",
    strictness: "blocking" as const,
    rules: [],
    onHead: true,
  };
  const inline = finding("F1", "open", { severity: "blocking", commented: true });
  const [wrong, ...rest] = noiseChoices(on, inline);
  expect(rest).toEqual([]);
  expect(wrong).toEqual({
    label: "This finding is wrong",
    hint: "keep it out of future rounds",
    choice: { kind: "wrong", changeId: changeId("app#1"), findingId: findingId("F1") },
    effect:
      "The finding is dismissed here and on GitHub: Lookover says so on its thread, hides its comment, and updates the summary and the check. It won't be raised again on this pull request.",
    saved: "Marked as wrong. The finding is dismissed.",
  });
  // In the summary only, it has no thread: the summary and the check say it.
  const summaryOnly = noiseChoices(on, finding("F2", "escalated", { commented: false }));
  expect(summaryOnly.map((c) => [c.choice.kind, c.effect])).toEqual([
    [
      "wrong",
      "The finding is dismissed here and on GitHub: Lookover updates the summary and the check. It won't be raised again on this pull request.",
    ],
  ]);
  // A commit pushed since the latest round: its check is on an older commit, and stays as it is.
  const pushed = { ...on, onHead: false };
  expect(
    [inline, finding("F2", "escalated", { commented: false })].map((f) => noiseChoices(pushed, f)[0]?.effect),
  ).toEqual([
    "The finding is dismissed here and on GitHub: Lookover says so on its thread, hides its comment, and updates the summary. The check stays: it is on an older commit. It won't be raised again on this pull request.",
    "The finding is dismissed here and on GitHub: Lookover updates the summary. The check stays: it is on an older commit. It won't be raised again on this pull request.",
  ]);
  // Kept off the pull request, or settled: nothing on GitHub to dismiss.
  expect(noiseChoices(on, finding("F3", "open", { posted: false }))).toEqual([]);
  for (const status of ["verified_fixed", "withdrawn", "dismissed", "acknowledged", "obsolete"] as const)
    expect(noiseChoices(on, finding("F4", status))).toEqual([]);
});
