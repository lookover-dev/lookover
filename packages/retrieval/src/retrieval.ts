import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CommitSha,
  FetchCredentials,
  FetchSpec,
  JobId,
  Prepared as PreparedForReview,
  ProcessLimits,
  ProcessResult,
  ProcessRunner,
  RepositoryRef,
  RulesFile,
} from "@lookover/contracts";
import { commitSha, HostError, RULES_FILES } from "@lookover/contracts";

export interface RetrievalOptions {
  /** Lookover's copies live here: `mirrors/<owner>/<name>.git` and `worktrees/<job>`. */
  root: string;
  runner: ProcessRunner;
  /** The git program, by absolute path. Looked up on `env`'s PATH when absent. */
  git?: string;
  /** The environment git runs in. Every `GIT_*` variable in it is dropped. */
  env: Record<string, string>;
  /** One line per git command run. Never holds a token. */
  log?: (line: string) => void;
}

export interface PrepareRequest {
  repo: RepositoryRef;
  job: JobId;
  /** The change's head commit: what the worktree is at. */
  head: CommitSha;
  /** The base branch's commit: the diff starts at its merge base with `head`. */
  base: CommitSha;
  fetch: FetchSpec;
}

/**
 * The whole diff's file in the worktree: at its root, so an engine confined to the working directory reads it,
 * under a name of its own each time (`.lookover-change-<16 hex>.diff`), made only if nothing is there: the change
 * controls every other name in its checkout, and a file or a link it holds is never written through. Untracked, so
 * it is never part of a diff git prints; removed with the worktree.
 */
const diffFileName = () => `.lookover-change-${randomBytes(8).toString("hex")}.diff`;

/** Names tried before giving up: a change can't guess a random name, so more than one is a fluke. */
const DIFF_FILE_TRIES = 5;

/**
 * Writes `text` to a new file at the worktree's root, created exclusively (`wx`: never through a link or over a
 * file already there), and gives its name.
 */
function writeDiffFile(worktree: string, text: string): string {
  for (let tries = 1; ; tries++) {
    const name = diffFileName();
    try {
      writeFileSync(join(worktree, name), text, { flag: "wx" });
      return name;
    } catch (error) {
      const taken = error instanceof Error && "code" in error && error.code === "EEXIST";
      if (!taken || tries >= DIFF_FILE_TRIES) throw error;
    }
  }
}

/**
 * What `review` reads (contracts' `Prepared`: `cwd`, `diff`) plus what the service needs: the rules files to parse
 * and keep, and what to clean up.
 */
export interface Prepared extends PreparedForReview {
  /**
   * The repository's rules files as they stand on its default branch (ADR 0048), in `RULES_FILES`' order; a file
   * the branch doesn't have, or holds as anything but a regular UTF-8 file, is left out.
   */
  rules: RulesFile[];
  mergeBase: CommitSha;
  /**
   * The whole diff saved as a file inside the worktree, its path relative to `cwd` (`diffFileName`): for an engine
   * shown only part of it, which can read files but not run git.
   */
  diffFile: string;
  /** Removes the worktree. The mirror stays. */
  dispose(): Promise<void>;
}

export interface Retrieval {
  prepare(request: PrepareRequest, signal?: AbortSignal): Promise<Prepared>;
}

export type RetrievalProblem =
  | "git_not_found"
  | "mirror_failed"
  | "fetch_failed"
  | "commit_not_found"
  | "worktree_failed"
  | "diff_failed"
  /** Only logged: the rules files couldn't be read, which never fails a prepare (ADR 0048). */
  | "rules_unread"
  | "cancelled";

/** The one thing `prepare` and `dispose` throw. `detail` is git's own words, with any token hidden. */
export class RetrievalError extends Error {
  readonly problem: RetrievalProblem;
  readonly detail: string;
  constructor(problem: RetrievalProblem, detail: string) {
    super(`${problem}: ${detail}`);
    this.name = "RetrievalError";
    this.problem = problem;
    this.detail = detail;
  }
}

/** One entry of a tree, as `ls-tree` lists it. */
interface TreeEntry {
  mode: string;
  type: string;
  object: string;
}

/**
 * Whether `name` is a branch name git accepts (`git check-ref-format --branch`'s rules): no control character,
 * space or `~^:?*[\`, no `..` or `@{`, not `@`, no empty part, none starting with `.` or ending in `.lock`, no end
 * in `.`. Such a name under `refs/heads/` is read by git as that ref, never as a revision (`main~1`,
 * `main:REVIEW.md`) or as a second line of a batch.
 */
function isBranchName(name: string): boolean {
  const control = [...name].some((c) => c <= " " || c === "\u007f");
  if (control || name === "@" || name.endsWith(".") || /[~^:?*[\\]|\.\.|@\{/.test(name)) return false;
  return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** The modes of entries that aren't plain files, by what they are. */
const KINDS: Record<string, string> = {
  "120000": "is a link",
  "160000": "is a submodule",
  "040000": "is a folder",
};

const FETCH_LIMITS: ProcessLimits = { wallClockMs: 10 * 60_000, idleMs: 2 * 60_000 };
const QUICK_LIMITS: ProcessLimits = { wallClockMs: 60_000, idleMs: 60_000 };
const HIDDEN = "<hidden>";

/** Environment names are case-insensitive on Windows (`Path`, `path`): match them as git does. */
const isGitVariable = (key: string) => key.toUpperCase().startsWith("GIT_");
const pathOf = (env: Record<string, string>) =>
  Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];

/** The environment git sees: the caller's without any `GIT_*` variable, and never a credential prompt. */
function gitEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (!isGitVariable(key)) out[key] = value;
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

type ConfigEntry = [key: string, value: string];

/**
 * The options every git command runs with (ADR 0056, SR-06), above whatever the user's own configuration says,
 * so a hostile repository meeting it runs nothing: no hook (the hooks folder is an empty one of ours), no link
 * checked out as a link, no fsmonitor, no LFS filter, no submodule followed, no file protocol. The fetch alone
 * sets `protocol.file.allow=user` after these (the last value wins): git counts a local path as that protocol,
 * and the evals, demo mode and the tests fetch from local folders.
 */
const safeConfig = (hooks: string): ConfigEntry[] => [
  ["core.hooksPath", hooks],
  ["core.symlinks", "false"],
  ["core.fsmonitor", "false"],
  ["filter.lfs.smudge", ""],
  ["filter.lfs.process", ""],
  ["filter.lfs.required", "false"],
  ["submodule.recurse", "false"],
  ["protocol.file.allow", "never"],
];

/** Git config for one command, in its environment: never on its command line (`git config`, "GIT_CONFIG_COUNT"). */
function configEnv(entries: ConfigEntry[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The credentials as sent: a basic credential, `username:password` in base64. */
const basicOf = (c: FetchCredentials) => btoa(`${c.username}:${c.password}`);

/** Every form the secret takes, so none of them reaches a log or an error. */
const formsOf = (c: FetchCredentials) => [c.password, btoa(c.password), basicOf(c)];

const redact = (text: string, secrets: string[]) =>
  secrets.reduce((out, secret) => (secret === "" ? out : out.replaceAll(secret, HIDDEN)), text);

const safeName = (job: JobId) => job.replaceAll(/[^A-Za-z0-9._-]/g, "_");

/** A failure's own words: a host's refusal keeps its code. */
function wordsOf(error: unknown): string {
  if (error instanceof HostError) return `${error.failure}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** A step that isn't git (the disk, the host's credentials), its failure turned into the one error retrieval throws. */
async function attempt<T>(problem: RetrievalProblem, what: string, step: () => T | Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof RetrievalError) throw error;
    throw new RetrievalError(problem, `${what}: ${wordsOf(error)}`);
  }
}

interface Run {
  args: string[];
  cwd: string;
  problem: RetrievalProblem;
  limits?: ProcessLimits;
  stdin?: string;
  /** Git config for this command only, after the safe options every git command gets: one list, one count. */
  config?: ConfigEntry[];
  /** Strings hidden from the log and from `detail`: the secret in every form it takes. */
  secrets?: string[];
}

export function createRetrieval(options: RetrievalOptions): Retrieval {
  const env = gitEnv(options.env);
  const git = options.git ?? Bun.which("git", { PATH: pathOf(env) ?? "" });
  const log = options.log ?? (() => {});
  const mirrorOf = (repo: RepositoryRef) => join(options.root, "mirrors", repo.owner, `${repo.name}.git`);
  const worktreeOf = (job: JobId) => join(options.root, "worktrees", safeName(job));
  /** The hooks folder every git command is given: empty, made by the first prepare. */
  const hooks = join(options.root, "no-hooks");
  const safe = safeConfig(hooks);
  const envWith = (config: ConfigEntry[] = []) => ({ ...env, ...configEnv([...safe, ...config]) });

  async function run(r: Run, signal?: AbortSignal): Promise<ProcessResult> {
    if (signal?.aborted) throw new RetrievalError("cancelled", "cancelled before git ran");
    if (git === null) throw new RetrievalError("git_not_found", "no git program on PATH");
    const secrets = r.secrets ?? [];
    const started = options.runner.start(
      { executable: git, args: r.args, cwd: r.cwd, env: envWith(r.config), stdin: r.stdin ?? "" },
      r.limits ?? QUICK_LIMITS,
    );
    const kill = () => started.kill();
    signal?.addEventListener("abort", kill, { once: true });
    const result = await started.result;
    signal?.removeEventListener("abort", kill);
    const code = result.exitCode === null ? "" : ` ${result.exitCode}`;
    log(redact(`git ${r.args.join(" ")}: ${result.end}${code} in ${result.tookMs} ms`, secrets));
    const stderr = redact(result.stderr.trim(), secrets);
    switch (result.end) {
      case "exited":
        if (result.exitCode === 0) return result;
        throw new RetrievalError(r.problem, stderr || `git exited ${result.exitCode}`);
      case "failed_to_start":
        throw new RetrievalError("git_not_found", stderr);
      case "killed":
        throw new RetrievalError("cancelled", "cancelled while git ran");
      case "wall_clock":
      case "idle":
        throw new RetrievalError(r.problem, `git took too long (${result.end})`);
    }
  }

  async function ensureMirror(mirror: string, signal?: AbortSignal): Promise<void> {
    if (existsSync(join(mirror, "HEAD"))) return;
    await attempt("mirror_failed", "the mirror's folder can't be made", () =>
      mkdirSync(mirror, { recursive: true }),
    );
    await run({ args: ["init", "--quiet", "--bare", mirror], cwd: mirror, problem: "mirror_failed" }, signal);
  }

  /** One fetch, the credentials in a header in this command's environment only: never in a URL or a file. */
  async function fetch(mirror: string, spec: FetchSpec, signal?: AbortSignal): Promise<void> {
    const credentials = await attempt("fetch_failed", "no credentials from the host", () =>
      spec.credentials(),
    );
    await run(
      {
        args: ["fetch", "--quiet", "--prune", "--no-tags", spec.cloneUrl, ...spec.refspecs],
        cwd: mirror,
        problem: "fetch_failed",
        limits: FETCH_LIMITS,
        config: [
          ["http.extraheader", `AUTHORIZATION: basic ${basicOf(credentials)}`],
          // No credential helper: a refused token fails here instead of asking a helper (or a person).
          ["credential.helper", ""],
          // A local folder is a clone URL too (evals, demo mode, tests): the file protocol for this fetch only.
          ["protocol.file.allow", "user"],
        ],
        secrets: formsOf(credentials),
      },
      signal,
    );
  }

  /** Both commits must be in the mirror after the fetch: one `cat-file` answers for both. */
  async function checkCommits(mirror: string, shas: CommitSha[], signal?: AbortSignal): Promise<void> {
    const check = await run(
      {
        args: ["cat-file", "--batch-check"],
        cwd: mirror,
        problem: "commit_not_found",
        stdin: `${shas.join("\n")}\n`,
      },
      signal,
    );
    // One line per sha asked, in order: `<sha> commit <size>`, or `<sha> missing`.
    const lines = check.stdout.split("\n");
    shas.forEach((sha, i) => {
      if (/^([0-9a-f]+) commit \d+$/.exec(lines[i] ?? "")?.[1] !== sha)
        throw new RetrievalError(
          "commit_not_found",
          `${sha} is not a commit of the repository after the fetch`,
        );
    });
  }

  /**
   * The commit of exactly `refs/heads/<branch>` in the mirror, or null when there is no such branch. Never asked as
   * a revision (`cat-file`, `rev-parse`): for a missing ref, git guesses others (`refs/heads/refs/heads/<branch>`,
   * `refs/tags/...`, `refs/remotes/...`) and would give a commit that isn't the branch's. `for-each-ref` lists the
   * refs its pattern names, never a guess; the pattern holds no glob (`isBranchName` refuses `*?[\`), and only the
   * ref named exactly is taken (the pattern also matches the refs under it, `refs/heads/<branch>/...`).
   */
  async function branchCommit(
    mirror: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<CommitSha | null> {
    if (!isBranchName(branch)) return null;
    const ref = `refs/heads/${branch}`;
    const listed = await run(
      {
        args: ["for-each-ref", "--format=%(objectname) %(objecttype) %(refname)", ref],
        cwd: mirror,
        problem: "rules_unread",
      },
      signal,
    );
    // One line per ref: `<sha> <type> <name>`; a ref's name holds no space.
    for (const line of listed.stdout.split("\n")) {
      const [sha, type, name] = line.split(" ");
      if (name === ref && type === "commit" && sha !== undefined) return commitSha(sha);
    }
    return null;
  }

  /** A worktree left behind (a crashed run) is cleared; `--force` lets git reuse its registration. */
  async function addWorktree(mirror: string, worktree: string, head: CommitSha, signal?: AbortSignal) {
    await attempt("worktree_failed", "the worktree left behind can't be removed", () =>
      rmSync(worktree, { recursive: true, force: true }),
    );
    await run(
      {
        args: ["worktree", "add", "--quiet", "--force", "--detach", worktree, head],
        cwd: mirror,
        problem: "worktree_failed",
      },
      signal,
    );
  }

  async function removeWorktree(mirror: string, worktree: string): Promise<void> {
    await run({
      args: ["worktree", "remove", "--force", worktree],
      cwd: mirror,
      problem: "worktree_failed",
    }).catch(async () => {
      await attempt("worktree_failed", "the worktree can't be removed", () =>
        rmSync(worktree, { recursive: true, force: true }),
      );
      await run({ args: ["worktree", "prune"], cwd: mirror, problem: "worktree_failed" });
    });
    if (existsSync(worktree)) throw new RetrievalError("worktree_failed", `${worktree} could not be removed`);
  }

  /**
   * The rules files at the root of the default branch's commit in the mirror (ADR 0048), in `RULES_FILES`' order:
   * never the change's worktree. A missing file is left out; one that isn't a plain UTF-8 file is left out and
   * logged; a branch the fetch didn't bring, or a git that fails, gives no rules and a logged line: only a
   * cancellation stops the prepare.
   */
  async function readRules(mirror: string, branch: string, signal?: AbortSignal): Promise<RulesFile[]> {
    try {
      const commit = await branchCommit(mirror, branch, signal);
      if (commit === null) {
        log(`rules: no branch ${branch} after the fetch: no rules read`);
        return [];
      }
      const entries = await rulesEntries(mirror, commit, signal);
      const files: RulesFile[] = [];
      for (const path of RULES_FILES) {
        const entry = entries.get(path);
        if (entry === undefined) continue;
        const text = await rulesText(mirror, entry, signal);
        if (typeof text === "string") files.push({ path, text, commit });
        else log(`rules: ${path} on ${branch} ${text.not}: not read`);
      }
      return files;
    } catch (error) {
      if (error instanceof RetrievalError && error.problem === "cancelled") throw error;
      log(`rules: not read: ${wordsOf(error)}`);
      return [];
    }
  }

  /** The tree's entries under the rules files' names: one `ls-tree` for all three. */
  async function rulesEntries(mirror: string, commit: CommitSha, signal?: AbortSignal) {
    const listed = await run(
      { args: ["ls-tree", "-z", commit, "--", ...RULES_FILES], cwd: mirror, problem: "rules_unread" },
      signal,
    );
    const entries = new Map<string, TreeEntry>();
    // One entry per NUL: `<mode> <type> <object>\t<path>`.
    for (const line of listed.stdout.split("\0")) {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(line);
      if (match?.[4] !== undefined)
        entries.set(match[4], { mode: match[1] ?? "", type: match[2] ?? "", object: match[3] ?? "" });
    }
    return entries;
  }

  /** A plain file's text, or why it isn't read: a link, a submodule, a folder, or not UTF-8 text. */
  async function rulesText(
    mirror: string,
    entry: TreeEntry,
    signal?: AbortSignal,
  ): Promise<string | { not: string }> {
    const kind = KINDS[entry.mode];
    if (kind !== undefined) return { not: kind };
    if (entry.type !== "blob") return { not: "not a file" };
    const blob = await run(
      { args: ["cat-file", "blob", entry.object], cwd: mirror, problem: "rules_unread" },
      signal,
    );
    // Git's bytes reach us decoded as UTF-8: a byte that isn't is the replacement character.
    if (/[�\0]/.test(blob.stdout)) return { not: "is not UTF-8 text" };
    return blob.stdout.replace(/^﻿/, "");
  }

  /** Each mirror's last prepare, settled: the next prepare of the repository starts once it ends. */
  const turns = new Map<string, Promise<void>>();

  /** Runs `step` after every earlier prepare of the mirror, failed or not; a signal fired while waiting cancels it. */
  function inTurn<T>(mirror: string, signal: AbortSignal | undefined, step: () => Promise<T>): Promise<T> {
    const mine = (turns.get(mirror) ?? Promise.resolve()).then(() => {
      if (signal?.aborted)
        throw new RetrievalError("cancelled", "cancelled while waiting for the repository");
      return step();
    });
    const settled = mine.then(
      () => {},
      () => {},
    );
    turns.set(mirror, settled);
    void settled.then(() => {
      if (turns.get(mirror) === settled) turns.delete(mirror);
    });
    return mine;
  }

  async function prepareInTurn(request: PrepareRequest, signal?: AbortSignal): Promise<Prepared> {
    const mirror = mirrorOf(request.repo);
    const worktree = worktreeOf(request.job);
    await attempt("mirror_failed", "the empty hooks folder can't be made", () =>
      mkdirSync(hooks, { recursive: true }),
    );
    await ensureMirror(mirror, signal);
    await fetch(mirror, request.fetch, signal);
    await checkCommits(mirror, [request.head, request.base], signal);
    const rules = await readRules(mirror, request.fetch.defaultBranch, signal);
    const base = await run(
      { args: ["merge-base", request.base, request.head], cwd: mirror, problem: "diff_failed" },
      signal,
    );
    const mergeBase = await attempt("diff_failed", "git gave no merge base", () =>
      commitSha(base.stdout.trim()),
    );
    await addWorktree(mirror, worktree, request.head, signal);
    const diff = await run(
      {
        args: [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "-M",
          mergeBase,
          request.head,
        ],
        cwd: mirror,
        problem: "diff_failed",
      },
      signal,
    );
    const diffFile = await attempt("diff_failed", `the diff could not be saved in ${worktree}`, () =>
      writeDiffFile(worktree, diff.stdout),
    );
    return {
      cwd: worktree,
      diff: diff.stdout,
      rules,
      mergeBase,
      diffFile,
      dispose: () => removeWorktree(mirror, worktree),
    };
  }

  return {
    prepare: (request, signal) =>
      inTurn(mirrorOf(request.repo), signal, () => prepareInTurn(request, signal)),
  };
}
