import { describe, expect, test } from "bun:test";
import {
  type CandidateFinding,
  type Confirmation,
  type DiffSide,
  type Finding,
  findingId,
  NOT_CHECKED,
  type RuledOut,
} from "@lookover/contracts";
import {
  type CaseResult,
  type EvalCase,
  type Planted,
  type ScoredFinding,
  SETUPS,
  type SessionName,
  type SessionRecord,
  type SetupName,
  type SetupResult,
  score,
} from "./index.ts";

/** A case planting `ranges` in `src/a.ts`, or a clean one. */
function evalCase(id: string, ranges: Planted["ranges"] | null): EvalCase {
  return {
    id,
    language: "typescript",
    summary: "A change.",
    base: [{ path: "src/a.ts", content: "a\n" }],
    change: [{ path: "src/a.ts", content: "b\n" }],
    planted: ranges === null ? null : { path: "src/a.ts", ranges, what: "A bug." },
  };
}

interface At {
  file?: string;
  side?: DiffSide;
  endLine?: number;
  posted?: boolean;
  confirmation?: Confirmation;
}

let next = 0;
/** A finding titled `title`, on `line` of `src/a.ts`'s head side unless `at` says otherwise. */
function finding(title: string, line: number, at: At = {}): Finding {
  next += 1;
  return {
    id: findingId(`F${next}`),
    fingerprints: { location: `l${next}`, meaning: `m${next}` },
    severity: "should_fix",
    category: "correctness",
    title,
    file: at.file ?? "src/a.ts",
    side: at.side ?? "head",
    line,
    endLine: at.endLine ?? null,
    lineText: null,
    anchoring: "reported",
    body: "When X, Y breaks.",
    foundBy: "claude",
    confirmation: at.confirmation ?? NOT_CHECKED,
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    status: "open",
    posted: at.posted ?? true,
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

/** A candidate the confirmer refuted, titled `title`, on `line` of `src/a.ts`'s head side. */
function refuted(title: string, line: number): RuledOut {
  const candidate: CandidateFinding = {
    severity: "should_fix",
    category: "correctness",
    title,
    body: "When X, Y breaks.",
    location: { path: "src/a.ts", side: "head", line, endLine: null },
    lineText: null,
    anchoring: "reported",
    foundBy: "claude",
    defectKey: "bug",
    suggestion: null,
    preExisting: false,
    rule: null,
    fingerprints: { location: title, meaning: title },
  };
  return { candidate, by: "codex", reason: "Not a bug.", evidence: [] };
}

/** A complete setup that kept `kept` and raised `hidden` besides, spending its setup's sessions. */
function complete(
  setup: SetupName,
  kept: Finding[],
  more: { hidden?: Finding[]; hiddenFirst?: boolean; ruledOut?: RuledOut[]; sessions?: SessionName[] } = {},
): SetupResult {
  const shape = SETUPS[setup];
  const sessions: SessionName[] = more.sessions ?? [
    ...shape.finds,
    ...(shape.confirm === null ? [] : [shape.confirm]),
  ];
  return {
    kind: "complete",
    kept,
    all: more.hiddenFirst ? [...(more.hidden ?? []), ...kept] : [...kept, ...(more.hidden ?? [])],
    judged: [],
    ruledOut: more.ruledOut ?? [],
    confirmer: null,
    sessions,
  };
}

/** Every setup complete with nothing kept, `setups` overriding some. */
function result(caseId: string, setups: Partial<Record<SetupName, SetupResult>> = {}): CaseResult {
  return {
    caseId,
    sessions: {},
    setups: {
      quick: setups.quick ?? complete("quick", []),
      "quick-codex": setups["quick-codex"] ?? complete("quick-codex", []),
      "standard-one": setups["standard-one"] ?? complete("standard-one", []),
      "standard-cross": setups["standard-cross"] ?? complete("standard-cross", []),
      deep: setups.deep ?? complete("deep", []),
    },
  };
}

describe("which planted bug a finding found", () => {
  test("a finding finds a bug at 10-12 within three lines of it: 14 does, 16 doesn't", () => {
    const scores = score(
      [evalCase("near", [[10, 12]]), evalCase("far", [[10, 12]])],
      [
        result("near", { quick: complete("quick", [finding("Near", 14)]) }),
        result("far", { quick: complete("quick", [finding("Far", 16)]) }),
      ],
    );
    expect(scores.setups.quick.kept.found).toBe(1);
    expect(scores.findings.filter((f) => f.setup === "quick")).toEqual([
      {
        caseId: "near",
        setup: "quick",
        file: "src/a.ts",
        line: 14,
        title: "Near",
        kept: true,
        match: "found",
        fromAlso: false,
      },
      {
        caseId: "far",
        setup: "quick",
        file: "src/a.ts",
        line: 16,
        title: "Far",
        kept: true,
        match: "unmatched",
        fromAlso: false,
      },
    ]);
  });

  test("a bug with two ranges is found near either, once; another file, the base side or far off finds nothing", () => {
    const twoRanges: Planted["ranges"] = [
      [3, 3],
      [20, 22],
    ];
    const scores = score(
      [evalCase("two", twoRanges)],
      [
        result("two", {
          quick: complete("quick", [
            finding("Wrong file", 20, { file: "src/b.ts" }),
            finding("Base side", 20, { side: "base" }),
            finding("Between", 12),
            finding("Starts four lines after", 26, { endLine: 30 }),
            finding("Near the call", 1),
            finding("Near the callee", 25),
          ]),
        }),
      ],
    );
    expect(scores.findings.map((f) => [f.title, f.match])).toEqual([
      ["Wrong file", "unmatched"],
      ["Base side", "unmatched"],
      ["Between", "unmatched"],
      ["Starts four lines after", "unmatched"],
      ["Near the call", "found"],
      ["Near the callee", "duplicate"],
    ]);
    expect(scores.setups.quick.kept.found).toBe(1);
    expect(scores.setups.quick.kept.duplicates).toBe(1);
  });

  test("a bug's other place finds it once; a second finding on it is a duplicate; a finding elsewhere matches nothing", () => {
    const placed: EvalCase = {
      ...evalCase("placed", [[3, 3]]),
      change: [
        { path: "src/a.ts", content: "b\n" },
        { path: "src/a.test.ts", content: "t\n" },
      ],
    };
    placed.planted = {
      path: "src/a.ts",
      ranges: [[3, 3]],
      also: [{ path: "src/a.test.ts", ranges: [[10, 12]] }],
      what: "A bug.",
    };
    const scores = score(
      [placed],
      [
        result("placed", {
          quick: complete("quick", [
            finding("No test covers it", 14, { file: "src/a.test.ts" }),
            finding("At the bug", 3),
            finding("Far in the test", 20, { file: "src/a.test.ts" }),
          ]),
          deep: complete("deep", [
            finding("At the bug", 4),
            finding("In the test", 11, { file: "src/a.test.ts" }),
          ]),
        }),
      ],
    );
    expect(scores.findings.map((f) => [f.setup, f.title, f.match, f.fromAlso])).toEqual([
      ["quick", "No test covers it", "found", true],
      ["quick", "At the bug", "duplicate", false],
      ["quick", "Far in the test", "unmatched", false],
      ["deep", "At the bug", "found", false],
      ["deep", "In the test", "duplicate", true],
    ]);
    expect(scores.setups.quick.kept).toMatchObject({ found: 1, duplicates: 1, findings: 3 });
    expect(scores.setups.quick.missed).toEqual([]);
  });

  test("a finding whose range starts before the bug and ends within three lines of it finds it", () => {
    const scores = score(
      [evalCase("span", [[20, 22]])],
      [
        result("span", {
          quick: complete("quick", [finding("Span", 5, { endLine: 17 }), finding("Early", 16)]),
        }),
      ],
    );
    expect(scores.findings.map((f) => [f.title, f.match])).toEqual([
      ["Span", "found"],
      ["Early", "unmatched"],
    ]);
  });
});

describe("a setup's numbers over the corpus", () => {
  test("a setup that kept nothing: precision 1, recall and F0.5 0, nothing listed", () => {
    const scores = score([evalCase("a", [[10, 12]]), evalCase("c", null)], [result("a"), result("c")]);
    expect(scores.setups.quick.kept).toEqual({
      planted: 1,
      found: 0,
      findings: 0,
      duplicates: 0,
      noise: 0,
      recall: 0,
      precision: 1,
      f05: 0,
    });
    expect(scores.setups.quick.missed).toEqual(["a"]);
    expect(scores.findings).toEqual([]);
  });

  test("a three-case corpus: found, duplicates, noise, precision, recall and F0.5, kept and all", () => {
    const scores = score(
      [evalCase("a", [[10, 12]]), evalCase("b", [[5, 5]]), evalCase("c", null)],
      [
        result("a", {
          "standard-cross": complete("standard-cross", [
            finding("A bug", 11),
            finding("A again", 13),
            finding("A far", 40),
          ]),
        }),
        result("b", {
          "standard-cross": complete("standard-cross", [finding("B far", 30)], {
            hidden: [finding("B hidden", 6, { posted: false })],
          }),
        }),
        result("c", { "standard-cross": complete("standard-cross", [finding("C noise", 2)]) }),
      ],
    );
    const cross = scores.setups["standard-cross"];
    // Kept: 5 findings, 1 duplicate; 1 of 2 bugs found. Precision 1/4, recall 1/2,
    // F0.5 = 1.25 * 1/4 * 1/2 / (0.25 * 1/4 + 1/2) = 0.15625 / 0.5625 = 5/18.
    expect(cross.kept).toEqual({
      planted: 2,
      found: 1,
      findings: 5,
      duplicates: 1,
      noise: 1,
      recall: 0.5,
      precision: 0.25,
      f05: 5 / 18,
    });
    // All: the hidden one finds b's bug. Precision 2/5, recall 1, F0.5 = 1.25 * 0.4 / (0.1 + 1) = 5/11.
    expect(cross.all).toEqual({
      planted: 2,
      found: 2,
      findings: 6,
      duplicates: 1,
      noise: 1,
      recall: 1,
      precision: 0.4,
      f05: 5 / 11,
    });
    expect(cross.missed).toEqual(["b"]);
    expect(scores.compared).toEqual(["a", "b", "c"]);
    const row = (
      caseId: string,
      line: number,
      title: string,
      kept: boolean,
      match: ScoredFinding["match"],
    ): ScoredFinding => ({
      caseId,
      setup: "standard-cross",
      file: "src/a.ts",
      line,
      title,
      kept,
      match,
      fromAlso: false,
    });
    expect(scores.findings).toEqual([
      row("a", 11, "A bug", true, "found"),
      row("a", 13, "A again", true, "duplicate"),
      row("a", 40, "A far", true, "unmatched"),
      row("b", 30, "B far", true, "unmatched"),
      row("b", 6, "B hidden", false, "found"),
      row("c", 2, "C noise", true, "unmatched"),
    ]);
  });

  test("a hidden finding the finder gave before the kept one is a duplicate of it: the kept finding found the bug", () => {
    const scores = score(
      [evalCase("a", [[10, 12]])],
      [
        result("a", {
          quick: complete("quick", [finding("Kept", 12)], {
            hidden: [finding("Hidden", 11, { posted: false })],
            hiddenFirst: true,
          }),
        }),
      ],
    );
    expect(scores.findings.map((f) => [f.title, f.kept, f.match])).toEqual([
      ["Kept", true, "found"],
      ["Hidden", false, "duplicate"],
    ]);
    expect(scores.setups.quick.all.found).toBe(1);
    expect(scores.setups.quick.all.duplicates).toBe(1);
  });

  test("the confirm measurement: planted bugs refuted, unmatched candidates refuted, demoted, per confirmer", () => {
    const demoted: Confirmation = {
      verdict: "unsure",
      by: "codex",
      reason: "Maybe.",
      evidence: [],
      demoted: true,
    };
    const scores = score(
      [evalCase("a", [[10, 12]]), evalCase("b", [[10, 12]]), evalCase("c", null)],
      [
        result("a", {
          "standard-cross": complete("standard-cross", [finding("Kept", 40, { confirmation: demoted })], {
            ruledOut: [refuted("The bug", 10), refuted("The bug again", 12), refuted("Far", 50)],
          }),
          deep: complete("deep", [finding("Kept", 40, { confirmation: demoted })], {
            ruledOut: [refuted("Far", 50)],
          }),
        }),
        // A kept finding found b's bug: the refuted candidate on it lost nothing, and isn't unmatched either.
        result("b", {
          "standard-cross": complete("standard-cross", [finding("Found", 11)], {
            ruledOut: [refuted("The bug too", 10)],
          }),
        }),
        result("c", {
          "standard-cross": complete("standard-cross", [], { ruledOut: [refuted("Noise", 1)] }),
          "standard-one": complete("standard-one", [], { ruledOut: [refuted("Noise", 1)] }),
        }),
      ],
    );
    expect(scores.setups["standard-cross"].confirm).toEqual({
      confirmer: "codex",
      plantedRefuted: 1,
      unmatchedRefuted: 2,
      demoted: 1,
    });
    expect(scores.setups["standard-one"].confirm).toEqual({
      confirmer: "claude",
      plantedRefuted: 0,
      unmatchedRefuted: 1,
      demoted: 0,
    });
    expect(scores.setups.deep.confirm).toEqual({
      confirmer: "codex",
      plantedRefuted: 0,
      unmatchedRefuted: 1,
      demoted: 1,
    });
    expect(scores.setups.quick.confirm).toBeNull();
  });

  test("cost: the sessions a setup spent, their tokens when reported, and their wall time", () => {
    const ran = (
      session: SessionName,
      usage: { inputTokens: number; outputTokens: number } | null,
      wallMs: number,
    ): SessionRecord => ({
      session,
      text: "",
      json: null,
      usage,
      wallMs,
      cli: { name: "claude", version: "2.1.0", model: "opus" },
      outcome: "ok",
      failure: null,
    });
    const sessions: CaseResult["sessions"] = {
      "claude-find": ran("claude-find", { inputTokens: 100, outputTokens: 10 }, 1000),
      "codex-confirms-claude": ran("codex-confirms-claude", null, 500),
      "claude-confirms-claude": { session: "claude-confirms-claude", outcome: "no_candidates" },
    };
    // Its confirm had nothing to judge: Standard one engine spent the find alone.
    const findOnly = complete("standard-one", [], { sessions: ["claude-find"] });
    const scores = score(
      [evalCase("a", [[10, 12]]), evalCase("b", null)],
      [
        { ...result("a", { "standard-one": findOnly }), sessions },
        { ...result("b", { "standard-one": findOnly }), sessions },
      ],
    );
    expect(scores.setups["standard-one"].cost).toEqual({
      sessions: 2,
      inputTokens: 200,
      outputTokens: 20,
      unknownUsage: 0,
      wallMs: 2000,
    });
    expect(scores.setups["standard-cross"].cost).toEqual({
      sessions: 4,
      inputTokens: 200,
      outputTokens: 20,
      unknownUsage: 2,
      wallMs: 3000,
    });
    expect(scores.setups.quick.cost).toEqual({
      sessions: 2,
      inputTokens: 200,
      outputTokens: 20,
      unknownUsage: 0,
      wallMs: 2000,
    });
  });
});

describe("the cases compared", () => {
  test("a case with a setup missing, or no result, is scored for no setup and listed apart", () => {
    const missing: SetupResult = { kind: "missing", session: "codex-find", reason: "timeout" };
    const scores = score(
      [evalCase("a", [[10, 12]]), evalCase("b", [[10, 12]]), evalCase("c", [[10, 12]])],
      [
        result("a", { quick: complete("quick", [finding("Found", 10)]) }),
        result("b", {
          quick: complete("quick", [finding("Found", 10)]),
          "quick-codex": missing,
          deep: missing,
        }),
      ],
    );
    expect(scores.compared).toEqual(["a"]);
    expect(scores.incomplete).toEqual([
      { caseId: "b", setups: ["quick-codex", "deep"] },
      { caseId: "c", setups: ["quick", "quick-codex", "standard-one", "standard-cross", "deep"] },
    ]);
    expect(scores.setups.quick.kept.planted).toBe(1);
    expect(scores.setups.quick.kept.found).toBe(1);
  });

  test("a result for a case the corpus doesn't hold is refused", () => {
    expect(() => score([evalCase("a", null)], [result("a"), result("ghost")])).toThrow("ghost");
  });

  test("two results for one case are refused", () => {
    expect(() => score([evalCase("a", null)], [result("a"), result("a")])).toThrow(
      "two results for the case a",
    );
  });
});
