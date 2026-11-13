// A test's scratch repository runs no background maintenance (ADR 0093): its config says so, plain, bare or cloned,
// and a `GIT_DIR` in the caller's environment (a hook's) never takes the write elsewhere.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quietRepository, scratchRepository } from "./index.ts";

// A few git commands per test: well under a second idle, more when other test runs share the machine.
setDefaultTimeout(15_000);

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-scratch-"));
  made.push(dir);
  return dir;
}

/** Git in `cwd`, in an environment of its own (a hook's `GIT_*` stays out): its output, trimmed. Exit codes in
 * `allowed` count as success (`config --get` answers 1 for a key that isn't set); any other failure throws. */
function git(cwd: string, args: string[], allowed: number[] = [0]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { HOME: cwd, USERPROFILE: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!allowed.includes(r.exitCode))
    throw new Error(`git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

/** One config value of the repository in `cwd` (a work tree or a bare one), `""` when it has none. */
const configOf = (cwd: string, key: string): string => git(cwd, ["config", "--local", "--get", key], [0, 1]);

const quiet = (repo: string) => [configOf(repo, "maintenance.auto"), configOf(repo, "gc.auto")];

test("a plain repository runs no maintenance, on main, with the test identity", () => {
  const repo = folder();
  scratchRepository(repo);
  expect(quiet(repo)).toEqual(["false", "0"]);
  expect(git(repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
  expect(configOf(repo, "user.name")).toBe("Test");
  expect(configOf(repo, "user.email")).toBe("test@example.com");
});

test("a bare repository runs no maintenance", () => {
  const repo = folder();
  scratchRepository(repo, { bare: true });
  expect(configOf(repo, "core.bare")).toBe("true");
  expect(quiet(repo)).toEqual(["false", "0"]);
});

test("a first commit holds the folder's files, on main", () => {
  const repo = folder();
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "sub", "b.txt"), "two\n");
  scratchRepository(repo, { commit: "base" });
  expect(git(repo, ["log", "--format=%s %D", "--name-only"]).split("\n")).toEqual([
    "base HEAD -> main",
    "",
    "a.txt",
    "sub/b.txt",
  ]);
  expect(quiet(repo)).toEqual(["false", "0"]);
});

test("a cloned repository is quieted the same", () => {
  const origin = folder();
  scratchRepository(origin, { bare: true });
  const clone = join(folder(), "clone");
  git(origin, ["clone", "-q", origin, clone]);
  expect(quiet(clone)).toEqual(["", ""]);
  quietRepository(clone);
  expect(quiet(clone)).toEqual(["false", "0"]);
});

test("a GIT_DIR in the caller's environment takes nothing out of the scratch folder", () => {
  const decoy = folder();
  git(decoy, ["init", "-q", "--bare"]);
  const repo = folder();
  writeFileSync(join(repo, "a.txt"), "one\n");
  const env = { HOME: repo, USERPROFILE: repo, GIT_DIR: decoy, GIT_INDEX_FILE: join(decoy, "index") };
  scratchRepository(repo, { commit: "base", env });
  const clone = join(folder(), "clone");
  git(repo, ["clone", "-q", repo, clone]);
  quietRepository(clone, { env });
  expect([...quiet(decoy), configOf(decoy, "user.name"), git(decoy, ["rev-list", "--all"])]).toEqual([
    "",
    "",
    "",
    "",
  ]);
  expect(quiet(repo)).toEqual(["false", "0"]);
  expect(quiet(clone)).toEqual(["false", "0"]);
  expect(git(repo, ["log", "--format=%s"])).toBe("base");
});

test("the git binary given is the one that runs", () => {
  expect(() => scratchRepository(folder(), { git: join(folder(), "no-git-here") })).toThrow("no-git-here");
});
