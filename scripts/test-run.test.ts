// The tests' own temp folder (`scripts/test-run.ts`, ADR 0071): `bun run test` and `test:scripts` run `bun test`
// through it. Here it runs a probe test file of its own, as a run of the suite would: the probe writes down what a
// test worker and a child it starts see, so this test can check the folder they shared is gone after. Two runs in
// all, a passing one and a failing one: each is a real `bun test`.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { cleanEnv } from "./clean-env.ts";
import { runsFolder, sweep, testArgs } from "./test-run.ts";

// A nested `bun test` takes 1 to 3 s on a busy machine, past Bun's 5 s with the sweep's run beside it.
setDefaultTimeout(30_000);

const ROOT = join(import.meta.dir, "..");
const RUNNER = join(import.meta.dir, "test-run.ts");
const WINDOWS = process.platform === "win32";
/** Longer ago than any run lasts: the sweep may take a folder last touched then. */
const HOURS_AGO = new Date(Date.now() - 3 * 60 * 60 * 1000);
/** A pid no process has: one that has just exited. */
const deadPid = () => Bun.spawnSync([process.execPath, "-e", "0"]).pid;

/** The probe and what it writes down, in this run's own temp folder, which the nested run must not use. */
const scratch = mkdtempSync(join(tmpdir(), "lookover-test-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A test file that writes what it sees to `<name>.json` beside it, then passes or fails as told. */
const probe = (name: string, outcome: "pass" | "fail") => {
  const file = join(scratch, `${name}.test.ts`);
  writeFileSync(
    file,
    `import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
test("probe", () => {
  const child = Bun.spawnSync([process.execPath, "-e", "console.log(require('node:os').tmpdir())"]);
  writeFileSync(${JSON.stringify(join(scratch, `${name}.json`))}, JSON.stringify({
    tmpdir: tmpdir(),
    child: child.stdout.toString().trim(),
    env: { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR },
    git: Bun.which("git"),
    gitDir: process.env.GIT_DIR ?? null,
  }));
  expect(${JSON.stringify(outcome)}).toBe("pass");
});
`,
  );
  return file;
};

interface Seen {
  tmpdir: string;
  child: string;
  env: Record<string, string>;
  git: string | null;
  gitDir: string | null;
}

/** The runner on a probe, from the root as `bun run test` runs it, with `test:scripts`' GIT_DIR. */
const run = (name: string, outcome: "pass" | "fail") => {
  const done = Bun.spawnSync([process.execPath, RUNNER, probe(name, outcome)], {
    cwd: ROOT,
    env: { ...cleanEnv(), GIT_DIR: "no-such-git-dir" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const seen: Seen = JSON.parse(readFileSync(join(scratch, `${name}.json`), "utf8"));
  return { code: done.exitCode, said: `${done.stdout.toString()}${done.stderr.toString()}`, seen };
};

const inside = (child: string, parent: string) => {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !/^[a-z]:/i.test(path);
};

let passed: ReturnType<typeof run>;
beforeAll(() => {
  passed = run("passing", "pass");
});

test("a test worker and a child it starts see the run's own folder, and it is gone after", () => {
  const { code, said, seen } = passed;
  expect(said).toContain(" 1 pass");
  expect(code).toBe(0);
  const worker = seen.tmpdir;
  expect(seen.child).toBe(worker);
  expect(seen.env).toEqual({ TEMP: worker, TMP: worker, TMPDIR: worker });
  expect(existsSync(worker)).toBe(false);
  // Its long path has no space, and no git finds a repository there.
  expect(realpathSync.native(dirname(worker))).toBe(dirname(worker));
  expect(worker).not.toContain(" ");
  expect(inside(worker, ROOT)).toBe(false);
  // A folder of this test's own beside it, named for a live pid so a run starting meanwhile keeps it.
  const beside = mkdtempSync(join(dirname(worker), `${process.pid}-git-`));
  try {
    const git = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
      cwd: beside,
      env: cleanEnv(),
    });
    expect(git.exitCode).not.toBe(0);
  } finally {
    rmSync(beside, { recursive: true, force: true });
  }
  // On Windows, outside the system's temp folder, whose size slows every bun started under it; elsewhere it may
  // sit under /tmp.
  if (WINDOWS) {
    const system = realpathSync.native(process.env.LOOKOVER_SYSTEM_TEMP ?? tmpdir());
    expect(inside(worker.toLowerCase(), system.toLowerCase())).toBe(false);
  }
});

test("test:scripts' GIT_DIR reaches the tests, and on Windows git is its real binary, not the launcher", () => {
  const { git, gitDir } = passed.seen;
  expect(gitDir).toBe("no-such-git-dir");
  expect(git).not.toBeNull();
  if (WINDOWS) expect(git?.toLowerCase()).not.toContain(join("git", "cmd").toLowerCase());
});

test("a failing run's code passes through and its folder goes; a folder a killed run left is swept, a live one's kept", () => {
  const runs = dirname(passed.seen.tmpdir);
  const gone = deadPid();
  const stale = join(runs, `${gone}-stale`);
  const live = join(runs, `${process.pid}-live`);
  mkdirSync(join(stale, "left"), { recursive: true });
  utimesSync(stale, HOURS_AGO, HOURS_AGO);
  mkdirSync(live, { recursive: true });
  try {
    const { code, said, seen } = run("failing", "fail");
    expect(said).toContain(" 1 fail");
    expect(code).toBe(1);
    expect(dirname(seen.tmpdir)).toBe(runs);
    expect(existsSync(seen.tmpdir)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  } finally {
    rmSync(stale, { recursive: true, force: true });
    rmSync(live, { recursive: true, force: true });
  }
});

test("the sweep keeps a folder its bun test still uses, or one touched within the hour, though its runner is gone", async () => {
  const runs = mkdtempSync(join(scratch, "runs-"));
  const folder = (name: string, testsPid?: number, touched = HOURS_AGO) => {
    const path = join(runs, name);
    mkdirSync(path);
    if (testsPid !== undefined) writeFileSync(join(path, ".lookover-test-run.pid"), String(testsPid));
    utimesSync(path, touched, touched);
    return path;
  };
  const gone = deadPid();
  const left = folder(`${gone}-left`);
  const leftWithItsTests = folder(`${gone}-tests-gone`, deadPid());
  const orphan = folder(`${gone}-orphan`, process.pid);
  const young = folder(`${gone}-young`, undefined, new Date());
  const live = folder(`${process.pid}-live`);
  await sweep(runs);
  expect(existsSync(left)).toBe(false);
  expect(existsSync(leftWithItsTests)).toBe(false);
  expect(existsSync(orphan)).toBe(true);
  expect(existsSync(young)).toBe(true);
  expect(existsSync(live)).toBe(true);
});

test("a folder another sweep removes while this one looks at it counts as cleaned, and the sweep goes on", async () => {
  const runs = mkdtempSync(join(scratch, "runs-"));
  const gone = deadPid();
  const taken = join(runs, `${gone}-taken`);
  const left = join(runs, `${gone}-left`);
  for (const path of [taken, left]) {
    mkdirSync(path);
    utimesSync(path, HOURS_AGO, HOURS_AGO);
  }
  // Another sweeper removes `taken` after this one listed it, before it reads when it was touched.
  let raced = false;
  await sweep(runs, Date.now(), (folder) => {
    if (folder === taken) {
      rmSync(taken, { recursive: true, force: true });
      raced = true;
    }
    return statSync(folder).mtimeMs;
  });
  expect(raced).toBe(true);
  expect(existsSync(taken)).toBe(false);
  expect(existsSync(left)).toBe(false);
});

test("no place fits: the runner says why it refused each", () => {
  const system = mkdtempSync(join(scratch, "system-"));
  const spaced = join(scratch, "with space");
  mkdirSync(spaced, { recursive: true });
  const gitFolder = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: ROOT,
    env: cleanEnv(),
  })
    .stdout.toString()
    .trim();
  const missing = join(scratch, "missing");
  const said = (() => {
    try {
      runsFolder(system, [missing, spaced, ROOT, gitFolder]);
      return "";
    } catch (error) {
      return String(error);
    }
  })();
  expect(said).toContain("no place for the tests' temp folder");
  expect(said).toContain(`\n${missing}: missing\n${spaced}: its long path `);
  expect(said).toContain(
    `has a space\n${ROOT}: inside a git repository\n${gitFolder}: inside a git repository`,
  );
});

test("--files-from runs the files its list names instead of the folders, the other arguments kept", () => {
  const list = join(scratch, "reached.txt");
  writeFileSync(list, "packages/core/src/a.test.ts\napps/web/src/b.test.tsx\n");
  expect(
    testArgs(["./packages", "./apps", "--parallel", `--files-from=${list}`, "--timings=t.json"]),
  ).toEqual(["--parallel", "--timings=t.json", "./packages/core/src/a.test.ts", "./apps/web/src/b.test.tsx"]);
  expect(testArgs(["./packages", "--parallel"])).toEqual(["./packages", "--parallel"]);
});
