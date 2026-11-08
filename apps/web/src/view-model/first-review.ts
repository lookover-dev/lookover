// Setup's First review list (#425, ADR 0070): the pull requests it offers, which of them Lookover already reviewed
// on their head by itself, what is picked, and what the step says when nothing is left to pick.
import type { Change, ChangeId, State } from "@lookover/contracts";
import { roundOnHead } from "./findings.ts";
import { agoSentence, metaLine } from "./format.ts";
import { authorLabel, CHIPS, type ChangeReview, changeReviews, chip, type StateChip } from "./select.ts";

/**
 * A row's small line, under its title: "owner/repo #n · by sasensi · written by Claude · 6 min ago", as a meta line.
 */
export function firstReviewMeta(change: Change, now: number): string {
  return metaLine([
    `${change.repoId} #${change.number}`,
    authorLabel(change),
    agoSentence(now, change.openedAt),
  ]);
}

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

/**
 * The line under the list, in its sentences: the screen draws each as a block of its own, so neither breaks
 * mid-phrase nor leaves "#148 too." alone (round 6: `pretty` left it, `balance` across both split "by / itself").
 */
export type Sentences = readonly string[];

/** What the step says when every pull request listed was reviewed already. */
export const NONE_LEFT: Sentences = [
  "Lookover already reviewed these by itself.",
  "Open one on GitHub to see its review, or go on.",
];

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

/** A pull request as the line names it: "sasensi/ledger-api #152". */
const named = (row: FirstReviewRow): string => `${row.change.repoId} #${row.change.number}`;

/**
 * What follows a line naming the reviewed while one is still picked: the pick it leaves the person, by name, so the
 * radio on one pull request and the words on another agree (round 4: they read as a mismatch, then as vague).
 */
const picks = (pick: FirstReviewRow): string => `Go on, or review ${named(pick)} too.`;

const namedLine = (row: FirstReviewRow, word: string, pick: FirstReviewRow): Sentences => [
  `Lookover already reviewed ${named(row)} by itself: ${word}.`,
  picks(pick),
];

const countedLine = (n: number, pick: FirstReviewRow): Sentences => [
  `Lookover already reviewed ${n} of your pull requests by itself.`,
  picks(pick),
];

/**
 * The line above the bar once a row is reviewed (ADR 0072): the one reviewed, named with its chip's word; a count
 * when several are; either with the pick still left (`picked`, else the one `firstReviewPick` hands it to) by name;
 * `NONE_LEFT` when every one is; no sentence while none is.
 */
export function reviewedLine(rows: readonly FirstReviewRow[], picked: ChangeId | null): Sentences {
  const reviewed = rows.filter((row) => row.reviewed);
  const [only] = reviewed;
  if (only === undefined) return [];
  const pickId = firstReviewPick(rows, picked);
  const pick = rows.find((row) => row.change.id === pickId);
  if (noneLeft(rows) || pick === undefined) return NONE_LEFT;
  return reviewed.length === 1 ? namedLine(only, only.chip.label, pick) : countedLine(reviewed.length, pick);
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

/** How many of the longest-named rows the held lines name: a few, so a long list holds a handful of lines, not n². */
const HELD_NAMES = 3;

/**
 * The lines laid in one place (`HeldDetail`) so the line never grows when a review lands or the pick changes: the one
 * shown, and the longest the step could show for these rows: the few rows with the longest names, each named with
 * each chip word a reviewed row can show and each other of them picked, the count as large as it can be with each of
 * them picked, and `NONE_LEFT`. Only the longest names are crossed (Lookover's round 4 F1: every pair of 300 rows
 * was 359,102 hidden lines).
 */
export function reviewedLines(rows: readonly FirstReviewRow[], picked: ChangeId | null): Sentences[] {
  const longest = [...rows].sort((a, b) => named(b).length - named(a).length).slice(0, HELD_NAMES);
  const lines = [
    reviewedLine(rows, picked),
    ...longest.flatMap((row) =>
      longest
        .filter((pick) => pick !== row)
        .flatMap((pick) => REVIEWED_CHIPS.map((c) => namedLine(row, c.label, pick))),
    ),
    ...longest.map((pick) => countedLine(Math.max(2, rows.length), pick)),
    NONE_LEFT,
  ];
  // One copy of each line, its sentences compared, not the arrays.
  return [...new Map(lines.map((line) => [JSON.stringify(line), line])).values()];
}
