// Preparing a built case (ADR 0050): through `retrieval`, as the service prepares a change, with the built repository
// as the clone URL, so the sessions get the worktree, the diff and the rules files the service would, and no Git host
// is reached.
import { type FetchSpec, jobId, type RepositoryRef } from "@lookover/contracts";
import type { Retrieval } from "@lookover/retrieval";
import type { BuiltCase, PreparedCase } from "./types.ts";

/**
 * Every case's repository and job take its neutral name, under one owner of the harness's own: a mirror per case, and
 * a worktree path (`<root>/worktrees/<name>`) that says nothing of the bug.
 */
const OWNER = "evals";

/** The fetch spec of a built repository: its path as the clone URL, its branches as they are, no credentials. */
const localFetch = (built: BuiltCase): FetchSpec => ({
  cloneUrl: built.cloneUrl,
  refspecs: ["+refs/heads/*:refs/heads/*"],
  defaultBranch: "main",
  credentials: () => Promise.resolve({ username: "", password: "" }),
});

/**
 * Prepares `built` through `retrieval`: the review worktree at its head, the diff from its merge base with `main`,
 * the rules files on `main`, and the diff's file. The job takes the case's neutral name, so a crashed run's worktree is replaced. Throws what
 * `retrieval` throws.
 */
export async function prepareCase(
  retrieval: Retrieval,
  built: BuiltCase,
  signal?: AbortSignal,
): Promise<PreparedCase> {
  const repo: RepositoryRef = { owner: OWNER, name: built.name };
  const request = {
    repo,
    job: jobId(built.name),
    head: built.head,
    base: built.base,
    fetch: localFetch(built),
  };
  const prepared = await retrieval.prepare(request, signal);
  return {
    head: built.head,
    diff: prepared.diff,
    rules: prepared.rules,
    cwd: prepared.cwd,
    diffFile: prepared.diffFile,
    dispose: () => prepared.dispose(),
  };
}
