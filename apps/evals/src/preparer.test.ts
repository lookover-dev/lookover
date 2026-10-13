// The real `prepare`: a case built by git under the build root, then asked of `retrieval` (a fake here: the real
// one is `prepare.test.ts`'s).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrepareRequest, Retrieval } from "@lookover/retrieval";
import { casePreparer, loadCorpus } from "./index.ts";

// It runs git to build the case.
setDefaultTimeout(60_000);

const GIT = Bun.which("git") ?? "";
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-evals-preparer-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

test("builds the case in the build root's repos folder, then prepares that repository", async () => {
  const corpus = loadCorpus(join(import.meta.dir, "..", "cases"));
  const evalCase = corpus.cases.find((c) => c.id === "ts-checkout-all");
  if (!evalCase) throw new Error("the corpus has no ts-checkout-all");
  const asked: PrepareRequest[] = [];
  const retrieval: Retrieval = {
    prepare: (request) => {
      asked.push(request);
      return Promise.resolve({
        cwd: join(temp, "build", "retrieval", "worktrees", "w"),
        diff: "the diff",
        rules: [],
        mergeBase: request.base,
        diffFile: ".lookover-change.diff",
        dispose: () => Promise.resolve(),
      });
    },
  };
  const prepare = casePreparer({
    review: corpus.review,
    buildRoot: join(temp, "build"),
    git: GIT,
    retrieval,
  });
  const prepared = await prepare(evalCase, new AbortController().signal);
  const [request] = asked;
  expect(request?.fetch.cloneUrl.startsWith(join(temp, "build", "repos"))).toBe(true);
  expect(existsSync(request?.fetch.cloneUrl ?? "")).toBe(true);
  expect(String(prepared.head)).toBe(String(request?.head));
  expect(prepared.diff).toBe("the diff");
});
