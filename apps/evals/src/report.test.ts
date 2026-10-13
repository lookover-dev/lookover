// The report (ADR 0050) through the package's entry: Markdown from scores written by hand, every expected line
// written by hand from the record's words and the numbers below.
import { describe, expect, test } from "bun:test";
import {
  type Counts,
  type Decision,
  type EvalCase,
  type ReportMeta,
  report,
  type Scores,
  type SetupScore,
} from "./index.ts";

const PLANTED = {
  path: "src/prices.ts",
  what: "The loop starts at 1, so | the first price is lost.",
};
const BUG: EvalCase = {
  id: "ts-sum-prices",
  language: "typescript",
  summary: "Adds the average of a list of prices.",
  base: [{ path: "src/prices.ts", content: "export const sum = 0;\n" }],
  change: [{ path: "src/prices.ts", content: "export const sum = 1;\n" }],
  planted: { ...PLANTED, ranges: [[3, 3]] },
};
const CLEAN: EvalCase = { ...BUG, id: "py-rename-total", language: "python", planted: null };
const LEFT_OUT: EvalCase = {
  ...BUG,
  id: "ts-left-out",
  planted: {
    ...PLANTED,
    ranges: [
      [2, 4],
      [9, 9],
    ],
  },
};

const counts = (c: Partial<Counts>): Counts => ({
  planted: 1,
  found: 0,
  findings: 0,
  duplicates: 0,
  noise: 0,
  recall: 0,
  precision: 1,
  f05: 0,
  ...c,
});

const setup = (kept: Partial<Counts>, more: Partial<SetupScore> = {}): SetupScore => ({
  kept: counts(kept),
  all: counts(kept),
  confirm: null,
  cost: { sessions: 2, inputTokens: 31_000, outputTokens: 1_200, unknownUsage: 0, wallMs: 164_000 },
  missed: [],
  ...more,
});

const SCORES: Scores = {
  compared: ["ts-sum-prices", "py-rename-total"],
  incomplete: [{ caseId: "ts-left-out", setups: ["quick-codex", "deep"] }],
  setups: {
    quick: setup(
      { found: 1, findings: 3, noise: 1, recall: 1, precision: 1 / 3, f05: 0.3846153846 },
      {
        all: counts({
          found: 1,
          findings: 4,
          duplicates: 1,
          noise: 1,
          recall: 1,
          precision: 1 / 3,
          f05: 0.38,
        }),
        cost: { sessions: 2, inputTokens: 30_000, outputTokens: 1_250, unknownUsage: 0, wallMs: 82_000 },
      },
    ),
    "quick-codex": setup({ found: 1, findings: 1, recall: 1, precision: 1, f05: 1 }),
    "standard-one": setup(
      { found: 1, findings: 2, recall: 1, precision: 0.5, f05: 0.5555555556 },
      { confirm: { confirmer: "claude", plantedRefuted: 0, unmatchedRefuted: 1, demoted: 0 } },
    ),
    "standard-cross": setup(
      { found: 0, findings: 2, noise: 1, precision: 0, f05: 0 },
      {
        confirm: { confirmer: "codex", plantedRefuted: 1, unmatchedRefuted: 0, demoted: 2 },
        missed: ["ts-sum-prices"],
        cost: { sessions: 4, inputTokens: 1_234_567, outputTokens: 0, unknownUsage: 1, wallMs: 3_725_000 },
      },
    ),
    deep: setup(
      { found: 1, findings: 2, recall: 1, precision: 0.5, f05: 0.5555555556 },
      { confirm: { confirmer: "codex", plantedRefuted: 0, unmatchedRefuted: 1, demoted: 0 } },
    ),
  },
  findings: [
    {
      caseId: "ts-sum-prices",
      setup: "quick",
      file: "src/prices.ts",
      line: 3,
      title: "sum() skips the first price",
      kept: true,
      match: "found",
      fromAlso: false,
    },
    {
      caseId: "ts-sum-prices",
      setup: "quick",
      file: "src/prices.ts",
      line: 8,
      title: "average() of an empty list is NaN",
      kept: true,
      match: "unmatched",
      fromAlso: false,
    },
    {
      caseId: "ts-sum-prices",
      setup: "quick",
      file: "src/prices.ts",
      line: 4,
      title: "The total skips a price",
      kept: false,
      match: "duplicate",
      fromAlso: false,
    },
    {
      caseId: "py-rename-total",
      setup: "standard-cross",
      file: "app/total.py",
      line: 2,
      title: "total_cents() of no amounts is 0",
      kept: true,
      match: "unmatched",
      fromAlso: false,
    },
  ],
};

const META: ReportMeta = {
  date: "2026-10-12",
  runs: 1,
  clis: [
    { name: "claude", version: "2.1.283", model: "opus" },
    { name: "codex", version: null, model: null },
  ],
  cases: [BUG, CLEAN, LEFT_OUT],
};

const STANDARD: Decision = { verdict: "standard", compared: 2 };

/** The lines of the report between `heading` and the next heading. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`no ${heading}`);
  const end = lines.findIndex((l, i) => i > start && /^##? |^<!--/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((l) => l !== "");
}

describe("report", () => {
  const md = report(SCORES, STANDARD, META);

  test("states the run: its date, its cases, what was compared, the one run, the CLIs", () => {
    expect(section(md, "## The run")).toEqual([
      "Run on 2026-10-12: 3 cases (2 with a planted bug, 1 clean), 2 compared (every setup complete). One run: each setup reviewed each case once, so no difference smaller than the rule's margin (0.05 of F0.5) means anything.",
      "Not compared: `ts-left-out` (Quick on Codex and Deep missing).",
      "Claude: version 2.1.283, model opus. Codex: version unknown, model unknown.",
    ]);
  });

  test("the setups table gives the count beside every rate", () => {
    expect(section(md, "## The setups").slice(0, 8)).toEqual([
      "What each setup keeps: what its round would post at the default strictness, over the 2 compared cases, one run.",
      "| Setup | Bugs found | Precision | F0.5 | Noise | Duplicates |",
      "|---|---|---|---|---|---|",
      "| Quick | 1 of 1, 100 % | 1 of 3, 33 % | 0.38 | 1 | 0 |",
      "| Quick on Codex | 1 of 1, 100 % | 1 of 1, 100 % | 1.00 | 0 | 0 |",
      "| Standard, one engine | 1 of 1, 100 % | 1 of 2, 50 % | 0.56 | 0 | 0 |",
      "| Standard, cross-model | 0 of 1, 0 % | 0 of 2, 0 % | 0.00 | 1 | 0 |",
      "| Deep | 1 of 1, 100 % | 1 of 2, 50 % | 0.56 | 0 | 0 |",
    ]);
    // The same table with the hidden findings counted too.
    expect(section(md, "## The setups")).toContain("| Quick | 1 of 1, 100 % | 1 of 3, 33 % | 0.38 | 1 | 1 |");
  });

  test("every line that counts runs says how many there were", () => {
    const three = report(SCORES, STANDARD, { ...META, runs: 3 });
    expect(section(three, "## The setups")[0]).toBe(
      "What each setup keeps: what its round would post at the default strictness, over the 2 compared cases, 3 runs.",
    );
    expect(section(three, "## The run")[0]).toContain("3 runs: each setup reviewed each case 3 times");
  });

  test("a setup that kept nothing says so instead of a rate", () => {
    const none = { ...SCORES, setups: { ...SCORES.setups, quick: setup({ planted: 0 }) } };
    expect(report(none, STANDARD, META)).toContain(
      "| Quick | nothing planted | nothing kept | 0.00 | 0 | 0 |",
    );
  });

  test("the verdict in ADR 0050's words, with the numbers the rule read", () => {
    expect(section(md, "## The verdict")).toEqual([
      "**Standard stays the default.** ADR 0050: “Otherwise Standard stays the default.”",
      "The rule read the kept findings over the 2 compared cases: F0.5 Quick 0.38, Standard cross-model 0.00, Deep 0.56; bugs found Standard cross-model 0, Deep 1; noise Standard cross-model 1, Deep 0.",
      "Standard, one engine against cross-model decides nothing about the default: it says what an owner with one subscription gets.",
    ]);
  });

  test("each verdict quotes its step of the rule", () => {
    const said = (verdict: Decision["verdict"]) =>
      section(report(SCORES, { verdict, compared: 2 }, META), "## The verdict")[0];
    expect(said("no_verdict")).toBe(
      "**No verdict: 2 cases compared, 13 needed.** ADR 0050: “Fewer than thirteen complete cases: no verdict, the missing sessions run again first.”",
    );
    expect(said("ask_owner")).toBe(
      "**Standard stays the default, and the owner is asked.** ADR 0050: “Quick scores at least Standard cross-model's F0.5: the default stays Standard, and the owner is asked, because dropping the second look changes what Lookover is.”",
    );
    expect(said("deep")).toBe(
      "**Deep becomes the default.** ADR 0050: “Deep beats Standard cross-model on F0.5 by more than 0.05, finds at least two more planted bugs, and keeps no more noise: Deep becomes the default.”",
    );
  });

  test("the per-case table: each setup's kept findings on each case", () => {
    expect(section(md, "## Per case")).toEqual([
      "| Case | Planted | Quick | Quick on Codex | Standard, one engine | Standard, cross-model | Deep |",
      "|---|---|---|---|---|---|---|",
      "| `ts-sum-prices` | `src/prices.ts:3`: The loop starts at 1, so \\| the first price is lost. | found, 1 unmatched | missed | missed | missed | missed |",
      "| `py-rename-total` | clean | nothing | nothing | nothing | 1 unmatched | nothing |",
      "| `ts-left-out` | `src/prices.ts:2-4, 9`: The loop starts at 1, so \\| the first price is lost. | not compared | missing | not compared | not compared | missing |",
    ]);
  });

  test("names each of a bug's places, and says when a setup found it only from another one", () => {
    const placed: EvalCase = {
      ...BUG,
      planted: {
        ...PLANTED,
        ranges: [[3, 3]],
        also: [
          { path: "src/prices.test.ts", ranges: [[5, 7]] },
          { path: "src/total.ts", ranges: [[2, 2]] },
        ],
      },
    };
    const atTest = {
      caseId: "ts-sum-prices",
      file: "src/prices.test.ts",
      line: 6,
      title: "No test covers the first price",
      kept: true,
      fromAlso: true,
    };
    const scores: Scores = {
      ...SCORES,
      findings: [
        ...SCORES.findings,
        { ...atTest, setup: "quick", match: "duplicate" },
        { ...atTest, setup: "quick-codex", match: "found" },
      ],
    };
    const md = report(scores, STANDARD, { ...META, cases: [placed, CLEAN, LEFT_OUT] });
    expect(section(md, "## Per case")[2]).toBe(
      "| `ts-sum-prices` | `src/prices.ts:3`, also `src/prices.test.ts:5-7` and `src/total.ts:2`: The loop starts at 1, so \\| the first price is lost. | found, 1 unmatched, 1 duplicate | found from another place | missed | missed | missed |",
    );
    expect(section(md, "## Findings on the bug")).toEqual([
      "- `ts-sum-prices`, Quick: `src/prices.ts:3` sum() skips the first price",
      "- `ts-sum-prices`, Quick: `src/prices.ts:4` The total skips a price (hidden, a duplicate)",
      "- `ts-sum-prices`, Quick: `src/prices.test.ts:6` No test covers the first price (a duplicate, from another place)",
      "- `ts-sum-prices`, Quick on Codex: `src/prices.test.ts:6` No test covers the first price (from another place)",
    ]);
  });

  test("the confirm measurement, per confirming setup", () => {
    expect(section(md, "## The confirm")).toEqual([
      "| Setup | Confirmer | Planted bugs it refuted (lost) | Unmatched candidates it refuted (gained) | Demoted |",
      "|---|---|---|---|---|",
      "| Standard, one engine | Claude | 0 | 1 | 0 |",
      "| Standard, cross-model | Codex | 1 | 0 | 2 |",
      "| Deep | Codex | 0 | 1 | 0 |",
    ]);
  });

  test("the cost: sessions, tokens and wall time, read from the answers", () => {
    expect(section(md, "## Cost")).toEqual([
      "| Setup | Sessions | Input tokens | Output tokens | Wall time |",
      "|---|---|---|---|---|",
      "| Quick | 2 | 30,000 | 1,250 | 1 min 22 s |",
      "| Quick on Codex | 2 | 31,000 | 1,200 | 2 min 44 s |",
      "| Standard, one engine | 2 | 31,000 | 1,200 | 2 min 44 s |",
      "| Standard, cross-model | 4 | 1,234,567 (1 session unknown) | 0 (1 session unknown) | 1 h 2 min |",
      "| Deep | 2 | 31,000 | 1,200 | 2 min 44 s |",
    ]);
  });

  test("lists every finding that matched the bug and every one that matched nothing", () => {
    expect(section(md, "## Findings on the bug")).toEqual([
      "- `ts-sum-prices`, Quick: `src/prices.ts:3` sum() skips the first price",
      "- `ts-sum-prices`, Quick: `src/prices.ts:4` The total skips a price (hidden, a duplicate)",
    ]);
    expect(section(md, "## Findings that matched nothing")).toEqual([
      "- `ts-sum-prices`, Quick: `src/prices.ts:8` average() of an empty list is NaN",
      "- `py-rename-total`, Standard, cross-model: `app/total.py:2` total_cents() of no amounts is 0",
    ]);
  });

  test("the author's reading is a marked section, outside the generated part", () => {
    const lines = md.split("\n");
    const at = (marker: RegExp) => lines.findIndex((l: string) => marker.test(l));
    const reading = [at(/^<!-- reading:start/), at(/^<!-- reading:end/)];
    const generated = [at(/^<!-- generated:start/), at(/^<!-- generated:end/)];
    expect([...reading, ...generated].every((i) => i >= 0)).toBe(true);
    expect(reading[1]).toBeLessThan(generated[0] ?? 0);
    expect(lines[0]).toBe("# Evaluation: the default depth");
  });
});
