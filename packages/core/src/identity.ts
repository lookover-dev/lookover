// A finding's identity (ADR 0032, ADR 0044, #63): when two findings are the same, and how one round's candidates
// meet each other and the ledger.
import { type CandidateFinding, type Finding, fingerprintWord } from "@lookover/contracts";

/** What identity reads: both fingerprints, and whether the finding came with its line's text. */
export type Identity = Pick<Finding, "fingerprints" | "lineText">;

const located = (a: Identity, b: Identity) => a.lineText !== null && b.lineText !== null;

/**
 * Two findings are the same (ADR 0044): the meanings match and the locations match, or either has no line text
 * (the meaning alone); and, whatever the kind key, the same category on the same line. `review`'s location
 * fingerprint hashes the category (normalised as the meaning's), the path, the side and the line's text, so with
 * both texts the rule comes to the locations matching; without, the location hashes a line number, which says
 * nothing across pushes, and the meaning decides. Lines holding the same text (`}`, `return null;`) share a
 * location: `distinct` and `pairUp` keep them apart by their line numbers.
 */
export function sameFinding(a: Identity, b: Identity): boolean {
  return located(a, b)
    ? a.fingerprints.location === b.fingerprints.location
    : a.fingerprints.meaning === b.fingerprints.meaning;
}

/**
 * One round's candidates, each finding once, as first reported: a later one the same as an earlier one is
 * dropped. One commit's line numbers compare, so two lines holding the same text are two places.
 */
export function distinct<C extends CandidateFinding>(candidates: C[]): C[] {
  return candidates.filter((c, i) => candidates.findIndex((other) => sameInRound(other, c)) === i);
}

/** The same category on the same line of one commit: the same path, side and line number. */
const sameCategoryAndLine = (a: CandidateFinding, b: CandidateFinding) =>
  a.location.path === b.location.path &&
  a.location.side === b.location.side &&
  a.location.line === b.location.line &&
  fingerprintWord(a.category) === fingerprintWord(b.category);

/**
 * Two of one round's candidates are one finding: with both texts, the same and on the same line number; with
 * either text missing, the same meaning, or the same category on the same line whatever kind key each gave (ADR
 * 0044: a Deep round's two passes naming one bug two ways, one of them without the line's text).
 */
export function sameInRound(a: CandidateFinding, b: CandidateFinding): boolean {
  if (located(a, b)) return sameFinding(a, b) && a.location.line === b.location.line;
  return sameFinding(a, b) || sameCategoryAndLine(a, b);
}

/**
 * Which ledger finding each candidate is, if any: one to one, so a candidate is at most one finding and a finding
 * is reported by at most one candidate. Among the same findings, the nearest stored line pairs first (then the
 * ledger's order, then the round's): when two lines hold the same text, each keeps its own finding. The answer
 * is, per candidate, the index of its finding in `ledger`, or undefined for a new one.
 */
export function pairUp(ledger: Finding[], candidates: CandidateFinding[]): (number | undefined)[] {
  const pairs: { f: number; c: number; distance: number }[] = [];
  ledger.forEach((finding, f) => {
    candidates.forEach((candidate, c) => {
      if (sameFinding(finding, candidate))
        pairs.push({ f, c, distance: Math.abs(finding.line - candidate.location.line) });
    });
  });
  pairs.sort((a, b) => a.distance - b.distance || a.f - b.f || a.c - b.c);
  const found: (number | undefined)[] = candidates.map(() => undefined);
  const taken = new Set<number>();
  for (const { f, c } of pairs) {
    if (taken.has(f) || found[c] !== undefined) continue;
    taken.add(f);
    found[c] = f;
  }
  return found;
}
