// The confirm pass's rules (ADR 0024, ADR 0044): which of a round's candidates the confirm session checks, and what
// each verdict makes of a candidate before `reconcile` raises it. Recall first (exploration 04 §2.2): only a
// `blocking` finding needs the confirmer's word to stay blocking.
import {
  type CandidateFinding,
  type CandidateVerdict,
  type Finding,
  NOT_CHECKED,
  type RuledOut,
  type Severity,
} from "@lookover/contracts";
import { sameInRound } from "./identity.ts";
import { meet, type ReconcileCandidate, type ReconcileInput } from "./reconcile.ts";

/**
 * The candidates the confirm pass checks (ADR 0044): those `reconcile` would raise, that is new to the ledger
 * `prior` (the same identity rule, the same dropping of switched-off rules, each finding once),
 * and not a `consider` from round 2, which is never posted. Each is given back as the same object, in the finder's
 * order: `confirmPolicy` finds its verdict by it. An earlier finding's verdict stays with the find pass.
 */
export function toConfirm<C extends ReconcileCandidate>(
  prior: Finding[],
  candidates: C[],
  input: Pick<ReconcileInput, "round" | "rules">,
): C[] {
  const met = meet(prior, candidates, input);
  return met.candidates.filter(
    (c, i) => met.paired[i] === undefined && (input.round <= 1 || c.severity !== "consider"),
  );
}

/** One candidate the confirm pass was given, with its verdict: `review`'s confirm answer, per candidate. */
export interface Judged {
  candidate: CandidateFinding;
  verdict: CandidateVerdict;
}

/** The round's candidates after the policy: what `reconcile` takes, and what the round keeps as ruled out. */
export interface ConfirmApplied {
  candidates: ReconcileCandidate[];
  ruledOut: RuledOut[];
}

/** A `blocking` finding that isn't confirmed becomes `should_fix`, and says it was lowered. */
const lowered = (severity: Severity) => ({
  severity: severity === "blocking" ? ("should_fix" as const) : severity,
  demoted: severity === "blocking",
});

/** One judged candidate: kept with its severity and confirmation, or ruled out. */
function judge(candidate: ReconcileCandidate, verdict: CandidateVerdict): ReconcileCandidate | RuledOut {
  switch (verdict.verdict) {
    case "confirmed": {
      const { by, reason, evidence } = verdict;
      return {
        ...candidate,
        severity: verdict.severity,
        confirmation: { verdict: "confirmed", by, reason, evidence },
      };
    }
    case "unsure": {
      const { by, reason, evidence } = verdict;
      const after = lowered(verdict.severity);
      return {
        ...candidate,
        severity: after.severity,
        confirmation: { verdict: "unsure", by, reason, evidence, demoted: after.demoted },
      };
    }
    case "not_checked": {
      const after = lowered(candidate.severity);
      return {
        ...candidate,
        severity: after.severity,
        confirmation: { verdict: "not_checked", demoted: after.demoted },
      };
    }
    case "refuted": {
      const { by, reason, evidence } = verdict;
      return { candidate, by, reason, evidence };
    }
  }
}

/**
 * The confirm policy (ADR 0044) over a round's candidates, in their order, each judged by its entry in `judged`
 * (matched by the candidate object `toConfirm` gave). The confirmer's severity comes first. `confirmed`: kept, at
 * that severity. `unsure`: kept, and a `blocking` one becomes `should_fix`, marked demoted. `not_checked` (left
 * out of the answer, or the pass failed): kept at the finder's severity, a `blocking` one demoted the same way.
 * `refuted`: no finding; the round keeps it as ruled out, with who refuted it and why. A candidate the find pass
 * reported again in the round (`toConfirm` gave only its first report) takes that report's verdict; refuted, it is
 * ruled out once. A candidate with no entry otherwise wasn't given to the pass (a finding reported again, a round-2
 * `consider`): kept as found, `NOT_CHECKED`.
 */
export function confirmPolicy(candidates: ReconcileCandidate[], judged: readonly Judged[]): ConfirmApplied {
  const kept: ReconcileCandidate[] = [];
  const ruledOut: RuledOut[] = [];
  for (const candidate of candidates) {
    const own = judged.find((j) => j.candidate === candidate);
    const first = own ?? judged.find((j) => sameInRound(j.candidate, candidate));
    const after =
      first === undefined
        ? { ...candidate, confirmation: candidate.confirmation ?? NOT_CHECKED }
        : judge(candidate, first.verdict);
    if (!("candidate" in after)) kept.push(after);
    else if (own) ruledOut.push(after);
  }
  return { candidates: kept, ruledOut };
}

/**
 * The policy for a round with no confirm pass (depth Quick, ADR 0044): each candidate the pass would have checked
 * (`asked`, as `toConfirm` gave them) is `not_checked`, so a `blocking` one is demoted as any not confirmed; the
 * others are kept as found. Nothing is ruled out.
 */
export function unconfirmed(
  candidates: ReconcileCandidate[],
  asked: readonly CandidateFinding[],
): ConfirmApplied {
  const verdict: CandidateVerdict = { verdict: "not_checked" };
  return confirmPolicy(
    candidates,
    asked.map((candidate) => ({ candidate, verdict })),
  );
}
