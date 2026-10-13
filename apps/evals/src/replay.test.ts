// The replay (ADR 0050): a committed run's answers, read again through the real `review` and `core` on fake engines,
// must give the committed scores exactly. Until the real run is committed in `recorded/`, a hand-made run of two
// test-only cases (`fixtures/replay`: a planted bug and a clean change, every answer written by hand in
// `replay.test-support.ts`, which also re-makes it) proves it. No process, no git: the stored inputs stand in for
// the cases' repositories.
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSha } from "@lookover/contracts";
import { loadCorpus, type PrepareCase, replayRecorded, report, writeReport } from "./index.ts";
import {
  FIXTURE_CASES,
  FIXTURE_DATE,
  FIXTURE_RECORDED,
  FIXTURE_REPORT,
  makeReplay,
} from "./replay.test-support.ts";

const EVALS = join(import.meta.dir, "..");
const RECORDED = join(EVALS, "recorded");

const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-evals-replay-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/**
 * Each committed run and the corpus it answered: the hand-made one always, the real one once committed. The real
 * run's report is in `docs/`, private: `scripts/private/evals-report.test.ts` checks it.
 */
const RUNS = [
  { name: "the hand-made run", cases: FIXTURE_CASES, recorded: FIXTURE_RECORDED },
  ...(existsSync(join(RECORDED, "scores.json"))
    ? [{ name: "the committed run", cases: join(EVALS, "cases"), recorded: RECORDED }]
    : []),
];

/** The report's generated part, its markers included. */
function generated(markdown: string): string {
  const text = markdown.replaceAll("\r\n", "\n");
  const start = text.indexOf("<!-- generated:start");
  const endMarker = "<!-- generated:end -->";
  const end = text.indexOf(endMarker);
  if (start === -1 || end < start) throw new Error("no generated part");
  return text.slice(start, end + endMarker.length);
}

describe("the replay", () => {
  for (const run of RUNS) {
    test(`${run.name} gives its committed scores exactly`, async () => {
      const replayed = await replayRecorded({
        corpus: loadCorpus(run.cases),
        recordedDir: run.recorded,
      });
      const { date: _date, ...committed } = Object(readJson(join(run.recorded, "scores.json")));
      expect(replayed).toEqual(committed);
    });
  }

  test("the hand-made run's report says what its replayed scores say", async () => {
    const corpus = loadCorpus(FIXTURE_CASES);
    const replayed = await replayRecorded({ corpus, recordedDir: FIXTURE_RECORDED });
    const date = String(Object(readJson(join(FIXTURE_RECORDED, "scores.json"))).date);
    const fresh = report(replayed.scores, replayed.decision, {
      date,
      runs: replayed.runs,
      clis: replayed.clis,
      cases: corpus.cases,
    });
    expect(generated(readFileSync(FIXTURE_REPORT, "utf8"))).toBe(generated(fresh));
  });

  test("the hand-made run is what its script makes", async () => {
    const corpus = loadCorpus(FIXTURE_CASES);
    const buildRoot = join(temp, "make-build");
    // The committed inputs stand in for git: the sessions see what they saw when the run was made.
    const prepare: PrepareCase = (evalCase) => {
      const stored = Object(readJson(join(FIXTURE_RECORDED, evalCase.id, "inputs.json")));
      return Promise.resolve({
        head: commitSha(String(stored.head)),
        diff: String(stored.diff),
        rules: stored.rules,
        cwd: join(buildRoot, evalCase.id),
        diffFile: ".lookover-change.diff",
        dispose: () => Promise.resolve(),
      });
    };
    const recordedDir = join(temp, "made");
    await makeReplay({ corpus, recordedDir, buildRoot, prepare });
    for (const c of corpus.cases)
      for (const file of readdirSync(join(FIXTURE_RECORDED, c.id)))
        expect([c.id, file, readJson(join(recordedDir, c.id, file))]).toEqual([
          c.id,
          file,
          readJson(join(FIXTURE_RECORDED, c.id, file)),
        ]);
    expect(FIXTURE_DATE).toBe(String(Object(readJson(join(FIXTURE_RECORDED, "scores.json"))).date));
  });

  test("the hand-made run scores what its answers say", async () => {
    const { scores, decision, clis, runs } = await replayRecorded({
      corpus: loadCorpus(FIXTURE_CASES),
      recordedDir: FIXTURE_RECORDED,
    });
    const kept = (name: keyof typeof scores.setups) => {
      const { found, findings, noise } = scores.setups[name].kept;
      return { found, findings, noise };
    };
    // Claude finds the bug and an empty average; Codex finds the bug alone. On the clean rename, Claude flags an
    // empty total: Claude refutes it, Codex is unsure of it on its own and refutes it once merged with its find.
    expect(scores.compared).toEqual(["replay-rename-total", "replay-sum-prices"]);
    expect(kept("quick")).toEqual({ found: 1, findings: 3, noise: 1 });
    expect(kept("quick-codex")).toEqual({ found: 1, findings: 1, noise: 0 });
    expect(kept("standard-one")).toEqual({ found: 1, findings: 2, noise: 0 });
    // Codex refutes the bug when it confirms Claude's find: Standard cross-model misses it.
    expect(kept("standard-cross")).toEqual({ found: 0, findings: 2, noise: 1 });
    expect(scores.setups["standard-cross"].missed).toEqual(["replay-sum-prices"]);
    expect(scores.setups["standard-cross"].confirm?.plantedRefuted).toBe(1);
    expect(kept("deep")).toEqual({ found: 1, findings: 2, noise: 0 });
    expect(scores.setups.deep.confirm?.unmatchedRefuted).toBe(1);
    expect(scores.setups.quick.cost).toEqual({
      sessions: 2,
      inputTokens: 30_000,
      outputTokens: 1_250,
      unknownUsage: 0,
      wallMs: 164_000,
    });
    expect(decision).toEqual({ verdict: "no_verdict", compared: 2 });
    expect(runs).toBe(1);
    expect(clis).toEqual([
      { name: "claude", version: "2.1.283", model: "claude-opus-4-1" },
      { name: "codex", version: "0.50.0", model: "gpt-5.5" },
    ]);
  });
});

describe("writeReport", () => {
  let n = 0;
  /** A copy of the hand-made run, to write into. */
  function copy() {
    n += 1;
    const recordedDir = join(temp, `recorded-${n}`);
    cpSync(FIXTURE_RECORDED, recordedDir, { recursive: true });
    rmSync(join(recordedDir, "scores.json"));
    return { casesDir: FIXTURE_CASES, recordedDir, reportFile: join(temp, `report-${n}.md`) };
  }

  test("writes the scores beside the answers and the report, dated with the run", async () => {
    const o = copy();
    await writeReport({ ...o, date: "2026-10-12" });
    const written = Object(readJson(join(o.recordedDir, "scores.json")));
    expect(written.date).toBe("2026-10-12");
    expect(written).toEqual({
      date: "2026-10-12",
      ...(await replayRecorded({ corpus: loadCorpus(o.casesDir), recordedDir: o.recordedDir })),
    });
    const md = readFileSync(o.reportFile, "utf8");
    expect(md).toContain("Run on 2026-10-12: 2 cases (1 with a planted bug, 1 clean), 2 compared");
    expect(md).toContain("**No verdict: 2 cases compared, 13 needed.**");
  });

  test("a report written again keeps the author's reading and the run's date", async () => {
    const o = copy();
    await writeReport({ ...o, date: "2026-10-12" });
    const reading = "## Reading\n\nThe empty average is a real bug the case didn't plant.";
    const first = readFileSync(o.reportFile, "utf8");
    writeFileSync(
      o.reportFile,
      first.replace("## Reading\n\nNot read yet.", reading).replaceAll("\n", "\r\n"),
    );
    await writeReport(o);
    const again = readFileSync(o.reportFile, "utf8");
    expect(again).toBe(first.replace("## Reading\n\nNot read yet.", reading));
  });

  test("refuses a first report with no date, a report that lost its reading's markers, and a mixed run", async () => {
    const o = copy();
    await expect(writeReport(o)).rejects.toThrow("no date");
    await writeReport({ ...o, date: "2026-10-12" });
    writeFileSync(o.reportFile, "# Evaluation\n\nThe reading, its markers gone.\n");
    await expect(writeReport(o)).rejects.toThrow("put the markers back");
    expect(readFileSync(o.reportFile, "utf8")).toBe("# Evaluation\n\nThe reading, its markers gone.\n");

    const mixed = copy();
    const file = join(mixed.recordedDir, "replay-sum-prices", "claude-find.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"2.1.283"', '"2.1.284"'));
    await expect(writeReport({ ...mixed, date: "2026-10-12" })).rejects.toThrow(
      "The sessions ran on more than one version of claude",
    );

    const unknown = copy();
    const codex = join(unknown.recordedDir, "replay-rename-total", "codex-find.json");
    writeFileSync(codex, readFileSync(codex, "utf8").replace('"gpt-5.5"', "null"));
    await expect(writeReport({ ...unknown, date: "2026-10-12" })).rejects.toThrow(
      "The model of codex isn't known for codex-find:",
    );
  });
});
