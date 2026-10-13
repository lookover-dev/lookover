// The round a finished run makes (ADR 0029, ADR 0039): the run's facts, and what `reconcile` decided the round
// raised, verified fixed and left open. One builder, so no two places count a round apart.
import type { Reconciled, Round } from "@lookover/contracts";

/**
 * The round `run` makes (everything but the counts), counted from `reconciled`: only posted findings are open
 * on the pull request (I-152).
 */
export function roundOf(
  run: Omit<Round, "raised" | "verifiedFixed" | "open">,
  reconciled: Pick<Reconciled, "raised" | "verifiedFixed" | "open">,
): Round {
  return {
    ...run,
    raised: reconciled.raised.length,
    verifiedFixed: reconciled.verifiedFixed,
    open: reconciled.open,
  };
}
