import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSha } from "@lookover/contracts";
import { createProcessRunner } from "@lookover/process";
import { createRetrieval, type PrepareRequest, type Retrieval } from "@lookover/retrieval";
import { buildCase, loadCorpus, prepareCase } from "./index.ts";

// A real prepare: a fetch, a worktree and a diff, several gits.
setDefaultTimeout(60_000);

const GIT = Bun.which("git") ?? "";
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-evals-prepare-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const corpus = loadCorpus(join(import.meta.dir, "..", "cases"));
const planted = corpus.cases.find((c) => c.id === "ts-checkout-all");
if (!planted) throw new Error("the corpus has no ts-checkout-all");

describe("prepareCase", () => {
  test("asks retrieval for the built repository, fetched from its path with empty credentials", async () => {
    const asked: PrepareRequest[] = [];
    const fake: Retrieval = {
      prepare: (request) => {
        asked.push(request);
        return Promise.resolve({
          cwd: "worktree",
          diff: "the diff",
          rules: [],
          mergeBase: request.base,
          diffFile: ".lookover-change.diff",
          dispose: () => Promise.resolve(),
        });
      },
    };
    const built = {
      id: "ts-checkout-all",
      name: "case-1234abcd",
      cloneUrl: join(temp, "elsewhere.git"),
      base: commitSha("1111111"),
      head: commitSha("2222222"),
    };
    const prepared = await prepareCase(fake, built);
    expect({
      cwd: prepared.cwd,
      diff: prepared.diff,
      diffFile: prepared.diffFile,
      head: prepared.head,
    }).toEqual({ cwd: "worktree", diff: "the diff", diffFile: ".lookover-change.diff", head: built.head });
    const [request] = asked;
    expect(request?.head).toBe(built.head);
    expect(request?.base).toBe(built.base);
    // The case's id names its bug: the job and the repository, which the worktree's path shows, never carry it.
    expect(request?.repo).toEqual({ owner: "evals", name: "case-1234abcd" });
    expect(String(request?.job)).toBe("case-1234abcd");
    expect(request?.fetch.cloneUrl).toBe(built.cloneUrl);
    expect(request?.fetch.defaultBranch).toBe("main");
    expect(await request?.fetch.credentials()).toEqual({ username: "", password: "" });
  });

  test("on real git: the worktree at the change, its diff, and REVIEW.md from main", async () => {
    // HOME in the folder and an environment of the test's own: no `GIT_*` of a hook reaches git.
    const env = { HOME: temp, USERPROFILE: temp, GIT_CONFIG_NOSYSTEM: "1" };
    const built = buildCase({
      evalCase: planted,
      review: corpus.review,
      root: join(temp, "built"),
      git: GIT,
    });
    const retrieval = createRetrieval({
      root: join(temp, "retrieval"),
      runner: createProcessRunner({ registryFile: join(temp, "processes.json") }),
      git: GIT,
      env,
    });
    const prepared = await prepareCase(retrieval, built);
    expect(prepared.head).toBe(built.head);
    expect(prepared.diff).toContain("+++ b/src/checkout.ts");
    expect(prepared.diff).toContain("+    saveOrder(order);\n");
    expect(prepared.diff).not.toContain("REVIEW.md");
    expect(prepared.rules).toEqual([{ path: "REVIEW.md", text: corpus.review, commit: built.base }]);
    expect(readFileSync(join(prepared.cwd, "src", "checkout.ts"), "utf8")).toContain(
      "export async function checkoutAll",
    );
    expect(prepared.cwd.startsWith(join(temp, "retrieval"))).toBe(true);
    expect(prepared.cwd).not.toContain(planted.id);
    expect(prepared.diffFile).toMatch(/^\.lookover-change-[0-9a-f]{16}\.diff$/);
    expect(existsSync(join(prepared.cwd, prepared.diffFile))).toBe(true);
    await prepared.dispose();
    expect(existsSync(prepared.cwd)).toBe(false);
  });
});
