// What the simulated GitHub page says: the check, the summary comment, each thread and what the coding agent
// sees. The page is dev only, but it tells the story GitHub would, so it follows the same rules (ADR 0021).
import {
  asSentence,
  bySeverity,
  type Change,
  type Finding,
  foundAndCheckedText,
  isCounted,
  isUnsettled,
  keptText,
  type Review,
  type Round,
  shortSha,
  skipText,
} from "@lookover/contracts";
import { placeText, roundOnHead } from "./findings.ts";
import { itOrThem, plural } from "./format.ts";
import { stepNow } from "./run.ts";
import { type ChangeReview, inAgentLoop, keptFindings, status, waitText } from "./select.ts";
import { cancelSentence, failureSentence } from "./status.ts";

export type Check = { tone: "pending" | "fail" | "ok" | "neutral"; title: string; text: string } | null;

/** The findings the pull request counts (I-152): the check, the summary and the agent never see the others. */
function openOnGitHub(review: Review): Finding[] {
  return bySeverity(review.findings.filter(isCounted), (f) => f.severity);
}

/**
 * As `publish` says it on the pull request (ADR 0042), in the words both take from contracts' `copy.ts`: how many
 * findings stay in the app, or null when none does. The summary comment says "the rest can go" only then.
 */
const keptOnGitHub = (review: Review): string | null => keptText(keptFindings(review).length);

/**
 * The check of a finished round: changes needed while a blocking finding is open, else passed. A check
 * belongs to the commit it reviewed: commits pushed since then have none until a review is asked for.
 */
function finishedCheck(it: ChangeReview): Check {
  const { review, change } = it;
  const open = openOnGitHub(review);
  const blocking = open.filter((f) => f.severity === "blocking").length;
  if (!roundOnHead(review, change)) return null;
  if (blocking > 0) {
    return {
      tone: "fail",
      title: "Changes needed",
      text: `${plural(blocking, "blocking finding")}${open.length > blocking ? `, ${plural(open.length - blocking, "other")}` : ""}`,
    };
  }
  if (open.length > 0) {
    return { tone: "ok", title: "Passed", text: `${plural(open.length, "finding")}, nothing blocking` };
  }
  const kept = keptOnGitHub(review);
  return { tone: "ok", title: "Passed", text: kept ? `Nothing to fix. ${kept}` : "No open findings" };
}

/** Lookover's check on the head commit, or `null` when that commit has none. */
export function checkOf(it: ChangeReview): Check {
  const s = status(it);
  switch (s.kind) {
    case "running":
      return it.review.preview
        ? null
        : { tone: "pending", title: "In progress", text: `Round ${s.round}: ${stepNow(s.step)}` };
    case "waiting":
      // ADR 0029: a deferred review says why it waits, and that nothing failed.
      return { tone: "pending", title: "Queued", text: `Waiting: ${waitText(s.deferral)}` };
    case "skipped":
      return { tone: "neutral", title: "Skipped", text: `Not reviewed: ${skipText(s.reason)}` };
    case "failed":
      return { tone: "neutral", title: "Failed", text: failureSentence(s.failure).slice(0, -1) };
    case "needs-you":
    case "to-fix":
    case "settled":
    case "cancelled":
      return finishedCheck(it);
    case "not-asked":
      return null;
  }
}

/**
 * Who found the round and who double-checked it (ADR 0055), as a sentence: contracts' `foundAndCheckedText`, which
 * the summary comment on GitHub says too (`byLine` in packages/publish/src/render.ts). No tokens and no times.
 */
function foundAndChecked(round: Round): string {
  return asSentence(foundAndCheckedText(round));
}

/**
 * The one comment Lookover keeps up to date on the pull request (ADR 0023); empty before the first round, which
 * posts it.
 */
export function summaryComment(it: ChangeReview): string {
  const { review } = it;
  const last = review.rounds.at(-1);
  if (!last) return "";
  const lead = `Looked over ${shortSha(last.sha)}. ${foundAndChecked(last)}`;
  const open = openOnGitHub(review);
  const where = (f: Finding) => `${f.file.split("/").at(-1)} ${placeText(f)}`;
  const escalated = open.filter((f) => f.status === "escalated");
  const [disputed] = escalated;
  if (disputed) {
    const kept = keptOnGitHub(review);
    const dispute =
      escalated.length === 1
        ? `${lead} The author and the reviewer disagree on ${where(disputed)}: only the owner can settle it.`
        : `${lead} The author and the reviewer disagree on ${escalated.length} findings, starting with ${where(disputed)}: only the owner can settle them.`;
    return kept ? `${dispute} ${kept}` : dispute;
  }
  const rest = keptOnGitHub(review) ?? "The rest can go.";
  const [first] = open;
  if (!first) return `${lead} Nothing to fix. ${rest}`;
  const count = open.length === 1 ? "One thing to fix" : `${open.length} things to fix`;
  return `${lead} ${count}, starting with ${where(first)}. ${rest}`;
}

export interface Thread {
  /** Folded away, the way GitHub shows a resolved thread. */
  resolved: boolean;
  label: string | null;
  note: string | null;
}

/**
 * An inline comment's thread. The reviewer never resolves one (ADR 0021): it says "verified fixed", and the
 * coding agent's `lookover wait` resolves the thread with the owner's login, or the author does by hand. An escalated
 * one stays open, labelled as the owner's to settle (ADR 0052).
 */
export function threadOf(change: Change, finding: Finding): Thread {
  if (finding.status === "escalated") return { resolved: false, label: "Needs the owner", note: null };
  if (isUnsettled(finding)) return { resolved: false, label: null, note: null };
  if (finding.status === "verified_fixed") {
    const fixed = finding.verifiedSha
      ? `Verified fixed in ${shortSha(finding.verifiedSha)}.`
      : "Verified fixed.";
    return inAgentLoop(change)
      ? {
          resolved: true,
          label: "Resolved",
          note: `${fixed} ${change.openedBy} resolved the thread with lookover wait.`,
        }
      : { resolved: false, label: "Verified fixed", note: `${fixed} The thread is yours to resolve.` };
  }
  return { resolved: true, label: "Withdrawn", note: finding.closedWhy };
}

/**
 * The lines an inline thread quotes, each by its number: the finding's place (`placeText`), from its line to its end
 * line, as far as its snippet holds them; none without a snippet.
 */
export function quotedLines({ line, endLine, snippet }: Finding): { number: number; text: string }[] {
  if (snippet === null) return [];
  const last = Math.max(line, endLine ?? line);
  return snippet.lines
    .map((text, i) => ({ number: snippet.start + i, text }))
    .filter((quoted) => quoted.number >= line && quoted.number <= last);
}

/**
 * The summary comment's last line: the round, then what its posted findings verified fixed, said only once there
 * is one (no zero counter, 06b §1 rule 2).
 */
export function summaryFooter(review: Review): string {
  const fixed = review.findings.filter((f) => f.posted && f.status === "verified_fixed").length;
  const soFar = fixed > 0 ? ` · verified fixed so far: ${fixed}` : "";
  return `Round ${review.rounds.length}${soFar} · one comment, updated after every round`;
}

/** The last line `lookover wait` prints for the agent. */
export function agentLine(it: ChangeReview): string {
  const { review } = it;
  const open = openOnGitHub(review);
  const blocking = open.filter((f) => f.severity === "blocking").length;
  const n = review.rounds.length;
  const s = status(it);
  switch (s.kind) {
    case "running":
      return `Waiting for the review${review.run ? ` of ${shortSha(review.run.sha)}` : ""} (round ${s.round})…`;
    case "waiting":
      // Paused reviews start when the owner resumes them; every other wait clears by itself.
      return s.deferral?.reason === "paused"
        ? `Waiting: ${waitText(s.deferral)}. The review starts when they resume…`
        : `Waiting: ${waitText(s.deferral)}. The review starts by itself…`;
    case "to-fix":
      return `Round ${n} done: ${plural(open.length, "finding")}${blocking > 0 ? ` (${blocking} blocking)` : ""}. Run \`lookover feedback\` to read ${itOrThem(open.length)}.`;
    case "needs-you":
      return `Round ${n} done: the owner has to decide on a finding. Stop and hand over.`;
    case "settled":
      return `Round ${n} done: nothing left to fix.`;
    case "failed":
      return failureSentence(s.failure);
    case "cancelled":
      return ["The review was cancelled.", cancelSentence(s.reason)].filter(Boolean).join(" ");
    case "skipped":
      return "This pull request is not reviewed.";
    case "not-asked":
      return "No review asked for yet.";
  }
}
