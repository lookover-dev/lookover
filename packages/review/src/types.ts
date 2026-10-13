// What the review takes and what it gives back: the service → review seam. The job, what was prepared and the
// round outcome are contracts' own (`ReviewJob`, `Prepared`, `RoundOutcome`); the policy and the run's result
// are this module's.
import type {
  CandidateFinding,
  CandidateVerdict,
  ConfirmFailure,
  EngineActivity,
  EngineId,
  EngineRunOutcome,
  Finding,
  FindRunPass,
  LimitMet,
  Prepared,
  PromptRulesFile,
  ReviewJob,
  RoundOutcome,
  RoundSession,
} from "@lookover/contracts";

/**
 * An earlier round's finding still open: what round 2 asks the engine about, with the newest claim its author made
 * on its thread (ADR 0052), or null.
 */
export type EarlierFinding = Pick<
  Finding,
  "id" | "severity" | "category" | "title" | "body" | "file" | "side" | "line" | "endLine" | "claim"
>;

/** How this run reviews: which engine, which pass, which round, what it must re-check, and the run's limits. */
export interface ReviewPolicy {
  engine: EngineId;
  /** Which find pass of the round this is: the finder's, or Deep's second; names the session (ADR 0055). */
  pass: FindRunPass;
  /** The round being produced, numbered per change from 1; said in the prompt. */
  round: number;
  /** The change's findings still open from earlier rounds; empty in round 1. */
  earlier: EarlierFinding[];
  timeoutMs: number;
  /** The run's folder, where the engine keeps the prompt and the raw answer. */
  artefactsDir: string;
  /**
   * Where the whole diff is saved inside the working directory, relative to it (`retrieval` writes it): a prompt
   * cut to its engine's input limit sends the engine there for what it doesn't show, removed lines and deleted
   * files included, which the checkout can't show and an engine without git can't get. None: not saved.
   */
  diffFile?: string;
  /** The repository's rules from its default branch, within the prompt budget (ADR 0048); empty when it has none. */
  rules: PromptRulesFile[];
  /** Told each activity the engine reports while it runs (ADR 0055), passed to the engine as it is. None: nobody listens. */
  onActivity?: (activity: EngineActivity) => void;
}

/**
 * Why a run produced no round: the engine did not answer (its outcome, as the port reports it), or it answered
 * but not in a shape that can be read at all (`missing_block`: no fenced block and no JSON from the port;
 * `malformed_block`: the last fence is not JSON and the port had none; `invalid_block`: JSON, but not an object
 * with `findings` and `earlier` lists, or a verdict on a finding that was never asked about).
 */
export type ReviewFailure =
  | Exclude<EngineRunOutcome, "ok">
  | "missing_block"
  | "malformed_block"
  | "invalid_block";

/**
 * A find pass's result: its round, whose `sessions` hold the one session it ran, or why it gave none, with what its
 * session used all the same (ADR 0055: an engine that answered spent its tokens, whatever was wrong with the answer).
 */
export type ReviewRun =
  | { kind: "reviewed"; round: RoundOutcome }
  | ({
      kind: "failed";
      reason: ReviewFailure;
      problems: string[];
      text: string;
      session: RoundSession;
    } & LimitMet);

/** How the confirm pass runs: on which engine (the round's confirmer), for which round, and the run's limits. */
export interface ConfirmPolicy {
  engine: EngineId;
  /** The round being produced: said in the prompt. */
  round: number;
  timeoutMs: number;
  /** The confirm session's own folder, a sub-folder of the run's. */
  artefactsDir: string;
  /** The same rules the find pass was given (ADR 0048), so a claim that cites one is judged against it. */
  rules: PromptRulesFile[];
  /** Told each activity the engine reports while it runs (ADR 0055), passed to the engine as it is. None: nobody listens. */
  onActivity?: (activity: EngineActivity) => void;
}

/** One candidate the confirm pass was given, and its verdict: the same object, so the caller finds it by it. */
export interface JudgedCandidate {
  candidate: CandidateFinding;
  verdict: CandidateVerdict;
}

/**
 * What a confirm pass gives back, never a failure (ADR 0044): one verdict per candidate given, in their order.
 * `failure`: why the session gave no verdicts at all (the engine's outcome, or `unreadable` when its answer held
 * no block that could be read), every candidate then `not_checked`; null when the block was read, a candidate it
 * left out or answered in the wrong shape `not_checked` and named in `problems`.
 */
export interface ConfirmRun extends LimitMet {
  judged: JudgedCandidate[];
  failure: ConfirmFailure | null;
  /** The engine's free notes, before the block. */
  notes: string;
  /** What the answer had that was not read, one line each. */
  problems: string[];
  /** What its session used, whatever came of it (ADR 0055); null when no session ran: no candidate to confirm. */
  session: RoundSession | null;
}

export interface ConfirmPass {
  /**
   * One confirm session for `candidates`, on `policy.engine`, in `prepared`'s worktree; no session when there is
   * no candidate. Never throws for anything the engine does.
   */
  run(
    job: ReviewJob,
    prepared: Prepared,
    candidates: CandidateFinding[],
    policy: ConfirmPolicy,
    signal: AbortSignal,
  ): Promise<ConfirmRun>;
}

export interface FindPass {
  /** One find pass for `job` on `prepared`, as `policy` says. Never throws for anything the engine does. */
  run(job: ReviewJob, prepared: Prepared, policy: ReviewPolicy, signal: AbortSignal): Promise<ReviewRun>;
}
