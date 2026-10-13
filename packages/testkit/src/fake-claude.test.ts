// The fake `claude` program on several recordings: which one a run replays, and where its reads land.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeClaude } from "./index.ts";

const RECORDINGS = resolve(import.meta.dir, "..", "fake-claude", "recordings");
const recorded = (name: string) => readFileSync(join(RECORDINGS, name, "run.stdout.jsonl"), "utf8");

/** Runs the fake as `engines` would, with `prompt` on stdin, and gives what it printed and the folder it ran in. */
function run(prompt: string): { stdout: string; cwd: string } {
  const { executable, args } = fakeClaude("review", "review-round-2");
  const cwd = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-fake-"));
  try {
    const result = Bun.spawnSync([executable, ...args, "-p"], { cwd, stdin: Buffer.from(prompt) });
    return { stdout: result.stdout.toString(), cwd };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const ROUND_1 =
  "Head commit: 703205dec59961a3a08427d7b4af007e278451a4, round 1 of this pull request's review.";
const ROUND_2 =
  "Head commit: 4700cffcc191fa0290cc7d91340f924a74c7f803, round 2 of this pull request's review.";

/** The `file_path` of each `Read` the stream holds. */
const readsOf = (stdout: string): unknown[] =>
  [...stdout.matchAll(/"name":"Read","input":\{"file_path":("(?:[^"\\]|\\.)*")/g)].map((m) =>
    JSON.parse(m[1] ?? '""'),
  );

test("a run replays the recording whose `when` the prompt holds, else the first without one", () => {
  // The round-2 recording names the fix commit it reviewed (its meta.json `when`): its init line comes out.
  expect(run(ROUND_2).stdout.split("\n")[0]).toBe(recorded("review-round-2").split("\n")[0]);
  // Round 1 read no file: it comes out as recorded.
  expect(run(ROUND_1).stdout).toBe(recorded("review"));
});

test("a file the recording read in its worktree is read in the folder the fake runs in", () => {
  const { stdout, cwd } = run(ROUND_2);
  expect(readsOf(recorded("review-round-2"))).toEqual([
    "~\\AppData\\Local\\Temp\\lookover-record-CPLgRc\\review-Mc8Mx3\\repos\\worktrees\\record\\src\\invoices.ts",
  ]);
  expect(readsOf(stdout)).toEqual([`${cwd}\\src\\invoices.ts`]);
});
