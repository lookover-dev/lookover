// The `lookover.review-result/v1` result (ADR 0032, ADR 0039): built from the round and written as the last
// line of the check's text, opened by contracts' `RESULT_MARKER` (contracts' `readResult` reads it back).
// The verdict, the next action, who must act on each finding and the counts are `core`'s, written as given.
// Findings go in whole, in the order a coding agent needs them (what is open on the pull request first), and
// only as many as fit the byte budget: `truncated` says when some were left out. Nothing is ever cut mid-way, but
// the author's words (a claim's text, the reply that acknowledged a finding), each cut to `AUTHOR_MAX_BYTES`.
import type {
  ActionBy,
  CommitSha,
  Finding,
  FindingCounts,
  FindingId,
  HostThread,
  ReplyKind,
  ReviewResult,
  ReviewResultFinding,
  Trigger,
} from "@lookover/contracts";
import {
  bySeverity,
  isCounted,
  isUnsettled,
  newestThread,
  RESULT_MARKER,
  REVIEW_RESULT_SCHEMA,
} from "@lookover/contracts";
import { clip } from "./fit.ts";
import type { PlacedFinding } from "./place.ts";
import type { Ended, JobCheck, RoundToPost, SkipWhy } from "./types.ts";

/** Contracts' `Trigger`, in the result's snake_case. */
const TRIGGER: Record<Trigger, ReviewResult["run"]["trigger"]> = {
  opened: "opened",
  push: "push",
  comment: "comment",
  manual: "manual",
  "first-review": "first_review",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Where the finding is, as `review` anchored it: its side and its whole range, on the commit those lines are on
 * (the round it was raised in, or the later one that moved it, ADR 0044).
 */
function locationOf(finding: Finding, anchoredOn: CommitSha): ReviewResultFinding["location"] {
  return {
    path: finding.file,
    start_line: finding.line,
    end_line: finding.endLine ?? finding.line,
    side: finding.side,
    sha: anchoredOn,
  };
}

/**
 * Where an inline finding's comment went this round: the lines it covers (one line of a range the host
 * refused, say), with the path the host wants. Null for a finding that went on no line.
 */
function placedOf(placed: PlacedFinding): ReviewResultFinding["placed"] {
  if (placed.placement !== "inline") return null;
  const { path, side, line, endLine } = placed.at;
  return { path, start_line: line, end_line: endLine ?? line, side };
}

/**
 * The finding's thread as the read when the check completed found it (ADR 0052): its root comment's id and URL, and
 * whether a person resolved it when the read can tell; null when it has none (no comment on a line). Absent when no
 * read was made, or the host refused it.
 */
function threadOf(finding: Finding, threads: HostThread[] | null): Pick<ReviewResultFinding, "thread"> {
  if (threads === null) return {};
  const thread = newestThread(threads, finding.id);
  if (!thread) return { thread: null };
  return {
    thread: {
      ...(thread.threadId === undefined ? {} : { id: thread.threadId }),
      comment_id: thread.commentId,
      url: thread.url,
      ...(thread.resolved === undefined ? {} : { resolved: thread.resolved }),
    },
  };
}

/** A time as the host gave it, in the format's UTC form; as given when it can't be read as one. */
function utc(at: string): string {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? at : iso(ms);
}

/**
 * The most of the author's words a finding carries into the result, in UTF-8 bytes, as the finder's prompt quotes
 * them (ADR 0052): a reply as long as the author likes never crowds the findings out of the check's budget.
 */
const AUTHOR_MAX_BYTES = 2048;

/** The author's newest claim the finding holds, with how many times a round kept it against one; none without. */
function claimOf(finding: Finding): Pick<ReviewResultFinding, "claim"> {
  const { claim } = finding;
  if (claim === null) return {};
  return {
    claim: {
      kind: claim.kind,
      text: clip(claim.text, AUTHOR_MAX_BYTES),
      by: claim.by,
      at: utc(claim.at),
      count: finding.kept,
    },
  };
}

/**
 * What this round's reply on a finding still unsettled says as its resolution (ADR 0052): kept against the claim (a
 * question answered is kept too), or escalated to the owner. A withdrawn or dismissed finding is settled: its status
 * says it.
 */
const REPLY_RESOLUTION: Record<ReplyKind, "kept" | "escalated" | null> = {
  kept: "kept",
  answered: "kept",
  escalated: "escalated",
  withdrawn: null,
  dismissed: null,
};

function resultFinding(
  round: RoundToPost,
  placed: ActedOn,
  on: { raised: CommitSha; anchored: CommitSha },
  threads: HostThread[] | null,
): ReviewResultFinding {
  const { finding } = placed;
  const checkedThisRound = isUnsettled(finding) || finding.closedIn === round.round;
  return {
    id: finding.id,
    fingerprints: finding.fingerprints,
    status: finding.status,
    posted: finding.posted,
    placement: placed.placement,
    needs_action_by: placed.by,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    location: locationOf(finding, on.anchored),
    placed: placedOf(placed),
    rule: finding.rule ? { id: finding.rule.id, source: finding.rule.file, line: finding.rule.line } : null,
    raised: { round: finding.raisedIn, sha: on.raised },
    ...(checkedThisRound ? { last_checked: { round: round.round, sha: round.sha } } : {}),
    ...threadOf(finding, threads),
    ...claimOf(finding),
    resolution: resolutionOf(finding, round),
    confirmation: finding.confirmation,
  };
}

/** Why a settled finding was settled; for one still unsettled, what this round answered on its thread, if anything. */
function resolutionOf(finding: Finding, round: RoundToPost): ReviewResultFinding["resolution"] {
  const { status, closedIn, closedWhy } = finding;
  if (status === "open" || status === "escalated" || closedIn === null) {
    const reply = round.reconciled.replies.find((r) => r.findingId === finding.id);
    const kind = reply ? REPLY_RESOLUTION[reply.kind] : null;
    if (!reply || kind === null) return null;
    return { kind, round: round.round, explanation: reply.why };
  }
  // An acknowledged finding's why is the author's reply.
  const why = status === "acknowledged" && closedWhy ? clip(closedWhy, AUTHOR_MAX_BYTES) : closedWhy;
  return { kind: status, round: closedIn, ...(why ? { explanation: why } : {}) };
}

/** A placed finding with who must act on it, as `core` said. */
export type ActedOn = PlacedFinding & { by: ActionBy };

/**
 * Each placed finding with its entry in `core`'s `actionBy`, paired before anything is posted: a finding without
 * one is a programming error (`core` gives every finding one), never "nobody" decided here.
 */
export function withActors(
  placed: PlacedFinding[],
  actionBy: RoundToPost["reconciled"]["actionBy"],
): ActedOn[] {
  const actors = new Map<FindingId, ActionBy>(actionBy.map((a) => [a.id, a.by]));
  return placed.map((p) => {
    const by = actors.get(p.finding.id);
    if (by === undefined)
      throw new Error(`${p.finding.id} has no entry in actionBy: core gives every finding one`);
    return { ...p, by };
  });
}

/**
 * `core`'s counts, field by field in the format's order. The format's counts have one key per severity and per
 * status (`reviewResultV1` ties them), so a new one fails to compile here until it is written; then how many
 * findings are kept in the app.
 */
function resultCounts(c: FindingCounts, kept: number): ReviewResult["counts"] {
  return {
    open: { blocking: c.open.blocking, should_fix: c.open.should_fix, consider: c.open.consider },
    escalated: c.escalated,
    verified_fixed: c.verified_fixed,
    withdrawn: c.withdrawn,
    acknowledged: c.acknowledged,
    dismissed: c.dismissed,
    obsolete: c.obsolete,
    kept_in_app: kept,
  };
}

/** A coding agent reads what is open on the pull request first, blocking first; the rest follows. */
function byUrgency(placed: ActedOn[]): ActedOn[] {
  const rank = (f: Finding) => (isCounted(f) ? 0 : isUnsettled(f) ? 1 : 2);
  return bySeverity(placed, (p) => p.finding.severity).sort((a, b) => rank(a.finding) - rank(b.finding));
}

export interface BuiltResult {
  result: ReviewResult;
  /** The findings the result holds, by id: the others did not fit. */
  included: Set<string>;
}

/**
 * The result with every finding, or, when `fits` refuses it, with the first findings that fit (whole, in
 * urgency order) and `truncated` true. The counts and the verdict never depend on which findings fit.
 */
export function buildResult(
  round: RoundToPost,
  placed: ActedOn[],
  headline: string,
  fits: (result: ReviewResult) => boolean,
  threads: HostThread[] | null = null,
): BuiltResult {
  const { change, reconciled } = round;
  const shaOf = new Map(round.rounds.map((r) => [r.n, r.sha]));
  // This round is not in `rounds` yet: its own commit is `round.sha`.
  const sha = (n: number) => shaOf.get(n) ?? round.sha;
  const all = byUrgency(placed).map((p) =>
    resultFinding(
      round,
      p,
      { raised: sha(p.finding.raisedIn), anchored: sha(p.finding.anchoredIn) },
      threads,
    ),
  );
  const base: ReviewResult = {
    schema: REVIEW_RESULT_SCHEMA,
    change: {
      host: change.host,
      repository: `${change.repo.owner}/${change.repo.name}`,
      number: change.number,
      url: change.url,
      head_sha: round.sha,
      ...(round.base ? { base_sha: round.base } : {}),
    },
    run: {
      id: round.run.id,
      state: "done",
      trigger: TRIGGER[round.run.trigger],
      engine: { finder: round.run.engine, confirmer: round.run.confirmer },
      ruled_out: round.run.ruledOut,
      started_at: iso(round.run.startedAt),
      completed_at: iso(round.run.completedAt),
    },
    verdict: { value: reconciled.verdict, conclusion: reconciled.conclusion, headline },
    loop: { state: reconciled.loop, round: round.round, next_action: reconciled.nextAction },
    counts: resultCounts(reconciled.counts, reconciled.keptInApp),
    findings: all,
    truncated: false,
  };
  let keep = all.length;
  let result = base;
  while (!fits(result) && keep > 0) {
    keep -= 1;
    result = { ...base, findings: all.slice(0, keep), truncated: true };
  }
  return { result, included: new Set(result.findings.map((f) => f.id)) };
}

/** Why a job ended without a round, as the result's `run.state_reason`: a machine code, in snake_case. */
const REASON: Record<SkipWhy, string> = {
  "newer-commit": "newer_commit",
  preview: "preview",
  replaced: "replaced",
  pushed: "pushed",
  closed: "closed",
  "not-yours": "not_yours",
  draft: "draft",
  "repo-off": "repo_off",
  "on-open-off": "on_open_off",
  "codex-not-yours": "codex_not_yours",
  fork: "fork",
};

/**
 * What a coding agent does next when no round came: wait for the review that took this one's place, ask a
 * person when the review failed, else stop.
 */
const NEXT: Record<SkipWhy, ReviewResult["loop"]["next_action"]> = {
  "newer-commit": "wait",
  preview: "stop",
  replaced: "wait",
  pushed: "stop",
  closed: "stop",
  "not-yours": "stop",
  draft: "stop",
  "repo-off": "stop",
  "on-open-off": "stop",
  "codex-not-yours": "stop",
  fork: "stop",
};

/**
 * The result of a job that ended without a round on `job.sha`: the run's state and its reason, no verdict, no
 * findings and every count at zero (the check shows none). The run is the job's, named by its id, until one ran.
 */
export function endedResult(job: JobCheck, ended: Ended, headline: string): ReviewResult {
  const failed = ended.kind === "failed";
  return {
    schema: REVIEW_RESULT_SCHEMA,
    change: {
      host: job.change.host,
      repository: `${job.change.repo.owner}/${job.change.repo.name}`,
      number: job.change.number,
      head_sha: job.sha,
    },
    run: {
      id: job.run?.id ?? job.job.id,
      state: failed ? "failed" : "skipped",
      state_reason: failed ? ended.failure : REASON[ended.why],
      trigger: TRIGGER[job.job.trigger],
      // No round: nothing was confirmed, nothing ruled out.
      ...(job.run
        ? { engine: { finder: job.run.engine, confirmer: null }, started_at: iso(job.run.startedAt) }
        : {}),
      ruled_out: 0,
      completed_at: iso(job.at),
    },
    verdict: { value: "none", conclusion: failed ? "neutral" : "skipped", headline: `${headline}.` },
    loop: { state: job.loop, round: job.rounds, next_action: failed ? "ask_human" : NEXT[ended.why] },
    counts: resultCounts(
      {
        open: { blocking: 0, should_fix: 0, consider: 0 },
        escalated: 0,
        verified_fixed: 0,
        withdrawn: 0,
        acknowledged: 0,
        dismissed: 0,
        obsolete: 0,
      },
      0,
    ),
    findings: [],
    truncated: false,
  };
}

/** The result's line in the check's text. `>` is escaped inside the JSON so no body can close the marker. */
export function resultLine(result: ReviewResult): string {
  return `${RESULT_MARKER}${JSON.stringify(result).replaceAll(">", "\\u003e")} -->`;
}
