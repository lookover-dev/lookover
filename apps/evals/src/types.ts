// The harness's words (ADR 0050), shared by the loader, the builder, the setups, the runner and the scorer: an eval
// case and its planted bug, the five sessions a case is reviewed in, what each session leaves on disk, the five
// setups built from them and what each kept. Findings, verdicts and usage are `contracts`' own types: the harness
// scores what the service would post, never a copy of it.
import type {
  CommitSha,
  ConfirmFailure,
  EngineId,
  EngineRunOutcome,
  EngineUsage,
  Finding,
  RuledOut,
  RulesFile,
} from "@lookover/contracts";
import type { Judged } from "@lookover/core";
import type { ReviewFailure } from "@lookover/review";

/** The languages the corpus is written in: a case names one. */
export const LANGUAGES = { typescript: true, python: true } satisfies Record<string, true>;
export type Language = keyof typeof LANGUAGES;

/** A file of a case's base, or one its change writes: a path relative to the repository's root, its text (LF). */
export interface CaseFile {
  path: string;
  content: string;
}

/** What the change does to one file: writes it (a new file, or the head's version of a base file), or deletes it. */
export type ChangeFile = CaseFile | { path: string; deleted: true };

/**
 * A place where a finding names a planted bug: a file the change writes and its head-side line ranges (`[start,
 * end]`, 1-based, inclusive; one or more).
 */
export interface Place {
  path: string;
  ranges: [start: number, end: number][];
}

/**
 * The bug a case plants (ADR 0050): its place (the file it is in, the head-side line ranges where a finding counts,
 * such as the call and the callee of a missing `await`), the other places that name the same bug (`also`, its 0050
 * amendment: the test the change writes for the planted code, a callee in another file; absent when the case lists
 * none, so a case's hash stays what it was), and what it is in one sentence. The answer key: never shown to an
 * engine.
 */
export interface Planted extends Place {
  also?: Place[];
  what: string;
}

/**
 * One eval case, as the loader read it from `cases/<id>.yaml`: its id (the file's name), its language, a one-line
 * summary, the base's files, the change's files, and its planted bug, or null for a clean case (`clean: true`).
 * Every text is LF. `change` has at least one file, and `planted.path` is a file the change writes, its ranges
 * within that file's head lines.
 */
export interface EvalCase {
  id: string;
  language: Language;
  summary: string;
  base: CaseFile[];
  change: ChangeFile[];
  planted: Planted | null;
}

/** The corpus: its cases, in their files' order, and the `REVIEW.md` every case's default branch carries (LF). */
export interface Corpus {
  cases: EvalCase[];
  review: string;
}

/**
 * A case built into a local repository (`buildCase`): its neutral name (`case-<8 hex>`, from its id: the id names the
 * bug, so no path, job or repository an engine can see carries it); the repository's path, which `retrieval` fetches
 * from as its clone URL; `main`'s commit (the base and `REVIEW.md`), every case's base; and `change`'s commit, its head.
 */
export interface BuiltCase {
  id: string;
  name: string;
  cloneUrl: string;
  base: CommitSha;
  head: CommitSha;
}

/**
 * What a case's sessions saw (ADR 0050): the head commit their prompts name, the diff from the merge base as git
 * printed it, and the rules files read on the default branch, before `core` parses them. Stored once per case, so the
 * replay gives the sessions the same input with no git.
 */
export interface CaseInputs {
  head: CommitSha;
  diff: string;
  rules: RulesFile[];
}

/**
 * A case prepared for its sessions: its inputs, the review worktree they run in (removed by `dispose`), and the whole
 * diff's file in it (`retrieval`'s `diffFile`, relative to `cwd`), which every find is given as the service gives it.
 * Not stored: it only names the file in the prompt of a diff cut to fit, and the replay's fake engines read no prompt.
 */
export interface PreparedCase extends CaseInputs {
  cwd: string;
  diffFile: string;
  dispose(): Promise<void>;
}

/**
 * How the runner gets a case ready: the real one builds the case and prepares it through `retrieval`
 * (`buildCase`, `prepareCase`); the replay's gives the stored inputs.
 */
export type PrepareCase = (evalCase: EvalCase, signal: AbortSignal) => Promise<PreparedCase>;

/**
 * The five sessions of a case (ADR 0050), names frozen: they key the stored answers. `engine`: the engine it runs
 * on; `pass`: a find, or a confirm of the candidates of the finds it names, merged in that order (`core.mergeFinds`).
 */
export const SESSIONS = {
  "claude-find": { engine: "claude", pass: "find" },
  "codex-find": { engine: "codex", pass: "find" },
  "claude-confirms-claude": { engine: "claude", pass: "confirm", of: ["claude-find"] },
  "codex-confirms-claude": { engine: "codex", pass: "confirm", of: ["claude-find"] },
  "codex-confirms-both": { engine: "codex", pass: "confirm", of: ["claude-find", "codex-find"] },
} as const satisfies Record<
  string,
  | { engine: EngineId; pass: "find" }
  | {
      engine: EngineId;
      pass: "confirm";
      of: readonly ["claude-find" | "codex-find", ...("claude-find" | "codex-find")[]];
    }
>;
export type SessionName = keyof typeof SESSIONS;

/** Whether `name` is one of the five sessions' names. */
export const isSessionName = (name: string): name is SessionName => Object.hasOwn(SESSIONS, name);

/** Every session, in `SESSIONS`' order: a session added there is in it with no other change. */
export const SESSION_NAMES: readonly SessionName[] = Object.keys(SESSIONS).filter(isSessionName);

/** A day, as a run's date is written: `YYYY-MM-DD`. */
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Why a session's answer can't be used: the engine's outcome other than `ok`, or, for an answer that came back, what
 * `review`'s reader made of it (a find's missing, malformed or invalid block; a confirm's `unreadable`).
 */
export type SessionFailure = ReviewFailure | ConfirmFailure;

/** The CLI a session ran on, as `engines` reported it: the program, its version, the model it resolved; null unknown. */
export interface SessionCli {
  name: EngineId;
  version: string | null;
  model: string | null;
}

/**
 * What every session that ran leaves: the answer as the engine gave it (its text, and a structured-output run's
 * value, which `review`'s reader falls back to), its usage, its wall time and its CLI.
 */
interface SessionRun {
  session: SessionName;
  text: string;
  json: { value: unknown } | null;
  usage: EngineUsage | null;
  wallMs: number;
  cli: SessionCli;
}

/**
 * One session as stored in `<run folder>/<case>/<session>.json` the moment it ends. Read: the engine answered `ok` and
 * `review` read the answer (`failure` null). Failed: why its answer can't be used, the engine run's outcome (any, `ok`
 * included when the answer was unreadable). `no_candidates`: a confirm with nothing to judge, which spent no session.
 * A run whose outcome isn't `ok` always names its failure: no record of one can pass for read.
 */
export type SessionRecord =
  | (SessionRun & { outcome: "ok"; failure: null })
  | (SessionRun & { outcome: EngineRunOutcome; failure: SessionFailure })
  | { session: SessionName; outcome: "no_candidates" };

/** Whether a stored session can be used as it is: answered and read, or a confirm with nothing to judge. */
export function isUsable(record: SessionRecord): boolean {
  return record.outcome === "no_candidates" || record.failure === null;
}

/** A stored session whose answer came back and was read. */
export type ReadRecord = Extract<SessionRecord, { failure: null }>;

/** Whether a stored session's answer came back and was read: not failed, not a confirm with nothing to judge. */
export function isRead(record: SessionRecord): record is ReadRecord {
  return record.outcome !== "no_candidates" && record.failure === null;
}

/**
 * The five eval setups (ADR 0050), each built from a case's sessions as `core` builds a round: the finds it merges,
 * in that order, and the confirm it takes, or null for none (Quick).
 */
export const SETUPS = {
  quick: { finds: ["claude-find"], confirm: null },
  "quick-codex": { finds: ["codex-find"], confirm: null },
  "standard-one": { finds: ["claude-find"], confirm: "claude-confirms-claude" },
  "standard-cross": { finds: ["claude-find"], confirm: "codex-confirms-claude" },
  deep: { finds: ["claude-find", "codex-find"], confirm: "codex-confirms-both" },
} as const satisfies Record<
  string,
  {
    finds: readonly ["claude-find" | "codex-find", ...("claude-find" | "codex-find")[]];
    confirm: SessionName | null;
  }
>;
export type SetupName = keyof typeof SETUPS;

/**
 * What one setup made of one case. `complete`: the findings `core.reconcile` raised on an empty ledger at round 1,
 * those it would post at the default strictness (`kept`, each `posted`) and all of them (`all`, hidden ones
 * included), each with its `confirmation`; every candidate the confirm judged and its verdict, in the finder's order
 * (empty with no confirm); the candidates it refuted; the engine that confirmed (null at Quick, or with nothing to
 * judge); and the sessions it spent (a confirm with nothing to judge is none). `missing`: a session it needs failed
 * (its failure) or was never run (`not_run`), so the case is scored apart for this setup, never as an empty review.
 */
export type SetupResult =
  | {
      kind: "complete";
      kept: Finding[];
      all: Finding[];
      judged: Judged[];
      ruledOut: RuledOut[];
      confirmer: EngineId | null;
      sessions: SessionName[];
    }
  | { kind: "missing"; session: SessionName; reason: SessionFailure | "not_run" };

/** One case's results: its sessions as stored (one absent was never run) and every setup built from them. */
export interface CaseResult {
  caseId: string;
  sessions: Partial<Record<SessionName, SessionRecord>>;
  setups: Record<SetupName, SetupResult>;
}
