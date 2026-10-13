// The loop (ADR 0029): one change's back-and-forth across rounds. Where it stands, and what the owner's
// dismissal does to its findings; what a round does is `reconcile`. There is no round cap: the author stops by
// not asking. Only posted findings count (ADR 0039, I-152): a finding kept off the pull request never holds
// the loop open.
import {
  type ActionBy,
  type Finding,
  type FindingCounts,
  type FindingId,
  isCounted,
  isUnsettled,
  type LoopState,
  type NextAction,
  type Reconciled,
} from "@lookover/contracts";

/**
 * Escalated wins: only the owner can settle it. Then any finding that counts on the pull request: the author
 * has work. One kept off the pull request never keeps the loop open.
 */
export function loopState(findings: Finding[]): LoopState {
  const counted = findings.filter(isCounted);
  if (counted.some((f) => f.status === "escalated")) return "needs_owner";
  return counted.length > 0 ? "open" : "settled";
}

/**
 * The owner settles unsettled findings by dismissing them (ADR 0052), after round `round`. The owner gives no
 * reason: what it means is said by the app and on GitHub, never kept in the ledger.
 */
export function findingsAfterDismissal(findings: Finding[], ids: FindingId[], round: number): Finding[] {
  return findings.map((f) =>
    ids.includes(f.id) && isUnsettled(f)
      ? { ...f, status: "dismissed", closedIn: round, closedWhy: null }
      : f,
  );
}

/** What the coding agent does next, by where the loop stands (ADR 0029, ADR 0039). */
const NEXT_ACTION: Record<LoopState, NextAction> = {
  open: "fix",
  needs_owner: "ask_human",
  settled: "stop",
};

/** Only the owner settles an escalation; the agent fixes what is open on the pull request; nobody acts on the rest. */
function actionBy(finding: Finding): ActionBy {
  if (finding.status === "escalated") return "human";
  return finding.status === "open" && finding.posted ? "agent" : "none";
}

/** The posted findings by status, the open ones by severity too (ADR 0039): what is kept off counts nowhere. */
function counts(findings: Finding[]): FindingCounts {
  const counted: FindingCounts = {
    open: { blocking: 0, should_fix: 0, consider: 0 },
    escalated: 0,
    verified_fixed: 0,
    acknowledged: 0,
    withdrawn: 0,
    dismissed: 0,
    obsolete: 0,
  };
  for (const f of findings.filter((finding) => finding.posted)) {
    if (f.status === "open") counted.open[f.severity] += 1;
    else counted[f.status] += 1;
  }
  return counted;
}

/** What `Reconciled` says of where a change stands, read from its findings alone. */
export type Standing = Pick<
  Reconciled,
  "findings" | "loop" | "verdict" | "nextAction" | "actionBy" | "conclusion" | "open" | "keptInApp" | "counts"
>;

/**
 * Where a change stands over `findings`: the loop, the verdict, the agent's next action, who acts on each finding,
 * the check's conclusion and its count, the findings kept in the app and the counts, over posted findings only.
 */
export function standingOf(findings: Finding[]): Standing {
  const counted = findings.filter(isCounted);
  const blocking = counted.some((f) => f.severity === "blocking");
  const loop = loopState(findings);
  return {
    findings,
    loop,
    verdict: counted.length === 0 ? "clean" : blocking ? "blocking" : "pass",
    nextAction: NEXT_ACTION[loop],
    actionBy: findings.map((f) => ({ id: f.id, by: actionBy(f) })),
    conclusion: blocking ? "neutral" : "success",
    open: counted.length,
    keptInApp: findings.filter((f) => isUnsettled(f) && !f.posted).length,
    counts: counts(findings),
  };
}

/**
 * A round restated over the change's ledger as it is now (ADR 0052): after the owner dismissed findings, the round's
 * summary and check say where the change stands, while what the round raised, posted, verified and answered stays
 * the round's.
 */
export function standing(round: Reconciled, findings: Finding[]): Reconciled {
  return { ...round, ...standingOf(findings) };
}
