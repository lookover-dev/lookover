// What `retrieval` prepares for a review job (ADR 0033, ADR 0039): the seam between preparing and reviewing.
// `review` reads these fields and nothing else of what `prepare` did.

export interface Prepared {
  /** The review worktree at the job's head commit: the engine's working directory. */
  cwd: string;
  /** The unified diff from the merge base, as git prints it. */
  diff: string;
}
