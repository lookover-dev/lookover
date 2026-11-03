// The status block in the pull request's description (ADR 0074), in the owner's prototype's words: a heading with the
// wordmark and where the review stands, one line under it (the round, the commit, what was fixed or withdrawn; why it
// waits or failed), then the open findings, each linking to its thread, one with no line comment showing its lines
// through a permalink GitHub embeds. Cut to the room the description leaves: list items from the end (the least
// urgent), then the permalinks; nothing when even the heading and its line don't fit.
import {
  bySeverity,
  type ChangeRef,
  type CommitSha,
  characterCount,
  dayText,
  escalationText,
  type Finding,
  failedHead,
  findingPermalink,
  lookingOverHead,
  NEEDS_YOUR_LOOK,
  notInDiffText,
  roundLine,
  shortSha,
  stoppedText,
  TRY_AGAIN,
  thingsText,
  twoDigits,
  waitingHead,
  waitingText,
  wordmark,
} from "@lookover/contracts";
import { postableLine } from "./filter.ts";
import { findingAt, severityOf } from "./render.ts";
import type { Status, StatusRound } from "./types.ts";

/** The pull request's page on GitHub. */
const pullOf = (change: ChangeRef) =>
  `https://github.com/${change.repo.owner}/${change.repo.name}/pull/${change.number}`;

/** A commit, as a link to it inside the pull request. */
const commitLink = (change: ChangeRef, sha: CommitSha) =>
  `[\`${shortSha(sha)}\`](${pullOf(change)}/commits/${sha})`;

/** "14:20" today; "on Wed 4 Nov at 14:20" another day: in the machine's time. */
function resetsAt(until: number, now: number, offset: (at: number) => number): string {
  const at = new Date(until + offset(until) * 60_000);
  const today = new Date(now + offset(now) * 60_000);
  const time = `${twoDigits(at.getUTCHours())}:${twoDigits(at.getUTCMinutes())}`;
  return dayText(at) === dayText(today) && at.getUTCFullYear() === today.getUTCFullYear()
    ? `at ${time}`
    : `on ${dayText(at)} at ${time}`;
}

/** Text a link shows: its brackets escaped, so it can't close the link. */
const linkText = (text: string) => text.replace(/[[\]]/g, "\\$&");

/** One open finding as a list item: its severity, its title (a link to its thread), where; its own line if any. */
function item(change: ChangeRef, posted: StatusRound, f: Finding, permalinks: boolean): string {
  const url = posted.threads.find((t) => t.findingId === f.id)?.url;
  const title = postableLine(f.title);
  const head = `- **${severityOf(f)}** · ${url === undefined ? title : `[${linkText(title)}](${url})`} · ${findingAt(f)}`;
  if (f.status === "escalated") return `${head}\n  ${escalationText(f.claim?.kind ?? null)}`;
  if (f.commented) return head;
  const note = `${head}\n  ${notInDiffText(postableLine(f.body))}`;
  const link = permalinks ? findingPermalink(change.repo, f, posted) : null;
  return link === null ? note : `${note}\n\n  ${link.url}`;
}

/** What is open on the pull request: escalated first, then by severity, then in the ledger's order (their ids). */
function openOf(posted: StatusRound): Finding[] {
  const open = posted.findings.filter((f) => f.posted && (f.status === "open" || f.status === "escalated"));
  const sorted = (status: Finding["status"]) =>
    bySeverity(
      open.filter((f) => f.status === status),
      (f) => f.severity,
    );
  return [...sorted("escalated"), ...sorted("open")];
}

/** "Round 3 · <commit> · 3 fixed, 1 withdrawn": withdrawn by the finder or dismissed by the owner. */
const roundLineOf = (change: ChangeRef, posted: StatusRound) =>
  roundLine(posted.n, commitLink(change, posted.sha), posted.findings).join("");

/** The block's heading, its line, and the round whose open findings it lists. */
function partsOf(
  change: ChangeRef,
  status: Status,
  offset: (at: number) => number,
): { head: string; line: string; posted: StatusRound | null } {
  /** The line of a job waiting or failed: its round's number past the first. */
  const ofRound = (round: number, text: string) => (round > 1 ? `Round ${round} · ${text}` : text);
  switch (status.kind) {
    case "running":
      return {
        head: lookingOverHead(commitLink(change, status.sha), status.again).join(""),
        line: `Round ${status.round}`,
        posted: null,
      };
    case "posted": {
      const { posted } = status;
      const open = openOf(posted).length;
      return {
        head: posted.loop === "needs_owner" ? NEEDS_YOUR_LOOK : thingsText(open),
        line: roundLineOf(change, posted),
        posted,
      };
    }
    case "waiting":
      return {
        head: waitingHead(commitLink(change, status.sha)).join(""),
        line: ofRound(
          status.round,
          waitingText(
            status.deferral,
            status.until === null ? null : resetsAt(status.until, status.now, offset),
          ),
        ),
        posted: status.posted,
      };
    case "failed":
      return {
        head: failedHead(commitLink(change, status.sha)).join(""),
        line: ofRound(status.round, `${stoppedText(status.failure, status.engine)} ${TRY_AGAIN}`),
        posted: status.posted,
      };
  }
}

/**
 * The status block for `status`, within `room` characters: every open finding with its permalinks when it fits;
 * else list items dropped from the end, then the permalinks too; null when the heading and its line alone are over.
 */
export function statusBlock(
  change: ChangeRef,
  status: Status,
  room: number,
  offset: (at: number) => number,
): string | null {
  const { head, line, posted } = partsOf(change, status, offset);
  const open = posted === null ? [] : openOf(posted);
  const shown = (count: number, permalinks: boolean): string => {
    const items = posted === null ? [] : open.slice(0, count).map((f) => item(change, posted, f, permalinks));
    return [`### ${wordmark(26)} · ${head}`, line, ...(items.length > 0 ? [items.join("\n")] : [])].join(
      "\n\n",
    );
  };
  // Items from the end with their permalinks, down to one; then the same without them; then the heading and its line.
  const tries = [true, false].flatMap((permalinks) =>
    Array.from({ length: open.length }, (_, i) => () => shown(open.length - i, permalinks)),
  );
  for (const attempt of [...tries, () => shown(0, false)]) {
    const block = attempt();
    if (characterCount(block) <= room) return block;
  }
  return null;
}
