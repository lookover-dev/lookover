// Port: the Git host as the coding agent sees it, with its own login (ADR 0021, ADR 0043). `lookover wait`
// (`agent-cli`) reads and writes through it with the agent's token, never with the App's key: the open change
// of a branch, a change's head, the `Lookover` checks of a commit from one App, the change's conversation
// comments with their reactions, and a comment written as the agent; Lookover's review threads, a reply in one
// and resolving one (ADR 0052: the App can't resolve, the agent's login can). `agent-cli` holds the real adapter
// (GitHub over HTTPS, GraphQL for the threads); `testkit`'s `FakeGitHost.asAgent` is the fake, over the same
// memory the App's ports see.
// It reports what the host shows; `wait` decides what it means (which comment is a request, which check counts,
// which reply is a claim).
// Error modes: every refusal is a `HostError` (`not_found` for a repository, change, commit, comment or thread the
// host doesn't have; `too_large` for a reply over `COMMENT_MAX_BYTES`; `unauthorized` for a token refused, or one
// without the right to resolve a thread, said plainly; `rate_limited`, `unavailable` as for the App's ports).
import type { ChangeRef, RepositoryRef } from "./host.ts";
import type { HostThread } from "./host-thread.ts";
import type { HostCheck, HostComment } from "./host-view.ts";
import type { CommitSha } from "./ids.ts";

/**
 * A change as the agent reads it: its number, its head commit now, and whether it comes from a fork (its head's
 * repository isn't the base's, or is gone: ADR 0048), which Lookover reviews only when the owner asks.
 */
export interface AgentChange {
  number: number;
  head: CommitSha;
  fork: boolean;
}

/** A Lookover thread as the agent reads it (GraphQL): its thread id and whether it is resolved always given. */
export interface AgentThread extends HostThread {
  threadId: string;
  resolved: boolean;
}

export interface AgentHost {
  /**
   * The open change whose head is `branch` of the repository itself (not of a fork), or null when there is none.
   * Throws `HostError("not_found")` for a repository the host doesn't have.
   */
  changeOf(repo: RepositoryRef, branch: string): Promise<AgentChange | null>;
  /** The change as it is now, open or not. Throws `HostError("not_found")` for a number that isn't one. */
  getChange(change: ChangeRef): Promise<AgentChange>;
  /**
   * The `Lookover` checks on the commit created by the App `app` (its slug, which the host keeps unique), oldest
   * first: a check of that name from any other App is left out. Empty when it has none. Throws
   * `HostError("not_found")` for a commit the repository doesn't have.
   */
  checks(repo: RepositoryRef, sha: CommitSha, app: string): Promise<HostCheck[]>;
  /**
   * The change's conversation comments, oldest first, each with who wrote it and the counts of Lookover's
   * reactions on it. Throws `HostError("not_found")` for a change that isn't one.
   */
  comments(change: ChangeRef): Promise<HostComment[]>;
  /**
   * Writes a comment on the change's conversation as the token's account. Returns its id. Throws
   * `HostError("not_found")` for a change that isn't one, and posts nothing then.
   */
  comment(change: ChangeRef, body: string): Promise<string>;
  /**
   * Lookover's review threads on the change, oldest first: those whose root comment is the App `app`'s (its slug:
   * the App's bot) and holds a finding marker, resolved and outdated ones included. Each reply after the root,
   * oldest first, whoever wrote it, the App's own included (`author.bot`, its login `<slug>[bot]` as REST names
   * it); a reply by a deleted account is left out. Throws `HostError("not_found")` for a change that isn't one.
   */
  threads(change: ChangeRef, app: string): Promise<AgentThread[]>;
  /**
   * Replies as the token's account in the thread holding the change's review comment `commentId`: a reply's id
   * files it under that thread's root, as GitHub does. Returns the reply's id. Throws `HostError("too_large")` over
   * `COMMENT_MAX_BYTES` and `HostError("not_found")` for a comment the change hasn't, and posts nothing then.
   */
  reply(change: ChangeRef, commentId: number, body: string): Promise<number>;
  /**
   * Resolves the thread `threadId` (an `AgentThread`'s), as the token's account; resolving a resolved one again
   * changes nothing. Throws `HostError("not_found")` for a thread the host doesn't have, and
   * `HostError("unauthorized")` with the host's words when the token may not resolve it.
   */
  resolve(threadId: string): Promise<void>;
}
