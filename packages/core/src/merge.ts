// Merging find passes (ADR 0044, I-159): a Deep round's two find passes, over one commit, become one outcome before
// the confirm pass, as if one pass had found what either found.
import type { EarlierVerdict, RoundOutcome } from "@lookover/contracts";
import { distinct } from "./identity.ts";

/**
 * Which verdict wins when the passes differ, first to last. `present`: a pass still sees the bug, so nothing closes
 * it. `gone` before `wrong`: code now gone is verified fixed whether or not its author disputed it, and the finder
 * says `wrong` only of a disputed finding (ADR 0052). `unknown` says nothing.
 */
const PRECEDENCE: Record<EarlierVerdict["verdict"], number> = { present: 0, gone: 1, wrong: 2, unknown: 3 };

/** Each earlier finding's verdict across the passes: the first in `PRECEDENCE` any pass gave; a tie, the first pass's. */
function mergeEarlier([first, ...rest]: [RoundOutcome, ...RoundOutcome[]]): EarlierVerdict[] {
  return first.earlier.map((own) =>
    rest
      .flatMap((p) => p.earlier.filter((v) => v.id === own.id))
      .reduce((best, v) => (PRECEDENCE[v.verdict] < PRECEDENCE[best.verdict] ? v : best), own),
  );
}

const joined = (texts: (string | null)[]): string =>
  texts.filter((t): t is string => t !== null && t.trim() !== "").join("\n\n");

/**
 * The passes as one outcome, the first pass's commit and engine (the finder's): each bug once, as the first pass
 * that found it reported it (`distinct`, the in-round rule, so a bug two passes named differently is one and two
 * bugs of one kind on two lines stay two); each earlier finding asked about by the first pass, present when any
 * pass says so, else gone when one does, else wrong, else unknown; each pass's sessions kept apart, in pass order (ADR
 * 0055); the notes, the problems and,
 * when nobody found anything, why, joined in pass order. Every pass asks about the same earlier findings.
 */
export function mergeFinds(passes: [RoundOutcome, ...RoundOutcome[]]): RoundOutcome {
  const [first] = passes;
  const candidates = distinct(passes.flatMap((p) => p.candidates));
  const emptyReason = joined(passes.map((p) => p.emptyReason));
  return {
    sha: first.sha,
    engine: first.engine,
    notes: joined(passes.map((p) => p.notes)),
    candidates,
    earlier: mergeEarlier(passes),
    emptyReason: candidates.length > 0 || emptyReason === "" ? null : emptyReason,
    problems: passes.flatMap((p) => p.problems),
    sessions: passes.flatMap((p) => p.sessions),
  };
}
