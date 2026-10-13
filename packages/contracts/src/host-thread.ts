// A review thread on a change as a host shows it (ADR 0052): the root inline comment and its replies, oldest
// first. One shape for both readers: the App's REST read (`in_reply_to_id`), which knows no thread node nor
// whether a person resolved it, and the coding agent's GraphQL read, which knows both. Lookover keeps the threads
// whose root comment is its own and holds a finding marker: `findingId` says which finding, found by that marker
// and never by the line, so a thread that went outdated after a push is still read.
import type { FindingId } from "./ids.ts";

export interface HostThreadReply {
  commentId: number;
  /** The host's global id of the reply (GitHub's `node_id`), which minimizing takes; both readers give it. */
  nodeId: string;
  author: { id: number; login: string; bot: boolean };
  body: string;
  /** When it was written, as the host gave it (ISO 8601). */
  at: string;
}

export interface HostThread {
  /** The root inline comment's id and its URL. */
  commentId: number;
  url: string;
  /**
   * The host's global id of the root comment (GitHub's `node_id`): what minimizing it takes, once its finding is
   * withdrawn or dismissed (ADR 0052). Both readers give it.
   */
  nodeId: string;
  /** The finding the root comment's marker names. */
  findingId: FindingId;
  /** The text the root comment was on is gone from the change's head. */
  outdated: boolean;
  /** GraphQL's node id of the thread, which resolving takes; absent from the REST read. */
  threadId?: string;
  /** Whether a person resolved it; absent from the REST read, which can't tell. */
  resolved?: boolean;
  /** The replies after the root comment, oldest first. */
  replies: HostThreadReply[];
}

/**
 * A finding's thread among a change's: the newest whose marker names it (a finding posted again after a review that
 * never landed has two, and goes on the newest); undefined when none does.
 */
export const newestThread = <T extends Pick<HostThread, "findingId" | "commentId">>(
  threads: readonly T[],
  finding: string,
): T | undefined =>
  threads
    .filter((t) => t.findingId === finding)
    .reduce<T | undefined>(
      (newest, t) => (newest !== undefined && newest.commentId > t.commentId ? newest : t),
      undefined,
    );
