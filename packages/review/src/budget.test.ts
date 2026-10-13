// The prompt within each engine's input limit, through the entry: a diff too long to send whole is cut at a file,
// the files left out named for the engine to read in the worktree, rather than refused by the CLI (codex-cli
// 0.154.0 refuses an input over 1,048,576 characters: "Input exceeds the maximum length", seen live on PR #100).
import { expect, test } from "bun:test";
import { commitSha, type EngineId, jobId, type ReviewJob } from "@lookover/contracts";
import { FakeEngines } from "@lookover/testkit";
import { createReview, type ReviewPolicy } from "./index.ts";

const job: ReviewJob = {
  id: jobId("job-1"),
  sha: commitSha("3c1d9a0"),
  trigger: "manual",
  state: "running",
  deferral: null,
  stepIn: null,
  skip: null,
  cancel: null,
  failure: null,
  turn: null,
};

const policy: ReviewPolicy = {
  engine: "codex",
  round: 1,
  earlier: [],
  timeoutMs: 60_000,
  pass: "find",
  artefactsDir: "/tmp/lookover/runs/run-1",
  rules: [],
};

/** A diff of `files` new files `src/f<i>.ts`, each `lines` lines long: about 25 characters a line. */
function bigDiff(files: number, lines: number): string {
  const file = (i: number) =>
    [
      `diff --git a/src/f${i}.ts b/src/f${i}.ts`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/src/f${i}.ts`,
      `@@ -0,0 +1,${lines} @@`,
      ...Array.from({ length: lines }, (_, n) => `+export const v${n} = ${n};`),
    ].join("\n");
  return `${Array.from({ length: files }, (_, i) => file(i)).join("\n")}\n`;
}

/** The prompt one pass on `engine` sends for `diff`, the review built with `inputLimits`. */
async function promptFor(
  diff: string,
  inputLimits?: Partial<Record<EngineId, number>>,
  engine: EngineId = "codex",
): Promise<string> {
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: '```json\n{"findings": []}\n```' });
  const review = createReview({ engines, ...(inputLimits === undefined ? {} : { inputLimits }) });
  await review.run(job, { cwd: "/tmp/w", diff }, { ...policy, engine }, new AbortController().signal);
  return engines.runs[0]?.prompt ?? "";
}

test("a prompt within the engine's input limit is the whole prompt, as with no limit", async () => {
  const diff = bigDiff(3, 10);
  const whole = await promptFor(diff);
  expect(await promptFor(diff, { codex: whole.length })).toBe(whole);
});

test("a prompt over the engine's input limit is cut at a file: the files that fit, the others named to read in the worktree", async () => {
  const diff = bigDiff(5, 40);
  // What the prompt holds around the diff, plus about two and a half files of 1,100 characters.
  const limit = (await promptFor("")).length + 2_900;
  const prompt = await promptFor(diff, { codex: limit });
  expect(prompt.length).toBeLessThanOrEqual(limit);
  expect(prompt).toContain("diff --git a/src/f0.ts b/src/f0.ts");
  expect(prompt).toContain("+export const v39 = 39;");
  expect(prompt).not.toContain("diff --git a/src/f4.ts");
  expect(prompt).toContain("The diff is too long to send whole. It shows the first 2 of its 5 files;");
  expect(prompt).toContain("\n- src/f2.ts\n- src/f3.ts\n- src/f4.ts\n");
  // Another engine, with no limit given, gets the whole diff.
  expect(await promptFor(diff, { codex: limit }, "claude")).toContain("diff --git a/src/f4.ts");
});

test("a first file longer than the limit on its own is cut at a line, and the prompt says so", async () => {
  const diff = bigDiff(2, 400);
  const limit = (await promptFor("")).length + 3_000;
  const prompt = await promptFor(diff, { codex: limit });
  expect(prompt.length).toBeLessThanOrEqual(limit);
  expect(prompt).toContain("diff --git a/src/f0.ts b/src/f0.ts");
  expect(prompt).toContain("+export const v0 = 0;\n");
  expect(prompt).not.toContain("+export const v399 = 399;");
  expect(prompt).toContain("The diff is too long to send whole. It shows the start of src/f0.ts, cut short;");
  expect(prompt).toContain("\n- src/f0.ts\n- src/f1.ts\n");
});

test("a file left out, a deleted one included, is to be read in the whole diff saved in the working directory", async () => {
  const deleted = [
    "diff --git a/src/old.ts b/src/old.ts",
    "deleted file mode 100644",
    "--- a/src/old.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-export const gone = 1;",
    "-export const alsoGone = 2;",
    "",
  ].join("\n");
  const diff = bigDiff(2, 40) + deleted;
  const engines = new FakeEngines();
  engines.answer({ outcome: "ok", text: '```json\n{"findings": []}\n```' });
  // Room for one file of about 1,100 characters, and the note naming the two left out.
  const limit = (await promptFor("")).length + 1_800;
  await createReview({ engines, inputLimits: { codex: limit } }).run(
    job,
    { cwd: "/tmp/w", diff },
    { ...policy, diffFile: ".lookover-change.diff" },
    new AbortController().signal,
  );
  const prompt = engines.runs[0]?.prompt ?? "";
  expect(prompt.length).toBeLessThanOrEqual(limit);
  expect(prompt).not.toContain("-export const gone = 1;");
  expect(prompt).toContain("\n- src/old.ts\n");
  expect(prompt).toContain(
    "The whole diff, removed lines and deleted files included, is in `.lookover-change.diff` in the working directory: read the files not shown there. It is Lookover's copy of the diff, not part of the change.",
  );
});

test("a change of thousands of files names the first hundred left out, and how many more", async () => {
  const diff = bigDiff(150, 3);
  const limit = (await promptFor("")).length + 8_000;
  const prompt = await promptFor(diff, { codex: limit });
  expect(prompt.length).toBeLessThanOrEqual(limit);
  expect(prompt).toMatch(/\n- src\/f\d+\.ts\n- and \d+ more files\n/);
});
