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
import { duration, metaLine, punctuationNext } from "./format.ts";
import { roundFinders } from "./rounds.ts";
import { codePlace } from "./said.ts";

/** A finding's severity as the app says it: a `blocking` one lowered because it wasn't confirmed says so. */
export function severityLabel(finding: Finding): string {
  const c = finding.confirmation;
  const demoted = c.verdict !== "confirmed" && c.demoted;
  return severityText(SEVERITY_LABEL[finding.severity], demoted);
}

/**
 * A run of Checked by's sentence: words, or a line it cites, drawn as inline code in the sentence, `tight` when the
 * words after it start with punctuation (`punctuationNext`), as a commit's chip is.
 */
type CheckedPart = string | { cite: string; tight: boolean };

/**
 * The card's line on how a finding was checked: `head` in bold, then `said`, the sentence with the lines it cites in
 * it, then `under`, each citation too long to sit in a sentence (`codePlace`), on its own line under it.
 */
export interface CheckedBy {
  head: string;
  said: CheckedPart[];
  under: string[];
}

/** Citations said as a list in a sentence, `end` after them: "a", "a and b", "a, b and c". */
function cited(lines: string[], end: string): CheckedPart[] {
  const after = (i: number) => (i === lines.length - 1 ? end : i === lines.length - 2 ? " and " : ", ");
  return lines.flatMap((cite, i): CheckedPart[] => [{ cite, tight: punctuationNext(after(i)) }, after(i)]);
}

/**
 * How a finding was checked: the confirmer and its verdict, at the lines it cites, then its reason; or that nobody
 * double-checked it, and why when its round's confirm session gave no answer. The citations come before the reason,
 * so a short one sits early in its line, never pushed alone onto a line of its own by a long reason (round 3,
 * 2026-11-08); one too long for a sentence goes under it.
 */
export function checkedBy(review: Review, finding: Finding): CheckedBy {
  const c = finding.confirmation;
  switch (c.verdict) {
    case "confirmed":
    case "unsure": {
      const verdict = c.verdict === "confirmed" ? "confirmed" : "unconfirmed";
      const inline = c.evidence.filter((line) => codePlace(line) === "inline");
      const reason = c.reason === "" ? "." : `. ${c.reason}`;
      const said: CheckedPart[] =
        inline.length === 0
          ? [`${engineName(c.by)}, ${verdict}${reason}`]
          : [`${engineName(c.by)}, ${verdict} at `, ...cited(inline, reason)];
      return { head: "Checked by:", said, under: c.evidence.filter((line) => codePlace(line) === "line") };
    }
    case "not_checked": {
      const raisedIn = review.rounds.find((r) => r.n === finding.raisedIn);
      const why =
        raisedIn?.confirmer && raisedIn.confirmFailure
          ? confirmFailureText(raisedIn.confirmFailure, raisedIn.confirmer)
          : null;
      return { head: "Not double-checked.", said: why ? [`${why}, so it shows as found.`] : [], under: [] };
    }
  }
}

/**
 * The details' labels: who found the round running or the last one, who double-checked every round, and what the
 * last one ruled out. Found by and Ruled out name their round once rounds came before it, as Double-checked by
 * speaks of them all (#644).
 */
export function confirmLabels(review: Review): Record<"found" | "checked" | "ruledOut", string> {
  const last = review.rounds.at(-1)?.n ?? 0;
  const found = review.run ? last + 1 : last;
  return {
    found: found > 1 ? `Found in round ${found} by` : "Found by",
    checked: "Double-checked by",
    ruledOut: last > 1 ? `Ruled out in round ${last}` : "Ruled out",
  };
}

/** Who found and who double-checked the last round, and the candidates its confirmer ruled out. */
export interface ConfirmDetails {
  found: string;
  /** One line per way the rounds were double-checked, each naming its rounds when they differ. */
  checked: string[];
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
 * "How this review ran"'s line (`metaLine`): the finders, how many candidates were ruled out, then the listed rounds'
 * time, every one of them ended ("0 s" included, a frozen clock's), or "running" before the first ends.
 */
export function howItRan(review: Review): string {
  const checks = confirmDetails(review);
  const total = review.rounds.reduce((ms, r) => ms + (r.endedAt - r.startedAt), 0);
  const said = [findersOf(review), checks?.count ?? null].filter((part): part is string => Boolean(part));
  return metaLine([...said, review.rounds.length > 0 ? duration(total) : "running"]);
}

/**
 * Who double-checked one round: its confirmer, why the finder did when the other engine didn't, or why nobody did;
 * `led`, after its rounds and a colon ("Round 2: nobody, nothing new to double-check").
 */
function checkedIn(round: Round, led = false): string {
  if (round.confirmer === null) {
    // As the pull request says it (`foundAndCheckedText`): new findings unchecked, or none to check.
    const why = round.raised > 0 ? `its new findings are ${NOT_DOUBLE_CHECKED}` : NOTHING_NEW_TO_CHECK;
    return led ? `nobody, ${why}` : `Nobody: ${why}`;
  }
  if (round.confirmFailure !== null) return confirmFailureText(round.confirmFailure, round.confirmer);
  const fallback =
    round.confirmFallback === null ? "" : `: ${fallbackText(round.confirmFallback, round.reviewer)}`;
  return round.confirmer === round.reviewer
    ? `${engineName(round.confirmer)}, in a new session${fallback}`
    : engineName(round.confirmer);
}

/** "Round 2", "Rounds 2 and 3", "Rounds 1, 2 and 4". */
function roundsText(ns: number[]): string {
  if (ns.length === 1) return `Round ${ns[0]}`;
  return `Rounds ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`;
}

/**
 * "Double-checked by" over every round, so it agrees with the finding cards and the Rounds table (round 4,
 * 2026-11-08: from the last round alone it said "Nobody" while round 1's checker had confirmed the finding shown):
 * one line per way the rounds were checked, in the order first met, each led by its rounds ("Round 1: Claude", #644:
 * a round tacked on after the reason read as part of it); every round alike, one line naming none.
 */
function checkedLines(rounds: readonly Round[]): string[] {
  const groups = new Map<string, { led: string; ns: number[] }>();
  for (const r of rounds) {
    const key = checkedIn(r);
    const group = groups.get(key) ?? { led: checkedIn(r, true), ns: [] };
    groups.set(key, { ...group, ns: [...group.ns, r.n] });
  }
  if (groups.size === 1) return [...groups.keys()];
  return [...groups.values()].map(({ led, ns }) => `${roundsText(ns)}: ${led}`);
}

/**
 * The review's details on how its rounds were checked: who found the last round and what it ruled out, and who
 * double-checked each round (`checkedLines`); null before any round.
 */
export function confirmDetails(review: Review): ConfirmDetails | null {
  const last = review.rounds.at(-1);
  if (!last) return null;
  const found = foundBy(last);
  const ruledOut = last.ruledOut.map((r) => ({ title: r.candidate.title, reason: r.reason }));
  const checked = checkedLines(review.rounds);
  const answered = last.confirmer !== null && last.confirmFailure === null;
  const count = !answered || ruledOut.length === 0 ? null : `${ruledOut.length} ruled out`;
  return { found, checked, ruledOut, count };
}
