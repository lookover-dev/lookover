// What the simulated GitHub page says: the check, Lookover's status block in the description, each round's review
// and its threads with Lookover's replies, and what the coding agent sees. The page is dev only, but it tells the
// story GitHub would, so it follows the same rules (ADR 0021, ADR 0074).
import {
  bySeverity,
  type Change,
  type CommitSha,
  type Connection,
  type Deferral,
  type Engine,
  type EngineId,
  escalationText,
  type Finding,
  failedHead,
  failedLine,
  failedTitle,
  failureWords,
  findingPermalink,
  isCounted,
  isUnsettled,
  keptText,
  lookingOverHead,
  NEEDS_YOUR_LOOK,
  notInDiffText,
  type ReplyKind,
  type Review,
  type Round,
  replyKind,
  roundLine,
  type State,
  shortSha,
  skipText,
  type TimelineEntry,
  thingsText,
  upperFirst,
  waitingHead,
  waitingText,
} from "@lookover/contracts";
import { severityLabel } from "./confirm.ts";
import { placeText, roundOnHead } from "./findings.ts";
import { itOrThem, onDayAt, plural, type Words } from "./format.ts";
import { stepNow } from "./run.ts";
import { type ChangeReview, inAgentLoop, keptFindings, openCounts, status, waitText } from "./select.ts";
import { cancelSentence } from "./status.ts";

export type Check = { tone: "pending" | "fail" | "ok" | "neutral"; title: string; text: string } | null;

/**
 * Who Lookover's posts are by (ADR 0066, ADR 0073): the person signed in, by their login; "you" while nobody is (the
 * posts are still the person's own). Never a bot.
 */
export const postedAs = ({ person }: Pick<Connection, "person">): string => person?.login ?? "you";

/** The findings the pull request counts (I-152): the check, the status block and the agent never see the others. */
function openOnGitHub(review: Review): Finding[] {
  return bySeverity(review.findings.filter(isCounted), (f) => f.severity);
}

/**
 * As `publish` says it on the pull request (ADR 0042), in the words both take from contracts' `copy.ts`: how many
 * findings stay in the app, or null when none does.
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

/**
 * Lookover's check on the head commit, or `null` when that commit has none. A preview makes none, whatever its status,
 * failed included (ADR 0072). `Review.preview` says what the last run was: a job asked since, still waiting or
 * skipped, has had no run yet, and it has its own check.
 */
export function checkOf(it: ChangeReview): Check {
  const s = status(it);
  if (it.review.preview && s.kind !== "waiting" && s.kind !== "skipped") return null;
  switch (s.kind) {
    case "running":
      return { tone: "pending", title: "In progress", text: `Round ${s.round}: ${stepNow(s.step)}` };
    case "waiting":
      // ADR 0029: a deferred review says why it waits, and that nothing failed.
      return { tone: "pending", title: "Queued", text: `Waiting: ${waitText(s.deferral)}` };
    case "skipped":
      return { tone: "neutral", title: "Skipped", text: `Not reviewed: ${skipText(s.reason)}` };
    case "failed":
      return { tone: "neutral", title: "Failed", text: upperFirst(failureWords(s.failure).phrase) };
    case "to-fix":
    case "needs-you":
    case "settled":
    case "cancelled":
      return finishedCheck(it);
    case "preview":
    case "not-asked":
      return null;
  }
}

// The status block in the pull request's description (ADR 0074), as `statusBlock` in packages/publish/src/status.ts
// posts it, in the words both take from contracts' `copy.ts`.

/** One open finding in the block. */
export interface BlockItem {
  finding: Finding;
  /** "Blocking", "Should fix, unconfirmed". */
  severity: string;
  /** Its title links to its thread: it has a line comment. */
  linked: boolean;
  /** "line 42", "lines 12 to 14", "old line 3". */
  place: string;
  /** Its second line: why the owner decides it, or, with no line comment, "Not in the diff: …"; null for neither. */
  note: string | null;
  /** Its lines on GitHub, for one with no line comment: the file on the commit they are on; null when not known. */
  permalink: { url: string; sha: CommitSha } | null;
}

/** The block: its heading after the wordmark, the one line under it, the open findings. */
export interface StatusBlock {
  head: Words;
  line: Words;
  items: BlockItem[];
}

/** What the block reads beside the review: the service's clock and each AI's limit, for a waiting review's reset. */
export interface Around extends Pick<State, "now"> {
  engines: Record<EngineId, Pick<Engine, "limitUntil">>;
}

/** A waiting job's line: an AI's limit at its reset, in the machine's time, when known. */
function waitingLine(deferral: Deferral | null, around: Around): string {
  const until = deferral?.reason === "engine-limit" ? around.engines[deferral.engine].limitUntil : null;
  return waitingText(deferral, until ? onDayAt(around.now, until) : null);
}

/**
 * One open finding in the block: one with no line comment shows its lines on the commit they are on, a base-side one
 * on the last round's merge base, as publish does.
 */
function itemOf({ repo, review }: ChangeReview, last: Round, f: Finding): BlockItem {
  const off = !f.commented && f.status !== "escalated";
  const note =
    f.status === "escalated" ? escalationText(f.claim?.kind ?? null) : off ? notInDiffText(f.body) : null;
  return {
    finding: f,
    severity: severityLabel(f),
    linked: f.commented,
    place: placeText(f),
    note,
    permalink: off ? findingPermalink(repo, f, { base: last.base, rounds: review.rounds }) : null,
  };
}

/** What is open on the pull request after the last round posted: escalated first, then by severity. */
function openItems(it: ChangeReview, last: Round): BlockItem[] {
  const open = it.review.findings.filter(isCounted);
  const sorted = (s: Finding["status"]) =>
    bySeverity(
      open.filter((f) => f.status === s),
      (f) => f.severity,
    );
  return [...sorted("escalated"), ...sorted("open")].map((f) => itemOf(it, last, f));
}

/** The block while a round runs on `sha`: no list, and "again" on the last round's commit. */
const lookingOver = (review: Review, sha: CommitSha): StatusBlock => ({
  head: lookingOverHead({ commit: sha }, review.rounds.at(-1)?.sha === sha),
  line: [`Round ${review.rounds.length + 1}`],
  items: [],
});

/**
 * The status block Lookover keeps in the pull request's description, as it stands, or null where it writes none:
 * before any job, on a pull request it skipped from the start, and after a preview, which posts nothing. It follows
 * the job, not the app's status: while a round runs, its commit and its round; once posted, what is left to fix;
 * waiting or failed, why, over the last posted round's list (a failure after a round included, which the app shows
 * as the loop's state).
 */
export function statusBlock(it: ChangeReview, around: Around): StatusBlock | null {
  const { review } = it;
  const { job, run } = review;
  const last = review.preview ? undefined : review.rounds.at(-1);
  const posted = (): StatusBlock | null =>
    last === undefined
      ? null
      : {
          head: [
            review.loop === "needs_owner"
              ? NEEDS_YOUR_LOOK
              : thingsText(review.findings.filter(isCounted).length),
          ],
          line: roundLine(last.n, { commit: last.sha }, review.findings),
          items: openItems(it, last),
        };
  /** A waiting or failed job's line: its round's number past the first. */
  const ofRound = (text: string): Words => [
    review.rounds.length > 0 ? `Round ${review.rounds.length + 1} · ${text}` : text,
  ];
  if (job === null) return null;
  switch (job.state) {
    case "running":
      return run?.preview ? null : lookingOver(review, run?.sha ?? job.sha);
    case "queued":
    case "deferred":
      return {
        head: waitingHead({ commit: job.sha }),
        line: ofRound(waitingLine(job.state === "deferred" ? job.deferral : null, around)),
        items: posted()?.items ?? [],
      };
    case "failed": {
      if (review.preview) return null;
      return {
        head: failedHead({ commit: job.sha }),
        line: ofRound(failedLine(job.failure)),
        items: posted()?.items ?? [],
      };
    }
    case "done":
    case "cancelled":
    case "skipped":
      return posted();
  }
}

/** One item of the page's timeline: a push or the opening, or a round's review, which holds its line comments. */
export type TimelineItem =
  | { kind: "event"; at: number; entry: TimelineEntry }
  | { kind: "review"; at: number; round: Round; findings: Finding[] };

/**
 * The pull request's timeline, oldest first: its opening and pushes, and each round's review, which holds the line
 * comments it posted. A round that posted no line comment posts no review (ADR 0074): the block says it.
 */
export function timelineOf(review: Review): TimelineItem[] {
  const events: TimelineItem[] = review.timeline
    .filter((t) => t.kind === "opened" || t.kind === "pushed")
    .map((entry) => ({ kind: "event", at: entry.at, entry }));
  const reviews: TimelineItem[] = review.preview
    ? []
    : review.rounds.flatMap((round) => {
        const findings = review.findings.filter((f) => f.posted && f.commented && f.raisedIn === round.n);
        return findings.length > 0 ? [{ kind: "review" as const, at: round.endedAt, round, findings }] : [];
      });
  return [...events, ...reviews].sort((a, b) => a.at - b.at);
}

export interface Thread {
  /** Folded away, the way GitHub shows a resolved thread. */
  resolved: boolean;
  /** Its first comment hidden by Lookover, as resolved (ADR 0074): withdrawn, or dismissed by the owner. */
  hidden: boolean;
  label: string | null;
  note: string | null;
}

/**
 * A line comment's thread. Lookover resolves none (ADR 0074: the shared App has no Contents: write): it hides the
 * first comment of one it withdrew or the owner dismissed, and the coding agent's `lookover wait` resolves those and
 * the ones verified fixed with the person's login; on any other pull request they are the author's to resolve. An
 * escalated one stays open, the owner's to settle (ADR 0052).
 */
export function threadOf(change: Change, finding: Finding): Thread {
  if (finding.status === "escalated")
    return { resolved: false, hidden: false, label: NEEDS_YOUR_LOOK, note: null };
  if (isUnsettled(finding)) return { resolved: false, hidden: false, label: null, note: null };
  const byWait = (said: string): Thread => ({
    resolved: true,
    hidden: finding.status !== "verified_fixed",
    label: "Resolved",
    note: `${said} ${change.openedBy} resolved the thread with lookover wait.`,
  });
  if (finding.status === "verified_fixed") {
    const fixed = finding.verifiedSha
      ? `Verified fixed in ${shortSha(finding.verifiedSha)}.`
      : "Verified fixed.";
    return inAgentLoop(change)
      ? byWait(fixed)
      : {
          resolved: false,
          hidden: false,
          label: "Verified fixed",
          note: `${fixed} The thread is yours to resolve.`,
        };
  }
  if (finding.status === "withdrawn" || finding.status === "dismissed") {
    const label = replyKind(finding.status === "withdrawn" ? "withdrawn" : "dismissed", finding).kind;
    return inAgentLoop(change)
      ? byWait(`${label}.`)
      : { resolved: false, hidden: true, label, note: "The thread is yours to resolve." };
  }
  // Acknowledged or obsolete: settled with no reply, the thread left as it is.
  return { resolved: false, hidden: false, label: null, note: null };
}

/** Lookover's reply on a thread: its kind after the wordmark, then what it says, one paragraph each. */
export interface Reply {
  kind: string;
  said: string[];
}

/**
 * Which reply Lookover last posted on a finding's thread, from what the round decided about the author's claim: kept
 * once, kept again once escalated (kept three times), escalated, withdrawn, dismissed by the owner; null for none.
 * Never `still_present` (ADR 0081): the finding keeps nothing of that reply, which lives on GitHub's thread alone.
 */
function replyOn(finding: Finding): ReplyKind | null {
  if (finding.status === "dismissed") return "dismissed";
  if (finding.claim === null) return null;
  switch (finding.status) {
    case "withdrawn":
      return "withdrawn";
    case "escalated":
      return finding.kept >= 3 ? "kept" : "escalated";
    case "open":
      return finding.kept === 1 ? "kept" : null;
    default:
      return null;
  }
}

/**
 * Lookover's newest reply on a finding's thread, as publish's `renderReply` words it (contracts' `replyKind`); null
 * when it posted none. The finder's own reason for keeping or escalating a finding isn't in the app: those replies
 * show their kind and closing alone, a withdrawn one the reason it was closed. An answer to a question isn't either:
 * none shows.
 */
export function replyOf(finding: Finding): Reply | null {
  const reply = replyOn(finding);
  if (reply === null) return null;
  const { kind, why, last } = replyKind(reply, finding);
  const own = reply === "withdrawn" ? finding.closedWhy : why;
  return { kind, said: [own, last].filter((part): part is string => part !== null && part !== "") };
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

/** What the agent reads after a preview, whatever it found: nothing reached GitHub (ADR 0072). */
const PREVIEW_LINE = "No review on GitHub: the owner's preview posted nothing.";

/** The last line `lookover wait` prints for the agent. */
export function agentLine(it: ChangeReview): string {
  const { review } = it;
  const { open, blocking } = openCounts(openOnGitHub(review));
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
    case "preview":
      return PREVIEW_LINE;
    case "to-fix":
      return `Round ${n} done: ${plural(open, "finding")}${blocking > 0 ? ` (${blocking} blocking)` : ""}. Run \`lookover feedback\` to read ${itOrThem(open)}.`;
    case "needs-you":
      return review.preview
        ? PREVIEW_LINE
        : `Round ${n} done: the owner has to decide on a finding. Stop and hand over.`;
    case "settled":
      return review.preview ? PREVIEW_LINE : `Round ${n} done: nothing left to fix.`;
    case "failed":
      return `${failedTitle(s.failure)}.`;
    case "cancelled":
      return ["The review was cancelled.", cancelSentence(s.reason)].filter(Boolean).join(" ");
    case "skipped":
      return "This pull request is not reviewed.";
    case "not-asked":
      return "No review asked for yet.";
  }
}
