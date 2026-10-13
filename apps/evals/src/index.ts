// @lookover/evals: the evaluation harness (ADR 0050).
// The decision it hides: how an eval case goes from text to what the service would see. A case is one YAML file
// under `cases/` (no source-code extension anywhere under that folder, so no linter or type checker reads its planted
// bug), beside the corpus' shared `REVIEW.md`. The builder makes each case a local bare repository with
// `git fast-import`, fixed dates and a fixed identity, its texts normalised to LF: `main` holds the base and
// `REVIEW.md`, `change` one neutral commit on top, no trailer. The same case gives the same commits on every machine.
// A built case is prepared through `retrieval`, with the repository's path as the clone URL and empty credentials, as
// the service prepares a change: no Git host is ever reached.
// Interface: `loadCorpus(dir)` reads every case and `REVIEW.md`; `parseCase(name, text)` reads one case file.
// `buildCase({ evalCase, review, root, git })` builds a case under `root` (the caller's folder: nothing is written
// in this repository) and gives its clone URL and commits. `prepareCase(retrieval, built, signal?)` gives the review
// worktree, the diff, its file and the rules files (`PreparedCase`); `casePreparer` composes the two into the
// runner's real `prepare`, under the build root. A built repository, its job and its worktree take the case's
// neutral name (`case-<8 hex>`), never its id, which names the bug.
// `runCorpus({ cases, review, findEngines, confirmEngines, prepare, lock, clock, runFolder, buildRoot, maxSessions,
// only })` runs each case's five sessions (the finds in parallel, then the confirms, each on the candidates `core`'s
// `toConfirm` asks about, after `mergeFinds` when it confirms two finds) through `review`, storing each in
// `<runFolder>/<case>/<session>.json` the moment it ends and the case's inputs once, with the hash of the case and
// the corpus' `REVIEW.md` (`inputs.json`); a rerun skips a session stored usable and prepares no case with nothing left
// to run. `readRun({ cases, review, runFolder, only })` reads a stored run as it is and spends nothing (the replay,
// `--keep`), with the same checks. `plannedSessions` gives what a run would spend: its sessions and their engines.
// `sameRun(sessions)` says whether sessions ran on one CLI version and model per engine; `sameRunRefusal` says why
// not, in a sentence.
// `buildSetups(inputs, sessions)` builds a case's five setups from its stored sessions as the service builds round 1
// (finds merged Claude then Codex, `toConfirm` on an empty ledger, the confirm policy or `unconfirmed` at Quick,
// `reconcile` at Lookover's default strictness, every rule switched on), each answer read again by `review`'s own
// passes, as the runner reads a find; a setup whose session failed or never ran is missing, with why.
// `score(cases, results)` matches each finding to the planted bug (same file, head side, within three lines of a
// range) and scores every setup over the complete cases; `decide(scores)` applies ADR 0050's rule in its order.
// `report(scores, decision, meta)` gives the research note's Markdown: counts beside every rate, the run count, the
// rule's verdict in the record's words, every finding that matched or didn't, and the author's reading between its
// markers. `replayRecorded({ corpus, recordedDir })` reads a committed run (the runner's store, read-only, on engines
// that answer nothing: no process, no git) and gives its CLIs, scores and verdict; `writeReport({ casesDir,
// recordedDir, reportFile, date? })` writes them to `<recordedDir>/scores.json` with the run's date, and the report,
// keeping the author's reading. The replay test holds the committed scores to what the replay gives.
// The shared types (`types.ts`) are the setups', the runner's and the scorer's words: `EvalCase`, `Planted` and its
// `Place`s, `SessionName`, `SessionRecord`, `CaseInputs`, `SetupName`, `SetupResult`, and their tests:
// `isSessionName`, `isUsable` (stored usable: a rerun skips it), `isRead` (its answer read), `DAY` (a run's date).
// Why each stage is exported: the harness's one user is `scripts/eval.ts`, which needs only the corpus, the runner,
// `readRun`, `sameRun` and the report; but each stage (load, build, prepare, set up, score, decide, report) is a seam
// of the pipeline with its own rules, driven by its own test through this entry, as the whole is by the replay test.
// Invariants: each place of a case's planted bug (its own, and the others it lists) is a file its change writes, its
// ranges within that file's head lines; a case is planted or clean, never both; its texts are LF whatever the checkout
// did; its commits depend on nothing but the case and `REVIEW.md`. A stored answer is never paid for twice, and never
// returned for a case or rules edited since.
// Error modes: `parseCase` and `loadCorpus` throw an `Error` naming the file and the reason (a missing or unknown
// field, both `planted` and `clean`, a range outside the change, a duplicate path, a file that isn't a case);
// `buildCase` throws when git fails, with git's words; `prepareCase` throws what `retrieval` throws
// (`RetrievalError`). The runner refuses before any session above its cap, under a held lock, or with the run
// folder and the build root inside each other; an engine signed out, at its limit or cancelled stops the whole run
// (`stopped`), any other failure is stored with its reason and the run goes on. It throws, naming the file or the
// case, for a stored file it can't read or that isn't its session's, a case or `REVIEW.md` edited since its
// sessions ran, a worktree outside the build root, rules prepared without the corpus' `REVIEW.md` or other than
// the stored ones, before any session of that case; and rethrows a session that threw once every other running
// session has ended.
// `writeReport` throws, writing nothing, with no date, on sessions of more than one CLI version or model per engine,
// or when the old report lost its reading's markers.
// It must never know: a real engine, a Git host, the service. It never wires `claude` or `codex`: `scripts/eval.ts`
// does, so nothing on the test path can call them.
export { type BuildCase, buildCase } from "./build.ts";
export { loadCorpus, parseCase } from "./cases.ts";
export { DEEP_MARGIN, type Decision, decide, MIN_COMPARED_CASES } from "./decide.ts";
export { prepareCase } from "./prepare.ts";
export { type CasePreparer, casePreparer } from "./preparer.ts";
export { type ReportMeta, report } from "./report.ts";
export {
  type CaseRun,
  type CorpusRun,
  type Planned,
  plannedSessions,
  type RunCorpusOptions,
  type RunScope,
  type RunStop,
  readRun,
  runCorpus,
} from "./run.ts";
export { type SameRun, sameRun, sameRunRefusal } from "./same-run.ts";
export {
  type ConfirmMeasure,
  type Cost,
  type Counts,
  type Incomplete,
  type ScoredFinding,
  type Scores,
  type SetupScore,
  score,
} from "./score.ts";
export { buildSetups } from "./setups.ts";
export type {
  BuiltCase,
  CaseFile,
  CaseInputs,
  CaseResult,
  ChangeFile,
  Corpus,
  EvalCase,
  Language,
  Place,
  Planted,
  PrepareCase,
  PreparedCase,
  ReadRecord,
  SessionCli,
  SessionFailure,
  SessionName,
  SessionRecord,
  SetupName,
  SetupResult,
} from "./types.ts";
export { DAY, isRead, isSessionName, isUsable, SESSIONS, SETUPS } from "./types.ts";
export { type Replayed, replayRecorded, type WriteReportOptions, writeReport } from "./write-report.ts";
