// The corpus test's cases, built once per content (ADR 0071): each case's repository, built by the real `buildCase`,
// and the lines the change adds at each of its planted bug's places, from git's own diff, kept by `testkit`'s
// `cachedByContent` in this clone's `node_modules/.cache`. The content is everything the build reads: the case, the
// corpus' REVIEW.md, the builder's code and this file's, and the git it runs. A change to any of them builds the case
// again; the same content is read back, with no git. `bun run eval` never comes here: it builds its cases afresh.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitSha } from "@lookover/contracts";
import { cachedByContent } from "@lookover/testkit";
import { z } from "zod";
import { type BuiltCase, buildCase, type EvalCase, type Place, type Planted } from "./index.ts";

/** What a cached case keeps: the built case and each place's added lines, by the place's path. */
export interface CachedCase {
  built: BuiltCase;
  added: Record<string, number[]>;
}

export interface CaseToCache {
  evalCase: EvalCase;
  review: string;
  /** The git program, by absolute path. */
  git: string;
  /** Where the cache lives: this clone's `node_modules/.cache` unless a test gives a scratch one. */
  cache?: string;
}

/** A planted bug's places: its own first, then the others the case lists. */
export const placesOf = (planted: Planted): Place[] => [planted, ...(planted.also ?? [])];

/** Its file in the cache folder: the built case without its folder, and the added lines. */
const KEPT = "case.json";
const Kept = z.object({
  built: z.object({ id: z.string(), name: z.string(), base: z.string(), head: z.string() }),
  added: z.record(z.string(), z.array(z.number())),
});
/** The source files whose code shapes what is kept. */
const CODE = ["build.ts", "cases.ts", "corpus.test-support.ts"].map((f) => join(import.meta.dir, f));

/** The git program's own identity: its path, size and time, so an upgrade of the same path builds again. */
const gitIdentity = (git: string) => {
  try {
    const s = statSync(git);
    return `${git} ${s.size} ${s.mtimeMs}`;
  } catch {
    return `${git} (not found)`;
  }
};

/** Everything a case's build reads, as text: two equal contents are one build. */
export const caseContent = ({ evalCase, review, git }: CaseToCache): string =>
  [JSON.stringify({ evalCase, review }), gitIdentity(git), ...CODE.map((f) => readFileSync(f, "utf8"))].join(
    "\n",
  );

/** The head-side lines the change adds to `path`, from git's own diff (no context lines). */
const addedLines = (git: string, repo: string, env: Record<string, string>, path: string): number[] => {
  const r = spawnSync(git, ["diff", "-U0", "main", "change", "--", path], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git diff ${path}: ${r.stderr}`);
  return r.stdout.split("\n").flatMap((line) => {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) return [];
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    return Array.from({ length: count }, (_, i) => start + i);
  });
};

/**
 * `evalCase` built by `buildCase` and its places' added lines: built now when the cache holds none for its content,
 * else read back. The repository is the cache's: read it, never write it.
 */
export async function cachedCase(c: CaseToCache): Promise<CachedCase> {
  const folder = await cachedByContent(
    {
      name: "lookover-eval-cases",
      content: caseContent(c),
      ...(c.cache === undefined ? {} : { root: c.cache }),
    },
    (into) => {
      const built = buildCase({ evalCase: c.evalCase, review: c.review, root: into, git: c.git });
      const env = { HOME: into, USERPROFILE: into, GIT_CONFIG_NOSYSTEM: "1" };
      const paths = c.evalCase.planted === null ? [] : placesOf(c.evalCase.planted).map((p) => p.path);
      const added = Object.fromEntries(paths.map((p) => [p, addedLines(c.git, built.cloneUrl, env, p)]));
      const { cloneUrl: _, ...kept } = built;
      writeFileSync(join(into, KEPT), JSON.stringify({ built: kept, added }));
    },
  );
  const kept = Kept.parse(JSON.parse(readFileSync(join(folder, KEPT), "utf8")));
  const built: BuiltCase = {
    ...kept.built,
    cloneUrl: join(folder, `${kept.built.name}.git`),
    base: commitSha(kept.built.base),
    head: commitSha(kept.built.head),
  };
  return { built, added: kept.added };
}
