// The confirm pass in words (ADR 0044): what a finding card's "Checked by" says, a severity lowered for want of a
// confirmation, and who found and who double-checked a round, with what was ruled out, for the review's details.
import {
  type ConfirmFallback,
  confirmFailureText,
  deferralText,
  type Engine,
  type EngineId,
  engineDeferral,
  engineName,
  type Finding,
  findersText,
  NOT_DOUBLE_CHECKED,
  NOTHING_NEW_TO_CHECK,
  type Review,
  type Round,
  severityText,
} from "@lookover/contracts";
import { SEVERITY_LABEL } from "./findings.ts";
import { roundFinders } from "./rounds.ts";

/** A finding's severity as the app says it: a `blocking` one lowered because it wasn't confirmed says so. */
export function severityLabel(finding: Finding): string {
  const c = finding.confirmation;
  const demoted = c.verdict !== "confirmed" && c.demoted;
  return severityText(SEVERITY_LABEL[finding.severity], demoted);
}

/** The card's line on how a finding was checked: `head` in bold, then `text`, then the lines it cites. */
export interface CheckedBy {
  head: string;
  text: string;
  evidence: string[];
}

/**
 * How a finding was checked: the confirmer, its verdict and its reason, with the lines it cites; or that nobody
 * double-checked it, and why when its round's confirm session gave no answer.
 */
export function checkedBy(review: Review, finding: Finding): CheckedBy {
  const c = finding.confirmation;
  switch (c.verdict) {
    case "confirmed":
    case "unsure": {
      const said = c.verdict === "confirmed" ? "confirmed" : "unconfirmed";
      return { head: "Checked by:", text: `${engineName(c.by)}, ${said}. ${c.reason}`, evidence: c.evidence };
    }
    case "not_checked": {
      const raisedIn = review.rounds.find((r) => r.n === finding.raisedIn);
      const why =
        raisedIn?.confirmer && raisedIn.confirmFailure
          ? confirmFailureText(raisedIn.confirmFailure, raisedIn.confirmer)
          : null;
      return { head: "Not double-checked.", text: why ? `${why}, so it shows as found.` : "", evidence: [] };
    }
  }
}

/** The details' labels for who found the last round, who double-checked it, and what was ruled out. */
export const CONFIRM_LABELS = {
  found: "Found by",
  checked: "Double-checked by",
  ruledOut: "Ruled out",
} as const satisfies Record<"found" | "checked" | "ruledOut", string>;

/** Who found and who double-checked the last round, and the candidates its confirmer ruled out. */
export interface ConfirmDetails {
  found: string;
  checked: string;
  ruledOut: { title: string; reason: string }[];
  /** "2 ruled out"; null when none was, or no confirm answered. */
  count: string | null;
}

/**
 * Why the finder double-checked instead of the other engine (ADR 0044): "Codex is signed out", "only Claude may
 * review this change" (Codex on another author's change or a fork's), "only Claude reviews this repository".
 */
function fallbackText(fallback: ConfirmFallback, finder: EngineId): string {
  switch (fallback.reason) {
    case "not-ready":
      return deferralText(engineDeferral(fallback.engine, fallback.state));
    case "not-own":
      return `only ${engineName(finder)} may review this change`;
    case "settings":
      return `only ${engineName(finder)} reviews this repository`;
  }
}

/**
 * Who found a round: its finder, and with Deep's second find pass (ADR 0044) the other engine or a second session;
 * when that pass gave no answer, the finder alone, and why.
 */
function foundBy(round: Round): string {
  const finder = engineName(round.reviewer);
  const second = round.secondFind;
  if (second === null) return finder;
  const same = second.engine === round.reviewer;
  if (second.failure !== null) {
    const why = confirmFailureText(second.failure, second.engine);
    return same ? `${finder}, in one session: ${why}` : `${finder} alone: ${why}`;
  }
  return roundFinders(round);
}

/**
 * The details' "Found by": the finder of the round running, else of the last round, with its CLI and version; a
 * Deep round, running or done, names both finders as `confirmDetails` words them (ADR 0055). Empty before any round.
 */
export function foundByLine(review: Review, engines: Record<EngineId, Engine>): string {
  const last = review.rounds.at(-1);
  const { run } = review;
  if (run?.secondFinder) return findersText(run.reviewer, run.secondFinder);
  if (run === null && last?.secondFind) return foundBy(last);
  const id = run?.reviewer ?? last?.reviewer;
  if (id === undefined) return "";
  const { name, cli, version } = engines[id];
  return version === null ? `${name}, ${cli}` : `${name}, ${cli} ${version}`;
}

/**
 * The finders of the round running, else of the last round, as "Found by" words them but without CLI or version:
 * the summary of "How this review ran". Null before any round.
 */
export function findersOf(review: Review): string | null {
  const { run } = review;
  if (run) return findersText(run.reviewer, run.secondFinder);
  const last = review.rounds.at(-1);
  return last ? roundFinders(last) : null;
}

/**
 * The review's last round, as the details say who found and who double-checked it, and why the finder did when
 * the other engine didn't; null before any round.
 */
export function confirmDetails(review: Review): ConfirmDetails | null {
  const last = review.rounds.at(-1);
  if (!last) return null;
  const found = foundBy(last);
  const ruledOut = last.ruledOut.map((r) => ({ title: r.candidate.title, reason: r.reason }));
  if (last.confirmer === null) {
    // As the pull request says it (`foundAndCheckedText`): new findings unchecked, or none to check.
    const why = last.raised > 0 ? `its new findings are ${NOT_DOUBLE_CHECKED}` : NOTHING_NEW_TO_CHECK;
    return { found, checked: `Nobody: ${why}`, ruledOut, count: null };
  }
  if (last.confirmFailure !== null) {
    return { found, checked: confirmFailureText(last.confirmFailure, last.confirmer), ruledOut, count: null };
  }
  const fallback =
    last.confirmFallback === null ? "" : `: ${fallbackText(last.confirmFallback, last.reviewer)}`;
  const who =
    last.confirmer === last.reviewer
      ? `${engineName(last.confirmer)}, in a new session${fallback}`
      : engineName(last.confirmer);
  const count = ruledOut.length === 0 ? null : `${ruledOut.length} ruled out`;
  return { found, checked: who, ruledOut, count };
}
