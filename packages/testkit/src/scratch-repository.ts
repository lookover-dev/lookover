// A test's scratch git repository, which runs no background maintenance (ADR 0093). A `git commit` may start
// `gc --auto` or `maintenance run --auto` in a detached process that writes under `.git/objects` (its
// `maintenance.lock`) while the test copies or walks the folder: `scratchRepository` writes `maintenance.auto=false`
// and `gc.auto=0` into the repository's config right after `init`, before any commit or `fast-import` can start
// it, and `quietRepository` writes them into one the test got by `clone`. The code under test runs git too and
// reads only the repository's config, hence the config, not `-c` on the test's own calls.
// Git runs in the environment the caller gives (none by default; the binary is found on this process's search path)
// without any of its `GIT_*`: inside a hook, git exports `GIT_DIR`, and a write would land in Lookover's own
// repository. Never imports `bun:test`: the demo's sandbox reaches it.

/** How git runs for a scratch repository. */
export interface ScratchGit {
  /** The git binary to run, `git` on the search path by default. */
  git?: string;
  /** The environment git runs in, every `GIT_*` dropped; none by default. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** How `scratchRepository` makes the repository. */
export interface ScratchRepositoryOptions extends ScratchGit {
  /** A bare repository, the folder being its git directory. */
  bare?: boolean;
  /** A first commit of every file already in the folder (an empty one when it holds none), with this message. */
  commit?: string;
}

/** What a scratch repository's config holds: the test identity, and no background maintenance. */
const IDENTITY: readonly [string, string][] = [
  ["user.name", "Test"],
  ["user.email", "test@example.com"],
];
const QUIET: readonly [string, string][] = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
];

/** Runs git in `cwd`, throwing an `Error` naming the command when it fails. */
function runner({ git = "git", env = {} }: ScratchGit): (cwd: string, args: string[]) => void {
  const gitFree: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("GIT_") && value !== undefined) gitFree[key] = value;
  }
  return (cwd, args) => {
    let failure: string;
    try {
      const r = Bun.spawnSync([git, ...args], { cwd, env: gitFree, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode === 0) return;
      failure = r.stderr.toString();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    throw new Error(`a scratch repository: ${git} ${args.join(" ")} failed: ${failure}`);
  };
}

const configure = (run: ReturnType<typeof runner>, repo: string, entries: readonly [string, string][]) => {
  for (const [key, value] of entries) run(repo, ["config", key, value]);
};

/**
 * Makes `folder` (which exists) a git repository on `main`, with the test identity and no background maintenance in
 * its config, and, given `commit`, a first commit of the files already in it.
 */
export function scratchRepository(folder: string, options: ScratchRepositoryOptions = {}): void {
  const run = runner(options);
  run(folder, ["init", "-q", ...(options.bare ? ["--bare"] : []), "-b", "main", folder]);
  configure(run, folder, [...IDENTITY, ...QUIET]);
  if (options.commit === undefined) return;
  run(folder, ["add", "-A"]);
  run(folder, ["commit", "-q", "--allow-empty", "-m", options.commit]);
}

/** Switches off background maintenance in the repository at `repo` (a clone's work tree, or a bare one). */
export function quietRepository(repo: string, options: ScratchGit = {}): void {
  configure(runner(options), repo, QUIET);
}
