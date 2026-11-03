// What lands on GitHub, in words (brand.md: plain, short, exact; says what it found, where, and what to do).
// The review (its marker) and each line comment, the replies on the threads, and the check's title, summary and text;
// the status block in the pull request's description is in `status.ts` (ADR 0074). Every sentence that lands on the
// pull request is written here and nowhere else, but for the phrases the app says too (contracts' `copy.ts`).
import type {
  CheckOutput,
  CommitSha,
  Deferral,
  EngineId,
  Finding,
  FindingId,
  InlineComment,
  ReviewPost,
  ReviewResult,
  Severity,
  ThreadReply,
} from "@lookover/contracts";
import {
  bySeverity,
  CHECK_OUTPUT_MAX_BYTES,
  COMMENT_MAX_BYTES,
  cancelText,
  confirmFailureText,
  dayText,
  deferralText,
  FINDING_MARKER,
  failureText,
  isCounted,
  keptText,
  replyMarker as markerOf,
  REVIEW_MARKER,
  replyKind,
  severityText,
  shortSha,
  startsOnceText,
  twoDigits,
  utf8Bytes,
  wordmark,
} from "@lookover/contracts";
import { fenced } from "./fence.ts";
import { fenceClosed, filteredAgain, postableLine } from "./filter.ts";
import { cut } from "./fit.ts";
import type { PlacedFinding } from "./place.ts";
import { resultLine } from "./result.ts";
import type { Ended, RoundToPost, SkipWhy } from "./types.ts";

const SEVERITY: Record<Severity, string> = {
  blocking: "Blocking",
  should_fix: "Should fix",
  consider: "Consider",
};

/**
 * A finding's severity as the pull request says it: a `blocking` finding lowered because the confirm pass didn't
 * confirm it says so (ADR 0044).
 */
export function severityOf(f: Finding): string {
  const demoted = f.confirmation.verdict !== "confirmed" && f.confirmation.demoted;
  return severityText(SEVERITY[f.severity], demoted);
}

/**
 * What the round's passes left undone (ADR 0044): Deep's second find pass that gave no round, and the confirm pass
 * that failed, its findings then posted as found; nothing otherwise.
 */
function confirmLine(round: RoundToPost): string[] {
  const { secondFind, confirmer, confirmFailure } = round.run;
  const second = secondFind?.failure
    ? [`One find pass, not two: ${confirmFailureText(secondFind.failure, secondFind.engine)}.`]
    : [];
  if (confirmer === null || confirmFailure === null) return second;
  return [
    ...second,
    `Not double-checked: ${confirmFailureText(confirmFailure, confirmer)}, so these findings are posted as found.`,
  ];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Its twin in the app: `placeText` in apps/web/src/view-model/findings.ts. Change both together.
/** `line 42`, `lines 42 to 44`; on the base side, `old line 42`: a line of the file before the change. */
function lines(f: Finding): string {
  const old = f.side === "base" ? "old " : "";
  const range = f.endLine !== null && f.endLine !== f.line;
  return range ? `${old}lines ${f.line} to ${f.endLine}` : `${old}line ${f.line}`;
}
/** `content`, on one line, as a code span: a backtick run longer than any inside it. */
function codeSpan(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}
// A path the finder named outside the diff is the engine's text: its secrets removed with the round's (`findingFilter`),
// filtered on its line here, in a code span or not.
const where = (f: Finding) => `${postableLine(f.file.split("/").at(-1) ?? "")} ${lines(f)}`;
/** Where a finding is, on a line of its own: its path as code, then its line or lines. */
export const findingAt = (f: Finding) => `${codeSpan(postableLine(f.file))} ${lines(f)}`;

/**
 * "The rest can go" closes a sentence only when nothing else is open, posted or not (ADR 0042): never while a
 * finding is kept in the app.
 */
const restCanGo = (round: RoundToPost) => (round.reconciled.keptInApp === 0 ? " The rest can go." : "");

/** How many findings are kept in the app (ADR 0042), or nothing when none is. */
function keptLine(round: RoundToPost): string[] {
  const kept = keptText(round.reconciled.keptInApp);
  return kept === null ? [] : [kept];
}

/** The one sentence on where the pull request stands: the check's summary opens with it, and the result carries it. */
export function headline(round: RoundToPost): string {
  const { findings, loop, open } = round.reconciled;
  const counted = bySeverity(findings.filter(isCounted), (f) => f.severity);
  if (loop === "needs_owner") {
    // `core` says only the owner can settle it; the escalated findings only name what.
    const escalated = counted.filter((f) => f.status === "escalated");
    const [disputed] = escalated;
    if (!disputed) return "The author and the reviewer disagree: only the owner can settle it.";
    return escalated.length === 1
      ? `The author and the reviewer disagree on ${where(disputed)}: only the owner can settle it.`
      : `The author and the reviewer disagree on ${escalated.length} findings, starting with ${where(disputed)}: only the owner can settle them.`;
  }
  const [first] = counted;
  const rest = restCanGo(round);
  if (!first || open === 0) return `Nothing to fix.${rest}`;
  return open === 1
    ? `One thing to fix, ${where(first)}.${rest}`
    : `${open} things to fix, starting with ${where(first)}.${rest}`;
}

/** The check's title: one short line next to the check's name. */
function title(round: RoundToPost): string {
  const { loop, open } = round.reconciled;
  if (loop === "needs_owner") return `Looked over ${shortSha(round.sha)}: needs the owner`;
  if (open === 0) return `Looked over ${shortSha(round.sha)}: nothing to fix`;
  return `Looked over ${shortSha(round.sha)}: ${open === 1 ? "one thing" : `${open} things`} to fix`;
}

// The review: one top comment and every inline comment of the round (ADR 0023).

/**
 * `text` as it is posted, within `budget` bytes: cut to fit (#67), a fence it leaves open closed, then filtered (ADR
 * 0056), last, so nothing done to a text after the filter lets anything out; cut shorter while what the filter adds
 * overflows. Every body Lookover posts ends here, whole or (a reply) its engine's part: Lookover's own words hold
 * nothing the filter changes.
 */
function fitted(text: string, budget: number): string {
  let room = budget;
  for (;;) {
    const shown = filteredAgain(fenceClosed(cut(text, room)));
    const over = utf8Bytes(shown) - budget;
    if (over <= 0 || room <= 0) return shown;
    room -= over;
  }
}

/** What every post opens with (ADR 0074): the wordmark, 18 px high, then its kind. Added after the output filter. */
const opening = (kind: string) => `${wordmark(18)} · ${kind}\n\n`;

/**
 * The finding's suggestion as GitHub applies it in one click (ADR 0074, I-226): only on a comment that covers exactly
 * its lines on the head side, so applying it replaces those lines and nothing else; none otherwise.
 */
function suggestionOf(finding: Finding, at: Omit<InlineComment, "body">): string | null {
  if (finding.suggestion === null || finding.side !== "head" || at.side !== "head") return null;
  const last = (place: { line: number; endLine: number | null }) => place.endLine ?? place.line;
  const exact = at.line === finding.line && last(at) === last(finding);
  return exact ? fenced("suggestion", finding.suggestion) : null;
}

/**
 * The comment of a finding placed inline, where `place` put it: its severity after the wordmark, its title in bold,
 * its body, then its suggestion, kept only when it fits whole and the filter leaves it as written, then its marker.
 * Only the body is cut (#67), the opening and the marker never.
 */
function inlineComment(round: RoundToPost, finding: Finding, at: Omit<InlineComment, "body">): InlineComment {
  const marker = JSON.stringify({
    v: 1,
    id: finding.id,
    fingerprints: finding.fingerprints,
    severity: finding.severity,
    sha: round.sha,
  });
  const open = opening(severityOf(finding));
  const tail = `\n\n${FINDING_MARKER}${marker} -->`;
  const text = `**${postableLine(finding.title)}**\n\n${fenceClosed(finding.body)}`;
  const suggestion = suggestionOf(finding, at);
  if (suggestion !== null) {
    const whole = filteredAgain(fenceClosed(`${text}\n\n${suggestion}`));
    const fits = utf8Bytes(`${open}${whole}${tail}`) <= COMMENT_MAX_BYTES;
    if (fits && whole.endsWith(`\n\n${suggestion}`)) return { ...at, body: `${open}${whole}${tail}` };
  }
  return { ...at, body: `${open}${fitted(text, COMMENT_MAX_BYTES - utf8Bytes(`${open}${tail}`))}${tail}` };
}

/** The round's review: its hidden marker for a body (ADR 0074), and a comment on each finding it places inline. */
export function renderReview(round: RoundToPost, placed: PlacedFinding[]): ReviewPost {
  const posting = new Set(round.reconciled.post.map((f) => f.id));
  const inline = placed.flatMap((p) => (p.placement === "inline" && posting.has(p.finding.id) ? [p] : []));
  return {
    sha: round.sha,
    body: reviewMarker(round),
    comments: inline.map((p) => inlineComment(round, p.finding, p.at)),
  };
}

/**
 * The hidden line that names the round in its review's body (ADR 0044): its run, unique to the round, and its
 * number. A send that may have reached the host looks for it before posting the review again.
 */
export function reviewMarker(round: Pick<RoundToPost, "run" | "round">): string {
  return `${REVIEW_MARKER}${JSON.stringify({ v: 1, run: round.run.id, n: round.round })} -->`;
}

// A reply on a finding's thread (ADR 0052): what the round decided about the author's claim, and why.

/**
 * The hidden line that ends a round's reply on a finding: what finds it on the host before it is sent again, and the
 * claim it answers (the reply id the finding holds), so `core.readThreads` reads a claim written after that one, even
 * when it lands before this reply.
 */
export function replyMarker(round: Pick<RoundToPost, "run" | "reconciled">, finding: FindingId): string {
  const claim = round.reconciled.findings.find((f) => f.id === finding)?.claim?.commentId;
  return markerOf({ run: round.run.id, finding, ...(claim === undefined ? {} : { claim }) });
}

/**
 * The hidden line that ends the owner's dismissal on a finding's thread (ADR 0052): the dismissal, apart from any run,
 * and the finding. What finds it on the host before it is sent again.
 */
export function dismissalMarker(dismissal: string, finding: FindingId): string {
  return markerOf({ dismissal, finding });
}

/**
 * The body of a reply on a finding's thread, with its hidden marker (the round's, unless given), within
 * `COMMENT_MAX_BYTES`: the wordmark and the reply's kind, its reason, its closing line. Only the reason is cut, so the
 * rest is always said.
 */
export function renderReply(
  round: RoundToPost,
  reply: ThreadReply,
  marker = replyMarker(round, reply.findingId),
): string {
  const finding = round.reconciled.findings.find((f) => f.id === reply.findingId);
  const { kind, why: own, last } = replyKind(reply.kind, finding);
  const open = opening(kind);
  const closing = last === null ? "" : `\n\n${last}`;
  const tail = `\n\n${marker}`;
  const room = COMMENT_MAX_BYTES - utf8Bytes(`${open}${closing}${tail}`);
  const why = own ?? fitted(reply.why.trim(), room);
  // An empty reason leaves the opening and the closing, without the blank lines around it.
  const said = [why, last].filter((part) => part !== null && part !== "").join("\n\n");
  return `${said === "" ? open.trimEnd() : `${open}${said}`}${tail}`;
}

// The check: in progress while the round posts, then completed with the result (ADR 0006, ADR 0039).

export function checkInProgress(round: RoundToPost): CheckOutput {
  return {
    title: `Looking over ${shortSha(round.sha)}`,
    summary: `Round ${round.round} is being posted.`,
    text: "The review, its status in the pull request's description and the result follow when the round is posted.",
  };
}

/** The check's summary lists at most this many findings: it has a byte limit too, and the description lists every open one. */
const CHECK_SUMMARY_LIST = 20;

/** A finding's line in the check's list: its id, severity, place and title, the title filtered as that line. */
function findingEntry(f: Finding): string {
  return `- ${f.id} · ${severityOf(f)} · ${findingAt(f)} · ${postableLine(f.title)}`;
}

function checkSummary(round: RoundToPost): string {
  const counted = bySeverity(round.reconciled.findings.filter(isCounted), (f) => f.severity);
  const shown = counted.slice(0, CHECK_SUMMARY_LIST);
  const list = shown.map(findingEntry);
  const more = counted.length - shown.length;
  if (more > 0) list.push(`- and ${more} more, in the pull request's description`);
  // Its titles are the engine's words, of any length: cut at a line to fit too (#67).
  return fitted(
    [headline(round), ...confirmLine(round), ...keptLine(round), ...list].join("\n"),
    CHECK_OUTPUT_MAX_BYTES,
  );
}

/** The check's text for a result: a line for people, then the result's line, last. */
export function checkText(result: ReviewResult, left: number): string {
  const lines = [
    "The review is on the pull request, and where it stands in its description. The last line of this text is the `lookover.review-result/v1` result, for coding agents.",
  ];
  if (result.truncated) {
    lines.push(
      `${plural(left, "finding")} did not fit the result and ${left === 1 ? "is" : "are"} left out of it; the open ones are in the pull request's description, and the app has them all.`,
    );
  }
  return [...lines, resultLine(result)].join("\n");
}

export function checkCompleted(round: RoundToPost, result: ReviewResult, left: number): CheckOutput {
  return { title: title(round), summary: checkSummary(round), text: checkText(result, left) };
}

// The check before its round, or of a job that ended without one (ADR 0043).

/** An engine's reset (epoch ms) and the service's offset from UTC then, in minutes east. */
export interface Reset {
  at: number;
  offset: number;
}

/**
 * "Wed 14 Oct 2026 at 10:11 (UTC+02:00)": an engine's reset on the service's wall clock, with its offset, since the
 * check is read elsewhere (ADR 0055).
 */
function resetText({ at, offset }: Reset): string {
  const d = new Date(at + offset * 60_000);
  const hours = `${offset < 0 ? "-" : "+"}${twoDigits(Math.floor(Math.abs(offset) / 60))}:${twoDigits(Math.abs(offset) % 60)}`;
  const zone = offset === 0 ? "UTC" : `UTC${hours}`;
  return `${dayText(d)} ${d.getUTCFullYear()} at ${twoDigits(d.getUTCHours())}:${twoDigits(d.getUTCMinutes())} (${zone})`;
}

/** When a deferred job starts, after the app's words for why it waits; an engine's limit, at its reset if known. */
function startsWhen(deferral: Deferral, reset: Reset | null): string {
  return deferral.reason === "engine-limit" && reset !== null
    ? `once the limit resets, on ${resetText(reset)}`
    : startsOnceText(deferral);
}

const OPEN_TEXT =
  "This check is completed when the review ends. The last line of its text is then the `lookover.review-result/v1` result, for coding agents.";

/** A waiting job's check: why it waits, in its title; until when, for an engine's limit with its reset known. */
export function checkWaiting(sha: CommitSha, deferral: Deferral | null, reset: Reset | null): CheckOutput {
  if (deferral === null) {
    return {
      title: "Waiting for its turn",
      summary: `Lookover looks over ${shortSha(sha)} once the reviews before it are done.`,
      text: OPEN_TEXT,
    };
  }
  return {
    title: `Waiting: ${deferralText(deferral)}`,
    summary: `Lookover looks over ${shortSha(sha)} ${startsWhen(deferral, reset)}.`,
    text: OPEN_TEXT,
  };
}

/** A running job's check. */
export function checkRunning(sha: CommitSha, round: number): CheckOutput {
  return { title: `Looking over ${shortSha(sha)}`, summary: `Round ${round} is running.`, text: OPEN_TEXT };
}

/** Why a job was skipped: the check's title, and what the summary adds after "Lookover did not look over <sha>". */
const SKIPPED: Record<SkipWhy, { title: string; more: string }> = {
  "newer-commit": { title: "A newer commit was pushed", more: ": it looks over the newer commit instead." },
  preview: {
    title: "A preview: nothing was posted",
    more: " here: the owner previewed its review in the app, and nothing was posted.",
  },
  replaced: { title: cancelText("replaced"), more: ": a newer review of the pull request follows." },
  pushed: {
    title: cancelText("pushed"),
    more: ": the owner asked for this commit, and a newer one was pushed before its review began. Ask again to review the newer commit.",
  },
  closed: { title: cancelText("closed"), more: "." },
  "not-yours": {
    title: "Not your pull request",
    more: ": it reviews the owner's pull requests, and those the owner asks for.",
  },
  draft: {
    title: "A draft: reviewed when the owner asks",
    more: ": it reviews a draft when the owner asks.",
  },
  "repo-off": { title: "Reviews are off for this repository", more: "." },
  "on-open-off": { title: "Reviews on open are off for this repository", more: "." },
  "codex-not-yours": {
    title: "Codex reviews only the owner's pull requests from this repository",
    more: ": only Codex may review here, and it reviews only the owner's pull requests from this repository.",
  },
  fork: {
    title: "Not reviewed: it comes from a fork",
    more: ": it reviews a pull request from a fork only when the owner asks, and with Claude only. To ask, comment `/lookover review` on it, or use “Review again” in Lookover.",
  },
};

/** A fork's skip where only Codex may review: a request would be skipped too, so the way is Settings (ADR 0048). */
const FORK_ONLY_CODEX =
  ": it reviews a pull request from a fork only when the owner asks, and with Claude only, and only Codex may review here. To have it reviewed, the owner lets Claude review too, in Lookover's Settings.";

/**
 * The one sentence on how the job ended: the check's title, and the result's headline. `engine` reviewed it, if a
 * run started.
 */
export function endedHeadline(ended: Ended, engine: EngineId | null): string {
  if (ended.kind === "failed") return `The review failed: ${failureText({ kind: ended.failure, engine })}`;
  return SKIPPED[ended.why].title;
}

/**
 * A job's check completed without a round: why, then the result, last. `onlyCodex`: only Codex may review in the
 * repository, so a fork's skip points to Settings.
 */
export function checkEnded(
  sha: CommitSha,
  ended: Ended,
  engine: EngineId | null,
  result: ReviewResult,
  onlyCodex: boolean,
): CheckOutput {
  const did = `Lookover did not look over ${shortSha(sha)}`;
  const more = (why: SkipWhy) => (why === "fork" && onlyCodex ? FORK_ONLY_CODEX : SKIPPED[why].more);
  const summary =
    ended.kind === "failed" ? `${did}. The owner sees why in Lookover.` : `${did}${more(ended.why)}`;
  const text = [
    "Lookover posted no review of this commit. The last line of this text is the `lookover.review-result/v1` result, for coding agents.",
    resultLine(result),
  ].join("\n");
  return { title: endedHeadline(ended, engine), summary, text };
}
