// Which (side, line) pairs a host takes an inline comment on, as the GitHub spike saw it (spikes/03-github).
import type { DiffFile, DiffIndex, DiffLocation, DiffSide, Place, Placement } from "@lookover/contracts";

import { normalizePath } from "./paths.ts";

/** The path a file has on a side: the new one on `head`, the old one on `base`. */
const pathOn = (file: DiffFile, side: DiffSide) =>
  side === "head" ? file.path : (file.oldPath ?? file.path);

/**
 * The file a location names. Its path on that side first; failing that, a renamed file's path on the other
 * side, since a finding may name the file as it was.
 */
export function fileOf(index: DiffIndex, path: string, side: DiffSide): DiffFile | undefined {
  const wanted = normalizePath(path);
  const other: DiffSide = side === "head" ? "base" : "head";
  return (
    index.files.find((file) => pathOn(file, side) === wanted) ??
    index.files.find((file) => file.oldPath !== null && pathOn(file, other) === wanted)
  );
}

/**
 * GitHub takes a comment on `head` (RIGHT) for an added or context line, and on `base` (LEFT) for a removed
 * line. A context line on `base` is not known to be accepted, so it is not offered.
 */
function inHunk(file: DiffFile, side: DiffSide, line: number): boolean {
  return linesOn(file, side).some((l) => l.number === line);
}

/** The lines of a file's hunks that take a comment on `side`, with their number on that side. */
export function linesOn(file: DiffFile, side: DiffSide): { number: number; text: string }[] {
  return file.hunks.flatMap((hunk) =>
    hunk.lines.flatMap((l) => {
      const number = side === "head" ? l.newLine : l.oldLine;
      const takes = side === "head" ? l.kind !== "removed" : l.kind === "removed";
      return takes && number !== null ? [{ number, text: l.text }] : [];
    }),
  );
}

export const place: Place = (index, location): Placement => {
  // In a cut index, a missing file may lie past the cut; a missing line may too, but only in the last file
  // read, the one the cut fell in: the files before it are complete.
  const outside = (reason: "file_not_in_diff" | "line_not_in_diff", cut: boolean): Placement => ({
    kind: "outside",
    reason: cut ? "diff_truncated" : reason,
  });
  const file = fileOf(index, location.path, location.side);
  if (!file) return outside("file_not_in_diff", index.truncated);
  if (file.binary) return { kind: "outside", reason: "binary_file" };
  if (!inHunk(file, location.side, location.line))
    return outside("line_not_in_diff", index.truncated && file === index.files.at(-1));
  const path = pathOn(file, location.side);
  const placed: DiffLocation = { path, side: location.side, line: location.line };
  return { kind: "inline", location: placed };
};
