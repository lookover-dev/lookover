// `bun run check`: every fast gate at once, in parallel, so the whole check costs about as much as the
// slowest step. Prints the output of each failed step, then one line per step. Exits 1 if any failed.
// `bun run check:full` (`--full`) adds the slower steps, run before a push and on GitHub, not after each edit.
// - First it checks that `node_modules` matches the manifests: after a pull that added or bumped a dependency,
//   one line says to run `bun install`, instead of dozens of "Cannot find module" errors from the steps.
// - It remembers the tree of its last green run (the working tree, untracked files included) and skips, in one
//   line, when nothing changed since: `bun run check && git commit` then pays for one check, not two.
//   `--force` runs it anyway.
// - `--pre-commit` (the git hook): no check at all when no code file is staged (`check-scope.ts`).
// - Over its budget (15 s, ADR 0036; `--budget-ms` sets another), it says so and names the slowest test files.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawn, spawnSync } from "bun";
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

/**
 * What this run checks: the working tree's git tree, untracked files included, hashed through a copy of the
 * index so the real one is untouched, with Bun's version. Null outside a git repository.
 */
function treeKey(): string | null {
  const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (index === null) return null;
  mkdirSync(CACHE, { recursive: true });
  const copy = join(tmpdir(), `lookover-check-${process.pid}.index`);
  try {
    if (existsSync(index)) writeFileSync(copy, readFileSync(index));
    const env = { ...process.env, GIT_INDEX_FILE: copy };
    const tree = git(["add", "--all", "."], env) === null ? null : git(["write-tree"], env);
    return tree === null ? null : `${tree} bun-${Bun.version}`;
  } finally {
    rmSync(copy, { force: true });
  }
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

const started = performance.now();
const steps = full ? [...STEPS, ...FULL_STEPS] : STEPS;
const results = await Promise.all(
  steps.map(async (step) => {
    const begun = performance.now();
    const proc = spawn([process.execPath, "run", step, ...(EXTRA_ARGS[step] ?? [])], {
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
if (!full && took > BUDGET_MS) {
  const slowest = slowestTests();
  console.log(
    `check took ${seconds(took)} s, over its ${BUDGET_MS / 1000} s budget (ADR 0036).${slowest.length > 0 ? ` Slowest test files: ${slowest.join(", ")}.` : ""}`,
  );
}
if (results.some((r) => !r.ok)) process.exit(1);
if (key !== null) for (const s of stamps) writeFileSync(join(CACHE, s), key);
