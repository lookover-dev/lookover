// The rule that picks the default depth (ADR 0050, "The rule that picks the default, written before the numbers"):
// a pure function of the scores, applied in the record's order. Standard one engine decides nothing here.
import type { Scores } from "./score.ts";

/** Fewer complete cases than this and the rule gives no verdict: the missing sessions run again first. */
export const MIN_COMPARED_CASES = 13;

/** How far Deep's F0.5 must beat Standard cross-model's, strictly, for Deep to become the default. */
export const DEEP_MARGIN = 0.05;

/** Deep must find at least this many more planted bugs than Standard cross-model. */
const DEEP_MORE_BUGS = 2;

/** F0.5 is a float: two equal ratios computed apart may differ in their last bit, never by this much. */
const FLOAT_NOISE = 1e-9;

/**
 * What the rule says, over `compared` complete cases. `no_verdict`: under `MIN_COMPARED_CASES`. `ask_owner`: Quick
 * scored at least Standard cross-model's F0.5, so the default stays Standard and the owner is asked (dropping the
 * second look changes what Lookover is, ADR 0042). `deep`: Deep becomes the default. `standard`: Standard stays.
 */
export interface Decision {
  verdict: "no_verdict" | "ask_owner" | "deep" | "standard";
  compared: number;
}

/** ADR 0050's rule, in its order, on the kept findings' counts over the cases where every setup is complete. */
export function decide(scores: Scores): Decision {
  const compared = scores.compared.length;
  if (compared < MIN_COMPARED_CASES) return { verdict: "no_verdict", compared };
  const quick = scores.setups.quick.kept;
  const cross = scores.setups["standard-cross"].kept;
  const deep = scores.setups.deep.kept;
  if (quick.f05 >= cross.f05 - FLOAT_NOISE) return { verdict: "ask_owner", compared };
  const deepWins =
    deep.f05 - cross.f05 > DEEP_MARGIN + FLOAT_NOISE &&
    deep.found >= cross.found + DEEP_MORE_BUGS &&
    deep.noise <= cross.noise;
  return { verdict: deepWins ? "deep" : "standard", compared };
}
