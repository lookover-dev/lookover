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
  /** The last run was a preview and left findings open: nothing was posted, so they are the owner's to read (ADR 0072). */
  | { kind: "preview" }
  | { kind: "settled"; clean: boolean }
  /** Cancelled before any round, and why (null for a job cancelled before the service said why). */
  | { kind: "cancelled"; reason: CancelReason | null }
  /** The job failed before any round; why, when the service said. */
  | { kind: "failed"; failure: JobFailure | null };

/** All reviews' outcome filters (`filters.ts`). */
export type Filter = "all" | "needs" | "open" | "done" | "skipped";

/**
 * The one filter besides All that holds each status; waiting and running reviews are only in All. A preview is the
 * owner's to read, so it needs you (ADR 0072). Home's Needs you group is the same.
 */
export const FILTER_OF = {
  "needs-you": "needs",
  failed: "needs",
  preview: "needs",
  "to-fix": "open",
  settled: "done",
  skipped: "skipped",
  "not-asked": "skipped",
  cancelled: "skipped",
  waiting: "all",
  running: "all",
} as const satisfies Record<DisplayStatus["kind"], Filter>;

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
      return review.preview ? { kind: "preview" } : { kind: "to-fix" };
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
      // A skip that never said why is shown as not reviewed, never as another author's (ADR 0078).
      return job.skip === null
        ? fromLoop(review, { kind: "not-asked" })
        : { kind: "skipped", reason: job.skip };
    case "done":
      return fromLoop(review, { kind: "not-asked" });
    case "cancelled":
      return fromLoop(review, { kind: "cancelled", reason: job.cancel });
    case "failed":
      return fromLoop(review, { kind: "failed", failure: job.failure });
  }
}
