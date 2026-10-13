// Where each finding goes on the pull request: inline when `diff` places it, in the summary otherwise (ADR
// 0022: one comment outside the diff would fail the whole review), and in the check only when it is kept off
// the pull request (ADR 0025, ADR 0039). `review` anchored each finding (its side, its line and its range's
// end, as reported); here it is placed: whether a comment can go there on the host now. A range goes as a
// range when the host takes it (one side, one hunk); when it doesn't, the comment goes on the range's first
// line, else on its last, so it still lands where it can; only when no line of those takes one does the
// finding go into the summary, with the first line's reason. A finding `review` could not anchor by its line's
// text (`unmatched`, ADR 0044) goes into the summary without asking: its line number is a guess.
// Placement is against this round's diff: an earlier round's finding is placed again each round, with its
// side and range, and one whose lines have left the diff reads `summary`, even if its comment landed inline
// back then. One whose review held no comment on it (`commented` false: it went into the summary) stays there
// (`no_comment`, #67): no comment of it exists to point to.
// When the host refuses a comment all the same (GitHub's diff is not git's, and its 422 never says which comment),
// `degrade` moves every finding the round posts inline into the summary (`host_refused`, ADR 0044).
// A finding the round posts whose lines are of another commit (`moved`: withheld by a round whose review never
// landed, and a push since) is found again by its line's text first (`findRange`), its range shifted as much; with
// no text, or a text no line of the diff holds, it goes into the summary, never on its old line number.
// One review holds `REVIEW_MAX_COMMENTS` comments at most (#67): `cap` keeps the round's most urgent findings inline,
// and moves the rest into the summary (`review_full`).
import type { DiffIndex, Finding, FindingId, InlineComment, Placement } from "@lookover/contracts";
import { bySeverity } from "@lookover/contracts";
import { findRange, place, placeRange } from "@lookover/diff";

/**
 * Why no comment goes on a finding's lines: the diff's reason, the host refused one of the round's comments, the
 * review had its most comments already, an earlier round posted it with none, or its lines are of an earlier
 * commit and nothing says where they are now.
 */
type Outside =
  | Extract<Placement, { kind: "outside" }>["reason"]
  | "host_refused"
  | "review_full"
  | "no_comment"
  | "line_moved";

/** Where a comment goes, as the host wants it (a renamed file's path on that side), without its words. */
type CommentPlace = Omit<InlineComment, "body">;

export type PlacedFinding =
  /** On the pull request, as a comment `at` that place. */
  | { finding: Finding; placement: "inline"; at: CommentPlace }
  /** On the pull request, in the summary: no comment can go on its lines, and why. */
  | { finding: Finding; placement: "summary"; outside: Outside }
  /** Kept off the pull request (strictness, the later-round rule): in the check's result only. */
  | { finding: Finding; placement: "check_only" };

const oneLine = (index: DiffIndex, first: Omit<CommentPlace, "endLine">): CommentPlace | Outside => {
  const line = place(index, first);
  return line.kind === "inline" ? { ...line.location, endLine: null } : line.reason;
};

/** Where a finding's comment can go: its range, else its first line, else its last, else why none can. */
function where(index: DiffIndex, finding: Finding): CommentPlace | Outside {
  const first = { path: finding.file, side: finding.side, line: finding.line };
  if (finding.endLine === null || finding.endLine === first.line) return oneLine(index, first);
  const last = { ...first, line: finding.endLine };
  const range = placeRange(index, first, last);
  if (range.kind === "inline") return { ...range.start, endLine: range.end.line };
  const start = oneLine(index, first);
  if (typeof start !== "string") return start;
  const end = oneLine(index, last);
  return typeof end === "string" ? start : end;
}

/** Where a finding found on another commit is on this diff: its line found by its text, or why it can't be. */
function found(index: DiffIndex, finding: Finding): Finding | Outside {
  if (finding.lineText === null) return "line_moved";
  const at = { path: finding.file, side: finding.side, line: finding.line, endLine: finding.endLine };
  const hit = findRange(index, at, finding.lineText);
  if (hit.kind === "none") return "text_not_in_diff";
  return { ...finding, line: hit.line, endLine: hit.endLine };
}

/**
 * Places `findings`; `posting`: the ones this round posts, whose comments are not written yet; `moved`: those of
 * them whose lines are of another commit, found again by their text first.
 */
export function placeFindings(
  index: DiffIndex,
  findings: Finding[],
  posting: ReadonlySet<FindingId>,
  moved: ReadonlySet<FindingId> = new Set(),
): PlacedFinding[] {
  return findings.map((finding): PlacedFinding => {
    if (!finding.posted) return { finding, placement: "check_only" };
    const now = moved.has(finding.id) ? found(index, finding) : finding;
    const at =
      typeof now === "string"
        ? now
        : finding.anchoring === "unmatched"
          ? "text_not_in_diff"
          : where(index, now);
    if (typeof at === "string") return { finding, placement: "summary", outside: at };
    if (!posting.has(finding.id) && !finding.commented)
      return { finding, placement: "summary", outside: "no_comment" };
    return { finding, placement: "inline", at };
  });
}

/** The round's findings to post (`posting`) placed inline go into the summary: the host refused a comment of theirs. */
export function degrade(placed: PlacedFinding[], posting: ReadonlySet<FindingId>): PlacedFinding[] {
  return placed.map((p) =>
    p.placement === "inline" && posting.has(p.finding.id)
      ? { finding: p.finding, placement: "summary", outside: "host_refused" }
      : p,
  );
}

/**
 * The round's findings to post (`posting`) placed inline past the first `max`, most urgent first (`bySeverity`), go
 * into the summary: one review holds `max` comments at most.
 */
export function cap(placed: PlacedFinding[], posting: ReadonlySet<FindingId>, max: number): PlacedFinding[] {
  const inline = placed.filter((p) => p.placement === "inline" && posting.has(p.finding.id));
  const kept = new Set(bySeverity(inline, (p) => p.finding.severity).slice(0, max));
  return placed.map((p) =>
    p.placement === "inline" && posting.has(p.finding.id) && !kept.has(p)
      ? { finding: p.finding, placement: "summary", outside: "review_full" }
      : p,
  );
}
