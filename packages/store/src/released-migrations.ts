// `@lookover/store/released-migrations`, for the store's own test and `bun run migrations --released`
// (scripts/migrations.ts): what the last release's migrations were, and what of them the working tree changed
// (ADR 0103, ADR 0104). Never exported from the store's index, so the service never carries it.
// - `migrationProblems(released, current)`: pure, two maps of file name to `textHash`; each released migration
//   edited, renamed (its text now under a name the release didn't carry) or deleted, with a message naming the
//   file, the release and ADR 0103. A new migration, or an edit to one no release carries, is none.
// - `checkReleased({ folder, list })`: the migrations `folder` holds against the last release, and the source it
//   used. The release is T, the newest plain `vX.Y.Z` tag merged into HEAD; the list L is `list`
//   (`released-migrations.json`). T reachable and not HEAD's own commit: L must be T's, hash for hash, else it
//   throws asking for `bun run migrations --released` (naming the first file whose hash differs when L names T);
//   then T is the source. T is HEAD's own commit (a release's tag, the release dry run's exported tag): L, the
//   release before's, and T both are, so an uncommitted edit to a migration T brought fails; L must exist and not
//   name a release newer than T. L newer than T (its tag not fetched): T and L both are, so an edit to a migration
//   T carries fails even with its hash in L. With both, each one's problems are reported, one they share (same
//   file, same change) once, naming both releases. No T (no git, not a repository, no tag: CI's checkout): L is.
//   Neither, a malformed L, or git failing in a repository: it throws.
// - `releasedList({ folder })`: the list's text for T, from the tag and never the working tree, as Biome formats
//   it; throws when no T is reachable.
// Git runs with its `cwd` the folder's parent, never this process's, in `env` (this process's environment by
// default, read in `config.ts`, so git keeps HOME and its global config) with every `GIT_*` dropped (a hook's
// `GIT_DIR` would point it at another repository), `LC_ALL=C` and, given `ceiling`, `GIT_CEILING_DIRECTORIES`
// (a test's scratch folder, whatever repository holds the machine's TMP); four calls at most, whatever the number
// of files: the tag's migrations come from one `ls-tree -z` and one `cat-file --batch`.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { CALLER_ENV } from "./config.ts";

/** Migrations by file name, each with the `textHash` of its text. */
export type MigrationHashes = Record<string, string>;

/** A release's migrations: its tag (`vX.Y.Z`) and each file it carries. */
export interface ReleasedMigrations {
  release: string;
  migrations: MigrationHashes;
}

/** What a change did to a migration the release carries. */
export interface MigrationProblem {
  kind: "edited" | "renamed" | "deleted";
  file: string;
  /** A rename's new name. */
  to?: string;
  message: string;
}

/** SHA-256, hex, of the text `bytes` hold (UTF-8) with every `\r\n` made `\n`: line endings never count. */
export function textHash(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes).replaceAll("\r\n", "\n");
  return createHash("sha256").update(text).digest("hex");
}

const RULE =
  "a released migration is never edited, renamed or deleted (ADR 0103): put the change in a new one";

/** A problem's message: its file, the releases that carry it (one or several), what happened and the rule. */
function problemMessage({ kind, file, to }: Omit<MigrationProblem, "message">, releases: string[]): string {
  const what = { edited: "was edited", deleted: "is gone", renamed: `is now ${to}` }[kind];
  const carry = releases.length === 1 ? "carries" : "carry";
  return `${file}, which ${releases.join(" and ")} ${carry}, ${what}: ${RULE}.`;
}

/** Each migration of `released` that `current` no longer holds as it was. */
export function migrationProblems(
  released: ReleasedMigrations,
  current: Readonly<MigrationHashes>,
): MigrationProblem[] {
  const { release, migrations } = released;
  const problems: Omit<MigrationProblem, "message">[] = [];
  for (const [file, hash] of Object.entries(migrations).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const now = current[file];
    if (now === hash) continue;
    if (now !== undefined) {
      problems.push({ kind: "edited", file });
      continue;
    }
    const to = Object.keys(current).find((name) => current[name] === hash && !(name in migrations));
    problems.push(to === undefined ? { kind: "deleted", file } : { kind: "renamed", file, to });
  }
  return problems.map((problem) => ({ ...problem, message: problemMessage(problem, [release]) }));
}

/** The problems against each of `released`, one that several share (same file, same change) said once. */
function problemsAgainst(released: ReleasedMigrations[], current: MigrationHashes): MigrationProblem[] {
  const shared = new Map<string, { problem: MigrationProblem; releases: string[] }>();
  for (const release of released) {
    for (const problem of migrationProblems(release, current)) {
      const key = JSON.stringify([problem.kind, problem.file, problem.to]);
      const seen = shared.get(key);
      if (seen) seen.releases.push(release.release);
      else shared.set(key, { problem, releases: [release.release] });
    }
  }
  return [...shared.values()].map(({ problem, releases }) => ({
    ...problem,
    message: problemMessage(problem, releases),
  }));
}

/** How git runs: the binary (`git` on the search path by default) and the environment it starts from. */
export interface GitOptions {
  git?: string;
  /** Every `GIT_*` in it is dropped and `LC_ALL=C` set; this process's by default. */
  env?: Readonly<Record<string, string | undefined>>;
  /** A folder git's search for the repository never enters (`GIT_CEILING_DIRECTORIES`), for a test's scratch one. */
  ceiling?: string;
}

/** Where the comparison's release came from, and `says`, a phrase naming it and why, for the test's name. */
export interface Source {
  from: "tag" | "list";
  release: string;
  says: string;
}

/** A plain release tag, no prerelease: `vX.Y.Z`. */
const PLAIN = /^v(\d+)\.(\d+)\.(\d+)$/;
const ASK = "run `bun run migrations --released` and commit the list (ADR 0104)";

const LIST = z
  .object({
    release: z.string().regex(PLAIN),
    migrations: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .strict();

/** `a` is a newer version than `b`, both plain tags. */
function newer(a: string, b: string): boolean {
  const [versionA, versionB] = [a, b].map((tag) => (PLAIN.exec(tag) ?? []).slice(1).map(Number));
  for (let i = 0; i < 3; i++) {
    const diff = (versionA?.[i] ?? 0) - (versionB?.[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

type Ran = { started: false } | { started: true; code: number; out: Buffer; err: string };
/** Git run in one folder, as `runner` makes it. */
type Git = (args: string[], input?: string) => Ran;

/** Runs git in `cwd`, as the header says. */
function runner(cwd: string, { git = "git", env = CALLER_ENV, ceiling }: GitOptions): Git {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith("GIT_") && value !== undefined) clean[key] = value;
  }
  clean.LC_ALL = "C";
  if (ceiling !== undefined) clean.GIT_CEILING_DIRECTORIES = ceiling;
  return (args, input = "") => {
    let done: ReturnType<typeof Bun.spawnSync>;
    try {
      done = Bun.spawnSync([git, ...args], {
        cwd,
        env: clean,
        stdin: new TextEncoder().encode(input),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      return { started: false };
    }
    return {
      started: true,
      code: done.exitCode ?? 1,
      out: done.stdout ?? Buffer.alloc(0),
      err: `${done.stderr}`,
    };
  };
}

/** Git's output for `args`, or throws naming the command: git failing in a repository fails the check. */
function output(run: Git, args: string[], input?: string): Buffer {
  const done = run(args, input);
  if (!done.started) throw new Error(`git ${args[0]} could not be started`);
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${done.err.trim()}`);
  return done.out;
}

type Reach = { tag: string; commit: string; head: string } | { noTag: string };

/** T, the newest plain tag merged into HEAD, with its commit and HEAD's; or why there is none. */
function newestTag(run: Git): Reach {
  const head = run(["rev-parse", "HEAD"]);
  if (!head.started) return { noTag: "git can't be started" };
  if (head.code !== 0) {
    if (/not a git repository/.test(head.err)) return { noTag: "not a git repository" };
    throw new Error(`git rev-parse HEAD failed: ${head.err.trim()}`);
  }
  const commit = head.out.toString().trim();
  let best: { tag: string; commit: string } | undefined;
  const refs = output(run, [
    "for-each-ref",
    "--merged=HEAD",
    "--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)",
    "refs/tags/v*",
  ]);
  for (const line of refs.toString().split("\n")) {
    const [tag = "", object = "", peeled = ""] = line.split("\0");
    if (PLAIN.test(tag) && (best === undefined || newer(tag, best.tag)))
      best = { tag, commit: peeled || object };
  }
  return best ? { ...best, head: commit } : { noTag: "no vX.Y.Z tag is reachable from HEAD" };
}

/** The migrations of `folder` at `commit`: one `ls-tree -z`, one `cat-file --batch`. */
function migrationsAt(run: Git, folder: string, commit: string): MigrationHashes {
  const blobs = output(run, ["ls-tree", "-z", commit, "--", `${basename(folder)}/`])
    .toString()
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      // `<mode> <type> <object>\t<path>`
      const tab = line.indexOf("\t");
      const [, type, object = ""] = line.slice(0, tab).split(" ");
      return { type, object, file: basename(line.slice(tab + 1)) };
    })
    .filter(({ type }) => type === "blob");
  if (blobs.length === 0) return {};
  const out = output(run, ["cat-file", "--batch"], blobs.map(({ object }) => `${object}\n`).join(""));
  const migrations: MigrationHashes = {};
  let at = 0;
  for (const { object, file } of blobs) {
    // `<object> blob <size>\n<content>\n`, each blob read by its byte size.
    const header = out.indexOf(10, at);
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(out.subarray(at, header).toString())?.[1];
    if (header < 0 || size === undefined) throw new Error(`git cat-file --batch: ${object} is no blob`);
    migrations[file] = textHash(out.subarray(header + 1, header + 1 + Number(size)));
    at = header + 1 + Number(size) + 1;
  }
  return migrations;
}

/** The list at `list`, or undefined when there is none; throws naming the file when it is malformed. */
function readList(list: string): ReleasedMigrations | undefined {
  if (!existsSync(list)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(list, "utf8"));
  } catch (error) {
    throw new Error(`${list} is not JSON (${error instanceof Error ? error.message : error}): ${ASK}`);
  }
  const parsed = LIST.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${list} is malformed (${issue?.path.join(".") || "its root"}: ${issue?.message}): ${ASK}`,
    );
  }
  return parsed.data;
}

/** The migrations `folder` holds now. */
function workingMigrations(folder: string): MigrationHashes {
  const migrations: MigrationHashes = {};
  for (const file of readdirSync(folder).sort())
    migrations[file] = textHash(readFileSync(`${folder}/${file}`));
  return migrations;
}

/** The first file, in name order, that `a` and `b` hold with different hashes or one holds alone. */
const firstDifference = (a: MigrationHashes, b: MigrationHashes) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().find((file) => a[file] !== b[file]);

/** The `says` of a source that has the list: its file, its release and why it is a source. */
const listSays = (list: string, listed: ReleasedMigrations, why: string) =>
  `${basename(list)} (${listed.release}), as ${why}`;

/** The list as the source, saying why. */
const fromList = (list: string, listed: ReleasedMigrations, why: string) => ({
  source: { from: "list" as const, release: listed.release, says: listSays(list, listed, why) },
  released: [listed],
});

/** The release to compare with, and where it came from; throws when the sources disagree or there is none. */
function releaseOf(
  folder: string,
  list: string,
  options: GitOptions,
): { source: Source; released: ReleasedMigrations[] } {
  const listed = readList(list);
  const run = runner(dirname(folder), options);
  const reach = newestTag(run);
  if ("noTag" in reach) {
    if (listed) return fromList(list, listed, reach.noTag);
    throw new Error(
      `neither a vX.Y.Z tag (${reach.noTag}) nor ${list}: nothing to check the released migrations against; ${ASK}`,
    );
  }
  const { tag, commit, head } = reach;
  const atTag = commit === head;
  // T still holds what it released: a list renamed to a newer release never vouches for an edit to one of T's
  // migrations, nor does the release before's list for an uncommitted edit at T's own commit.
  const besideTag = (listed: ReleasedMigrations, why: string) => ({
    source: {
      from: "list" as const,
      release: listed.release,
      says: `its tag ${tag}, and ${listSays(list, listed, why)}`,
    },
    released: [{ release: tag, migrations: migrationsAt(run, folder, commit) }, listed],
  });
  if (listed && newer(listed.release, tag)) {
    if (atTag) throw new Error(`${list} names ${listed.release}, newer than ${tag}, HEAD's own tag: ${ASK}`);
    return besideTag(listed, `it names a release newer than ${tag}, the newest tag reachable`);
  }
  if (atTag) {
    if (listed) return besideTag(listed, `HEAD is ${tag}'s own commit`);
    throw new Error(
      `neither ${list} nor a release before ${tag}: HEAD is ${tag}'s own commit, where the list is the source; ${ASK}`,
    );
  }
  // A list of another release is behind before the tag is read.
  if (listed?.release !== tag)
    throw new Error(
      `${list} is not ${tag}'s list (it names ${listed?.release ?? "nothing"}), and ${tag} is the last release: ${ASK}`,
    );
  const released = { release: tag, migrations: migrationsAt(run, folder, commit) };
  const differs = firstDifference(listed.migrations, released.migrations);
  if (differs !== undefined)
    throw new Error(`${list}'s hashes differ from its tag ${tag}'s, first at ${differs}: ${ASK}`);
  return { source: { from: "tag", release: tag, says: `its tag ${tag}` }, released: [released] };
}

/** The migrations of `folder` against the last release, as the header says. */
export function checkReleased({ folder, list, ...options }: GitOptions & { folder: string; list: string }): {
  source: Source;
  problems: MigrationProblem[];
} {
  const { source, released } = releaseOf(folder, list, options);
  const current = workingMigrations(folder);
  return { source, problems: problemsAgainst(released, current) };
}

/** The list's text for the newest plain tag merged into HEAD, from the tag alone, as the header says. */
export function releasedList({ folder, ...options }: GitOptions & { folder: string }): {
  release: string;
  text: string;
} {
  const run = runner(dirname(folder), options);
  const reach = newestTag(run);
  if ("noTag" in reach) throw new Error(`no vX.Y.Z tag to write the list from: ${reach.noTag}`);
  const at = migrationsAt(run, folder, reach.commit);
  const migrations: MigrationHashes = {};
  for (const file of Object.keys(at).sort()) migrations[file] = at[file] ?? "";
  return { release: reach.tag, text: `${JSON.stringify({ release: reach.tag, migrations }, null, 2)}\n` };
}
