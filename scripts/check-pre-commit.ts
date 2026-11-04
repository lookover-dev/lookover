// `bun run check --pre-commit`, the git hook's check (ADR 0076): static only, about 3 s. Biome (no write) on
// the staged files it reads, `typecheck` and `imports`, in parallel, on the working tree as the editor sees it.
// A failed step is shown cut to the lines about the staged files (`check-cut.ts`), the others counted: it fails
// only when a staged file is red, since another ticket's red must not block every commit (the push's check finds
// a staged change that breaks another file). A failure that names no file fails whole; one with a diagnostic it
// can't tie to a file fails too. A staged root config file or lint rule can move any file's result, so then Biome checks
// the whole tree and nothing is cut; so too when git can't list the staged files. No test, no tree key, no green
// stamp. Over its budget it says so, without failing.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { aboutFiles } from "./check-cut.ts";
import { isLinted, movesEveryFile } from "./check-scope.ts";

type Step = { name: string; args: string[] };
type Ran = { name: string; ok: boolean; output: string; ms: number };

/** The steps for these staged files: Biome on the whole tree, or only when one of them is a file it reads. */
function stepsFor(root: string, staged: readonly string[], everything: boolean): Step[] {
  // A staged deletion is gone from the tree: Biome would stop on its name.
  const linted = staged.filter((f) => isLinted(f) && existsSync(join(root, f)));
  const biome: Step[] = everything
    ? [{ name: "lint", args: [] }]
    : linted.length > 0
      ? [{ name: "lint:files", args: linted }]
      : [];
  return [...biome, { name: "typecheck", args: [] }, { name: "imports", args: [] }];
}

async function run(root: string, { name, args }: Step): Promise<Ran> {
  const begun = performance.now();
  const proc = Bun.spawn([process.execPath, "run", "--silent", name, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { name, ok: code === 0, output: `${out}${err}`.trim(), ms: performance.now() - begun };
}

const seconds = (ms: number, digits: number) => (ms / 1000).toFixed(digits);

/**
 * Runs the pre-commit check on the staged code files (repository-relative; null when they couldn't be listed,
 * so the whole tree is checked and nothing is cut); its exit code.
 */
export async function preCommit(
  root: string,
  staged: readonly string[] | null,
  budgetMs: number,
): Promise<number> {
  const started = performance.now();
  if (staged === null)
    console.log("pre-commit: git can't list the staged files, so the whole tree is checked.");
  const files = staged ?? [];
  const everything = staged === null || staged.some(movesEveryFile);
  const results = await Promise.all(stepsFor(root, files, everything).map((step) => run(root, step)));
  const lines: string[] = [];
  let failed = false;
  for (const r of results) {
    const took = `${r.name} (${seconds(r.ms, 2)} s)`;
    if (r.ok) {
      lines.push(`pre-commit: ok   ${took}`);
      continue;
    }
    const cut = everything ? { text: r.output, mine: 0, others: 0, loose: 0 } : aboutFiles(r.output, files);
    // Red only in files not staged passes; a diagnostic tied to no file may be any file's, so it fails.
    if (cut.mine === 0 && cut.others > 0 && cut.loose === 0) {
      lines.push(
        `pre-commit: ok   ${took}, ${cut.others} red in files not staged (\`bun run check\` lists them)`,
      );
      continue;
    }
    failed = true;
    console.error(`\n--- ${r.name} ---\n${cut.text}\n`);
    lines.push(`pre-commit: FAIL ${took}`);
  }
  for (const line of lines) console.log(line);
  const ms = performance.now() - started;
  if (ms > budgetMs) {
    console.log(`pre-commit: took ${seconds(ms, 1)} s, over its ${budgetMs / 1000} s budget (ADR 0076).`);
  }
  return failed ? 1 : 0;
}
