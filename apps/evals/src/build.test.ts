import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCase, loadCorpus, parseCase } from "./index.ts";

// Each test runs git a few times: more than Bun's 5 s on a busy machine.
setDefaultTimeout(30_000);

const GIT = Bun.which("git") ?? "";
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-evals-build-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const CASES = join(import.meta.dir, "..", "cases");
const corpus = loadCorpus(CASES);
const planted = corpus.cases.find((c) => c.id === "ts-checkout-all");
if (!planted) throw new Error("the corpus has no ts-checkout-all");

/** Git on a built repository, in an environment of the test's own: nothing of this process's `GIT_*` reaches it. */
const git = (repo: string, ...args: string[]) => {
  const env = { HOME: temp, USERPROFILE: temp, GIT_CONFIG_NOSYSTEM: "1" };
  const r = spawnSync(GIT, args, { cwd: repo, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const root = (name: string) => mkdtempSync(join(temp, `${name}-`));

describe("buildCase", () => {
  test("gives the same commits for the same case, on every machine", () => {
    const first = buildCase({ evalCase: planted, review: corpus.review, root: root("a"), git: GIT });
    const again = buildCase({ evalCase: planted, review: corpus.review, root: root("b"), git: GIT });
    // Pinned: a change to the builder, the case or REVIEW.md moves them, and the recorded answers go stale.
    expect([String(first.base), String(first.head)]).toEqual([
      "f413a347cd3ff269a7c9013ce1dd6d80fc54bd07",
      "283063438d280f0ee5273e7443557a87e0c73295",
    ]);
    expect({ base: again.base, head: again.head }).toEqual({ base: first.base, head: first.head });
  });

  test("gives the same commits from a case file checked out with CRLF line ends", () => {
    const text = readFileSync(join(CASES, "ts-checkout-all.yaml"), "utf8").replaceAll("\r\n", "\n");
    const crlf = parseCase("ts-checkout-all.yaml", text.replaceAll("\n", "\r\n"));
    const lf = buildCase({ evalCase: planted, review: corpus.review, root: root("lf"), git: GIT });
    const fromCrlf = buildCase({
      evalCase: crlf,
      review: corpus.review.replaceAll("\n", "\r\n"),
      root: root("crlf"),
      git: GIT,
    });
    expect(fromCrlf.head).toBe(lf.head);
  });

  test("main holds the base and REVIEW.md; change holds one neutral commit on it", () => {
    const where = root("layout");
    const built = buildCase({ evalCase: planted, review: corpus.review, root: where, git: GIT });
    expect(built.cloneUrl.startsWith(where)).toBe(true);
    // A neutral name: the case's id names its bug, and an engine that reads around could see the path.
    expect(built.name).toMatch(/^case-[0-9a-f]{8}$/);
    expect(readdirSync(where)).toEqual([`${built.name}.git`]);
    expect(built.cloneUrl).not.toContain(planted.id);
    expect(git(built.cloneUrl, "rev-parse", "refs/heads/main")).toBe(built.base);
    expect(git(built.cloneUrl, "rev-parse", "refs/heads/change")).toBe(built.head);
    expect(git(built.cloneUrl, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual([
      "REVIEW.md",
      "src/checkout.ts",
      "src/store.ts",
    ]);
    expect(git(built.cloneUrl, "show", "main:REVIEW.md")).toBe(corpus.review.trim());
    expect(git(built.cloneUrl, "rev-list", "main..change").split("\n")).toEqual([built.head]);
    expect(git(built.cloneUrl, "log", "-1", "--format=%B", "change")).toBe("Update");
    expect(git(built.cloneUrl, "diff", "--name-status", "main", "change").split("\n")).toEqual([
      "M\tsrc/checkout.ts",
      "M\tsrc/store.ts",
    ]);
  });

  test("deletes a file the change deletes", () => {
    const evalCase = {
      ...planted,
      id: "deletes",
      change: [
        ...planted.change.filter((f) => f.path !== "src/store.ts"),
        { path: "src/store.ts", deleted: true as const },
      ],
    };
    const built = buildCase({ evalCase, review: corpus.review, root: root("deletes"), git: GIT });
    expect(git(built.cloneUrl, "diff", "--name-status", "main", "change").split("\n")).toEqual([
      "M\tsrc/checkout.ts",
      "D\tsrc/store.ts",
    ]);
  });

  test("builds a case again over the one already there", () => {
    const where = root("again");
    const first = buildCase({ evalCase: planted, review: corpus.review, root: where, git: GIT });
    expect(buildCase({ evalCase: planted, review: corpus.review, root: where, git: GIT })).toEqual(first);
  });
});
