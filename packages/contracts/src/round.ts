// A round: a run that finished and posted its result. Rounds are numbered per change. Of the words review
// job, run, loop and round, it is the only one the screens show. Also here: what one find pass produces for
// the round (`RoundOutcome`, `review`'s answer and `core.reconcile`'s input), with the candidate findings and
// their fingerprints (ADR 0032), and the verdicts on the earlier open findings. The confirm pass's verdict on one
// candidate, and what a refuted candidate leaves in its round (ADR 0044).
import type { ConfirmFailure, ConfirmFallback, ConfirmVerdict } from "./confirm.ts";
import type { Anchoring, DiffLocation } from "./diff.ts";
import type { EngineId } from "./engine.ts";
import type { EngineUsage } from "./engines-port.ts";
import type { Fingerprints, Severity } from "./finding.ts";
import type { CommitSha, FindingId } from "./ids.ts";
import type { CitedRule } from "./rule.ts";
import type { RunPass, RunStep } from "./run.ts";

/**
 * Depth Deep's second find pass in a round (ADR 0044): the engine that ran it (the run's `secondFinder`), and why it
 * gave no round when it failed (its findings missing, the first pass's posted alone; the job never fails for it), in
 * the confirm pass's words: the engine's outcome, or `unreadable`. `failure` null: its findings were merged in.
 */
export interface SecondFind {
  engine: EngineId;
  failure: ConfirmFailure | null;
}

/**
 * What one engine session of a round used (ADR 0055): its pass, its engine, how long its program ran and the tokens
 * its CLI reported (null when it said none). A session that answered counts even when its pass failed.
 */
export interface RoundSession {
  pass: RunPass;
  engine: EngineId;
  ms: number;
  usage: EngineUsage | null;
}

export interface Round {
  n: number;
  sha: CommitSha;
  /** The finder: the run's `reviewer`. */
  reviewer: EngineId;
  /** Deep's second find pass, filled by the service from its run; null when the round had one find pass. */
  secondFind: SecondFind | null;
  /**
   * The engine that ran the round's confirm session (ADR 0044); null when the round wasn't confirmed (depth Quick,
   * or no candidate to confirm). Filled by the service from its run's confirm step.
   */
  confirmer: EngineId | null;
  /** The run's `confirmFallback`, copied by the service when the round is made: why the finder confirmed. */
  confirmFallback: ConfirmFallback | null;
  /**
   * Why the confirm session gave no verdicts, when it failed: its candidates were posted as found, not checked.
   * Filled by the service from `review`'s confirm answer; null when the pass read, or didn't run.
   */
  confirmFailure: ConfirmFailure | null;
  /**
   * The candidates the confirmer refuted, in the finder's order: no findings, kept for the app's "N ruled out".
   * Filled by the service from `core`'s confirm policy; empty when nothing was refuted, or no confirm ran.
   */
  ruledOut: RuledOut[];
  startedAt: number;
  endedAt: number;
  raised: number;
  verifiedFixed: number;
  /** Findings still open on the pull request when the round ended: only posted findings count (I-152). */
  open: number;
  steps: { step: RunStep; ms: number }[];
  /**
   * What each of its engine sessions used, in the order they ran: find, Deep's second find, confirm (ADR 0055). Filled
   * by the service from its run; a pass that never ran a session has none here.
   */
  sessions: RoundSession[];
}

/** A finding as the engine proposed it, read by `review`, before `core` gives it an identity and a status. */
export interface CandidateFinding {
  severity: Severity;
  category: string;
  title: string;
  /** Markdown, in the shape "when X, Y breaks, because Z". */
  body: string;
  /** The line it is on, and the last line of its range: null when the engine reported one line. */
  location: DiffLocation & { endLine: number | null };
  /**
   * The text of `location.line` as the engine copied it (`line_text`, ADR 0044, I-158), once `review` re-anchored
   * the candidate to the line that holds it; null when the engine gave none.
   */
  lineText: string | null;
  /** How `review` anchored it by `lineText` (ADR 0044): `reported` until `review` re-anchors. */
  anchoring: Anchoring;
  /** The engine whose find pass proposed it: set by `review` from the pass, kept when a Deep round merges two. */
  foundBy: EngineId;
  /** The engine's short snake_case name of the kind of defect; feeds the meaning fingerprint. */
  defectKey: string;
  /** Replacement code that fully fixes it, when the engine offers one. */
  suggestion: string | null;
  /** The problem was there before this change (ADR 0025). */
  preExisting: boolean;
  /** The repository's rule it follows, as `review` mapped the finder's label (ADR 0048); null when it cites none. */
  rule: CitedRule | null;
  fingerprints: Fingerprints;
}

/**
 * The engine's verdict on an earlier open finding: still there at this commit, gone, `wrong` when the finder,
 * reading the author's dispute with it, says the finding was a mistake (ADR 0052), or `unknown` when the engine
 * gave none, in which case the finding stays as it was.
 */
export interface EarlierVerdict {
  id: FindingId;
  verdict: "present" | "gone" | "wrong" | "unknown";
  /** The engine's one sentence on why; empty when unknown. */
  why: string;
}

/**
 * The confirm pass's verdict on one candidate (ADR 0044): read by `review`'s confirm entry, turned by `core`'s
 * confirm policy into the finding's severity and `Confirmation`, or a `RuledOut`. A verdict names the confirmer,
 * its one-sentence reason, the lines it cites (`path:line`) and the severity it would give, which replaces the
 * finder's. `not_checked`: the confirm session left the candidate out, or gave no verdicts at all.
 */
export type CandidateVerdict =
  | { verdict: ConfirmVerdict; by: EngineId; reason: string; evidence: string[]; severity: Severity }
  | { verdict: "not_checked" };

/** A candidate the confirmer refuted (ADR 0044): not a finding, kept with its round, with who refuted it and why. */
export interface RuledOut {
  candidate: CandidateFinding;
  by: EngineId;
  reason: string;
  evidence: string[];
}

/** What one find pass produced for the round: `review`'s answer, `core.reconcile`'s input. */
export interface RoundOutcome {
  sha: CommitSha;
  engine: EngineId;
  /** The engine's free notes, before the block. Kept for the run's record, never posted as they are. */
  notes: string;
  candidates: CandidateFinding[];
  /** One verdict per earlier open finding asked about: the engine's order, then the unanswered ones as `unknown`. */
  earlier: EarlierVerdict[];
  /** Why the engine found nothing, when it said so. */
  emptyReason: string | null;
  /** What the answer had that was not read (a finding in the wrong shape, a missing verdict), one line each. */
  problems: string[];
  /** What its find sessions used: the one pass's, or a merged Deep round's two, in pass order, never summed (ADR 0055). */
  sessions: RoundSession[];
}
