// Anchoring by the line's text (ADR 0044, I-158): the engine copies the line it anchors to, and its line number
// is checked against the diff. Engines count lines off by one now and then; the text they copy they get right.
import type { Anchoring, CandidateFinding, DiffIndex } from "@lookover/contracts";
import { findRange } from "@lookover/diff";

type Located = Pick<CandidateFinding, "location" | "lineText" | "anchoring">;

/**
 * Where a finding sits once its text is checked. No text (or a blank one): as reported. The reported line's
 * text matches: as reported. Another line on the same side of the same file matches: the nearest, the end line
 * shifted as much (`moved`). None does: `unmatched`, at the reported line, which `publish` puts in the summary;
 * unless the diff was cut in that file or before it, where the line may lie past the cut, and the reported line
 * stands (a file read whole before the cut is complete: there, `unmatched`). The text kept is the engine's copy,
 * which matches the diff's whitespace aside.
 */
export function anchor(
  index: DiffIndex,
  location: CandidateFinding["location"],
  text: string | null,
): Located {
  const lineText = text === null || text.trim() === "" ? null : text;
  const as = (anchoring: Anchoring, at = location) => ({ location: at, lineText, anchoring });
  if (lineText === null) return as("reported");
  const hit = findRange(index, location, lineText);
  if (hit.kind === "none") return as(hit.reason === "diff_truncated" ? "reported" : "unmatched");
  if (hit.line === location.line) return as("reported");
  return as("moved", { ...location, line: hit.line, endLine: hit.endLine });
}
