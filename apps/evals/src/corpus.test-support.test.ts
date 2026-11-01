import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedCase, caseContent } from "./corpus.test-support.ts";
import { loadCorpus } from "./index.ts";

// Each build runs git a few times: more than Bun's 5 s on a busy machine.
setDefaultTimeout(30_000);

const GIT = Bun.which("git") ?? "";
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-evals-cached-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const corpus = loadCorpus(join(import.meta.dir, "..", "cases"));
const planted = corpus.cases.find((c) => c.id === "ts-checkout-all");
if (!planted) throw new Error("the corpus has no ts-checkout-all");

const git = (repo: string, ...args: string[]) => {
  const env = { HOME: temp, USERPROFILE: temp, GIT_CONFIG_NOSYSTEM: "1" };
  const r = spawnSync(GIT, args, { cwd: repo, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe("cachedCase", () => {
  const cache = join(temp, "cache");

  test("builds a case once per content: the repository, its commits and each place's added lines", async () => {
    const first = await cachedCase({ evalCase: planted, review: corpus.review, git: GIT, cache });
    expect(git(first.built.cloneUrl, "rev-parse", "refs/heads/change")).toBe(first.built.head);
    expect(first.built.id).toBe(planted.id);
    expect(first.added["src/checkout.ts"]?.length).toBeGreaterThan(0);
    expect(Object.keys(first.added).sort()).toEqual(["src/checkout.ts", "src/store.ts"]);
    const again = await cachedCase({ evalCase: planted, review: corpus.review, git: GIT, cache });
    expect(again).toEqual(first);
  });

  test("builds a case again when its content changes", async () => {
    const before = await cachedCase({ evalCase: planted, review: corpus.review, git: GIT, cache });
    const edited = {
      ...planted,
      change: planted.change.map((f) =>
        f.path === "src/checkout.ts" && "content" in f
          ? { ...f, content: `// one more line\n${f.content}` }
          : f,
      ),
    };
    const after = await cachedCase({ evalCase: edited, review: corpus.review, git: GIT, cache });
    expect(after.built.cloneUrl).not.toBe(before.built.cloneUrl);
    expect(after.built.base).toBe(before.built.base);
    expect(after.built.head).not.toBe(before.built.head);
    expect(after.added["src/checkout.ts"]).toContain(1);
    expect(before.added["src/checkout.ts"]).not.toContain(1);
    expect(git(after.built.cloneUrl, "show", "change:src/checkout.ts")).toStartWith("// one more line");
  });

  test("builds a case again when REVIEW.md changes", async () => {
    const before = await cachedCase({ evalCase: planted, review: corpus.review, git: GIT, cache });
    const after = await cachedCase({
      evalCase: planted,
      review: `${corpus.review}\nOne more rule.\n`,
      git: GIT,
      cache,
    });
    expect(after.built.base).not.toBe(before.built.base);
  });

  test("keys a case on the builder's code and the git it runs, too", () => {
    const content = caseContent({ evalCase: planted, review: corpus.review, git: GIT });
    expect(content).toContain(readFileSync(join(import.meta.dir, "build.ts"), "utf8"));
    expect(content).toContain(readFileSync(join(import.meta.dir, "corpus.test-support.ts"), "utf8"));
    expect(content).toContain(GIT);
    expect(caseContent({ evalCase: planted, review: corpus.review, git: `${GIT}-other` })).not.toBe(content);
  });
});
