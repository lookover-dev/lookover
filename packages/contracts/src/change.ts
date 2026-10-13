// A change Lookover watches: a pull request on GitHub, a merge request elsewhere (ADR 0008, ADR 0030).
// Code says change; people read "pull request".
import type { EngineId } from "./engine.ts";
import type { ChangeId, CommitSha, RepositoryId } from "./ids.ts";

export interface Change {
  id: ChangeId;
  repoId: RepositoryId;
  number: number;
  title: string;
  openedBy: string;
  author: "you" | "agent" | "other";
  /** The engine of the coding agent that wrote it, when an agent did. */
  writtenBy: EngineId | null;
  headSha: CommitSha;
  openedAt: number;
  draft: boolean;
  /** Its head is in another repository than its base, or in one since deleted (ADR 0048). */
  fork: boolean;
  /** Commits pushed since the last reviewed round. */
  newCommits: number;
}
