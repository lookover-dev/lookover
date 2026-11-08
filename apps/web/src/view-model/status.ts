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
import { asSentence, cancelPhrase, failureWords } from "@lookover/contracts";

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
  /** The job failed before any round (after one, the loop says; the review screen says the failure above it); why. */
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
 * Why a review failed and what to do, in the app (ADR 0081): the cause's sentence, as the status block says it;
 * then, where another try can't help, what would change it. Where it can, `next` is null: the page's one primary
 * button says "Try again" (`reviewButton`), so the notice says only the cause.
 */
export function failedWords(failure: JobFailure | null): { sentence: string; next: string | null } {
  const words = failureWords(failure);
  return { sentence: words.sentence, next: words.retry ? null : words.next };
}

/**
 * What a failed review's notice says under its cause where another try is known to help (round 6, 2026-11-08: the
 * cause alone read as hiding the rest in the log): what the cause means when its sentence is short, then how likely
 * another try works; "Try again" above is the way. Null where that isn't known (ADR 0081: the cause and its limit,
 * another try only where it helps): no cause said (an unexpected error, a publish that failed, the service stopped,
 * GitHub's rate limit, a session cancelled or signed out), or a cause another try can't cure, which has its remedy.
 */
export function retryNote(failure: JobFailure | null): string | null {
  switch (failure?.cause ?? null) {
    case "engine_answer":
      return "It stopped, or sent an answer Lookover couldn't read. Another try usually works.";
    case "git_silent":
    case "network":
      return "Another try usually gets through.";
    default:
      return null;
  }
}

/** Whether another try can help a failed review (ADR 0081): the review button then says "Try again". */
export function retryHelps(failure: JobFailure | null): boolean {
  return failureWords(failure).retry;
}

/**
 * The eyes an outcome's card opens with, in their tone (ADR 0083, round 6: "Looked over" without them read as a
 * second pattern): green once settled, amber while findings are left to fix, quiet (`--muted`) where the review ended
 * without one: cancelled, or not reviewed. Null where the page shows no verdict card but a block of its own: a running
 * round, a wait, and where the person is needed, the escalated banner or the failed notice, whose eyes are theirs.
 */
export function outcomeEyes(s: DisplayStatus): EyesTone | null {
  return OUTCOME_EYES[s.kind];
}

export type EyesTone = "ok" | "fix" | "quiet";

const OUTCOME_EYES = {
  settled: "ok",
  "to-fix": "fix",
  preview: "fix",
  "needs-you": null,
  failed: null,
  cancelled: "quiet",
  skipped: "quiet",
  "not-asked": "quiet",
  waiting: null,
  running: null,
} as const satisfies Record<DisplayStatus["kind"], EyesTone | null>;

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

/**
 * Whether a review's page ends with Details (settings used, its log, and once a round ran or runs, how it ran). Before
 * any round only a failed review has them, its log the way to see why; a waiting, skipped or cancelled one used no
 * settings yet.
 */
export function detailsShown(review: Review): boolean {
  if (review.run || review.rounds.length > 0) return true;
  return displayStatus(review).kind === "failed" && review.timeline.length > 0;
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
