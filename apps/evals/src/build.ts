// The case builder (ADR 0050): a case becomes a local bare repository through one `git fast-import`, written as
// `testkit`'s planted sandbox is, with a fixed identity and fixed dates, so its commits are the same on every
// machine and the recorded answers stay matched to them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitSha } from "@lookover/contracts";
import { lf } from "./cases.ts";
import type { BuiltCase, CaseFile, ChangeFile, EvalCase } from "./types.ts";

/** Who wrote every commit, and when: nothing of the machine's own. The change comes an hour after its base. */
const IDENTITY = "Lookover evals <evals@example.com>";
const BASE_DATE = "2026-10-10T08:00:00Z";
const CHANGE_DATE = "2026-10-10T09:00:00Z";
/** Neutral messages, no trailer: nothing in a commit says what the change does or what it plants. */
const BASE_MESSAGE = "Initial commit";
const CHANGE_MESSAGE = "Update";
const RULES_FILE = "REVIEW.md";

export interface BuildCase {
  evalCase: EvalCase;
  /** The corpus' `REVIEW.md`, committed on `main` beside the base. */
  review: string;
  /** The caller's folder: the case's repository is `<root>/<name>.git`, and nothing is written outside it. */
  root: string;
  /** The git program, by absolute path. */
  git: string;
}

const data = (text: string) => {
  const bytes = Buffer.from(lf(text));
  return [Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from("\n")];
};

const written = (files: (CaseFile | ChangeFile)[]) =>
  files.flatMap((f) =>
    "content" in f
      ? [Buffer.from(`M 100644 inline ${f.path}\n`), ...data(f.content)]
      : [Buffer.from(`D ${f.path}\n`)],
  );

/** One commit of the stream, marked `mark`, on `from` (a mark of the same stream) when given. */
const commit = (ref: string, mark: number, date: string, message: string, files: Buffer[], from?: string) => [
  Buffer.from(`commit ${ref}\nmark :${mark}\n`),
  Buffer.from(`committer ${IDENTITY} ${Date.parse(date) / 1000} +0000\n`),
  ...data(`${message}\n`),
  Buffer.from(from === undefined ? "" : `from ${from}\n`),
  ...files,
];

/** A case's neutral name: the same for the same id, and nothing of the id (which names the bug) shows. */
const neutralName = (id: string) => `case-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;

/**
 * Builds `evalCase` into `<root>/<name>.git` (`name` its neutral name), a bare repository: `main` one commit of the base and `REVIEW.md`,
 * `change` one commit on it writing and deleting the change's files. Texts are written LF. A repository already
 * there is built again from nothing (its commits are the same). Throws when git fails, with git's words.
 */
export function buildCase({ evalCase, review, root, git }: BuildCase): BuiltCase {
  const name = neutralName(evalCase.id);
  const repo = join(root, `${name}.git`);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  // HOME in the caller's folder and no system config: the user's own git config never shapes a commit.
  const env = { HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: "1" };
  const run = (cwd: string, args: string[], input?: Buffer) => {
    const r = spawnSync(git, args, { cwd, env, encoding: "utf8", ...(input === undefined ? {} : { input }) });
    if (r.status !== 0) throw new Error(`building ${evalCase.id}: git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  run(root, ["init", "-q", "--bare", "-b", "main", repo]);
  const base = written([...evalCase.base, { path: RULES_FILE, content: review }]);
  const stream = Buffer.concat([
    ...commit("refs/heads/main", 1, BASE_DATE, BASE_MESSAGE, base),
    ...commit("refs/heads/change", 2, CHANGE_DATE, CHANGE_MESSAGE, written(evalCase.change), ":1"),
  ]);
  run(repo, ["fast-import", "--quiet"], stream);
  // Both refs in one call: a process per case costs more than anything else the builder does.
  const [baseSha = "", headSha = ""] = run(repo, ["rev-parse", "refs/heads/main", "refs/heads/change"]).split(
    /\s+/,
  );
  return { id: evalCase.id, name, cloneUrl: repo, base: commitSha(baseSha), head: commitSha(headSha) };
}
