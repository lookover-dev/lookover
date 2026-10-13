// Fingerprints (ADR 0032, ADR 0044, exploration 04 §5): two per finding. `location` is where it is: category,
// path, side and the anchored line's text, whitespace aside, so lines added above it change nothing and two
// lines holding the same kind of defect stay apart. `meaning` is what it says: category, path and the defect
// key. Both hash normalised text, so a rephrased title or body changes neither. `core` says "the same finding"
// from both (ADR 0044's rule).
// A finding without its line's text (an answer that didn't copy it) hashes the line number instead: `core` reads
// the location only when both findings have their text, so that hash only tells two lines of one round apart.
import { type DiffLocation, type Fingerprints, fingerprintWord } from "@lookover/contracts";
import { normalizeLineText } from "@lookover/diff";

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

/** FNV-1a over the UTF-8 bytes, 64 bits as 16 hex digits. Pure and stable: no `node:crypto`. */
function fnv1a64(text: string): string {
  let hash = OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

const path = (text: string) => text.trim().replaceAll("\\", "/");

export function fingerprints(
  category: string,
  location: DiffLocation,
  defectKey: string,
  lineText: string | null,
): Fingerprints {
  const line = lineText === null ? String(location.line) : normalizeLineText(lineText);
  const where = [fingerprintWord(category), path(location.path), location.side, line];
  const what = [fingerprintWord(category), path(location.path), fingerprintWord(defectKey)];
  return { location: fnv1a64(where.join("|")), meaning: fnv1a64(what.join("|")) };
}
