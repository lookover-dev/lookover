// `scripts/live-sign-in-folder.ts` on a throwaway clone with a worktree (ADR 0073): the live sign-in's folder is
// `LOOKOVER_HOME`'s, else the main checkout's `.dev/data`, whichever checkout of the clone asks.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import { cleanEnv } from "./clean-env.ts";
import { liveSignInFolder } from "./live-sign-in-folder.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** git in `cwd`, outside any hook's reach. */
function git(cwd: string, args: string[]): void {
  const result = spawnSync(["git", ...args], { cwd, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

/** A clone with one commit (its main checkout, `main`) and a worktree of it beside, `worktree`. */
function cloneWithWorktree(): { main: string; worktree: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-sign-in-folder-test-")));
  dirs.push(root);
  const main = join(root, "main");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  git(main, [
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "one",
  ]);
  const worktree = join(root, "worktree");
  git(main, ["worktree", "add", "-q", "-b", "elsewhere", worktree]);
  return { main, worktree };
}

const env = cleanEnv();
delete env.LOOKOVER_HOME;

describe("the live sign-in's folder", () => {
  test("from a worktree: the main checkout's .dev/data", () => {
    const { main, worktree } = cloneWithWorktree();
    expect(liveSignInFolder({ cwd: worktree, env })).toBe(join(main, ".dev", "data"));
  });

  test("from a folder inside the main checkout: its .dev/data", () => {
    const { main } = cloneWithWorktree();
    mkdirSync(join(main, "scripts"));
    expect(liveSignInFolder({ cwd: join(main, "scripts"), env })).toBe(join(main, ".dev", "data"));
  });

  test("from a worktree nested in the main checkout (.claude/worktrees): the main checkout's .dev/data", () => {
    const { main } = cloneWithWorktree();
    const nested = join(main, ".claude", "worktrees", "x");
    git(main, ["worktree", "add", "-q", "-b", "nested", nested]);
    expect(liveSignInFolder({ cwd: nested, env })).toBe(join(main, ".dev", "data"));
  });

  test("LOOKOVER_HOME, made absolute against the folder asking, wins over the main checkout's", () => {
    const { worktree } = cloneWithWorktree();
    expect(liveSignInFolder({ cwd: worktree, env: { ...env, LOOKOVER_HOME: "elsewhere/data" } })).toBe(
      resolve(worktree, "elsewhere/data"),
    );
  });

  test("a stray GIT_DIR in the environment doesn't move it", () => {
    const { main, worktree } = cloneWithWorktree();
    const stray = { ...env, GIT_DIR: join(worktree, "not-a-git-folder") };
    expect(liveSignInFolder({ cwd: worktree, env: stray })).toBe(join(main, ".dev", "data"));
  });

  test("outside a clone: refused, saying so", () => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-sign-in-folder-test-")));
    dirs.push(outside);
    expect(() => liveSignInFolder({ cwd: outside, env })).toThrow(
      `${outside} is not in a clone of Lookover: set LOOKOVER_HOME to the folder whose sign-in live runs use.`,
    );
  });
});
