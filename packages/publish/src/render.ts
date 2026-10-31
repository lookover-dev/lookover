// What lands on GitHub, in words (brand.md: plain, short, exact; says what it found, where, and what to do).
// The review's top comment and each inline comment, the summary comment (every posted finding's status and
// the round history, ADR 0023), and the check's title, summary and text. Every sentence that lands on the pull
// request is written here and nowhere else, but for the phrases the app says too (contracts' `copy.ts`).
import type {
  CheckOutput,
  ClaimKind,
  CommitSha,
  Deferral,
  EngineId,
  EngineUnusable,
  Finding,
  FindingClaim,
  FindingId,
  InlineComment,
  ReplyKind,
  ReviewPost,
  ReviewResult,
  Severity,
  ThreadReply,
} from "@lookover/contracts";
import {
  asSentence,
  bySeverity,
  CHECK_OUTPUT_MAX_BYTES,
  COMMENT_MAX_BYTES,
  cancelText,
  confirmFailureText,
  dayText,
  deferralText,
  engineName,
  FINDING_MARKER,
  failureText,
  foundAndCheckedText,
  isCounted,
  isUnsettled,
  keptText,
  LOOKOVERS_OPENING,
  replyMarker as markerOf,
  NOT_RAISED_AGAIN,
  REVIEW_MARKER,
  REVIEW_MAX_COMMENTS,
  ruleText,
  SUMMARY_MARKER,
  severityText,
  shortSha,
  twoDigits,
  unusableFixedText,
  utf8Bytes,
} from "@lookover/contracts";
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

/** A finding placed in the summary, and why. */
type SummaryPlaced = Extract<PlacedFinding, { placement: "summary" }>;

const OUTSIDE: Record<SummaryPlaced["outside"], string> = {
  file_not_in_diff: "the file is not in the diff",
  line_not_in_diff: "the line is not in the diff",
  binary_file: "a binary file",
  diff_truncated: "the diff was cut before this line",
  text_not_in_diff: "the code it names is not in the diff",
  host_refused: "GitHub would not place this round's comments",
  review_full: `the review holds ${REVIEW_MAX_COMMENTS} comments at most`,
  no_comment: "none was posted for it",
  line_moved: "its line moved since it was found",
};

/**
 * A finding's severity as the pull request says it: a `blocking` finding lowered because the confirm pass didn't
 * confirm it says so (ADR 0044).
 */
function severityOf(f: Finding): string {
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

/**
 * Who found the round and who double-checked it (ADR 0055), as a sentence on its own line under the summary's header
 * (its twin in the app: `summaryComment` in apps/web/src/view-model/github.ts; both say `foundAndCheckedText`). The
 * lines under the headline say why a confirm pass or a second find pass gave no answer (`confirmLine`). No tokens
 * and no times: they are the owner's, kept in the app.
 */
function byLine(round: RoundToPost): string {
  const { engine, secondFind, confirmer, confirmFailure } = round.run;
  const said = foundAndCheckedText({
    reviewer: engine,
    secondFind,
    confirmer,
    confirmFailure,
    raised: round.reconciled.raised.length,
  });
  return asSentence(said);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Its twin in the app: `placeText` in apps/web/src/view-model/findings.ts. Change both together.
/** `line 42`, `lines 42 to 44`; on the base side, `old line 42`: a line of the file before the change. */
function lines(f: Finding): string {
  const old = f.side === "base" ? "old " : "";
  const range = f.endLine !== null && f.endLine !== f.line;
  return range ? `${old}lines ${f.line} to ${f.endLine}` : `${old}line ${f.line}`;
}
/** The repository's rule a finding follows (ADR 0048), as a sentence: "Rule: REVIEW.md, line 12."; none without. */
const ruleLine = (f: Finding): string[] => (f.rule ? [`Rule: ${ruleText(f.rule)}.`] : []);
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
const at = (f: Finding) => `${codeSpan(postableLine(f.file))} ${lines(f)}`;

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

/** The one sentence on where the pull request stands: the check's summary opens with it, the summary too. */
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

/**
 * `text`, then its hidden marker line, within `COMMENT_MAX_BYTES`: `text` is cut to fit (#67), the marker never.
 */
function marked(text: string, marker: string): string {
  const tail = `\n\n${marker}`;
  return `${fitted(text, COMMENT_MAX_BYTES - utf8Bytes(tail))}${tail}`;
}

/** The comment of a finding placed inline, where `place` put it. */
function inlineComment(round: RoundToPost, finding: Finding, at: Omit<InlineComment, "body">): InlineComment {
  const marker = JSON.stringify({
    v: 1,
    id: finding.id,
    fingerprints: finding.fingerprints,
    severity: finding.severity,
    sha: round.sha,
  });
  return {
    ...at,
    body: marked(
      [
        `${LOOKOVERS_OPENING}**${postableLine(finding.title)}** · ${severityOf(finding)}`,
        fenceClosed(finding.body),
        ...ruleLine(finding),
      ].join("\n\n"),
      `${FINDING_MARKER}${marker} -->`,
    ),
  };
}

/**
 * The review's top comment: what this round posted, then what earlier rounds left open (the summary comment
 * has those). "The rest can go" only when nothing else is open, on the pull request or kept in the app.
 */
function reviewBody(round: RoundToPost, inline: Finding[], summary: SummaryPlaced[]): string {
  const sha = shortSha(round.sha);
  const posted = inline.length + summary.length;
  const earlier = Math.max(0, round.reconciled.open - posted);
  const fresh = round.round > 1 ? "new " : "";
  const first = inline[0] ?? summary[0]?.finding;
  const lines: string[] = [];
  if (!first) {
    lines.push(`${LOOKOVERS_OPENING}Looked over ${sha}. Nothing ${fresh}to fix.`);
  } else if (posted === 1) {
    lines.push(`${LOOKOVERS_OPENING}Looked over ${sha}. One ${fresh}thing to fix, ${where(first)}.`);
  } else {
    lines.push(
      `${LOOKOVERS_OPENING}Looked over ${sha}. ${posted} ${fresh}things to fix, starting with ${where(first)}.`,
    );
  }
  if (earlier > 0) {
    lines.push(
      earlier === 1
        ? "One finding from an earlier round is still open: it is in the summary comment."
        : `${earlier} findings from earlier rounds are still open: they are in the summary comment.`,
    );
  } else {
    lines[0] += restCanGo(round);
  }
  lines.push(...whySummary(summary));
  return marked(lines.join("\n\n"), reviewMarker(round));
}

/** Why the round's findings in the summary have no comment of their own: one sentence per reason. */
function whySummary(summary: SummaryPlaced[]): string[] {
  const lines: string[] = [];
  const outside = summary.filter((p) => p.outside !== "review_full").length;
  const full = summary.length - outside;
  if (summary.some((p) => p.outside === "host_refused")) {
    lines.push(
      "GitHub would not place this round's comments on their lines: the findings are in the summary comment.",
    );
  } else if (outside > 0) {
    lines.push(
      outside === 1
        ? "One finding is on a line outside the diff: it is in the summary comment."
        : `${outside} findings are on lines outside the diff: they are in the summary comment.`,
    );
  }
  if (full > 0) {
    lines.push(
      full === 1
        ? `One finding did not fit in the review's ${REVIEW_MAX_COMMENTS} comments: it is in the summary comment.`
        : `${full} findings did not fit in the review's ${REVIEW_MAX_COMMENTS} comments: they are in the summary comment.`,
    );
  }
  return lines;
}

export function renderReview(round: RoundToPost, placed: PlacedFinding[]): ReviewPost {
  const posting = new Set(round.reconciled.post.map((f) => f.id));
  const thisRound = placed.filter((p) => posting.has(p.finding.id));
  const inline = thisRound.flatMap((p) => (p.placement === "inline" ? [p] : []));
  const summary = thisRound.flatMap((p) => (p.placement === "summary" ? [p] : []));
  return {
    sha: round.sha,
    body: reviewBody(
      round,
      inline.map((p) => p.finding),
      summary,
    ),
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
 * What the reply says first, by what the round decided. A finding kept once against its author is escalated the
 * next time (ADR 0052): the reply says so, unless the owner already has it.
 */
function replyOpening(reply: ThreadReply, finding: Finding | undefined): { first?: string; last?: string } {
  switch (reply.kind) {
    case "kept":
      return finding?.status === "escalated"
        ? { first: "Kept. The owner decides." }
        : { first: "Kept.", last: "If it is kept again, the owner decides." };
    case "escalated":
      return { first: "The owner decides this one." };
    case "withdrawn":
      return { first: "Withdrawn." };
    case "answered":
      // The answer to a question is the reason itself.
      return {};
    case "dismissed":
      return { first: "Dismissed by the owner.", last: `It ${NOT_RAISED_AGAIN}.` };
  }
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
 * `COMMENT_MAX_BYTES`: only the reason is cut, so its opening and closing lines are always said.
 */
export function renderReply(
  round: RoundToPost,
  reply: ThreadReply,
  marker = replyMarker(round, reply.findingId),
): string {
  const finding = round.reconciled.findings.find((f) => f.id === reply.findingId);
  const { first, last } = replyOpening(reply, finding);
  const opening = first === undefined ? "" : `${first}\n\n`;
  const closing = last === undefined ? "" : `\n\n${last}`;
  const tail = `\n\n${marker}`;
  const room = COMMENT_MAX_BYTES - utf8Bytes(`${opening}${closing}${tail}`);
  const why = fitted(reply.why.trim(), room);
  // An empty reason leaves the opening and the closing, without the blank lines around it.
  return `${[first, why, last].filter((part) => part !== undefined && part !== "").join("\n\n")}${tail}`;
}

// The summary comment: where every posted finding stands, and the rounds so far (ADR 0023).

/** What the author's claim said (ADR 0052), after their login. */
const SAID: Record<ClaimKind, string> = {
  claimed_fixed: "said fixed",
  wont_fix: "said won't fix",
  disputed: "disputed it",
  deferred: "said deferred",
  question: "asked",
};

/** What this round answered on a finding still unsettled: the word before the finder's reason. */
const ANSWERED: Record<ReplyKind, string> = {
  kept: "Kept",
  answered: "Answered",
  escalated: "Escalated to the owner",
  withdrawn: "Withdrawn",
  dismissed: "Dismissed by the owner",
};

/** Who claimed what on the finding's thread: "dana said won't fix", the login plain (a mention notifies). */
const claimLine = (claim: FindingClaim) => `${claim.by} ${SAID[claim.kind]}`;

/**
 * The finding's claim and this round's answer to it, under its entry: "dana said won't fix. Kept: <why>"; nothing
 * when the round answered no claim on it.
 */
function answerLines(round: RoundToPost, f: Finding): string[] {
  const reply = round.reconciled.replies.find((r) => r.findingId === f.id);
  if (!reply || f.claim === null) return [];
  return [`${claimLine(f.claim)}. ${ANSWERED[reply.kind]}: ${postableLine(reply.why)}`];
}

function settledLine(f: Finding): string {
  switch (f.status) {
    case "verified_fixed":
      return `verified fixed${f.verifiedSha ? ` in ${shortSha(f.verifiedSha)}` : ""}`;
    case "withdrawn":
      return `withdrawn${f.closedWhy ? `: ${postableLine(f.closedWhy)}` : ""}`;
    case "acknowledged":
      // The author's call (ADR 0052): who said what; their words are on the thread.
      if (f.claim !== null) return `acknowledged: ${claimLine(f.claim)}`;
      return `acknowledged${f.closedWhy ? `: ${postableLine(f.closedWhy)}` : ""}`;
    case "dismissed":
      return `dismissed by the owner${f.closedWhy ? `: ${postableLine(f.closedWhy)}` : ""}`;
    case "obsolete":
      return "no longer in the code";
    case "open":
    case "escalated":
      return "";
  }
}

/** A heading and its list, as one block; nothing when the list is empty. */
function section(heading: string, items: string[]): string[] {
  return items.length > 0 ? [`**${heading}**\n${items.join("\n")}`] : [];
}

function roundsTable(round: RoundToPost): string {
  const rounds = [...round.rounds, { n: round.round, sha: round.sha }];
  const posted = round.reconciled.findings.filter((f) => f.posted);
  const rows = rounds.map((r) => {
    const raised = posted.filter((f) => f.raisedIn === r.n).length;
    const fixed = posted.filter((f) => f.status === "verified_fixed" && f.closedIn === r.n).length;
    return `| ${r.n} | ${shortSha(r.sha)} | ${raised} | ${fixed === 0 ? "–" : fixed} |`;
  });
  return ["| Round | Commit | Raised | Verified fixed |", "|---|---|---|---|", ...rows].join("\n");
}

/** A finding's line in a list: its id, severity, place and title, the title filtered as that line. */
function findingEntry(f: Finding): string {
  return `- ${f.id} · ${severityOf(f)} · ${at(f)} · ${postableLine(f.title)}`;
}

export function renderSummary(round: RoundToPost, placed: PlacedFinding[]): string {
  const posted = bySeverity(
    placed.filter((p) => p.finding.posted),
    (p) => p.finding.severity,
  );
  const open = posted.filter((p) => p.finding.status === "open");
  /** A finding's entry, with the claim this round answered under it. */
  const entry = (f: Finding) => [findingEntry(f), ...answerLines(round, f)].join("\n  ");
  const toFix = open.filter((p) => p.placement === "inline").map(({ finding: f }) => entry(f));
  // Every open finding with no comment of its own, whatever the reason, in one list by severity: a cut from the end
  // drops the least urgent (#67).
  const notOnALine = open.flatMap((p) =>
    p.placement === "summary"
      ? [
          [
            findingEntry(p.finding),
            postableLine(p.finding.body),
            ...ruleLine(p.finding),
            `No comment on the line: ${OUTSIDE[p.outside]}.`,
            ...answerLines(round, p.finding),
          ].join("\n  "),
        ]
      : [],
  );
  const needsOwner = posted.filter((p) => p.finding.status === "escalated").map(({ finding: f }) => entry(f));
  const done = posted
    .filter((p) => !isUnsettled(p.finding))
    .map(({ finding: f }) => `- ${f.id} · ${postableLine(f.title)} · ${settledLine(f)}`);
  const summary = [
    `**Lookover** · round ${round.round} · looked over ${shortSha(round.sha)}\n${byLine(round)}`,
    headline(round),
    ...confirmLine(round),
    ...keptLine(round),
    ...section("Needs the owner", needsOwner),
    ...section("To fix", toFix),
    ...section("Not on a line", notOnALine),
    ...section("Done", done),
    roundsTable(round),
  ].join("\n\n");
  // Cut from the end (#67): what is least urgent, the history first, goes when it doesn't fit.
  const head = `${SUMMARY_MARKER}\n\n`;
  return `${head}${fitted(summary, COMMENT_MAX_BYTES - utf8Bytes(head))}`;
}

// The check: in progress while the round posts, then completed with the result (ADR 0006, ADR 0039).

export function checkInProgress(round: RoundToPost): CheckOutput {
  return {
    title: `Looking over ${shortSha(round.sha)}`,
    summary: `Round ${round.round} is being posted.`,
    text: "The review, the summary comment and the result follow when the round is posted.",
  };
}

/** The check's summary lists at most this many findings: it has a byte limit too, and the summary comment has them all. */
const CHECK_SUMMARY_LIST = 20;

function checkSummary(round: RoundToPost): string {
  const counted = bySeverity(round.reconciled.findings.filter(isCounted), (f) => f.severity);
  const shown = counted.slice(0, CHECK_SUMMARY_LIST);
  const list = shown.map(findingEntry);
  const more = counted.length - shown.length;
  if (more > 0) list.push(`- and ${more} more, in the summary comment`);
  // Its titles are the engine's words, of any length: cut at a line to fit too (#67).
  return fitted(
    [headline(round), ...confirmLine(round), ...keptLine(round), ...list].join("\n"),
    CHECK_OUTPUT_MAX_BYTES,
  );
}

/** The check's text for a result: a line for people, then the result's line, last. */
export function checkText(result: ReviewResult, left: number): string {
  const lines = [
    "The review and the summary comment are on the pull request. The last line of this text is the `lookover.review-result/v1` result, for coding agents.",
  ];
  if (result.truncated) {
    lines.push(
      `${plural(left, "finding")} did not fit the result and ${left === 1 ? "is" : "are"} left out of it; every posted finding is in the summary comment, and the app has them all.`,
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

/** What makes a missing engine usable: installed, or, its program found but not usable, what fixes that. */
function missingFixed(engine: EngineId, unusable: EngineUnusable | null): string {
  return unusable === null
    ? `${engineName(engine)} is installed`
    : unusableFixedText(unusable, engine, "the owner");
}

/** When a deferred job starts, after the app's words for why it waits; an engine's limit, at its reset if known. */
function startsWhen(deferral: Deferral, reset: Reset | null): string {
  switch (deferral.reason) {
    case "paused":
      return "once the owner resumes reviews";
    case "connection":
      return "once GitHub is back";
    case "engine-signed-out":
      return `by itself once the owner signs ${engineName(deferral.engine)} in`;
    case "engine-missing":
      return `by itself once ${missingFixed(deferral.engine, deferral.unusable)}`;
    case "engine-limit":
      return reset === null ? "once the limit resets" : `once the limit resets, on ${resetText(reset)}`;
    case "engine-failed-self-test":
      return `by itself once a version of ${engineName(deferral.engine)} passes it`;
  }
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
