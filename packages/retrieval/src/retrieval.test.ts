// `retrieval` through its entry, with real git and no network, on the test host of `retrieval.test-support.ts`:
// the prepare itself, the mirror, the fetch, the token and failures. The rules files' tests are in `rules.test.ts`,
// a file of its own so the two run on separate workers.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommitSha, FetchSpec, ProcessRunner } from "@lookover/contracts";
import { commitSha, HostError, jobId } from "@lookover/contracts";
import { createRetrieval, RetrievalError } from "@lookover/retrieval";
import {
  credentials,
  GIT,
  gitDirOf,
  headOf,
  importCommits,
  REPO,
  setupGit,
  TOKEN,
  testHost,
  USER,
} from "./retrieval.test-support.ts";

// The tests run one after the other, so each limit times its own prepares: a few hundred ms of real git on an
// idle machine, past Bun's 5 s on one busy with other checks. Tests that only read what one prepare gave share it
// (`shared`), each keeping its own name and expectations.
setDefaultTimeout(15_000);

const { r, fetchSpec, data, request, shared, refsOf, holds } = testHost();

/** Where `firstPrepare`'s environment points `GIT_DIR`: a repository of its own in the data root. */
const elsewhereOf = (root: string) => join(root, "elsewhere.git");

/**
 * The change's head prepared on an empty data root (the first fetch: `init`, then the fetch), with a `GIT_DIR`
 * and a `GIT_WORK_TREE` in the environment, pointing elsewhere.
 */
const firstPrepare = shared(() => request("job-1"), {
  env: (root) => {
    setupGit(r.env, root, "init", "-q", "--bare", elsewhereOf(root));
    return { ...r.env, GIT_DIR: elsewhereOf(root), GIT_WORK_TREE: root };
  },
});

/** The diff with its `index <blob>..<blob>` line made constant: blob ids are not written by hand. */
const withoutBlobIds = (diff: string) => diff.replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, "index <blobs>");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const base64 = (text: string) => Buffer.from(text).toString("base64");
/** The token as sent (a basic credential), on its own, and raw. */
const TOKEN_FORMS = [TOKEN, base64(TOKEN), base64(`${USER}:${TOKEN}`)];
const holdsToken = (content: Buffer | string) => TOKEN_FORMS.some((form) => content.includes(form));

test("prepare gives the worktree at the head commit and the diff from the merge base", async () => {
  const { prepared } = await firstPrepare();

  expect(headOf(prepared.cwd)).toBe(r.b);
  expect(readFileSync(join(prepared.cwd, "greeting.txt"), "utf8")).toBe("hello\nworld\n");
  expect(prepared.mergeBase).toBe(r.a);
  // `c`'s other.txt is not in the diff: the diff is from the merge base, not from main's tip.
  expect(withoutBlobIds(prepared.diff)).toBe(
    [
      "diff --git a/greeting.txt b/greeting.txt",
      "index <blobs> 100644",
      "--- a/greeting.txt",
      "+++ b/greeting.txt",
      "@@ -1 +1,2 @@",
      " hello",
      "+world",
      "",
    ].join("\n"),
  );
  // The whole diff is also a file inside the worktree, for an engine shown only part of it (it can't run git):
  // at its root, under a name of its own each time, so the change can't hold a file or a link there.
  expect(prepared.diffFile).toMatch(/^\.lookover-change-[0-9a-f]{16}\.diff$/);
  expect(readFileSync(join(prepared.cwd, prepared.diffFile), "utf8")).toBe(prepared.diff);
});

test("a file the change tracks at the diff file's old name is left as it is", async () => {
  const prepared = await data({ seeded: true }).retrieval().prepare(request("job-17", r.tracked));

  expect(readFileSync(join(prepared.cwd, ".lookover-change.diff"), "utf8")).toBe("tracked\n");
  expect(prepared.diffFile).not.toBe(".lookover-change.diff");
  expect(readFileSync(join(prepared.cwd, prepared.diffFile), "utf8")).toBe(prepared.diff);
});

test("a link the change holds at the diff file's old name is checked out as a plain file: its target stays", async () => {
  const prepared = await data({ seeded: true }).retrieval().prepare(request("job-18", r.linked));

  // Checked out as a plain file holding the link's target, though the user's git checks links out as links.
  const old = join(prepared.cwd, ".lookover-change.diff");
  expect(lstatSync(old).isSymbolicLink()).toBe(false);
  expect(readFileSync(old, "utf8")).toBe(r.target.replaceAll("\\", "/"));
  expect(readFileSync(r.target, "utf8")).toBe("the service's own file\n");
  expect(lstatSync(join(prepared.cwd, prepared.diffFile)).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(prepared.cwd, prepared.diffFile), "utf8")).toBe(prepared.diff);
});

/**
 * The hostile setup's folder, where its scripts are: its name holds a space, as a user's folder may
 * (`C:\Users\Your Name`), so the scripts' paths are quoted for the shell git runs them through.
 */
const hostileDir = mkdtempSync(join(tmpdir(), "lookover hostile-"));

afterAll(() => rmSync(hostileDir, { recursive: true, force: true }));

/** What the hostile setup's scripts write when git runs them: a hook, the LFS filter, the fsmonitor. */
const MARKERS = ["post-checkout", "lfs", "fsmonitor"];

/**
 * A user whose global git configuration runs code (a hooks folder, an LFS filter, an fsmonitor), checks
 * links out as links, recurses into submodules and allows them from local paths; and a remote whose `hostile`
 * branch meets it: a file under the LFS filter, a submodule of a local repository, and a link.
 */
function hostileSetup() {
  const dir = hostileDir;
  const posix = (path: string) => path.replaceAll("\\", "/");
  const markerOf = (name: string) => join(dir, `${name}.marker`);
  const script = (name: string, path: string, then = "") =>
    writeFileSync(path, `#!/bin/sh\necho ran >> "${posix(markerOf(name))}"\n${then}`, { mode: 0o755 });
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  script("post-checkout", join(hooks, "post-checkout"));
  // Writes its marker and leaves: git counts the filter failed, and goes on when the filter isn't required.
  script("lfs", join(dir, "lfs.sh"));
  script("fsmonitor", join(dir, "fsmonitor.sh"));
  const home = join(dir, "home");
  mkdirSync(home);
  // A command git runs through the shell: its path in single quotes, which git's config reader keeps.
  const command = (path: string) => `'${posix(path)}'`;
  writeFileSync(
    join(home, ".gitconfig"),
    [
      "[core]",
      `\thooksPath = ${posix(hooks)}`,
      "\tsymlinks = true",
      `\tfsmonitor = ${command(join(dir, "fsmonitor.sh"))}`,
      '[filter "lfs"]',
      // The long-running process comes before a smudge (and an empty one is no filter at all): both named.
      `\tprocess = ${command(join(dir, "lfs.sh"))}`,
      `\tsmudge = ${command(join(dir, "lfs.sh"))}`,
      "\trequired = true",
      "[submodule]",
      "\trecurse = true",
      "[protocol]",
      "\tallow = always",
      '[protocol "file"]',
      "\tallow = always",
      "",
    ].join("\n"),
  );
  const sub = join(dir, "sub.git");
  setupGit(r.env, dir, "init", "-q", "--bare", "-b", "main", sub);
  const [subCommit] = importCommits(r.env, sub, [
    { ref: "refs/heads/main", message: "s", files: { "inside.txt": "from the submodule\n" } },
  ]);
  const origin = join(dir, "origin.git");
  setupGit(r.env, dir, "init", "-q", "--bare", "-b", "main", origin);
  const [base, head] = importCommits(r.env, origin, [
    { ref: "refs/heads/main", message: "a", files: { "greeting.txt": "hello\n" } },
    {
      ref: "refs/heads/hostile",
      from: ":1",
      message: "b",
      files: {
        ".gitattributes": "*.bin filter=lfs\n",
        "data.bin": "smudge me\n",
        ".gitmodules": `[submodule "sub"]\n\tpath = sub\n\turl = ${posix(sub)}\n`,
      },
      links: { "link.txt": "greeting.txt" },
      entries: { sub: { mode: "160000", id: subCommit ?? "" } },
    },
  ]);
  if (!base || !head) throw new Error("setup: git fast-import wrote fewer commits than asked");
  // The shell on PATH, as on the user's machine: git runs a filter's command through it.
  const env = { HOME: home, USERPROFILE: home, PATH: dirname(Bun.which("sh") ?? "") };
  const markers = () => MARKERS.filter((name) => existsSync(markerOf(name)));
  return { origin, base, head, env, markers };
}

test("a hostile repository meeting the user's global git settings runs nothing: no hook, filter, submodule or link", async () => {
  const hostile = hostileSetup();
  const { root, retrieval } = data();

  const prepared = await retrieval([], hostile.env).prepare({
    repo: REPO,
    job: jobId("job-30"),
    head: hostile.head,
    base: hostile.base,
    fetch: { ...fetchSpec(), cloneUrl: hostile.origin },
  });
  const sub = join(prepared.cwd, "sub");
  const seen = {
    // The file under the LFS filter as the commit holds it, never smudged.
    data: readFileSync(join(prepared.cwd, "data.bin"), "utf8"),
    // The submodule's folder, if any, holds nothing: no clone of it, in the worktree or the mirror.
    sub: existsSync(sub) ? readdirSync(sub) : [],
    modules: filesUnder(root).filter((path) => /[\\/]modules[\\/]/.test(path)),
    // A plain file holding the link's target (on Windows that is git for Windows' default: trivially so there).
    link: lstatSync(join(prepared.cwd, "link.txt")).isSymbolicLink(),
    linkText: readFileSync(join(prepared.cwd, "link.txt"), "utf8"),
  };
  await prepared.dispose();
  const markers = hostile.markers();
  // The control: the same commands without the safe options, under the same user, run every script the setup
  // plants (the LFS filter not required, so the checkout its script fails goes on to the hook).
  const plain = join(hostileDir, "plain.git");
  setupGit(hostile.env, hostileDir, "clone", "-q", "--bare", hostile.origin, plain);
  const worktree = join(hostileDir, "plain");
  setupGit(
    hostile.env,
    plain,
    "-c",
    "filter.lfs.required=false",
    "worktree",
    "add",
    "-q",
    "--detach",
    worktree,
    hostile.head,
  );

  expect({ ...seen, markers }).toEqual({
    data: "smudge me\n",
    sub: [],
    modules: [],
    link: false,
    linkText: "greeting.txt",
    markers: [],
  });
  expect(hostile.markers()).toEqual(MARKERS);
});

test("a second prepare reuses the mirror and sees what was pushed since", async () => {
  const { root, retrieval } = data({ seeded: true });
  const retrieve = retrieval();
  const first = await retrieve.prepare(request("job-2a"));
  const d = pushAnotherCommit();

  const second = await retrieve.prepare(request("job-2b", d));

  expect(headOf(second.cwd)).toBe(d);
  expect(readdirSync(join(root, "mirrors", REPO.owner))).toEqual([`${REPO.name}.git`]);
  expect(dirname(gitDirOf(second.cwd))).toBe(dirname(gitDirOf(first.cwd)));
  // One worktree per job: the first stays until its job disposes it.
  expect(headOf(first.cwd)).toBe(r.b);
});

test("two prepares of one repository at once run one after the other: no two gits on the mirror together", async () => {
  const { runner, retrieval } = data({ seeded: true });
  const real = runner();
  let running = 0;
  let most = 0;
  const counting: ProcessRunner = {
    start: (invocation, limits) => {
      running += 1;
      most = Math.max(most, running);
      const started = real.start(invocation, limits);
      return {
        ...started,
        result: started.result.finally(() => {
          running -= 1;
        }),
      };
    },
    sweepOrphans: () => real.sweepOrphans(),
  };
  const retrieve = retrieval([], r.env, counting);

  const [first, second] = await Promise.all([
    retrieve.prepare(request("job-14a")),
    retrieve.prepare(request("job-14b", r.d)),
  ]);

  expect(most).toBe(1);
  expect(headOf(first.cwd)).toBe(r.b);
  expect(headOf(second.cwd)).toBe(r.d);
});

test("a base the host doesn't have fails at the fetch, cleanly, and doesn't hold the next prepare of the repository", async () => {
  const { mirror, retrieval } = data({ seeded: true });
  const log: string[] = [];
  const retrieve = retrieval(log);
  // A base branch force-pushed on the host since the job was made: its old commit is gone.
  const missing = commitSha("0123456789abcdef0123456789abcdef01234567");

  const [failed, prepared] = await Promise.allSettled([
    retrieve.prepare({ ...request("job-15a"), base: missing }),
    retrieve.prepare(request("job-15b")),
  ]);

  expect(failed).toMatchObject({
    status: "rejected",
    reason: { problem: "fetch_failed", detail: expect.stringContaining(missing) },
  });
  expect(prepared.status).toBe("fulfilled");
  // The default branch is there: the failure is the base's, so no second fetch without the branch.
  expect(log.filter((line) => line.startsWith("git fetch"))).toHaveLength(2);
  expect(refsOf(mirror)).toContain("refs/lookover/default");
  expect(refsOf(mirror).filter((ref) => ref.startsWith("refs/lookover/jobs/"))).toEqual([]);
});

test("a prepare waiting for the repository is cancelled by its signal before any git of its own runs", async () => {
  const { retrieval } = data();
  const log: string[] = [];
  const retrieve = retrieval(log);
  const abort = new AbortController();

  const first = retrieve.prepare(request("job-16a"));
  const waiting = retrieve.prepare(request("job-16b"), abort.signal);
  abort.abort();

  await expect(waiting).rejects.toMatchObject({ problem: "cancelled" });
  const before = log.length;
  await first;
  // Only the first prepare's gits ran, one each: init, fetch, cat-file (the two commits), for-each-ref (the
  // default branch's), ls-tree (main has no rules file), merge-base, worktree add, diff, update-ref (the job's
  // refs deleted).
  expect(before).toBeLessThanOrEqual(9);
  expect(log.map((line) => line.split(" ")[1])).toEqual([
    "init",
    "fetch",
    "cat-file",
    "for-each-ref",
    "ls-tree",
    "merge-base",
    "worktree",
    "diff",
    "update-ref",
  ]);
});

test("dispose removes the worktree and leaves the mirror", async () => {
  const { mirror, retrieval } = data({ seeded: true });
  const prepared = await retrieval().prepare(request("job-3"));

  await prepared.dispose();

  expect(existsSync(prepared.cwd)).toBe(false);
  const listed = setupGit(r.env, mirror, "worktree", "list", "--porcelain").replaceAll("\\", "/");
  expect(listed).not.toContain(prepared.cwd.replaceAll("\\", "/"));
  expect(setupGit(r.env, mirror, "cat-file", "-t", r.b)).toBe("commit");
});

test("after a prepare, no file in the mirror or the worktree, no logged line and no argument holds the token", async () => {
  const { root, log, invocations } = await firstPrepare();

  const files = filesUnder(root);
  expect(files.length).toBeGreaterThan(10);
  expect(files.filter((f) => holdsToken(readFileSync(f)))).toEqual([]);
  expect(log.filter((line) => line.includes("fetch"))).toHaveLength(1);
  expect(log.filter(holdsToken)).toEqual([]);
  expect(invocations.length).toBeGreaterThan(1);
  expect(invocations.flatMap((i) => i.args).filter(holdsToken)).toEqual([]);
});

test("the fetch sends the host's credentials as given, as a basic credential header of its own command", async () => {
  const { invocations } = await firstPrepare();

  const header = `AUTHORIZATION: basic ${base64(`${USER}:${TOKEN}`)}`;
  const carrying = invocations.filter((i) => Object.values(i.env).includes(header));
  expect(carrying.map((i) => i.args[0])).toEqual(["fetch"]);
});

test("a GIT_DIR in the environment is dropped: git acts on the mirror, not on it", async () => {
  const { root, prepared } = await firstPrepare();

  expect(headOf(prepared.cwd)).toBe(r.b);
  expect(readdirSync(join(elsewhereOf(root), "refs", "heads"))).toEqual([]);
});

test("a worktree a crashed run left behind is replaced by the next prepare of the job", async () => {
  const retrieve = data({ seeded: true }).retrieval();
  const first = await retrieve.prepare(request("job-6"));
  writeFileSync(join(first.cwd, "leftover.txt"), "from the crashed run\n");

  const again = await retrieve.prepare(request("job-6"));

  expect(again.cwd).toBe(first.cwd);
  expect(headOf(again.cwd)).toBe(r.b);
  expect(existsSync(join(again.cwd, "leftover.txt"))).toBe(false);
});

/** The head on no branch (`d`, under `refs/pull/1/head` only) prepared on an empty data root. */
const noBranchPrepare = shared(() => request("job-12", r.d));

test("a change's head on no branch, only under refs/pull/1/head, is fetched by commit: its worktree, merge base and diff", async () => {
  const { prepared } = await noBranchPrepare();

  expect(headOf(prepared.cwd)).toBe(r.d);
  expect(prepared.mergeBase).toBe(r.a);
  expect(withoutBlobIds(prepared.diff)).toBe(
    [
      "diff --git a/greeting.txt b/greeting.txt",
      "index <blobs> 100644",
      "--- a/greeting.txt",
      "+++ b/greeting.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+hi",
      "",
    ].join("\n"),
  );
});

test("only the change is fetched: no other pull request's ref, no other branch, none of their commits", async () => {
  const { mirror } = await noBranchPrepare();

  // The default branch stays, for the rules and the next fetch; the job's own refs are gone already.
  expect(refsOf(mirror)).toEqual(["refs/lookover/default"]);
  expect(holds(mirror, r.d)).toBe(true);
  expect(holds(mirror, r.otherChange)).toBe(false);
  expect(holds(mirror, r.otherBranch)).toBe(false);
  // The `change` branch's head: another change's commit, on a branch.
  expect(holds(mirror, r.b)).toBe(false);
});

test("the logged fetch names the two commits and the default branch, and no pattern", async () => {
  const { log } = await firstPrepare();

  const fetches = log.filter((line) => line.startsWith("git fetch"));
  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toStartWith(
    `git fetch --quiet --no-tags ${r.origin} +${r.b}:refs/lookover/jobs/job-1/head ` +
      `+${r.c}:refs/lookover/jobs/job-1/base +refs/heads/main:refs/lookover/default: exited 0 in `,
  );
  expect(fetches[0]).not.toContain("*");
});

test("the job's refs are gone after a review and after a prepare that failed after the fetch", async () => {
  const { mirror, retrieval } = data({ seeded: true });
  const retrieve = retrieval();
  const ownRefs = () => refsOf(mirror).filter((ref) => ref.startsWith("refs/lookover/jobs/"));

  const prepared = await retrieve.prepare(request("job-42a"));
  await prepared.dispose();
  // A base with no merge base with the head: fetched, then the prepare fails.
  const failed = await retrieve
    .prepare({ ...request("job-42b"), base: r.unrelated })
    .catch((e: unknown) => e);

  expect(failed).toMatchObject({ problem: "diff_failed" });
  expect(ownRefs()).toEqual([]);
});

test("a head commit the host doesn't have fails at the fetch, with fetch_failed", async () => {
  const { retrieval } = data({ seeded: true });
  const missing = commitSha("0123456789abcdef0123456789abcdef01234567");

  await expect(retrieval().prepare(request("job-7", missing))).rejects.toMatchObject({
    problem: "fetch_failed",
    detail: expect.stringContaining(missing),
  });
});

test("a head that is no commit fails with commit_not_found", async () => {
  const { retrieval } = data();
  const blob = commitSha(setupGit(r.env, r.origin, "rev-parse", `${r.a}:greeting.txt`));

  await expect(retrieval().prepare(request("job-44", blob))).rejects.toMatchObject({
    problem: "commit_not_found",
    detail: expect.stringContaining(blob),
  });
});

test("a repository that can't be fetched fails with fetch_failed, the detail in git's words", async () => {
  const { retrieval } = data();
  const log: string[] = [];
  const fetch: FetchSpec = {
    cloneUrl: join(r.dir, "nowhere.git"),
    defaultBranch: "main",
    credentials,
  };

  const error = await retrieval(log)
    .prepare({ ...request("job-8"), fetch })
    .catch((e: unknown) => e);

  expect(error).toMatchObject({
    problem: "fetch_failed",
    detail: expect.stringContaining("does not appear to be a git repository"),
  });
  expect(holdsToken(String(error))).toBe(false);
  // Not a missing default branch: the first fetch's error, and no second fetch.
  expect(log.filter((line) => line.startsWith("git fetch"))).toHaveLength(1);
});

test("git's words never carry the token, even when git echoes what held it", async () => {
  const { retrieval } = data();
  // A clone URL that holds the token: git names it in its error, and the error must not.
  const fetch: FetchSpec = {
    cloneUrl: join(r.dir, `${TOKEN}.git`),
    defaultBranch: "main",
    credentials,
  };

  const error = await retrieval()
    .prepare({ ...request("job-9"), fetch })
    .catch((e: unknown) => e);

  expect(error).toMatchObject({ problem: "fetch_failed", detail: expect.stringContaining("<hidden>.git") });
  expect(holdsToken(String(error))).toBe(false);
});

test("credentials the host refuses fail with fetch_failed, in the host's words, and no fetch runs", async () => {
  const { retrieval } = data();
  const log: string[] = [];
  const refused = () =>
    Promise.reject(new HostError("unauthorized", "The host refused the credentials (401)"));
  const fetch: FetchSpec = { ...fetchSpec(), credentials: refused };

  const error = await retrieval(log)
    .prepare({ ...request("job-12"), fetch })
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(RetrievalError);
  expect(error).toMatchObject({
    problem: "fetch_failed",
    detail: "no credentials from the host: unauthorized: The host refused the credentials (401)",
  });
  expect(log.some((line) => line.startsWith("git fetch"))).toBe(false);
});

test("a data folder that can't hold the mirror fails with mirror_failed", async () => {
  const { root, runner } = data();
  // A file where the mirrors' folder should be: no mirror can be made under it.
  writeFileSync(join(root, "mirrors"), "");
  const retrieve = createRetrieval({ root, runner: runner(), git: GIT, env: r.env });

  const error = await retrieve.prepare(request("job-13")).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(RetrievalError);
  expect(error).toMatchObject({ problem: "mirror_failed" });
});

test("a git program that can't run fails with git_not_found", async () => {
  const { root, runner } = data();
  const retrieve = createRetrieval({
    root,
    runner: runner(),
    git: join(r.dir, "no-such-git"),
    env: r.env,
  });

  await expect(retrieve.prepare(request("job-10"))).rejects.toMatchObject({ problem: "git_not_found" });
});

test("a signal already aborted cancels before any git runs", async () => {
  const { retrieval } = data();
  const log: string[] = [];

  await expect(retrieval(log).prepare(request("job-11"), AbortSignal.abort())).rejects.toMatchObject({
    problem: "cancelled",
  });
  expect(log).toEqual([]);
});

/** A new commit `d` on the change, pushed to the remote. */
function pushAnotherCommit(): CommitSha {
  const [pushed] = importCommits(r.env, r.origin, [
    {
      ref: "refs/heads/change",
      from: "refs/heads/change^0",
      message: "d",
      files: { "greeting.txt": "hello\nworld\n!\n" },
    },
  ]);
  if (!pushed) throw new Error("setup: git fast-import wrote no commit");
  return pushed;
}
