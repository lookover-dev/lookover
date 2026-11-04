// Port: writing to the Git host (ADR 0006, ADR 0023, ADR 0033, ADR 0039, ADR 0043). The `github` package posts
// as who posts (ADR 0066, ADR 0073): the person signed in to the shared App, the check always under the App;
// `testkit`'s `FakeGitHost` records. "The bot" below is who posts. Shaped by the check following a review job
// and by what one round posts. The check is created when the job is recorded (`queued`, or `in_progress`), updated
// as the job changes (its status and text), and completed: by the round, after one review holding every inline
// comment (only when it has one, ADR 0074) and the status block in the description; or without a round. The bot's
// own comments are told by its numeric user id, never by its login. Apart from a round, it reacts to a review
// request (ADR 0043): 👀 when the request is recorded, 🚀 when its round is posted. Each post can be sent again
// safely (ADR 0044): the check carries its external id (`checkExternalId`: the job's id, the pull request's number and the person's, found with
// `findCheck` before a re-send), and the review its round's `REVIEW_MARKER` (found with `findReview` before a
// re-send). The status block (ADR 0074) is the description's part between `STATUS_MARKER` and `STATUS_END_MARKER`,
// rewritten whole each time (`upsertStatus`), the author's text around it kept. On its threads (ADR 0052) it
// replies, one reply per conversation, and it minimizes the comments a round settled, since it can't resolve a
// thread. Every body is budgeted in bytes: the limits are in `host.ts`.
import type { DiffLocation } from "./diff.ts";
import type { ChangeRef, RepositoryRef } from "./host.ts";
import type { CommitSha } from "./ids.ts";

/** How a round concludes its check (ADR 0006): `success` with no open blocking finding, `neutral` otherwise. */
export type RoundConclusion = "success" | "neutral";

/**
 * How a completed check concludes: a round's conclusion; `neutral` too for a review that failed; `skipped` for a
 * job that ended without a round for a reason that is no failure (a newer commit, the change closed, not the
 * owner's, ADR 0043). Never `failure`: Lookover never blocks a merge (ADR 0006).
 */
export type CheckConclusion = RoundConclusion | "skipped";

/** Where a check not yet completed stands: `queued` while its job waits, `in_progress` while it runs. */
export type OpenCheckStatus = "queued" | "in_progress";

/** The reactions Lookover puts on a review request (ADR 0043): `eyes` (👀) recorded, `rocket` (🚀) posted. */
export type Reaction = "eyes" | "rocket";

/**
 * Why Lookover hides a comment (ADR 0052): `resolved`, its visual "done", since the App can't resolve a thread (a
 * handled request, the root comment of a finding withdrawn or dismissed); `outdated`, superseded.
 */
export type MinimizeReason = "resolved" | "outdated";

/**
 * What the check shows. A completed check's `text` ends with the hidden `lookover.review-result/v1` block;
 * `summary` and `text` are budgeted in bytes.
 */
export interface CheckOutput {
  title: string;
  summary: string;
  text: string;
}

/** A comment on a line (`line`), or on a range of lines (`line` to `endLine`) of one side, in one hunk. */
export interface InlineComment extends DiffLocation {
  /** The range's last line, on the same side; null for a comment on one line. */
  endLine: number | null;
  /** Markdown, `COMMENT_MAX_BYTES` at most. */
  body: string;
}

/** One round's review: its top comment and every inline comment, posted together (ADR 0023). */
export interface ReviewPost {
  /** The commit the comments' lines refer to: the change's head when the round ran. */
  sha: CommitSha;
  /** Markdown, `COMMENT_MAX_BYTES` at most, holding the round's `REVIEW_MARKER` line. */
  body: string;
  /** `REVIEW_MAX_COMMENTS` at most: the rest go to the status block. */
  comments: InlineComment[];
}

export interface HostWriter {
  /**
   * Creates the `Lookover` check on the commit, `queued` or `in_progress`, with its output, and `externalId` (the
   * job's id, the pull request's number and the person's id, `checkExternalId`), which the host keeps with it (GitHub's `external_id`). Returns
   * the host's id for it, to update and complete it with. Throws `HostError("too_large")` as `completeCheck` does.
   */
  createCheck(
    repo: RepositoryRef,
    sha: CommitSha,
    status: OpenCheckStatus,
    output: CheckOutput,
    externalId: string,
  ): Promise<string>;
  /**
   * The host's id for the App's `Lookover` check on the commit created with `externalId`, the newest
   * when there are several; null when there is none. How a check created on an answer that was lost is found
   * before it is created again (ADR 0044).
   */
  findCheck(repo: RepositoryRef, sha: CommitSha, externalId: string): Promise<string | null>;
  /**
   * Sets a check not yet completed to `status`, with its new output. Throws as `completeCheck` does. Updating a
   * completed check is the caller's mistake: what the host does then is its own.
   */
  updateCheck(
    repo: RepositoryRef,
    checkId: string,
    status: OpenCheckStatus,
    output: CheckOutput,
  ): Promise<void>;
  /**
   * Completes the check with its conclusion and final output. A check completed already is completed again with
   * the new ones (the owner's dismissal rewrites the latest round's check, ADR 0052). Throws
   * `HostError("too_large")` when `summary` or `text` is over `CHECK_OUTPUT_MAX_BYTES`, and posts nothing then;
   * `HostError("not_found")` for a check id the host doesn't have.
   */
  completeCheck(
    repo: RepositoryRef,
    checkId: string,
    conclusion: CheckConclusion,
    output: CheckOutput,
  ): Promise<void>;
  /**
   * Posts the review with all its comments at once. One comment on a line outside the diff fails the whole
   * call with `HostError("unplaceable_comment")`, and nothing of the review is posted (ADR 0022); a body or a
   * comment over `COMMENT_MAX_BYTES` is `HostError("too_large")`. Returns the host's id for the review. The host
   * keeps no memory of a post, and may save a review it answers with an error: a round's review is posted once
   * because the caller asks `findReview` for its marker before sending it again.
   */
  publishReview(change: ChangeRef, review: ReviewPost): Promise<string>;
  /**
   * The host's id for the bot's review on the change whose body holds `marker` (a round's `REVIEW_MARKER` line),
   * looking through every review of the change, past the host's first page; null when there is none. A review
   * someone else wrote holding the marker is not the bot's. Throws `HostError("not_found")` for a change that
   * isn't one.
   */
  findReview(change: ChangeRef, marker: string): Promise<string | null>;
  /**
   * Writes Lookover's status block into the change's description (ADR 0074), between `STATUS_MARKER` and
   * `STATUS_END_MARKER`, as `spliceStatus` places it: the author's text kept byte for byte, the block replacing the
   * one there or written at the end. The host reads the description fresh right before the write (never a cached
   * read); when it doesn't show the last block this writer sent (`showsStatus`: the host's reads lag its writes, ADR
   * 0069), it reads again, for up to 30 s, then writes on the last read. `render` is given the characters the block
   * may take (`statusRoom`: `DESCRIPTION_MAX_CHARACTERS` less the rest, below zero when the author's text alone
   * is past it) and gives the block, or null to write nothing. Idempotent: nothing to keep, the change names the
   * block; a description already holding the spliced text is not written again. A refusal is a standing one, never a
   * sign-out: `HostError("too_large")` for a block past its room (nothing sent) or the host's own "too long";
   * `HostError("invalid")` when the person may not edit this description; `HostError("not_found")` for a change the
   * host doesn't have.
   */
  upsertStatus(change: ChangeRef, render: (room: number) => string | null): Promise<void>;
  /**
   * Puts the bot's `reaction` on a conversation comment of the repository. Idempotent, as GitHub answers a
   * repeat with `200`: a reaction the bot already put there stays one. Throws `HostError("not_found")` for a
   * comment the repository doesn't have.
   */
  react(repo: RepositoryRef, commentId: string, reaction: Reaction): Promise<void>;
  /**
   * Replies, as the bot, in the review thread whose root inline comment is `commentId` (a `HostThread`'s), and
   * returns the host's id for the reply. A reply's id names its thread too: the reply lands under the thread's
   * root, after the others, as GitHub files it. The host keeps no memory of a post: a reply that may be on the host
   * already is found by its marker in `HostIntake.threads` before it is sent again. GitHub files each reply as a
   * review of its own with an empty body, which `findReview` never takes for a round's. A body over
   * `COMMENT_MAX_BYTES` is `HostError("too_large")`, and nothing is posted; `HostError("not_found")` for a change,
   * or a root comment on it, the host doesn't have.
   */
  reply(change: ChangeRef, commentId: number, body: string): Promise<string>;
  /**
   * Hides a comment of the repository (an inline comment or a conversation comment, its own or anyone's), by the
   * host's global id for it (`HostThread.nodeId`, `HostConversationComment.nodeId`), for `reason`. Minimizing one
   * hidden already hides it again, for the new reason. Throws `HostError("not_found")` for an id the host doesn't
   * have.
   */
  minimize(repo: RepositoryRef, nodeId: string, reason: MinimizeReason): Promise<void>;
}
