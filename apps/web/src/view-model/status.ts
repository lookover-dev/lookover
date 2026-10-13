// The one display status of a change, derived from its three levels (ADR 0029): the review job says whether a
// review waits or runs, the run says at which step, and the loop says where the back-and-forth stands once
// nothing waits or runs.
import type {
  CancelReason,
  Deferral,
  JobFailure,
  Review,
  RunStep,
  SkipReason,
  Turn,
} from "@lookover/contracts";
import { asSentence, cancelPhrase, failureText } from "@lookover/contracts";

export { failureText };

export type DisplayStatus =
  /** No review asked for yet. */
  | { kind: "not-asked" }
  | { kind: "skipped"; reason: SkipReason }
  /**
   * Waiting its turn (no deferral), behind what `turn` says (null until the service says, ADR 0055), or deferred
   * for a reason outside the review.
   */
  | { kind: "waiting"; deferral: Deferral | null; turn: Turn | null }
  | { kind: "running"; round: number; step: RunStep }
  /** A finding is escalated: only the owner can settle it. */
  | { kind: "needs-you" }
  | { kind: "to-fix" }
  | { kind: "settled"; clean: boolean }
  /** Cancelled before any round, and why (null for a job cancelled before the service said why). */
  | { kind: "cancelled"; reason: CancelReason | null }
  /** The job failed before any round; why, when the service said. */
  | { kind: "failed"; failure: JobFailure | null };

/** Why the review was cancelled, as a sentence after "This review was cancelled.", or nothing. */
export function cancelSentence(reason: CancelReason | null): string {
  return reason === null ? "" : asSentence(cancelPhrase(reason));
}

/**
 * Why the review did not run, as a sentence of its own: contracts' `copy.ts` phrase (story 9 of spec #17: "the
 * service stopped"), which the check on GitHub says too, naming the engine that gave no review.
 */
export function failureSentence(failure: JobFailure | null): string {
  return asSentence(failureText(failure));
}

/** Where the loop stands; `none` when there is no round yet. */
function fromLoop(review: Review, none: DisplayStatus): DisplayStatus {
  switch (review.loop) {
    case "needs_owner":
      return { kind: "needs-you" };
    case "open":
      return { kind: "to-fix" };
    case "settled":
      return { kind: "settled", clean: review.findings.length === 0 };
    case null:
      return none;
  }
}

export function displayStatus(review: Review): DisplayStatus {
  const { job } = review;
  if (!job) return fromLoop(review, { kind: "not-asked" });
  switch (job.state) {
    case "queued":
      return { kind: "waiting", deferral: null, turn: job.turn };
    case "deferred":
      return { kind: "waiting", deferral: job.deferral, turn: null };
    case "running":
      return { kind: "running", round: review.rounds.length + 1, step: review.run?.step ?? "preparing" };
    case "skipped":
      return { kind: "skipped", reason: job.skip ?? "not-yours" };
    case "done":
      return fromLoop(review, { kind: "not-asked" });
    case "cancelled":
      return fromLoop(review, { kind: "cancelled", reason: job.cancel });
    case "failed":
      return fromLoop(review, { kind: "failed", failure: job.failure });
  }
}
