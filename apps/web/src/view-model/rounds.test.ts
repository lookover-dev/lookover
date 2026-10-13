// A round's row in the review's details (ADR 0055): who found and who double-checked it, and the tokens its
// sessions used, as the Rounds table shows them. Expected values written by hand.
import { expect, test } from "bun:test";
import { commitSha, type Round, type RoundSession } from "@lookover/contracts";
import { roundRow } from "./rounds.ts";

function round(extra: Partial<Round> = {}): Round {
  return {
    n: 1,
    sha: commitSha("703205d"),
    reviewer: "codex",
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

const session = (
  pass: RoundSession["pass"],
  engine: RoundSession["engine"],
  inputTokens: number,
  outputTokens: number,
): RoundSession => ({ pass, engine, ms: 1_000, usage: { inputTokens, outputTokens } });

test("commit: its first seven characters, as GitHub shortens it", () => {
  expect(roundRow(round({ sha: commitSha("a7b8c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3") })).commit).toBe(
    "a7b8c9d",
  );
});

test("by: the finder, then the confirmer", () => {
  expect(roundRow(round()).by).toBe("Codex → Claude");
});

test("by: the finder alone when nobody double-checked, or the confirm session gave no answer", () => {
  expect(roundRow(round({ confirmer: null })).by).toBe("Codex");
  expect(roundRow(round({ confirmFailure: "timeout" })).by).toBe("Codex");
});

test("by: the finder confirming its own round names it twice", () => {
  expect(roundRow(round({ reviewer: "claude", confirmer: "claude" })).by).toBe("Claude → Claude");
});

test("by: Deep's two finders, the second only when its pass answered", () => {
  const deep = { reviewer: "claude", confirmer: "codex" } as const;
  expect(roundRow(round({ ...deep, secondFind: { engine: "codex", failure: null } })).by).toBe(
    "Claude and Codex → Codex",
  );
  expect(roundRow(round({ ...deep, secondFind: { engine: "claude", failure: null } })).by).toBe(
    "Claude in two sessions → Codex",
  );
  expect(roundRow(round({ ...deep, secondFind: { engine: "codex", failure: "auth_required" } })).by).toBe(
    "Claude → Codex",
  );
});

test("tokens: every session's, in and out, in thousands past a thousand", () => {
  const sessions = [session("find", "codex", 20_027, 1_631), session("confirm", "claude", 900, 40)];
  expect(roundRow(round({ sessions })).tokens).toBe("21k in · 1.7k out");
});

test("tokens: small counts as they are, a thousand and up with one decimal below ten, millions as M", () => {
  expect(roundRow(round({ sessions: [session("find", "codex", 950, 12)] })).tokens).toBe("950 in · 12 out");
  expect(roundRow(round({ sessions: [session("find", "codex", 9_960, 1_000)] })).tokens).toBe(
    "10k in · 1k out",
  );
  expect(roundRow(round({ sessions: [session("find", "codex", 1_250_000, 999_600)] })).tokens).toBe(
    "1.3M in · 1M out",
  );
});

test("tokens: a dash when no session's CLI said any; the sessions that did count alone", () => {
  expect(roundRow(round()).tokens).toBe("—");
  const silent: RoundSession = { pass: "find", engine: "codex", ms: 9_000, usage: null };
  expect(roundRow(round({ sessions: [silent] })).tokens).toBe("—");
  expect(roundRow(round({ sessions: [silent, session("confirm", "claude", 1_600, 280)] })).tokens).toBe(
    "1.6k in · 280 out",
  );
});
