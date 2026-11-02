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

/**
 * Whether Lookover's last job on the change is done and a round sits on its head commit: setup's reviewed row, and
 * Try it's clean posted review, whose check is on the head.
 */
export const reviewedOnHead = (it: ChangeReview): boolean =>
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

/**
 * The bar's primary (ADR 0072): Continue ("go-on") when nothing can be picked or as soon as a listed row is
 * reviewed, since a review Lookover posted by itself is a first review; else "Review this pull request".
 */
export function firstReviewPrimary(
  rows: readonly FirstReviewRow[],
  picked: ChangeId | null,
): "review" | "go-on" {
  return picked === null || rows.some((row) => row.reviewed) ? "go-on" : "review";
}

const namedLine = (row: FirstReviewRow, word: string): string =>
  `Lookover already reviewed ${row.change.repoId} #${row.change.number} by itself: ${word}.`;

const countedLine = (n: number): string => `Lookover already reviewed ${n} of your pull requests by itself.`;

/**
 * The line above the bar once a row is reviewed (ADR 0072): the one reviewed, named with its chip's word; a count
 * when several are; `NONE_LEFT` when every one is; "" while none is.
 */
export function reviewedLine(rows: readonly FirstReviewRow[]): string {
  const reviewed = rows.filter((row) => row.reviewed);
  const [only] = reviewed;
  if (only === undefined) return "";
  if (noneLeft(rows)) return NONE_LEFT;
  return reviewed.length === 1 ? namedLine(only, only.chip.label) : countedLine(reviewed.length);
}

/**
 * The bar's middle place (ADR 0072): the secondary "Review this pull request" ("review") while Continue is the
 * primary because a row is reviewed and one can still be picked; else "Preview here only, post nothing"
 * ("preview", disabled when nothing can be picked). Once a review was posted, previewing is no longer offered.
 */
export function firstReviewSecondary(
  rows: readonly FirstReviewRow[],
  picked: ChangeId | null,
): "preview" | "review" {
  return picked !== null && firstReviewPrimary(rows, picked) === "go-on" ? "review" : "preview";
}

/**
 * The lines laid in one place (`HeldDetail`) so the line never grows when a review lands: the one shown, and every
 * one the step could show for these rows (each row named with each chip word a reviewed row can show, the count as
 * large as it can be, `NONE_LEFT`).
 */
export function reviewedLines(rows: readonly FirstReviewRow[]): string[] {
  const lines = [
    reviewedLine(rows),
    ...rows.flatMap((row) => REVIEWED_CHIPS.map((c) => namedLine(row, c.label))),
    countedLine(Math.max(2, rows.length)),
    NONE_LEFT,
  ];
  return [...new Set(lines)];
}
