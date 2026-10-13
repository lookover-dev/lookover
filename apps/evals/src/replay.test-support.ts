// The hand-made run (`fixtures/replay`): two test-only cases, every engine answer written here by hand, run through
// the real runner on `FakeEngines` so the stored files are the store's exact format. `replay.test.ts` checks that
// `makeReplay` still gives the committed sessions. To re-make the committed run (after a change to the store, the
// cases' format or the hash), run this file: `bun apps/evals/src/replay.test-support.ts`. It builds the cases with
// git through `retrieval`, as a real run does, writes their sessions, scores and report, and formats the JSON with
// Biome.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessRunner } from "@lookover/process";
import { createRetrieval } from "@lookover/retrieval";
import { FakeEngines, type ScriptedRun } from "@lookover/testkit";
import {
  type Corpus,
  casePreparer,
  loadCorpus,
  type PrepareCase,
  runCorpus,
  SESSIONS,
  writeReport,
} from "./index.ts";

/** The hand-made run's folder: its cases, its stored sessions, its report. */
const FIXTURE = join(import.meta.dir, "..", "fixtures", "replay");
export const FIXTURE_CASES = join(FIXTURE, "cases");
export const FIXTURE_RECORDED = join(FIXTURE, "recorded");
export const FIXTURE_REPORT = join(FIXTURE, "report.md");
/** The day the hand-made run says it ran. */
export const FIXTURE_DATE = "2026-10-10";

const answer = (block: unknown) =>
  `I read the change.\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
const finding = (path: string, line: number, severity: string, title: string, key: string, body: string) => ({
  path,
  side: "head",
  line,
  end_line: null,
  severity,
  category: "correctness",
  title,
  body,
  defect_key: key,
  suggestion: null,
  pre_existing: false,
});
const finds = (inputTokens: number, ...findings: unknown[]): ScriptedRun => ({
  outcome: "ok",
  text: answer({ findings, earlier: [] }),
  usage: { inputTokens, outputTokens: 400 + findings.length * 150 },
});
const verdicts = (...said: [string, "confirmed" | "refuted" | "unsure", string, string][]): ScriptedRun => ({
  outcome: "ok",
  text: answer({
    verdicts: said.map(([id, verdict, severity, reason]) => ({
      id,
      verdict,
      reason,
      evidence: [],
      severity,
    })),
  }),
  usage: { inputTokens: 9000, outputTokens: 300 },
});

const SKIPS_FIRST = finding(
  "src/prices.ts",
  3,
  "blocking",
  "sum() skips the first price",
  "loop_starts_at_one",
  "The loop starts at 1, so prices[0] is never added and every total is short.",
);
const EMPTY_AVERAGE = finding(
  "src/prices.ts",
  8,
  "should_fix",
  "average() of an empty list is NaN",
  "average_divides_by_zero",
  "With no prices, sum is 0 and prices.length is 0: the average is NaN, not an error.",
);
const CODEX_SKIPS = finding(
  "src/prices.ts",
  3,
  "blocking",
  "The first price is left out of the sum",
  "first_price_skipped",
  "i starts at 1: prices[0] never reaches total.",
);
const EMPTY_TOTAL = finding(
  "app/total.py",
  2,
  "should_fix",
  "total_cents() of no amounts is 0",
  "empty_total_zero",
  "An empty list sums to 0, which hides a missing basket.",
);

/** The engines, each answering its sessions in the order the runner asks: the clean rename first (name order). */
function scripted() {
  const find = new FakeEngines();
  const confirm = new FakeEngines();
  for (const e of [find, confirm]) {
    e.setHealth("claude", { installed: true, version: "2.1.283", signedIn: true });
    e.setHealth("codex", { installed: true, version: "0.50.0", signedIn: true });
  }
  find.answerFor("claude", finds(14000, EMPTY_TOTAL), finds(16000, SKIPS_FIRST, EMPTY_AVERAGE));
  find.answerFor("codex", finds(15000), finds(17000, CODEX_SKIPS));
  confirm.answerFor(
    "claude",
    verdicts([
      "C1",
      "refuted",
      "should_fix",
      "Summing nothing to 0 is what sum() does; nothing reads it as missing.",
    ]),
    verdicts(
      ["C1", "confirmed", "blocking", "range(1, n) leaves prices[0] out."],
      ["C2", "confirmed", "should_fix", "Division by prices.length with no guard."],
    ),
  );
  confirm.answerFor(
    "codex",
    verdicts(["C1", "unsure", "should_fix", "Depends on whether callers pass an empty basket."]),
    verdicts([
      "C1",
      "refuted",
      "should_fix",
      "Nothing reads the old total; the empty case is handled upstream.",
    ]),
    verdicts(
      ["C1", "refuted", "blocking", "The loop reads every price."],
      ["C2", "confirmed", "should_fix", "No guard for an empty list."],
    ),
    verdicts(
      ["C1", "confirmed", "blocking", "i starts at 1."],
      ["C2", "unsure", "should_fix", "Callers may never pass an empty list."],
    ),
  );
  return { find, confirm };
}

/**
 * Runs the hand-made run's sessions into `recordedDir` (emptied first), each case prepared by `prepare` in
 * `buildRoot`. Each session's model is planted where `engines` writes it, and the engines' run folders removed after.
 */
export async function makeReplay(o: {
  corpus: Corpus;
  recordedDir: string;
  buildRoot: string;
  prepare: PrepareCase;
}): Promise<void> {
  rmSync(o.recordedDir, { recursive: true, force: true });
  for (const c of o.corpus.cases)
    for (const [session, { engine }] of Object.entries(SESSIONS)) {
      const dir = join(o.recordedDir, c.id, "runs", session);
      mkdirSync(dir, { recursive: true });
      // Codex's model is the one it was run on (`run.json`); Claude's, the one its stream's `init` event names.
      if (engine === "codex") writeFileSync(join(dir, "run.json"), JSON.stringify({ model: "gpt-5.5" }));
      else
        writeFileSync(
          join(dir, "stdout.jsonl"),
          `${JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-1" })}\n`,
        );
    }
  const { find, confirm } = scripted();
  let t = 0;
  const run = await runCorpus({
    cases: o.corpus.cases,
    review: o.corpus.review,
    findEngines: find,
    confirmEngines: confirm,
    prepare: o.prepare,
    lock: () => ({ release: () => undefined }),
    clock: { now: () => (t += 41_000) },
    runFolder: o.recordedDir,
    buildRoot: o.buildRoot,
    maxSessions: 10,
  });
  if (run.kind !== "ran" || run.stopped !== null)
    throw new Error(`the hand-made run didn't run: ${run.kind}`);
  for (const c of o.corpus.cases) rmSync(join(o.recordedDir, c.id, "runs"), { recursive: true, force: true });
}

/** Re-makes the committed hand-made run with real git, then its scores and report, formatted as committed. */
async function remake(): Promise<void> {
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-make-replay-")));
  try {
    const git = Bun.which("git") ?? "";
    const buildRoot = join(temp, "build");
    const corpus = loadCorpus(FIXTURE_CASES);
    const retrieval = createRetrieval({
      root: join(buildRoot, "retrieval"),
      runner: createProcessRunner({ registryFile: join(temp, "processes.json") }),
      git,
      env: { HOME: temp, USERPROFILE: temp, GIT_CONFIG_NOSYSTEM: "1" },
    });
    const prepare = casePreparer({ review: corpus.review, buildRoot, git, retrieval });
    await makeReplay({ corpus, recordedDir: FIXTURE_RECORDED, buildRoot, prepare });
    rmSync(FIXTURE_REPORT, { force: true });
    await writeReport({
      casesDir: FIXTURE_CASES,
      recordedDir: FIXTURE_RECORDED,
      reportFile: FIXTURE_REPORT,
      date: FIXTURE_DATE,
    });
    Bun.spawnSync([process.execPath, "x", "biome", "format", "--write", FIXTURE_RECORDED], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) await remake();
