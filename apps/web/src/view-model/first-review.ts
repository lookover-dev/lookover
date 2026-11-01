// Setup's First review list (#425, ADR 0070): the pull requests it offers, which of them Lookover already reviewed
// on their head by itself, what is picked, and what the step says when nothing is left to pick.
import type { ChangeId, State } from "@lookover/contracts";
import { roundOnHead } from "./findings.ts";
import { CHIPS, type ChangeReview, changeReviews, chip, type StateChip } from "./select.ts";

/**
 * The pull requests setup's first review offers: the owner's, in a repository that is on. Never another author's,
 * nor one from a fork, whoever opened it (ADR 0048): neither is reviewed unless asked by hand.
 */
export function firstReviewCandidates(state: State): ChangeReview[] {
  return changeReviews(state).filter(
    (it) => it.repo.enabled && it.change.author !== "other" && !it.change.fork,
  );
}

/** One row of the list: a pull request offered, and whether Lookover already reviewed its head commit. */
export interface FirstReviewRow extends ChangeReview {
  /**
   * A round posted on the change's head commit, its job done there and not a preview: picking it would post the
   * same review again, so the row can't be picked. A review running now, a preview, or a skipped, failed or
   * cancelled job stays pickable.
   */
  reviewed: boolean;
  /** The state chip's words, as Home says them; what a reviewed row shows beside its link. */
  chip: StateChip;
}

/**
 * The chips a reviewed row can show (a done job leaves the loop's state), each held in its place so a row becoming
 * reviewed moves nothing.
 */
export const REVIEWED_CHIPS: readonly StateChip[] = [
  CHIPS.clean,
  CHIPS.settled,
  CHIPS["to-fix"],
  CHIPS["needs-you"],
];

/** What the step says when every pull request listed was reviewed already. */
export const NONE_LEFT =
  "Lookover already reviewed these by itself. Open one on GitHub to see its review, or go on.";

/** Whether the step says `NONE_LEFT`: pull requests are listed, and every one was reviewed already. */
export function noneLeft(rows: readonly FirstReviewRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.reviewed);
}

const reviewedOnHead = (it: ChangeReview): boolean =>
  it.review.job?.state === "done" && roundOnHead(it.review, it.change);

/**
 * The list: the rows already `shown` keep their places, in that order (a review that ends moves none, though Home
 * would put it first), and a pull request that appears is added under them; the first time, Home's order (the latest
 * update first).
 */
export function firstReviewRows(state: State, shown: readonly ChangeId[] = []): FirstReviewRow[] {
  const place = (id: ChangeId) => {
    const at = shown.indexOf(id);
    return at === -1 ? shown.length : at;
  };
  return firstReviewCandidates(state)
    .map((it, i) => ({ it, at: place(it.change.id), i }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(({ it }) => ({ ...it, reviewed: reviewedOnHead(it), chip: chip(it) }));
}

/**
 * The pull request picked (ADR 0068): the person's pick while it is listed and not reviewed, else the first such in
 * `rows` (`firstReviewRows`, in the order shown); null when none is. The list follows the host, so a pull request
 * that appears is picked when none was, and one that closes or gets reviewed hands the pick on.
 */
export function firstReviewPick(rows: readonly FirstReviewRow[], picked: ChangeId | null): ChangeId | null {
  const pickable = rows.filter((it) => !it.reviewed);
  return (pickable.find((it) => it.change.id === picked) ?? pickable[0])?.change.id ?? null;
}
