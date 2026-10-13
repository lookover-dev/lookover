// The machine `lookover` runs on: the checkout through `git`, the agent's token from the environment or the `gh`
// CLI, the real clock, stdout and stderr. What the `lookover` command (`apps/service/src/main.ts`) hands to `run`.
import { type CommitSha, commitSha, type RepositoryRef } from "@lookover/contracts";
import { createAgentHost } from "./github.ts";
import type { LocalGit, World } from "./world.ts";

type Env = Record<string, string | undefined>;

/** Runs a command; its trimmed stdout, or null when it fails or can't start. */
function output(command: string[], cwd: string, env: Env): string | null {
  try {
    const done = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
    return done.exitCode === 0 ? done.stdout.toString().trim() : null;
  } catch {
    // Not installed: the caller says what it needed.
    return null;
  }
}

/** `owner/name` from a GitHub remote URL (HTTPS, SSH or `git@github.com:`), or null for another host. */
function githubRepository(url: string): RepositoryRef | null {
  const read =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return read?.[1] && read[2] ? { owner: read[1], name: read[2] } : null;
}

/** The checkout at `cwd`, read with `git`. */
function localGit(cwd: string, env: Env): LocalGit {
  const git = (...args: string[]) => output(["git", ...args], cwd, env);
  return {
    head: (): Promise<CommitSha> => {
      const sha = git("rev-parse", "HEAD");
      if (sha === null)
        return Promise.reject(new Error(`No commit checked out in ${cwd}: is it a git repository?`));
      return Promise.resolve(commitSha(sha));
    },
    branch: () => Promise.resolve(git("symbolic-ref", "--quiet", "--short", "HEAD")),
    origin: (): Promise<RepositoryRef> => {
      const url = git("remote", "get-url", "origin");
      if (url === null) return Promise.reject(new Error("This checkout has no origin remote."));
      const repo = githubRepository(url);
      if (repo === null) return Promise.reject(new Error(`The origin remote (${url}) is not on GitHub.`));
      return Promise.resolve(repo);
    },
  };
}

/**
 * The agent's own GitHub token (ADR 0021): `GH_TOKEN`, else `GITHUB_TOKEN`, else what `gh auth token` prints
 * (`gh` given to test it). Throws a plain `Error` when there is none.
 */
export function agentToken(
  env: Env,
  gh: () => string | null = () => output(["gh", "auth", "token"], ".", env),
): string {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || gh();
  if (!token) throw new Error("No GitHub token: set GH_TOKEN, or sign in with gh auth login.");
  return token;
}

/** The machine's world: the checkout in `cwd`, the agent's token, the real clock and streams. */
export function realWorld(cwd: string, env: Env): World {
  return {
    host: () => Promise.resolve(createAgentHost({ token: agentToken(env) })),
    git: localGit(cwd, env),
    env,
    clock: { now: () => Date.now() },
    sleep: (ms) => Bun.sleep(ms),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}
