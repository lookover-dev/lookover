// `bun run release:dry-run`: a release from this checkout, short of publishing (ADR 0061). Each step runs in turn,
// printed with its time; the first that fails stops it.
//
//   export   the public tree of HEAD (`export-public.ts`, a dry run: `.private-names` when the checkout has one),
//            committed as the public repository would get it (`public-sync.ts` into a local bare repository) and
//            cloned into the tree, so the tree is a git checkout with the public `.gitattributes` applied
//   install  `bun install --frozen-lockfile` in the tree
//   check    `bun run check` in the tree: the public checks
//   build    `bun run build` in the tree, `--baseline` on x64 as the release builds it
//   assets   `bun scripts/release-assets.ts --host` in the tree: this machine's npm packages in `dist/npm/`
//   smoke    `bun scripts/release-smoke.ts` in the tree: those packages installed with npm and run
//
//   bun scripts/release-dry-run.ts [<step>...] [--tree <dir>] [--keep]
//   bun scripts/release-dry-run.ts --touches <base>
//
// With no step named, every step, into a new temporary tree, deleted when every step passed (`--keep` keeps it).
// `--tree <dir>` names the tree: new or empty when `export` is asked, else an exported one, such as the public
// repository's own checkout (`--tree .`), where no step named means every step but `export`. The workflows call
// the steps one by one: the private repository's dry run `export --tree <dir>` then each other step on it, the
// public `release.yml` each step but `export` with `--tree .`, so neither can drift from this.
//
// `--touches <base>` prints `true` when the commits from <base> to HEAD change anything the dry run reads, else
// `false` (`export-public.ts --touches`): the private repository's CI skips the dry run on `false`. It needs the
// private export, so it runs in the private repository only.
//
// Exit 0 when every step passed, 1 at the first that failed, 2 on a usage error.
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "bun";
import { cleanEnv } from "./clean-env.ts";

export const STEPS = ["export", "install", "check", "build", "assets", "smoke"] as const;
type Step = (typeof STEPS)[number];

type Plan = { steps: Step[]; tree: string | undefined; keep: boolean } | { touches: string };

const USAGE = `usage: bun scripts/release-dry-run.ts [<step>...] [--tree <dir>] [--keep]
       bun scripts/release-dry-run.ts --touches <base>
steps: ${STEPS.join(" ")}`;

const isStep = (word: string): word is Step => STEPS.some((step) => step === word);

/** What a command line asks for, or why it can't be run. */
export function plan(args: string[]): Plan | string {
  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const { values, positionals } = parsed;
  if (values.touches !== undefined) {
    if (positionals.length > 0 || values.tree !== undefined || values.keep)
      return "--touches takes a base commit and nothing else";
    return { touches: values.touches };
  }
  const unknown = positionals.find((word) => !isStep(word));
  if (unknown !== undefined) return `no step ${unknown}; the steps: ${STEPS.join(" ")}`;
  const tree = values.tree === undefined ? undefined : resolve(values.tree);
  const asked = positionals.length > 0 ? STEPS.filter((step) => positionals.includes(step)) : undefined;
  const steps = asked ?? STEPS.filter((step) => tree === undefined || step !== "export");
  const first = steps[0];
  if (tree === undefined && first !== "export")
    return `${first} works on an exported tree: pass --tree <dir>, or ask for export too`;
  return { steps, tree, keep: values.keep };
}

const parseCommand = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    options: {
      tree: { type: "string" },
      keep: { type: "boolean", default: false },
      touches: { type: "string" },
    },
  });

/** `bun run build`'s arguments: the release's x64 executables run on Bun's baseline target (older CPUs). */
export const buildArgs = (arch: string): string[] => (arch === "x64" ? ["--baseline"] : []);

/** A command and the folder it runs in. */
type Command = { argv: string[]; cwd: string };

/** The scripts this one starts, beside it. */
const script = (name: string): string => join(import.meta.dir, name);

/**
 * The export: the public tree of HEAD into `work/export`, committed into a local bare repository the way the sync
 * commits a release, then cloned into `tree`.
 */
function exportCommands(tree: string, work: string): Command[] {
  const here = process.cwd();
  const exported = join(work, "export");
  const bare = join(work, "public.git");
  const ownNames = join(here, ".private-names");
  const names = existsSync(ownNames) ? ownNames : join(work, "no-names");
  if (!existsSync(names)) writeFileSync(names, "");
  return [
    { argv: [process.execPath, script("export-public.ts"), exported], cwd: here },
    { argv: ["git", "init", "--bare", "--quiet", "--initial-branch=main", bare], cwd: here },
    {
      argv: [
        process.execPath,
        script("public-sync.ts"),
        exported,
        "--remote",
        bare,
        "--names",
        names,
        "--author",
        "Lookover dry run <dry-run@example.com>",
        "--push",
      ],
      cwd: here,
    },
    { argv: ["git", "clone", "--quiet", bare, tree], cwd: here },
  ];
}

function commandsOf(step: Step, tree: string, work: string): Command[] {
  const bun = (...args: string[]): Command => ({ argv: [process.execPath, ...args], cwd: tree });
  switch (step) {
    case "export":
      return exportCommands(tree, work);
    case "install":
      return [bun("install", "--frozen-lockfile")];
    case "check":
      return [bun("run", "check")];
    case "build":
      return [bun("run", "build", ...buildArgs(process.arch))];
    case "assets":
      return [bun("scripts/release-assets.ts", "--host")];
    case "smoke":
      return [bun("scripts/release-smoke.ts")];
  }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Why the steps can't start on this tree, or undefined when they can. */
function treeProblem(steps: readonly Step[], tree: string): string | undefined {
  if (steps.includes("export"))
    return existsSync(tree) && readdirSync(tree).length > 0
      ? `${tree} is not empty; the export needs a new or empty folder`
      : undefined;
  return existsSync(join(tree, "package.json"))
    ? undefined
    : `${tree} holds no package.json; export a tree first`;
}

/** Runs one step's commands; whether they all passed. */
function runStep(step: Step, tree: string, work: string): boolean {
  const begun = Date.now();
  // A tree given in its short form runs in its long one too (see `run`), once it exists.
  const at = existsSync(tree) ? realpathSync.native(tree) : tree;
  for (const { argv, cwd } of commandsOf(step, at, work)) {
    const done = spawnSync(argv, { cwd, env: cleanEnv(), stdout: "inherit", stderr: "inherit" });
    if (done.exitCode !== 0) {
      console.error(
        `\nrelease dry run: ${step} failed after ${seconds(Date.now() - begun)} (exit ${done.exitCode})`,
      );
      return false;
    }
  }
  return true;
}

/**
 * Runs each step in turn; 0 when all passed, 1 at the first that failed (its tree and work folder kept), 2 when the
 * tree can't take them. The work folder (the export, the bare repository and the default tree) is a new temporary
 * one, deleted when every step passed unless `keep`.
 */
function run(steps: readonly Step[], given: string | undefined, keep: boolean): number {
  // The long form of the path: Windows' temporary folder may be named in its short 8.3 form (`ABCDEF~1` for a
  // user folder), and Bun's `install --frozen-lockfile` run in a folder named that way says the lockfile changed
  // (Bun 1.4.2).
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-release-dry-run-")));
  const tree = given ?? join(work, "public");
  const problem = treeProblem(steps, tree);
  if (problem !== undefined) {
    console.error(`release dry run: ${problem}`);
    rmSync(work, { recursive: true, force: true });
    return 2;
  }
  const times: [Step, number][] = [];
  const started = Date.now();
  for (const step of steps) {
    console.log(`\n== ${step}`);
    const begun = Date.now();
    if (!runStep(step, tree, work)) {
      console.error(`kept: ${work}`);
      return 1;
    }
    times.push([step, Date.now() - begun]);
    console.log(`== ${step} passed in ${seconds(Date.now() - begun)}`);
  }
  console.log("\nrelease dry run passed:");
  for (const [step, ms] of times) console.log(`  ${step.padEnd(8)}${seconds(ms).padStart(9)}`);
  console.log(`  ${"total".padEnd(8)}${seconds(Date.now() - started).padStart(9)}`);
  if (keep) console.log(`kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
  return 0;
}

/** `--touches`: the export's answer, printed as it gave it. */
function touches(base: string): number {
  if (!existsSync(script("export-public.ts"))) {
    console.error(
      "release dry run: --touches needs the private export; it runs in the private repository only",
    );
    return 2;
  }
  const done = spawnSync([process.execPath, script("export-public.ts"), "--touches", base], {
    env: cleanEnv(),
    stdout: "inherit",
    stderr: "inherit",
  });
  return done.exitCode ?? 1;
}

if (import.meta.main) {
  const asked = plan(process.argv.slice(2));
  if (typeof asked === "string") {
    console.error(`release dry run: ${asked}`);
    console.error(USAGE);
    process.exitCode = 2;
  } else if ("touches" in asked) {
    process.exitCode = touches(asked.touches);
  } else {
    process.exitCode = run(asked.steps, asked.tree, asked.keep);
  }
}
