import { describe, expect, test } from "bun:test";
import { DEEP_MARGIN, decide, MIN_COMPARED_CASES, type Scores, type SetupScore } from "./index.ts";

interface Line {
  f05: number;
  found?: number;
  noise?: number;
}

/** A setup's score with the F0.5, bugs found and noise the rule reads; the rest stays at its empty value. */
function setup({ f05, found = 5, noise = 0 }: Line): SetupScore {
  const counts = { planted: 12, found, findings: 10, duplicates: 0, noise, recall: 0, precision: 1, f05 };
  return {
    kept: counts,
    all: counts,
    confirm: null,
    cost: { sessions: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, wallMs: 0 },
    missed: [],
  };
}

/** Scores over `compared` cases with Quick, Standard cross-model and Deep as given; the others score 0. */
function scores(compared: number, lines: { quick: Line; cross: Line; deep: Line }): Scores {
  return {
    compared: Array.from({ length: compared }, (_, i) => `case-${i}`),
    incomplete: [],
    setups: {
      quick: setup(lines.quick),
      "quick-codex": setup({ f05: 0 }),
      "standard-one": setup({ f05: 0 }),
      "standard-cross": setup(lines.cross),
      deep: setup(lines.deep),
    },
    findings: [],
  };
}

const CROSS: Line = { f05: 0.6, found: 6, noise: 1 };
const DEEP_WINS: Line = { f05: 0.66, found: 8, noise: 1 };

describe("the rule that picks the default (ADR 0050)", () => {
  test("its constants: thirteen complete cases, a margin of 0.05", () => {
    expect(MIN_COMPARED_CASES).toBe(13);
    expect(DEEP_MARGIN).toBe(0.05);
  });

  test("under thirteen complete cases there is no verdict, whoever wins", () => {
    expect(decide(scores(12, { quick: { f05: 0.9 }, cross: CROSS, deep: DEEP_WINS }))).toEqual({
      verdict: "no_verdict",
      compared: 12,
    });
  });

  test("Quick at Standard cross-model's F0.5 or above: the owner is asked, even when Deep also wins", () => {
    expect(decide(scores(13, { quick: { f05: 0.6 }, cross: CROSS, deep: DEEP_WINS }))).toEqual({
      verdict: "ask_owner",
      compared: 13,
    });
    expect(decide(scores(15, { quick: { f05: 0.7 }, cross: CROSS, deep: { f05: 0.5 } }))).toEqual({
      verdict: "ask_owner",
      compared: 15,
    });
  });

  test("Deep by more than the margin, two more bugs and no more noise becomes the default", () => {
    expect(decide(scores(13, { quick: { f05: 0.5 }, cross: CROSS, deep: DEEP_WINS }))).toEqual({
      verdict: "deep",
      compared: 13,
    });
  });

  test("Deep within the margin, one bug short or noisier: Standard stays", () => {
    const quick = { f05: 0.5 };
    const within = { ...DEEP_WINS, f05: 0.65 };
    const oneMore = { ...DEEP_WINS, found: 7 };
    const noisier = { ...DEEP_WINS, noise: 2 };
    for (const deep of [within, oneMore, noisier]) {
      expect(decide(scores(13, { quick, cross: CROSS, deep }))).toEqual({
        verdict: "standard",
        compared: 13,
      });
    }
  });

  test("neither Quick nor Deep wins: Standard stays", () => {
    expect(decide(scores(15, { quick: { f05: 0.4 }, cross: CROSS, deep: { f05: 0.55, found: 6 } }))).toEqual({
      verdict: "standard",
      compared: 15,
    });
  });
});
