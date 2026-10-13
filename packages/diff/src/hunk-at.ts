// The hunk a line is in, as git prints it (ADR 0044): what the confirm pass shows of each claim's code, whole or
// a window of it around the claim's lines.
import type { DiffHunk, DiffIndex, DiffLine, DiffLocation } from "@lookover/contracts";

import { fileOf } from "./place.ts";

const MARK: Record<DiffLine["kind"], string> = { context: " ", added: "+", removed: "-" };

/**
 * One side's start and count over `shown`, lines of `hunk` from `from`: the first shown line's number on that side;
 * with none, the number of the last line on that side above them (git's start for an empty side), else the hunk's.
 */
function span(hunk: DiffHunk, from: number, shown: DiffLine[], side: "oldLine" | "newLine") {
  const numbers = shown.flatMap((l) => (l[side] === null ? [] : [l[side]]));
  const [first] = numbers;
  if (first !== undefined) return `${first},${numbers.length}`;
  const above = hunk.lines.slice(0, from).flatMap((l) => (l[side] === null ? [] : [l[side]]));
  const start = side === "oldLine" ? hunk.oldStart : hunk.newStart;
  return `${above.at(-1) ?? Math.max(0, start - 1)},0`;
}

/** Lines `from` to `to` (inclusive) of `hunk`, with the header of what they show, as git prints a hunk. */
function printed(hunk: DiffHunk, from: number, to: number): string {
  const shown = hunk.lines.slice(from, to + 1);
  const header = `@@ -${span(hunk, from, shown, "oldLine")} +${span(hunk, from, shown, "newLine")} @@`;
  return [header, ...shown.map((l) => `${MARK[l.kind]}${l.text}`)].join("\n");
}

/**
 * The hunk that shows `location.line` on its side (a context line is on both), of the file found as `place` finds
 * it, printed as git prints it; null when no hunk of the diff shows that line. With `around`, only the lines from
 * `location.line` to `location.endLine` (when the hunk shows it) and `around` lines of the hunk either side, under
 * a header counting what is shown: a claim in a long hunk costs a window, not the hunk.
 */
export function hunkAt(
  index: DiffIndex,
  location: DiffLocation & { endLine?: number | null },
  around = Number.POSITIVE_INFINITY,
): string | null {
  const file = fileOf(index, location.path, location.side);
  const on = (l: DiffLine) => (location.side === "head" ? l.newLine : l.oldLine);
  const hunk = file?.hunks.find((h) => h.lines.some((l) => on(l) === location.line));
  if (!hunk) return null;
  if (around === Number.POSITIVE_INFINITY) return printed(hunk, 0, hunk.lines.length - 1);
  const first = hunk.lines.findIndex((l) => on(l) === location.line);
  const end = location.endLine ?? location.line;
  const last = Math.max(
    first,
    hunk.lines.findLastIndex((l) => on(l) === end),
  );
  return printed(hunk, Math.max(0, first - around), Math.min(hunk.lines.length - 1, last + around));
}
