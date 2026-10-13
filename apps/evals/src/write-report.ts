// The committed run and its report (ADR 0050): the answers of the run behind the report live in `recorded/` in the
// runner's store format; their scores are computed from them and kept beside them (`scores.json`), and the report's
// generated part is written from those scores. The replay reads `recorded/` as the runner stored it (`readRun`: no
// engine, no process, no git, no wall time waited: the stored one is read), builds the setups through `review` and
// `core`, and scores them: what `bun run check` compares with `scores.json`, and what `writeReport` writes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineId } from "@lookover/contracts";
import { z } from "zod";
import { loadCorpus } from "./cases.ts";
import { type Decision, decide } from "./decide.ts";
import { keepReading, report } from "./report.ts";
import { readRun } from "./run.ts";
import { sameRun, sameRunRefusal } from "./same-run.ts";
import { type Scores, score } from "./score.ts";
import { buildSetups } from "./setups.ts";
import { type CaseResult, type Corpus, DAY, isRead, type SessionCli, type SessionRecord } from "./types.ts";

/** ADR 0050: one run per setup. */
const RUNS = 1;

/** What the replay computes from a committed run: how many runs, the CLIs they ran on, the scores, the verdict. */
export interface Replayed {
  runs: number;
  clis: SessionCli[];
  scores: Scores;
  decision: Decision;
}

const ENGINE_ORDER = { claude: 0, codex: 1 } satisfies Record<EngineId, number>;

/** Every CLI the sessions ran on, once each, Claude's first. */
function clisOf(sessions: SessionRecord[]): SessionCli[] {
  const seen = new Map<string, SessionCli>();
  for (const s of sessions.filter(isRead)) {
    const { name, version, model } = s.cli;
    seen.set(JSON.stringify([name, version, model]), { name, version, model });
  }
  return [...seen.values()].sort(
    (a, b) =>
      ENGINE_ORDER[a.name] - ENGINE_ORDER[b.name] ||
      String(a.version).localeCompare(String(b.version)) ||
      String(a.model).localeCompare(String(b.model)),
  );
}

async function replay({ cases, review }: Corpus, recordedDir: string) {
  const read = readRun({ cases, review, runFolder: recordedDir });
  const results: CaseResult[] = [];
  for (const c of read)
    if (c.inputs !== null)
      results.push({
        caseId: c.caseId,
        sessions: c.sessions,
        setups: await buildSetups(c.inputs, c.sessions),
      });
  const sessions = read.flatMap((c) => Object.values(c.sessions));
  const scores = score(cases, results);
  const replayed: Replayed = { runs: RUNS, clis: clisOf(sessions), scores, decision: decide(scores) };
  return { replayed, sessions };
}

/**
 * Replays the run stored in `recordedDir` (the runner's store) for `corpus`: each case's stored sessions read
 * again, its setups built, the corpus scored and the rule applied. A case with no stored inputs is scored as never
 * run. Throws what the store throws: a file it can't read, a case or `REVIEW.md` edited since its sessions ran.
 */
export async function replayRecorded(o: { corpus: Corpus; recordedDir: string }): Promise<Replayed> {
  return (await replay(o.corpus, o.recordedDir)).replayed;
}

export interface WriteReportOptions {
  /** The corpus (`apps/evals/cases`). */
  casesDir: string;
  /** The committed run (`apps/evals/recorded`), in the runner's store format; `scores.json` is written in it. */
  recordedDir: string;
  /** The report (`docs/research/10-evals.md`): its generated part is written, the author's reading kept. */
  reportFile: string;
  /** The day the run ran (`YYYY-MM-DD`); left out, the one the run's `scores.json` already holds. */
  date?: string;
}

function dateOf(o: WriteReportOptions): string {
  const file = join(o.recordedDir, "scores.json");
  const stored = existsSync(file)
    ? z.object({ date: z.string() }).safeParse(JSON.parse(readFileSync(file, "utf8")))
    : null;
  const date = o.date ?? (stored?.success === true ? stored.data.date : undefined);
  if (date === undefined) throw new Error(`${file} holds no date: give the day the run ran.`);
  if (!DAY.test(date)) throw new Error(`The run's date is YYYY-MM-DD, not ${date}.`);
  return date;
}

/**
 * Scores the run in `recordedDir`, writes `scores.json` beside it (the date and what `replayRecorded` gives) and
 * the report, keeping the author's reading of the one it replaces. Throws, writing nothing, when there's no date,
 * when the sessions ran on more than one version or model of an engine (a report is made from one run), or when
 * the old report lost its reading's markers. `scores.json` is written as `JSON.stringify` lays it out: the caller
 * runs Biome's formatter on it before committing, and every reader parses it, never compares its text.
 */
export async function writeReport(o: WriteReportOptions): Promise<Replayed & { date: string }> {
  const date = dateOf(o);
  const corpus = loadCorpus(o.casesDir);
  const { replayed, sessions } = await replay(corpus, o.recordedDir);
  const refused = sameRunRefusal(sameRun(sessions));
  if (refused !== null) throw new Error(`${o.recordedDir}: ${refused}`);
  const fresh = report(replayed.scores, replayed.decision, {
    date,
    runs: replayed.runs,
    clis: replayed.clis,
    cases: corpus.cases,
  });
  const markdown = existsSync(o.reportFile) ? keepReading(readFileSync(o.reportFile, "utf8"), fresh) : fresh;
  const written = { date, ...replayed };
  writeFileSync(join(o.recordedDir, "scores.json"), `${JSON.stringify(written, null, 2)}\n`);
  writeFileSync(o.reportFile, markdown);
  return written;
}
