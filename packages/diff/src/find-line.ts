// Finding a line by its text (ADR 0044, I-158): where a line a finding quotes really is in the diff.
import type { DiffIndex, DiffLocation } from "@lookover/contracts";

import { fileOf, linesOn } from "./place.ts";

/**
 * Where a line's text is. `found`: on that line. `none`: on no line of the diff (`not_in_diff`), or not in what
 * was read of a diff cut short, where it may well lie past the cut (`diff_truncated`: its file is the one the cut
 * fell in, or wasn't read at all; the files before it are complete).
 */
export type LineFound =
  | { kind: "found"; line: number }
  | { kind: "none"; reason: "not_in_diff" | "diff_truncated" };

/**
 * A line's text as it is compared: leading and trailing whitespace dropped, every run of whitespace inside one
 * space. Re-indented code is the same line; anything else that differs is not.
 */
export function normalizeLineText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * The line nearest `near.line` that takes a comment on `near.side` of `near.path`'s file (a line a hunk shows on
 * that side, as `place` accepts it) and whose text matches `text`, whitespace aside; the one above on a tie.
 * The file is found the way `place` finds it.
 */
export function findLine(index: DiffIndex, near: DiffLocation, text: string): LineFound {
  const file = fileOf(index, near.path, near.side);
  const none = (cut: boolean): LineFound => ({
    kind: "none",
    reason: index.truncated && cut ? "diff_truncated" : "not_in_diff",
  });
  if (!file) return none(true);
  const wanted = normalizeLineText(text);
  const distance = (n: number) => Math.abs(n - near.line);
  let best: number | null = null;
  for (const line of linesOn(file, near.side)) {
    if (normalizeLineText(line.text) !== wanted) continue;
    const closer = best === null || distance(line.number) < distance(best);
    const tieAbove = best !== null && distance(line.number) === distance(best) && line.number < best;
    if (closer || tieAbove) best = line.number;
  }
  return best === null ? none(file === index.files.at(-1)) : { kind: "found", line: best };
}

/** Where a range is: its first line found by its text, its end moved as far; or why it is on no line. */
export type RangeFound =
  | { kind: "found"; line: number; endLine: number | null }
  | Extract<LineFound, { kind: "none" }>;

/**
 * A range found by its first line's text (`findLine`), its end line (null for one line) shifted as far as its first
 * line moved: how a finding is anchored again by the line it quotes.
 */
export function findRange(
  index: DiffIndex,
  at: DiffLocation & { endLine: number | null },
  text: string,
): RangeFound {
  const hit = findLine(index, at, text);
  if (hit.kind === "none") return hit;
  const shift = hit.line - at.line;
  return { kind: "found", line: hit.line, endLine: at.endLine === null ? null : at.endLine + shift };
}
