// `bun run check`: every fast gate at once, in parallel, so the whole check costs about as much as the
// slowest step. Prints the output of each failed step, then one line per step. Exits 1 if any failed.
// `bun run check:full` (`--full`) adds the slower steps, run before a push and on GitHub, not after each edit.
// - First it checks that `node_modules` matches the manifests: after a pull that added or bumped a dependency,
//   one line says to run `bun install`, instead of dozens of "Cannot find module" errors from the steps.
// - It remembers the tree of its last green run (the working tree, untracked files included) and skips, in one
//   line, when nothing changed since: `bun run check && git commit` then pays for one check, not two.
//   `--force` runs it anyway.
// - It runs only the test files the change can reach (ADR 0071, the owner's answer on #440; `check-reach.ts` says
//   what the change is and how a test is reached): the files that differ from the tree of the last green run (a
//   green `check:full` counts), else from the merge base with `origin/main` (no green run, its tree gone, another
//   Bun), and every test file whose imports reach one of them. A red run keeps the older base, so the next run
//   takes again what it reached. When in doubt, everything: a change the import graph can't
//   place (a preload, `bunfig.toml`, a `package.json`, `bun.lock`, a tsconfig, a fixture or recording read at run
//   time, `scripts/check*`, a file the graph doesn't hold), no merge base, or another Bun than the last green run's,
//   runs every test file and says why. One line says what ran: "ran N of M test files (the change reaches these)".
//   `--full` (`check:full`: the pre-push hook and CI) runs every test file, whatever the change.
// - What a run checks, its key, is the working tree's git tree (every tracked file hashed again from its content,
//   about half a second a key here), Bun's version and what is installed in
//   `node_modules` (the package folders Bun installed and each workspace's links to them). The key is taken again
//   after the steps: a file changed while they ran, and the green run is not remembered. Another install than the
//   last green run's is doubt, measured from the merge base. Ignored files a test reads (a `.dev/` file, a cache)
//   are outside the key: that is why `check:full` still runs everything before a push.
// - `--pre-commit` (the git hook): no check at all when no code file is staged (`check-scope.ts`).
// - Over its budget (15 s, ADR 0036; `--budget-ms` sets another), it says so and names the slowest test files.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawn, spawnSync } from "bun";
import { changeOf, selectTests } from "./check-reach.ts";
import { isCode } from "./check-scope.ts";

const root = process.cwd();
const flag = (name: string) => process.argv.includes(name);
const full = flag("--full");
const budgetArg = process.argv.find((a) => a.startsWith("--budget-ms="));
const BUDGET_MS = budgetArg === undefined ? 15_000 : Number(budgetArg.slice("--budget-ms=".length));
const CACHE = join(root, "node_modules", ".cache", "lookover-check");
const TIMINGS = join(CACHE, "test-timings.json");

/** Runs git in the repository; its trimmed output, or null when git fails (no repository, say). */
function git(args: string[], env: Record<string, string | undefined> = process.env): string | null {
  const done = spawnSync(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "ignore" });
  return done.exitCode === 0 ? done.stdout.toString().trim() : null;
}

if (flag("--pre-commit")) {
  const staged = git(["diff", "--cached", "--name-only", "--no-renames"]);
  if (staged !== null && !staged.split("\n").some(isCode)) {
    console.log("pre-commit: no code file staged, so no check.");
    process.exit(0);
  }
}

// A version range to compare with what is installed; `workspace:`, `file:` and the like are only checked linked.
const SEMVER_RANGE = /^[\^~<>=\d*]/;

/** Why `node_modules` doesn't match one dependency of `dir`'s manifest, or undefined when it does. */
async function staleDependency(dir: string, dep: string, range: string) {
  const where = relative(root, dir).replaceAll("\\", "/") || "the root";
  // Bun links a package's dependencies into its own node_modules, or hoists them to the root's.
  const installed = [dir, root].map((d) => join(d, "node_modules", dep)).find((p) => existsSync(p));
  if (!installed) return `${where} needs ${dep}`;
  if (!SEMVER_RANGE.test(range)) return undefined;
  const { version } = await Bun.file(join(installed, "package.json")).json();
  return Bun.semver.satisfies(version, range)
    ? undefined
    : `${where} needs ${dep}@${range}, ${version} is installed`;
}

/** The first dependency, of the root or of a workspace package, that `node_modules` doesn't hold as asked. */
async function staleNodeModules(): Promise<string | undefined> {
  const manifests = ["package.json"];
  for await (const p of new Bun.Glob("{packages,apps}/*/package.json").scan(root)) manifests.push(p);
  for (const manifest of manifests) {
    const dir = join(root, dirname(manifest));
    const json = await Bun.file(join(root, manifest)).json();
    for (const [dep, range] of Object.entries<string>({ ...json.dependencies, ...json.devDependencies })) {
      const stale = await staleDependency(dir, dep, range);
      if (stale) return stale;
    }
  }
  return undefined;
}

/** One installed package, as its link's target or its version; undefined when `path` holds no package. */
function installedAs(path: string): string | undefined {
  if (lstatSync(path).isSymbolicLink()) return readlinkSync(path);
  const manifest = join(path, "package.json");
  return existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).version : undefined;
}

/** What one `node_modules` folder holds: each package (scoped ones too) with what it is; dot folders aside. */
function installedIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const names = name.startsWith("@") ? readdirSync(join(dir, name)).map((n) => `${name}/${n}`) : [name];
    for (const pkg of names) {
      const as = installedAs(join(dir, pkg));
      if (as !== undefined) lines.push(`${pkg} ${as}`);
    }
  }
  return lines;
}

/**
 * A fingerprint of what `bun install` put in `node_modules`: the package folders of its store (`.bun`, named
 * `name@version`) and each workspace's packages, so an install that changed nothing in git still changes the key.
 */
function installKey(): string {
  const store = join(root, "node_modules", ".bun");
  const lines = existsSync(store) ? readdirSync(store).map((n) => `.bun ${n}`) : [];
  const folders = [".", ...[...new Bun.Glob("{packages,apps}/*/package.json").scanSync(root)].map(dirname)];
  for (const folder of folders) {
    for (const line of installedIn(join(root, folder, "node_modules"))) lines.push(`${folder} ${line}`);
  }
  return Bun.hash(lines.sort().join("\n")).toString(16);
}

/**
 * What this run checks: the working tree's git tree, untracked files included, hashed through a copy of the
 * index so the real one is untouched, with Bun's version and what is installed. Null outside a git repository.
 * Every tracked file is hashed again from its content: the index's stat data can trust a same-size edit made
 * in the commit's second (#462), and the key must never miss an edit.
 */
function treeKey(): string | null {
  const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (index === null) return null;
  mkdirSync(CACHE, { recursive: true });
  const copy = join(tmpdir(), `lookover-check-${process.pid}.index`);
  try {
    if (existsSync(index)) writeFileSync(copy, readFileSync(index));
    const env = { ...process.env, GIT_INDEX_FILE: copy };
    const added =
      git(["add", "--all", "."], env) !== null && git(["add", "--renormalize", "."], env) !== null;
    const tree = added ? git(["write-tree"], env) : null;
    return tree === null ? null : `${tree} bun-${Bun.version} install-${installKey()}`;
  } finally {
    rmSync(copy, { force: true });
  }
}

/** A key's parts: its tree, its Bun and its install (each undefined when the key is missing or older). */
function keyParts(key: string | null | undefined) {
  const match = /^(\S+) bun-(\S+)(?: install-(\S+))?$/.exec(key ?? "");
  return { tree: match?.[1], bun: match?.[2], install: match?.[3] };
}

const stale = await staleNodeModules();
if (stale) {
  console.error(`node_modules is out of date (${stale}): run \`bun install\`, then check again.`);
  process.exit(1);
}

const key = treeKey();
// A green `check:full` also stands for the fast check, whose steps it includes.
const stamps = full ? ["green-full", "green"] : ["green"];
const stamp = join(CACHE, stamps[0] ?? "green");
if (!flag("--force") && key !== null && existsSync(stamp) && readFileSync(stamp, "utf8") === key) {
  console.log("check: nothing changed since the last green run, so it was skipped (`--force` runs it).");
  process.exit(0);
}

const STEPS = ["typecheck", "lint", "ignores", "docs", "imports", "knip", "test"];
// Slower steps: the site's build and its checks in the machine's browser (ADR 0064, 8), and the tests of the
// check scripts themselves (they drive real git repos), the gate test (`scripts/gates.test.ts`, also
// `bun run gates`) among them.
const FULL_STEPS = ["site:check", "test:scripts"];
// `bun test` writes each file's duration here, for the over-budget line.
const EXTRA_ARGS: Record<string, string[]> = { test: [`--timings=${TIMINGS}`, "--update-timings"] };

/** The test files this run takes: the line that says so, why all of them when in doubt, and `bun run test`'s list. */
type Reach = { line: string; doubt?: string; list?: string; none: boolean };

/** What the fast check's tests run (ADR 0071; the rules are `check-reach.ts`'s); every test file if that fails. */
function reach(): Reach {
  try {
    return reachOrThrow();
  } catch (error) {
    // A half-edited package.json, a file that can't be read: doubt, never a crash.
    const message = error instanceof Error ? error.message : String(error);
    return { line: "ran every test file", doubt: `the selection failed: ${message}`, none: false };
  }
}

function reachOrThrow(): Reach {
  // The last green run's key (a green `check:full` writes it too), and the one this run checks.
  const green = keyParts(existsSync(join(CACHE, "green")) ? readFileSync(join(CACHE, "green"), "utf8") : "");
  const now = keyParts(key);
  const sameBun = green.bun === Bun.version;
  const sameInstall = green.install === now.install;
  // The green tree only when it was checked on this Bun and install; the tree now in any case.
  const trees = { green: sameBun && sameInstall ? green.tree : undefined, now: now.tree };
  const change = changeOf(root, process.env, trees);
  const selection = selectTests(root, "files" in change ? change.files : []);
  const doubt =
    "doubt" in change
      ? change.doubt
      : green.bun !== undefined && !sameBun
        ? `Bun is ${Bun.version}, the last green run's was ${green.bun}`
        : green.tree !== undefined && !sameInstall
          ? "node_modules holds another install than the last green run's"
          : selection.doubt;
  const count = doubt === undefined ? selection.tests.length : selection.total;
  const line = `ran ${count} of ${selection.total} test files (the change reaches these)`;
  if (doubt !== undefined) return { line, doubt, none: false };
  // One list per run, removed after it: two checks at once in this worktree don't take each other's.
  const list = join(CACHE, `reached-tests-${process.pid}.txt`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(list, selection.tests.map((t) => `${t}\n`).join(""));
  return { line, list, none: selection.tests.length === 0 };
}

const started = performance.now();
const steps = full ? [...STEPS, ...FULL_STEPS] : STEPS;
let reached: Reach | undefined;
const results = await Promise.all(
  steps.map(async (step) => {
    const begun = performance.now();
    const extra = [...(EXTRA_ARGS[step] ?? [])];
    // The other steps are started by now: the selection reads the graph while they run.
    if (step === "test" && !full) {
      reached = reach();
      if (reached.none) return { step, ok: true, output: "", ms: performance.now() - begun };
      if (reached.list !== undefined) extra.push(`--files-from=${reached.list}`);
    }
    const proc = spawn([process.execPath, "run", step, ...extra], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { step, ok: code === 0, output: `${out}${err}`.trim(), ms: performance.now() - begun };
  }),
);
const took = performance.now() - started;
if (reached?.list !== undefined) rmSync(reached.list, { force: true });

/** The three slowest test files of the last run, as `name 6.1 s`. */
function slowestTests(): string[] {
  if (!existsSync(TIMINGS)) return [];
  const { files } = JSON.parse(readFileSync(TIMINGS, "utf8"));
  return Object.entries<number>(files ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([file, ms]) => `${file} ${(ms / 1000).toFixed(1)} s`);
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);
for (const r of results.filter((x) => !x.ok)) console.error(`\n--- ${r.step} ---\n${r.output}\n`);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.step} (${(r.ms / 1000).toFixed(2)} s)`);
if (reached?.doubt !== undefined) console.log(`check: ${reached.doubt}. Every test file runs.`);
if (reached !== undefined) console.log(reached.line);
if (!full && took > BUDGET_MS) {
  const slowest = slowestTests();
  console.log(
    `check took ${seconds(took)} s, over its ${BUDGET_MS / 1000} s budget (ADR 0036).${slowest.length > 0 ? ` Slowest test files: ${slowest.join(", ")}.` : ""}`,
  );
}
if (results.some((r) => !r.ok)) process.exit(1);
// Only the tree the steps saw is remembered: a file changed while they ran, and this run stands for neither.
if (key !== null && treeKey() !== key) {
  console.log("check: a file changed while it ran, so this green run is not remembered.");
} else if (key !== null) for (const s of stamps) writeFileSync(join(CACHE, s), key);
