// The scorer (ADR 0050, "Scoring"): which planted bug each finding found, and every setup's numbers over the corpus.
// Pure: no clock, no disk, no engine. The matcher is code, the same on every run, never an LLM judge.
import type { DiffSide, EngineId } from "@lookover/contracts";
import {
  type CaseResult,
  type EvalCase,
  type Place,
  type Planted,
  SESSIONS,
  SETUPS,
  type SessionName,
  type SetupName,
  type SetupResult,
} from "./types.ts";

/** How far, in lines, a finding may be from one of the planted ranges and still find the bug. */
const NEAR_LINES = 3;

/** F0.5's beta: precision weighs more than recall (vision, principle 5: signal over noise). */
const BETA = 0.5;

/**
 * One setup's counts over the compared cases, on its kept findings or on all its findings. `found`: planted bugs
 * found (each once), which is also the findings that found one; `findings`: the findings counted, `duplicates`
 * apart; `noise`: the findings on clean cases (duplicates can't be any: a clean case plants nothing).
 * `precision` = found / (findings - duplicates), 1 when that is 0; `recall` = found / planted, 0 with nothing
 * planted; `f05` = F0.5 of the two, 0 when nothing was found.
 */
export interface Counts {
  planted: number;
  found: number;
  findings: number;
  duplicates: number;
  noise: number;
  recall: number;
  precision: number;
  f05: number;
}

/**
 * What a setup's confirmer did (ADR 0050, "the confirm measurement"): planted bugs a refuted candidate found (a
 * loss; a bug counted once per case, whether or not a kept finding found it too), refuted candidates that found no
 * planted bug (a gain), and the findings it demoted (`confirmation.demoted`, over all findings).
 */
export interface ConfirmMeasure {
  confirmer: EngineId;
  plantedRefuted: number;
  unmatchedRefuted: number;
  demoted: number;
}

/**
 * What a setup spent over the compared cases: its sessions (a confirm with nothing to judge is none), the tokens of
 * those whose usage is known, how many had none reported (`unknownUsage`), and their wall time.
 */
export interface Cost {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  unknownUsage: number;
  wallMs: number;
}

/** One setup's score: its counts on kept findings and on all, its confirm (null at Quick), its cost, the ids of the planted cases it missed. */
export interface SetupScore {
  kept: Counts;
  all: Counts;
  confirm: ConfirmMeasure | null;
  cost: Cost;
  missed: string[];
}

/**
 * One finding as the scorer read it: the planted bug it `found`, a `duplicate` of a finding that found it first, or
 * `unmatched` (any finding on a clean case). `kept` findings are matched among the kept; the others among all.
 * `fromAlso`: it is near only another place the case lists (ADR 0050's amendment), not the bug's own.
 */
export interface ScoredFinding {
  caseId: string;
  setup: SetupName;
  file: string;
  line: number;
  title: string;
  kept: boolean;
  match: "found" | "duplicate" | "unmatched";
  fromAlso: boolean;
}

/** A case left out of the comparison, and the setups that are missing for it (all, when it has no result). */
export interface Incomplete {
  caseId: string;
  setups: SetupName[];
}

/**
 * The corpus scored: the ids of the cases where every setup is complete (`compared`, in the cases' order), the
 * cases left out, every setup's score over the compared cases, and every finding of theirs, in case, setup, then
 * finding order.
 */
export interface Scores {
  compared: string[];
  incomplete: Incomplete[];
  setups: Record<SetupName, SetupScore>;
  findings: ScoredFinding[];
}

type Complete = Extract<SetupResult, { kind: "complete" }>;

/** `make` for every setup, in `SETUPS`' order: the one list of setups the scorer reads, which fails to compile when a setup is added. */
function perSetup<T>(make: (name: SetupName) => T): Record<SetupName, T> {
  return {
    quick: make("quick"),
    "quick-codex": make("quick-codex"),
    "standard-one": make("standard-one"),
    "standard-cross": make("standard-cross"),
    deep: make("deep"),
  };
}

const SETUP_NAMES: SetupName[] = Object.values(perSetup((name) => name));

interface Located {
  path: string;
  side: DiffSide;
  line: number;
  endLine: number | null;
}

/** Whether something at `at` is on the place's file's head side, its lines within `NEAR_LINES` of one range. */
function near(place: Place, at: Located): boolean {
  if (at.path !== place.path || at.side !== "head") return false;
  const last = at.endLine ?? at.line;
  return place.ranges.some(([start, end]) => at.line <= end + NEAR_LINES && last >= start - NEAR_LINES);
}

/**
 * Which of the bug's places something at `at` finds it from: its own (`planted`), only another the case lists
 * (`also`), or none (null, always on a clean case).
 */
function placeOf(planted: Planted | null, at: Located): "planted" | "also" | null {
  if (planted === null) return null;
  if (near(planted, at)) return "planted";
  return (planted.also ?? []).some((place) => near(place, at)) ? "also" : null;
}

const finds = (planted: Planted | null, at: Located): boolean => placeOf(planted, at) !== null;

/** Each of `items` matched against the case's bug, in order: the first to find it `found`, the next ones `duplicate`. */
function matchAll(planted: Planted | null, items: Located[]): ScoredFinding["match"][] {
  let taken = false;
  return items.map((at) => {
    if (!finds(planted, at)) return "unmatched";
    if (taken) return "duplicate";
    taken = true;
    return "found";
  });
}

interface Tally {
  planted: number;
  found: number;
  findings: number;
  duplicates: number;
  noise: number;
}

function counts({ planted, found, findings, duplicates, noise }: Tally): Counts {
  const counted = findings - duplicates;
  const precision = counted === 0 ? 1 : found / counted;
  const recall = planted === 0 ? 0 : found / planted;
  const b2 = BETA * BETA;
  const f05 = found === 0 ? 0 : ((1 + b2) * precision * recall) / (b2 * precision + recall);
  return { planted, found, findings, duplicates, noise, recall, precision, f05 };
}

function emptyTally(): Tally {
  return { planted: 0, found: 0, findings: 0, duplicates: 0, noise: 0 };
}

/** Adds one case's matches to `tally`. */
function add(tally: Tally, planted: Planted | null, matches: ScoredFinding["match"][]): void {
  if (planted !== null) tally.planted += 1;
  tally.findings += matches.length;
  for (const match of matches) {
    if (match === "found") tally.found += 1;
    if (match === "duplicate") tally.duplicates += 1;
  }
  if (planted === null) tally.noise += matches.length;
}

function located(finding: { file: string; side: DiffSide; line: number; endLine: number | null }): Located {
  return { path: finding.file, side: finding.side, line: finding.line, endLine: finding.endLine };
}

function confirmerOf(setup: SetupName): EngineId | null {
  const confirm = SETUPS[setup].confirm;
  return confirm === null ? null : SESSIONS[confirm].engine;
}

/** A setup's running totals while the compared cases are read. */
interface Running {
  kept: Tally;
  all: Tally;
  confirm: ConfirmMeasure | null;
  cost: Cost;
  missed: string[];
}

function running(setup: SetupName): Running {
  const confirmer = confirmerOf(setup);
  return {
    kept: emptyTally(),
    all: emptyTally(),
    confirm: confirmer === null ? null : { confirmer, plantedRefuted: 0, unmatchedRefuted: 0, demoted: 0 },
    cost: { sessions: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, wallMs: 0 },
    missed: [],
  };
}

/**
 * Scores every setup over the cases where every setup is complete (ADR 0050). A case with no result, or one setup
 * missing, is listed in `incomplete` and scored for none. Throws when a result names a case `cases` doesn't hold,
 * or when two results name the same case.
 */
export function score(cases: EvalCase[], results: CaseResult[]): Scores {
  const byId = resultsByCase(cases, results);
  const totals = perSetup(running);
  const compared: string[] = [];
  const incomplete: Incomplete[] = [];
  const findings: ScoredFinding[] = [];
  for (const evalCase of cases) {
    const r = byId.get(evalCase.id);
    const missing =
      r === undefined ? SETUP_NAMES : SETUP_NAMES.filter((name) => r.setups[name].kind !== "complete");
    if (r === undefined || missing.length > 0) {
      incomplete.push({ caseId: evalCase.id, setups: missing });
      continue;
    }
    compared.push(evalCase.id);
    for (const name of SETUP_NAMES) {
      const setup = r.setups[name];
      if (setup.kind === "complete")
        findings.push(...scoreCase(totals[name], evalCase, name, setup, r.sessions));
    }
  }
  return { compared, incomplete, setups: perSetup((name) => done(totals[name])), findings };
}

/** Each result by its case's id, refusing one for a case the corpus doesn't hold and a second for the same case. */
function resultsByCase(cases: EvalCase[], results: CaseResult[]): Map<string, CaseResult> {
  const known = new Set(cases.map((c) => c.id));
  const byId = new Map<string, CaseResult>();
  for (const r of results) {
    if (!known.has(r.caseId))
      throw new Error(`a result names the case ${r.caseId}, which the corpus doesn't hold`);
    if (byId.has(r.caseId)) throw new Error(`two results for the case ${r.caseId}`);
    byId.set(r.caseId, r);
  }
  return byId;
}

function done({ kept, all, confirm, cost, missed }: Running): SetupScore {
  return { kept: counts(kept), all: counts(all), confirm, cost, missed };
}

/**
 * Adds one complete setup's case to its totals, and gives its findings as scored. All findings are matched kept
 * first, then the hidden ones: a hidden finding never takes the bug from a kept one that found it.
 */
function scoreCase(
  totals: Running,
  evalCase: EvalCase,
  name: SetupName,
  setup: Complete,
  records: CaseResult["sessions"],
): ScoredFinding[] {
  const { planted } = evalCase;
  const keptIds = new Set(setup.kept.map((f) => f.id));
  const hidden = setup.all.filter((f) => !keptIds.has(f.id));
  const keptMatches = matchAll(planted, setup.kept.map(located));
  const allMatches = matchAll(planted, [...setup.kept, ...hidden].map(located));
  add(totals.kept, planted, keptMatches);
  add(totals.all, planted, allMatches);
  const keptFound = keptMatches.includes("found");
  if (planted !== null && !keptFound) totals.missed.push(evalCase.id);
  if (totals.confirm !== null) measure(totals.confirm, planted, keptFound, setup);
  spend(totals.cost, records, setup.sessions);
  const scored = (
    f: Complete["all"][number],
    kept: boolean,
    match: ScoredFinding["match"],
  ): ScoredFinding => ({
    caseId: evalCase.id,
    setup: name,
    file: f.file,
    line: f.line,
    title: f.title,
    kept,
    match,
    fromAlso: placeOf(planted, located(f)) === "also",
  });
  return [
    ...setup.kept.map((f, i) => scored(f, true, keptMatches[i] ?? "unmatched")),
    ...hidden.map((f, i) => scored(f, false, allMatches[setup.kept.length + i] ?? "unmatched")),
  ];
}

/**
 * Adds what the confirmer refuted and demoted on one case. A refuted candidate that found the planted bug is a loss
 * only when no kept finding found it; either way it is not an unmatched candidate.
 */
function measure(
  confirm: ConfirmMeasure,
  planted: Planted | null,
  keptFound: boolean,
  setup: Complete,
): void {
  const refuted = matchAll(
    planted,
    setup.ruledOut.map((r) => r.candidate.location),
  );
  if (refuted.includes("found") && !keptFound) confirm.plantedRefuted += 1;
  confirm.unmatchedRefuted += refuted.filter((m) => m === "unmatched").length;
  confirm.demoted += setup.all.filter(
    (f) => f.confirmation.verdict !== "confirmed" && f.confirmation.demoted,
  ).length;
}

/** Adds the sessions a setup spent on one case to its cost, from the stored records. */
function spend(cost: Cost, records: CaseResult["sessions"], sessions: SessionName[]): void {
  for (const name of sessions) {
    cost.sessions += 1;
    const record = records[name];
    if (record === undefined || record.outcome === "no_candidates") continue;
    cost.wallMs += record.wallMs;
    if (record.usage === null) {
      cost.unknownUsage += 1;
      continue;
    }
    cost.inputTokens += record.usage.inputTokens;
    cost.outputTokens += record.usage.outputTokens;
  }
}
