// `bun run test` and `bun run test:scripts`: `bun test` with the same arguments, in a temp folder of the run's own
// (ADR 0071). The run folder is made fresh under a `.lookover-test-runs` folder whose long path has no space and that
// no git finds a repository in: on Windows beside the clone (the first folder up from it outside any repository),
// else under the system's temp folder. On Windows the system's temp folder is never used: it grows huge, and every
// `bun` started under a huge folder pays for it at startup (row 28's survey, F1).
//
// `TEMP`, `TMP` and `TMPDIR` point at it for every test worker and every child they start; on Windows, git's real
// binary comes first on `PATH`, so each git command is one process, not Git for Windows' launcher and the real one
// (F2). The exit code is `bun test`'s. Once it has exited (its workers with it), the folder is removed, retrying a
// busy file, never changing the exit code; a folder a killed run left behind is swept at a later start, once its
// runner and its `bun test` are gone and nothing has touched it for an hour.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse, relative, resolve } from "node:path";
import { cleanEnv } from "./clean-env.ts";

const ROOT = join(import.meta.dir, "..");
const RUNS = ".lookover-test-runs";
/** The system's temp folder, kept for nested runs (their `TEMP` is the outer run's folder). */
const SYSTEM_TEMP = "LOOKOVER_SYSTEM_TEMP";
const WINDOWS = process.platform === "win32";
/** In a run folder: the pid of its `bun test`, which may outlive a runner killed hard. */
const TESTS_PID = ".lookover-test-run.pid";
/** A run folder touched this recently is kept by the sweep whatever its pids say: longer than any run lasts. */
const IDLE_BEFORE_SWEEP_MS = 60 * 60 * 1000;

/**
 * Git in `dir`, without the `GIT_*` variables a hook or `test:scripts` sets, and in English (its messages are read
 * below); undefined when git can't be run.
 */
const git = (args: string[], dir: string) => {
  try {
    const done = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: { ...cleanEnv(), LC_ALL: "C", LANGUAGE: "C" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: done.exitCode, out: done.stdout.toString().trim(), err: done.stderr.toString() };
  } catch {
    return undefined;
  }
};

/** The repository git finds from `dir`, its top folder; undefined when none (or no git, which finds none either). */
function repositoryOf(dir: string): string | undefined {
  const found = git(["rev-parse", "--show-toplevel"], dir);
  if (found === undefined) return undefined;
  if (found.code === 0) return resolve(found.out === "" ? dir : found.out);
  // Inside a `.git` folder there is no top to show, but git finds the repository all the same.
  if (/must be run in a work tree/i.test(found.err)) return resolve(dir);
  if (/not a git repository/i.test(found.err)) return undefined;
  throw new Error(`test-run: can't tell whether ${dir} is in a git repository: ${found.err.trim()}`);
}

/** The first folder up from `from` that is in no repository. */
function besideRepository(from: string): string | undefined {
  let dir = from;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    const top = repositoryOf(parent);
    if (top === undefined) return parent;
    dir = top;
  }
}

const isInside = (child: string, parent: string) => {
  const path = relative(WINDOWS ? parent.toLowerCase() : parent, WINDOWS ? child.toLowerCase() : child);
  return path === "" || (!path.startsWith("..") && parse(path).root === "");
};

/** Where the `.lookover-test-runs` folder may go, best first. */
const places = (systemTemp: string) =>
  WINDOWS ? [besideRepository(ROOT), parse(ROOT).root] : [systemTemp, besideRepository(ROOT)];

/** The `.lookover-test-runs` folder, made if missing; throws, saying why each place was refused, when none fits. */
export function runsFolder(systemTemp: string, candidates = places(systemTemp)): string {
  const refused: string[] = [];
  for (const place of candidates) {
    if (place === undefined) continue;
    const why = refusal(place, systemTemp);
    if (why === undefined) {
      const runs = join(realpathSync.native(place), RUNS);
      mkdirSync(runs, { recursive: true });
      return runs;
    }
    refused.push(`${place}: ${why}`);
  }
  throw new Error(
    `test-run: no place for the tests' temp folder: it needs a long path without a space, outside any git repository${WINDOWS ? " and outside the system's temp folder" : ""}.\n${refused.join("\n")}`,
  );
}

function refusal(place: string, systemTemp: string): string | undefined {
  let long: string;
  try {
    long = realpathSync.native(place);
  } catch {
    return "missing";
  }
  if (long.includes(" ")) return `its long path ${long} has a space`;
  if (WINDOWS && isInside(long, realpathSync.native(systemTemp))) return "inside the system's temp folder";
  if (repositoryOf(long) !== undefined) return "inside a git repository";
  return undefined;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** The pid of the `bun test` a run folder holds, if it says. */
const testsPid = (folder: string) => {
  try {
    return Number(readFileSync(join(folder, TESTS_PID), "utf8"));
  } catch {
    return Number.NaN;
  }
};

const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** When `folder` was last touched; undefined when it is gone (another run's sweep removed it). */
function touched(folder: string, mtimeOf: (folder: string) => number): number | undefined {
  try {
    return mtimeOf(folder);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/**
 * Removes the run folders (named `<runner's pid>-…`) no run uses any more: their runner is gone, so is their
 * `bun test` (an orphan outlives a runner killed hard), and nothing has touched them for longer than a run lasts (a
 * worker outliving both, or a reused pid, can't be told from a pid). Runs started together sweep together: a folder
 * another sweep removes while this one looks at it is cleaned already. `mtimeOf` is for tests.
 */
export async function sweep(
  runs: string,
  now = Date.now(),
  mtimeOf = (folder: string) => statSync(folder).mtimeMs,
) {
  for (const name of readdirSync(runs)) {
    const pid = Number(/^(\d+)-/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid === process.pid || alive(pid)) continue;
    const folder = join(runs, name);
    // No pid file, or one gone with its folder, reads as no `bun test`: the folder's time decides.
    const tests = testsPid(folder);
    if (Number.isInteger(tests) && alive(tests)) continue;
    const at = touched(folder, mtimeOf);
    if (at === undefined || now - at < IDLE_BEFORE_SWEEP_MS) continue;
    await remove(folder);
  }
}

/** Removes `folder`, retrying a busy file for a few seconds; says so when it stays. Gone meanwhile is removed. */
async function remove(folder: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(folder, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!existsSync(folder)) return;
      if (attempt >= 20) {
        console.error(`test-run: couldn't remove ${folder} (${String(error)}); the next run sweeps it.`);
        return;
      }
      await Bun.sleep(250);
    }
  }
}

/** The folder of git's real binary (`mingw64/bin` beside its exec path), on Windows; undefined elsewhere or none. */
function realGitFolder(): string | undefined {
  if (!WINDOWS) return undefined;
  const execPath = git(["--exec-path"], ROOT);
  if (execPath === undefined || execPath.code !== 0) return undefined;
  const folder = resolve(execPath.out, "..", "..", "bin");
  return Bun.file(join(folder, "git.exe")).size > 0 ? folder : undefined;
}

/** `env` for the tests: the temp variables on `folder`, git's real binary first on `PATH`, any case of each name. */
function testEnv(env: NodeJS.ProcessEnv, folder: string, systemTemp: string, gitFolder: string | undefined) {
  const out: Record<string, string> = {};
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || ["TEMP", "TMP", "TMPDIR"].includes(key.toUpperCase())) continue;
    out[key] = value;
  }
  out.TEMP = folder;
  out.TMP = folder;
  out.TMPDIR = folder;
  out[SYSTEM_TEMP] = systemTemp;
  if (gitFolder !== undefined) out[pathKey] = [gitFolder, env[pathKey]].filter(Boolean).join(delimiter);
  return out;
}

const FILES_FROM = "--files-from=";

/**
 * `bun test`'s arguments from the runner's. `--files-from=<list>` (`bun run check`, ADR 0071) runs the test files
 * its list names, one per line from the root, instead of the folders the script names: Bun runs a file under any
 * folder it is given, so they go. A list, not arguments: the command line stays short however many files it holds.
 */
export function testArgs(args: string[]): string[] {
  const list = args.find((a) => a.startsWith(FILES_FROM));
  if (list === undefined) return args;
  const files = readFileSync(list.slice(FILES_FROM.length), "utf8")
    .split(/\r?\n/)
    .filter((f) => f !== "")
    .map((f) => `./${f}`);
  return [...args.filter((a) => a.startsWith("-") && a !== list), ...files];
}

async function main(args: string[]): Promise<number> {
  const systemTemp = process.env[SYSTEM_TEMP] ?? tmpdir();
  const runs = runsFolder(systemTemp);
  await sweep(runs);
  const folder = mkdtempSync(join(runs, `${process.pid}-`));
  // Ctrl+C reaches `bun test` too: wait for it to stop, then clean up.
  process.on("SIGINT", () => {});
  try {
    const tests = Bun.spawn([process.execPath, "test", ...testArgs(args)], {
      env: testEnv(process.env, folder, systemTemp, realGitFolder()),
      stdio: ["inherit", "inherit", "inherit"],
    });
    writeFileSync(join(folder, TESTS_PID), String(tests.pid));
    return (await tests.exited) ?? 1;
  } finally {
    await remove(folder);
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
