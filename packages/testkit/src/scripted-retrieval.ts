// Retrieval without git (ADR 0046): `retrieval`'s `Retrieval` port, structurally (the request and what a
// prepare gives have the shapes `packages/retrieval` declares; it is not imported: testkit may reach only
// contracts). Each commit of each change scripted gets its own worktree path, `<root>/<change>/<sha>`, where
// nothing is ever written, and the unified diff scripted for it: the scripted engines answer by that path, and a
// review of the same commit asked twice reads the same code. A commit nothing is scripted for gets the default
// diff (`diff`, none unless set) at `<root>/<job>`: what the service's tests run on. A repository's rules files
// (`scriptRules`) come with each of its prepares, as the real one reads them from the default branch; none unless set.
import { join } from "node:path";
import type { CommitSha, FetchSpec, JobId, Prepared, RepositoryRef, RulesFile } from "@lookover/contracts";

const repoKey = (repo: RepositoryRef) => `${repo.owner}/${repo.name}`;

/** What the service asks a prepare for: `retrieval`'s `PrepareRequest`, by shape. */
export interface ScriptedPrepareRequest {
  repo: RepositoryRef;
  job: JobId;
  head: CommitSha;
  base: CommitSha;
  fetch: FetchSpec;
}

/** What a prepare gives: `retrieval`'s `Prepared`, by shape (contracts' `cwd` and `diff`, plus the service's). */
export interface ScriptedPrepared extends Prepared {
  /** The repository's rules files, as `scriptRules` set them. */
  rules: RulesFile[];
  mergeBase: CommitSha;
  /** The name the whole diff would have at the worktree's root. Nothing is written under it. */
  diffFile: string;
  dispose(): Promise<void>;
}

export interface ScriptedRetrievalOptions {
  /** Where the worktree paths point. Nothing is written there. `worktrees` by default. */
  root?: string;
}

/** A commit's script: the change it belongs to and its diff from the merge base. */
interface Scripted {
  change: number;
  diff: string;
}

/**
 * Retrieval from a script: each prepare gives a worktree path nothing is written to and the diff scripted for its
 * commit (the default diff when none is), unless a refusal was set for it. It keeps the jobs it prepared and
 * disposed, in order.
 */
export class ScriptedRetrieval {
  /** The jobs prepared, in order. */
  readonly prepared: JobId[] = [];
  /** The jobs whose worktree was removed, in order. */
  readonly disposed: JobId[] = [];
  /** The diff a prepare of a commit nothing is scripted for gives: none by default, so every finding goes into the summary. */
  diff = "";
  private readonly root: string;
  private readonly commits = new Map<CommitSha, Scripted>();
  private refusal: Error | null = null;
  private readonly rules = new Map<string, RulesFile[]>();

  constructor(options: ScriptedRetrievalOptions = {}) {
    this.root = options.root ?? "worktrees";
  }

  /**
   * From now on a prepare of `sha`, a commit of change `change`, gives `diff` at `worktreeOf(change, sha)`. A
   * commit is one change's: a prepare names the commit alone, so a sha scripted under another change already is
   * refused rather than moved (scripted again under the same change, its diff is replaced).
   */
  script(change: number, sha: CommitSha, diff: string): void {
    const already = this.commits.get(sha);
    if (already && already.change !== change)
      throw new Error(`Commit ${sha} is scripted under change ${already.change} already, not ${change}`);
    this.commits.set(sha, { change, diff });
  }

  /**
   * From now on every prepare of `repo` gives `files` as its rules files: what the real one reads from the default
   * branch (ADR 0048), given as they are. A repository nothing is scripted for has none.
   */
  scriptRules(repo: RepositoryRef, files: RulesFile[]): void {
    this.rules.set(repoKey(repo), files);
  }

  /** The worktree path a prepare of this commit of this change gives: `<root>/<change>/<sha>`. */
  worktreeOf(change: number, sha: CommitSha): string {
    return join(this.root, String(change), sha);
  }

  /** The next prepare throws `error` (the real one throws its `RetrievalError`), then the following answer again. */
  refuse(error: Error): void {
    this.refusal = error;
  }

  prepare(request: ScriptedPrepareRequest): Promise<ScriptedPrepared> {
    const refusal = this.refusal;
    this.refusal = null;
    if (refusal) return Promise.reject(refusal);
    this.prepared.push(request.job);
    const scripted = this.commits.get(request.head);
    return Promise.resolve({
      cwd: scripted ? this.worktreeOf(scripted.change, request.head) : join(this.root, request.job),
      diff: scripted ? scripted.diff : this.diff,
      rules: this.rules.get(repoKey(request.repo)) ?? [],
      mergeBase: request.base,
      diffFile: ".lookover-change.diff",
      dispose: () => {
        this.disposed.push(request.job);
        return Promise.resolve();
      },
    });
  }
}
