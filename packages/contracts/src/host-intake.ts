// Port: reading the Git host (ADR 0033, ADR 0039, ADR 0043). The `github` package is the real one; `testkit`'s
// `FakeGitHost` the in-memory one. Shaped by what the service calls: the open changes of a repository, one change
// as it is now, what `retrieval` needs to fetch its commits, and what polling reads (the repository's
// conversation comments since a point, and how many commits a push brought), and Lookover's review threads on a
// change, which a round reads before its finder runs (ADR 0052). Intake reports what the host shows;
// the service and `core` decide what it means (ADR 0043).
// A listing says `unchanged` when the host says it lists the same as at this adapter's last read of it (GitHub's
// `304` to a request sent with the last answer's ETag, which costs no rate limit); its items are still given, as
// that read gave them. The first read of a listing by an adapter is never `unchanged`. `unchanged` is a hint
// only, about the adapter's last read whoever asked: a caller decides from `items` against what it stored itself.
// With two callers on one adapter, one may read the change and the other see `unchanged` after it, so a caller
// that skips its work on `unchanged` misses what the other read.
import type { ChangeRef, GitHost, RepositoryRef } from "./host.ts";
import type { HostThread } from "./host-thread.ts";
import type { CommitSha } from "./ids.ts";

/** A change as the host shows it now. Code says change; people read "pull request" (ADR 0030). */
export interface HostChange {
  /** The host it is on, as the adapter that read it knows. */
  host: GitHost;
  number: number;
  title: string;
  url: string;
  /** The host's numeric user id is the identity; the login is for people (ADR 0006). */
  author: { login: string; id: number };
  draft: boolean;
  /**
   * Its head repository isn't its base's, or is gone (a deleted fork): the adapter decides it from the host's
   * repository identities, never names (ADR 0048).
   */
  fork: boolean;
  head: { ref: string; sha: CommitSha };
  base: { ref: string; sha: CommitSha };
}

/**
 * What a listing read: every item, past any page size the host has, and whether the host said the listing is as
 * it was at this adapter's last read of it (the items are then what that read gave, for this call's question).
 * Decide from `items`; `unchanged` is a hint that saves nothing but the work of comparing them.
 */
export interface Listing<T> {
  unchanged: boolean;
  items: T[];
  /**
   * When the host answered, by the host's own clock, in milliseconds since the Unix epoch (GitHub's `Date` header,
   * to the second): what a caller compares with times the host gives (a comment's) instead of its own clock.
   */
  at: number;
}

/**
 * A comment on a change's conversation, as the repository's listing shows it (an issue comment, to GitHub):
 * which change it is on, who wrote it, what it says, when it was written and last edited, in milliseconds since
 * the Unix epoch. The host keeps times to the second.
 */
export interface HostConversationComment {
  id: string;
  /** The host's global id of the comment (GitHub's `node_id`): what minimizing a handled request takes (ADR 0052). */
  nodeId: string;
  /** The number of the change it is on. GitHub lists issues' comments too: their number is no open change's. */
  change: number;
  author: { id: number; login: string };
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** What a push brought, between the head before it (`from`) and the head after it (`to`). */
export interface CommitCount {
  /** The commits `to` has that `from` hasn't. */
  commits: number;
  /** `from` is no ancestor of `to`: the history was rewritten (a force-push), or moved back. */
  diverged: boolean;
  /**
   * The full messages of those commits, oldest first, trailers included: what Lookover reads who wrote a change
   * from (`Co-authored-by`, ADR 0044). As many as the host lists in one answer (GitHub: the first 100), so a
   * long push may give fewer messages than `commits`.
   */
  messages: string[];
}

/**
 * HTTP basic credentials for a fetch, in the host's own form (GitHub: `x-access-token` and an installation
 * token). The password is a short-lived secret: the fetcher sends both as given and never writes them down.
 */
export interface FetchCredentials {
  username: string;
  password: string;
}

/** What one fetch needs. The credentials go through git's credential header, never into the URL. */
export interface FetchSpec {
  /** The repository's HTTPS clone URL, without credentials. */
  cloneUrl: string;
  /**
   * What to fetch, as git refspecs in the host's own ref layout: its branches and every change's head, so that
   * one fetch brings a change's head commit (GitHub: the branches, and `refs/pull/<n>/head`).
   */
  refspecs: string[];
  /**
   * The repository's default branch as the host names it now (a rename is followed): where its rules files are read
   * (ADR 0048). The refspecs bring it as a branch.
   */
  defaultBranch: string;
  /** Credentials valid for the fetch about to run. Asked for at fetch time, so they are never stale. */
  credentials(): Promise<FetchCredentials>;
}

export interface HostIntake {
  /**
   * The changes open now, drafts among them, any order. Empty for a repository with none. Throws `HostError` for
   * one it can't read (`not_found` for a repository that isn't one).
   */
  listOpenChanges(repo: RepositoryRef): Promise<Listing<HostChange>>;
  /**
   * The conversation comments of every change of the repository, the bot's own among them, last edited at or
   * after `since` (milliseconds since the Unix epoch), newest edited first. A listing read in pages may give a
   * comment twice (one edited between two page reads moves the others down a place). Throws
   * `HostError("not_found")` for a repository that isn't one.
   */
  listComments(repo: RepositoryRef, since: number): Promise<Listing<HostConversationComment>>;
  /** One change as it is now, head commit included. Throws `HostError("not_found")` for a number that isn't one. */
  getChange(repo: RepositoryRef, number: number): Promise<HostChange>;
  /**
   * Lookover's review threads on the change (ADR 0052), oldest first: those whose root comment is the bot's (by its
   * numeric id) and holds a finding marker, each with every reply after it, oldest first, whoever wrote it (the
   * bot's own among them; a reply whose author's account is gone is left out). Outdated threads are read too: a
   * thread is the finding's by its marker, never by its line. The adapter filters, so every thread names its
   * finding; whose reply counts as a claim is `core`'s rule. Read whole, past the host's first page, on every call.
   * Throws `HostError("not_found")` for a change that isn't one.
   */
  threads(change: ChangeRef): Promise<HostThread[]>;
  /**
   * How many commits `to` has that `from` hasn't, and whether `from` is no ancestor of `to`. Throws
   * `HostError("not_found")` for a commit the repository doesn't have.
   */
  countCommits(repo: RepositoryRef, from: CommitSha, to: CommitSha): Promise<CommitCount>;
  fetchSpec(repo: RepositoryRef): Promise<FetchSpec>;
}
