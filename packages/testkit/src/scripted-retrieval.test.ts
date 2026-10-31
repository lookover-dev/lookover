import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSha, type FetchSpec, jobId, type RepositoryRef, type RulesFile } from "@lookover/contracts";
import { ScriptedRetrieval } from "./index.ts";

const repo: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
const BASE = commitSha("0123456789abcdef0123456789abcdef01234567");
const PLANTED = commitSha("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
const FIXED = commitSha("4700cffc0000000000000000000000000000cffc");
const fetch: FetchSpec = {
  cloneUrl: "https://github.com/sasensi/lookover-sandbox.git",
  refspecs: ["+refs/heads/*:refs/heads/*"],
  defaultBranch: "main",
  credentials: () => Promise.resolve({ username: "x-access-token", password: "ghs_fake" }),
};
const request = (job: string, head = PLANTED) => ({ repo, job: jobId(job), head, base: BASE, fetch });
/** Pull request #1 of the sandbox, and #1 of the organisation's sandbox of the same name. */
const pr1 = { repo, number: 1 };
const orgPr1 = { repo: { owner: "lookover-dev", name: "lookover-sandbox" }, number: 1 };

const PLANTED_DIFF = "diff --git a/src/total.ts b/src/total.ts\n--- a/src/total.ts\n+++ b/src/total.ts\n";
const FIXED_DIFF = "diff --git a/src/total.ts b/src/total.ts\n+ fixed\n";

/** A real, empty folder as the root: what stays empty after every prepare and dispose. */
const root = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-scripted-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ScriptedRetrieval", () => {
  test("gives each scripted commit of a change its own worktree path under the root, with the diff scripted for it, and writes nothing there", async () => {
    const retrieval = new ScriptedRetrieval({ root });
    retrieval.script(pr1, PLANTED, PLANTED_DIFF);
    retrieval.script(pr1, FIXED, FIXED_DIFF);

    const round1 = await retrieval.prepare(request("id-1"));
    const again = await retrieval.prepare(request("id-2"));
    const round2 = await retrieval.prepare(request("id-3", FIXED));
    await round1.dispose();

    expect(round1).toMatchObject({
      cwd: join(root, "sasensi", "lookover-sandbox", "1", PLANTED),
      diff: PLANTED_DIFF,
      mergeBase: BASE,
      diffFile: ".lookover-change.diff",
    });
    expect(again.cwd).toBe(round1.cwd);
    expect(round2).toMatchObject({
      cwd: join(root, "sasensi", "lookover-sandbox", "1", FIXED),
      diff: FIXED_DIFF,
    });
    expect(retrieval.worktreeOf(pr1, FIXED)).toBe(round2.cwd);
    expect(readdirSync(root)).toEqual([]);
    expect(retrieval.prepared).toEqual([jobId("id-1"), jobId("id-2"), jobId("id-3")]);
    expect(retrieval.disposed).toEqual([jobId("id-1")]);
  });

  test("a commit is one change's: scripted under another, even one of its number in a same-named repository, it is refused; under the same, its diff is replaced", async () => {
    const retrieval = new ScriptedRetrieval({ root: "demo/worktrees" });
    retrieval.script(pr1, PLANTED, PLANTED_DIFF);

    expect(() => retrieval.script({ repo, number: 2 }, PLANTED, FIXED_DIFF)).toThrow(
      "scripted under sasensi/lookover-sandbox#1 already, not sasensi/lookover-sandbox#2",
    );
    expect(() => retrieval.script(orgPr1, PLANTED, FIXED_DIFF)).toThrow(
      "scripted under sasensi/lookover-sandbox#1 already, not lookover-dev/lookover-sandbox#1",
    );
    retrieval.script(pr1, PLANTED, FIXED_DIFF);

    expect(await retrieval.prepare(request("id-1"))).toMatchObject({
      cwd: join("demo/worktrees", "sasensi", "lookover-sandbox", "1", PLANTED),
      diff: FIXED_DIFF,
    });
  });

  test("one number in two same-named repositories of two accounts gives two worktrees", async () => {
    const retrieval = new ScriptedRetrieval({ root: "demo/worktrees" });
    retrieval.script(pr1, PLANTED, PLANTED_DIFF);
    retrieval.script(orgPr1, FIXED, FIXED_DIFF);

    const org = await retrieval.prepare({ ...request("id-1", FIXED), repo: orgPr1.repo });
    expect(org).toMatchObject({
      cwd: join("demo/worktrees", "lookover-dev", "lookover-sandbox", "1", FIXED),
      diff: FIXED_DIFF,
    });
    expect(retrieval.worktreeOf(orgPr1, FIXED)).toBe(org.cwd);
    expect(retrieval.worktreeOf(pr1, PLANTED)).toBe(
      join("demo/worktrees", "sasensi", "lookover-sandbox", "1", PLANTED),
    );
  });

  test("a commit nothing is scripted for gets the default diff (none) at a path of its job's", async () => {
    const retrieval = new ScriptedRetrieval();
    const first = await retrieval.prepare(request("id-1"));
    expect(first).toMatchObject({ cwd: join("worktrees", "id-1"), diff: "" });

    retrieval.diff = PLANTED_DIFF;
    expect((await retrieval.prepare(request("id-2"))).diff).toBe(PLANTED_DIFF);
  });

  test("a repository's scripted rules files come with each of its prepares; another repository's have none", async () => {
    const retrieval = new ScriptedRetrieval();
    const rules: RulesFile[] = [
      { path: "REVIEW.md", text: "- Never log a token.\n", commit: BASE },
      { path: "AGENTS.md", text: "- Tests go through the entry.\n", commit: BASE },
    ];
    retrieval.scriptRules(repo, rules);

    expect((await retrieval.prepare(request("id-1"))).rules).toEqual(rules);
    expect((await retrieval.prepare(request("id-2", FIXED))).rules).toEqual(rules);
    const other = { ...request("id-3"), repo: { owner: "lookover-dev", name: "lookover-private" } };
    expect((await retrieval.prepare(other)).rules).toEqual([]);
  });

  test("refused once, the next prepare throws the error given and the one after answers", async () => {
    const retrieval = new ScriptedRetrieval();
    const error = new Error("fetch_failed: fatal: could not read from remote repository");
    retrieval.refuse(error);

    await expect(retrieval.prepare(request("id-1"))).rejects.toBe(error);

    expect((await retrieval.prepare(request("id-2"))).diff).toBe("");
    expect(retrieval.prepared).toEqual([jobId("id-2")]);
  });
});
