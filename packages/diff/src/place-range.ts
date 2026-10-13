// A range of lines: GitHub takes `start_line`/`start_side` with `line`/`side` only on one side, inside one
// hunk (spikes/03-github step 10). Contracts' `Placement` names one line, so the range form lives here.
import type { DiffHunk, DiffIndex, DiffLocation, Placement } from "@lookover/contracts";

import { place } from "./place.ts";

type OutsideReason = Extract<Placement, { kind: "outside" }>["reason"];

/**
 * Where a range goes. `inline`: both ends as the host wants them, `start` first; when the ends are the same
 * line, the caller sends a single line. `outside`: one end's own reason, or what the range itself does
 * wrong: `range_crosses_sides` (one end on `head`, the other on `base`), `range_crosses_hunks` (the two ends
 * sit in different hunks of the file), `range_crosses_files` (the ends name two files).
 */
export type RangePlacement =
  | { kind: "inline"; start: DiffLocation; end: DiffLocation }
  | {
      kind: "outside";
      reason: OutsideReason | "range_crosses_sides" | "range_crosses_hunks" | "range_crosses_files";
    };

const holds = (hunk: DiffHunk, side: DiffLocation["side"], line: number) =>
  hunk.lines.some((l) => (side === "head" ? l.newLine : l.oldLine) === line);

/** Whether and where a range of lines can take one comment. Pure. */
export function placeRange(index: DiffIndex, start: DiffLocation, end: DiffLocation): RangePlacement {
  const first = place(index, start);
  if (first.kind === "outside") return first;
  const last = place(index, end);
  if (last.kind === "outside") return last;
  if (first.location.side !== last.location.side) return { kind: "outside", reason: "range_crosses_sides" };
  if (first.location.path !== last.location.path) return { kind: "outside", reason: "range_crosses_files" };
  const { path, side } = first.location;
  const file = index.files.find((f) => (side === "head" ? f.path : (f.oldPath ?? f.path)) === path);
  const sameHunk = file?.hunks.some(
    (h) => holds(h, side, first.location.line) && holds(h, side, last.location.line),
  );
  if (!sameHunk) return { kind: "outside", reason: "range_crosses_hunks" };
  const [from, to] = [first.location, last.location].sort((a, b) => a.line - b.line);
  return { kind: "inline", start: from ?? first.location, end: to ?? last.location };
}
