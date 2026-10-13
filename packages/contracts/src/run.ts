// The run (ADR 0029): one attempt to carry out a review job, step by step. A job retried after a crash, or
// deferred while it ran, has several runs. Owned by the review module. Who finds and who confirms are decided
// when the job is taken, and held for the whole run (ADR 0044).
import type { RunActivity } from "./activity.ts";
import type { ConfirmFallback } from "./confirm.ts";
import type { EngineId } from "./engine.ts";
import type { TransientHostFailure } from "./host.ts";
import type { CommitSha, RunId } from "./ids.ts";

export type RunStep = "preparing" | "finding" | "confirming" | "publishing";

/** A run's engine sessions: the find pass, Deep's second find pass, the confirm pass (its run folder's names). */
export type RunPass = "find" | "find-2" | "confirm";

/** A run's find passes: the find pass and Deep's second (ADR 0044). */
export type FindRunPass = Exclude<RunPass, "confirm">;

/**
 * A publishing run's outbox (ADR 0055): how many of its round's posts are `sent` of the `owed` ones, and while the
 * host makes it wait, until when (`until`, ms since the epoch) and the host's refusal; null when nothing waits.
 */
export interface RunPosting {
  sent: number;
  owed: number;
  wait: { until: number; refusal: TransientHostFailure } | null;
}

export interface Run {
  id: RunId;
  /** The finder (ADR 0044): the engine whose find pass reviews the change. Its failure defers or fails the job. */
  reviewer: EngineId;
  /**
   * Depth Deep's second find pass (ADR 0044): always the confirmer (the other engine, or `reviewer` again when the
   * other may not review the change or isn't ready), so a run holds no engine beyond its finder and its confirmer;
   * null for one find pass (Quick, Standard). Filled by the service's take. Its failure never defers or fails the
   * job: the round goes on with the first pass's findings.
   */
  secondFinder: EngineId | null;
  /**
   * The engine planned to confirm (ADR 0044): the other one, or `reviewer` in a new session (`confirmFallback`
   * says why); null when the run confirms nothing (depth Quick). Filled by the service's take. Its failure never
   * defers or fails the job.
   */
  confirmer: EngineId | null;
  /** Why `confirmer` is the finder rather than the other engine; null when it isn't, or there is no confirmer. */
  confirmFallback: ConfirmFallback | null;
  sha: CommitSha;
  /** A preview posts nothing: the first review, run as "preview here only". */
  preview: boolean;
  startedAt: number;
  step: RunStep;
  stepAt: number;
  /** The steps already done, and how long each took. */
  steps: { step: RunStep; ms: number }[];
  /**
   * What its engines did, newest last, the last `RUN_ACTIVITIES_KEPT` (ADR 0055): live only, gone with the run.
   * Empty when a run starts.
   */
  activities: RunActivity[];
  /** Its outbox while it posts (ADR 0055); null before its first `run.posting`. */
  posting: RunPosting | null;
}

/** The run's steps once its current step is closed at `at`: the steps done, then the current one and how long it took. */
export function stepsDone(run: Pick<Run, "step" | "stepAt" | "steps">, at: number): Run["steps"] {
  return [...run.steps, { step: run.step, ms: at - run.stepAt }];
}
