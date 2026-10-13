// What `lookover` runs against: the host with the agent's token, the local checkout, the environment, time and
// its two output streams. The `lookover` command gives the real ones; tests give a `FakeGitHost` and a clock they move.
import type { AgentHost, Clock, CommitSha, RepositoryRef } from "@lookover/contracts";

/** The local checkout, as git shows it. Each throws a plain `Error` when git can't say. */
export interface LocalGit {
  /** The commit checked out: `git rev-parse HEAD`. */
  head(): Promise<CommitSha>;
  /** The branch checked out, or null on a detached head. */
  branch(): Promise<string | null>;
  /** The repository the `origin` remote points to. */
  origin(): Promise<RepositoryRef>;
}

export interface World {
  /**
   * The host with the agent's own token, asked for once the arguments are read. Throws a plain `Error` when no
   * token can be found.
   */
  host(): Promise<AgentHost>;
  git: LocalGit;
  /** The environment: `LOOKOVER_APP` names the App when `--app` doesn't. */
  env: Record<string, string | undefined>;
  clock: Clock;
  /** Resolves `ms` later by `clock`. */
  sleep(ms: number): Promise<void>;
  /** Writes one line on stdout. */
  out(line: string): void;
  /** Writes one line on stderr. */
  err(line: string): void;
}
