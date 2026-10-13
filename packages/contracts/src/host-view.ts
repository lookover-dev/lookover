// What a Git host shows of one change now: its `Lookover` checks, the reviews with their inline comments, and
// the conversation's comments, each oldest first. One shape for every host adapter: `github`'s `view` reads it
// from GitHub's API, `testkit`'s `FakeGitHost.view` from memory, so the `HostWriter` suite and the live run
// read back the same thing from both. Polling will read it too.

import type {
  CheckConclusion,
  CheckOutput,
  InlineComment,
  MinimizeReason,
  OpenCheckStatus,
  Reaction,
} from "./host-writer.ts";
import type { CommitSha } from "./ids.ts";

export interface HostCheck {
  id: string;
  name: string;
  sha: CommitSha;
  status: OpenCheckStatus | "completed";
  /**
   * What the writer concluded it with, or `other` with the host's word when the host concluded it with one of
   * its own, which Lookover never posts (a person cancelled it, it went stale). Null while it runs.
   */
  conclusion: CheckConclusion | { other: string } | null;
  output: CheckOutput;
}

/**
 * An inline comment as the host shows it now. After a push the host re-anchors it: `line` (and `endLine`, the
 * last line of a range) moves with the text it was on, and both are null once that text is gone (GitHub calls
 * it outdated); `originalLine` stays where it was posted (a range's first line).
 */
export interface HostInlineComment extends Omit<InlineComment, "line"> {
  /** The host's id for the comment: a `HostThread`'s root comment id, written as a string. */
  id: string;
  line: number | null;
  originalLine: number;
  /** Why it is hidden; null when it isn't. */
  minimized: Minimized;
}

/**
 * Why a comment is hidden (ADR 0052): one of Lookover's reasons, or `other` with the host's word for a reason
 * Lookover never gives (a person hid it as spam, say); null when it isn't hidden.
 */
export type Minimized = MinimizeReason | { other: string } | null;

export interface HostReview {
  id: string;
  sha: CommitSha;
  body: string;
  comments: HostInlineComment[];
}

export interface HostComment {
  id: string;
  author: { id: number; login: string };
  body: string;
  /** How many accounts put each of Lookover's reactions on it, the bot among them. */
  reactions: Record<Reaction, number>;
}

/** A conversation comment as the view shows it: with why it is hidden, which the agent's reader doesn't ask. */
export interface HostViewComment extends HostComment {
  /** Why it is hidden; null when it isn't. */
  minimized: Minimized;
}

/** The change's checks on one commit, its reviews and its comments, oldest first. */
export interface HostView {
  checks: HostCheck[];
  reviews: HostReview[];
  comments: HostViewComment[];
}
