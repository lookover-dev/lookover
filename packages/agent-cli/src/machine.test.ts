// The machine's side of `lookover`: the checkout read with real `git` in a temporary repository, and where the
// agent's token comes from. Git runs in a hand-built environment, so nothing of this process's own reaches it
// (a hook's `GIT_DIR` would point it at this repository instead).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSha } from "@lookover/contracts";
import { agentToken, realWorld } from "./index.ts";

// A few git processes per test: Bun's 5 s fails them on a busy machine.
setDefaultTimeout(30_000);

const home = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-agent-cli-home-"));
const env = { HOME: home, USERPROFILE: home };
const folders: string[] = [home];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** A fresh repository with one commit on `branch` and `origin` at `url`. Returns its folder. */
function checkout(url: string | null, branch = "feature/unpaid"): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-agent-cli-"));
  folders.push(dir);
  const git = (...args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
    return done.stdout.toString().trim();
  };
  git("init", "--quiet", "--initial-branch", branch);
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "One",
  );
  if (url !== null) git("remote", "add", "origin", url);
  return dir;
}

/** The checkout's `origin` is now `url`, whatever it was: one git run, where `remote add` makes it. */
function setOrigin(dir: string, url: string): void {
  const set = Bun.spawnSync(["git", "config", "remote.origin.url", url], { cwd: dir, env, stderr: "pipe" });
  if (set.exitCode !== 0) throw new Error(`git config remote.origin.url ${url}: ${set.stderr.toString()}`);
}

const sha = (dir: string) =>
  commitSha(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir, env, stdout: "pipe" }).stdout.toString().trim(),
  );

describe("realWorld: the checkout through git", () => {
  test("the head commit, the branch and the origin's repository", async () => {
    const dir = checkout("https://github.com/sasensi/lookover-sandbox.git");
    const git = realWorld(dir, env).git;
    expect(await git.head()).toBe(sha(dir));
    expect(await git.branch()).toBe("feature/unpaid");
    expect(await git.origin()).toEqual({ owner: "sasensi", name: "lookover-sandbox" });
  });

  test("every way GitHub's remote is written names the same repository", async () => {
    // One checkout, its origin set to each form in turn: a repository costs three git runs.
    const dir = checkout(null);
    for (const url of [
      "git@github.com:lookover-dev/lookover-private.git",
      "ssh://git@github.com/lookover-dev/lookover-private",
      "https://x-access-token@github.com/lookover-dev/lookover-private",
    ]) {
      setOrigin(dir, url);
      expect(await realWorld(dir, env).git.origin()).toEqual({
        owner: "lookover-dev",
        name: "lookover-private",
      });
    }
  });

  test("a detached head has no branch; no origin, or one off GitHub, is an error", async () => {
    const dir = checkout(null);
    Bun.spawnSync(["git", "checkout", "--quiet", "--detach"], { cwd: dir, env });
    expect(await realWorld(dir, env).git.branch()).toBeNull();
    await expect(realWorld(dir, env).git.origin()).rejects.toThrow("This checkout has no origin remote.");
    setOrigin(dir, "https://gitlab.com/a/b.git");
    await expect(realWorld(dir, env).git.origin()).rejects.toThrow(
      "The origin remote (https://gitlab.com/a/b.git) is not on GitHub.",
    );
  });

  test("a folder that is no repository has no head", async () => {
    const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-agent-cli-"));
    folders.push(dir);
    await expect(realWorld(dir, env).git.head()).rejects.toThrow("No commit checked out");
  });
});

describe("agentToken", () => {
  const gh = () => "gho_from_gh";
  test("GH_TOKEN first, then GITHUB_TOKEN, then gh auth token", () => {
    expect(agentToken({ GH_TOKEN: "a", GITHUB_TOKEN: "b" }, gh)).toBe("a");
    expect(agentToken({ GITHUB_TOKEN: "b" }, gh)).toBe("b");
    expect(agentToken({ GH_TOKEN: "" }, gh)).toBe("gho_from_gh");
  });

  test("none at all is an error that says how to get one", () => {
    expect(() => agentToken({}, () => null)).toThrow(
      "No GitHub token: set GH_TOKEN, or sign in with gh auth login.",
    );
  });
});
