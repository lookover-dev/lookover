// Which engine may step in for one that can't review (ADR 0029, ADR 0047): the other one, when the owner uses it
// and it may review the change. Who finds is the round plan's (`plan.test.ts`).
import { expect, test } from "bun:test";
import type { Change, EngineId, Reviewers } from "@lookover/contracts";
import { stepIn } from "./index.ts";

test("a review waiting for one AI can go to the other only if the owner uses that other AI", () => {
  const cases: [Reviewers, EngineId, EngineId | null][] = [
    ["both", "claude", "codex"],
    ["both", "codex", "claude"],
    ["claude", "claude", null],
    ["codex", "codex", null],
    // The setting changed since the review was deferred: the AI the owner now uses takes it.
    ["claude", "codex", "claude"],
    ["codex", "claude", "codex"],
  ];
  for (const [reviewers, from, expected] of cases) {
    expect([reviewers, from, stepIn(from, reviewers, { author: "you", fork: false })]).toEqual([
      reviewers,
      from,
      expected,
    ]);
  }
});

test("Codex never steps in on another author's change (ADR 0044); Claude steps in on anyone's", () => {
  const cases: [Reviewers, EngineId, Change["author"], EngineId | null][] = [
    // Codex's change to step in to: only the owner's, or the owner's agent's (ADR 0016).
    ["both", "claude", "you", "codex"],
    ["both", "claude", "agent", "codex"],
    ["both", "claude", "other", null],
    ["codex", "claude", "other", null],
    // Claude may step in whoever's change it is.
    ["both", "codex", "other", "claude"],
    ["claude", "codex", "other", "claude"],
  ];
  for (const [reviewers, from, author, expected] of cases) {
    expect([reviewers, from, author, stepIn(from, reviewers, { author, fork: false })]).toEqual([
      reviewers,
      from,
      author,
      expected,
    ]);
  }
});

test("Codex never steps in on a fork change, whoever wrote it (ADR 0048); Claude does", () => {
  for (const author of ["you", "agent", "other"] satisfies Change["author"][]) {
    const fork = { author, fork: true };
    expect([author, stepIn("claude", "both", fork), stepIn("codex", "both", fork)]).toEqual([
      author,
      null,
      "claude",
    ]);
  }
});
