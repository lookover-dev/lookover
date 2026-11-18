// The smoke runs where nothing was installed (ADR 0061): the public release.yml's `verify` jobs check the repository
// out, set Bun up and run `bun scripts/release-smoke.ts --from-registry`, with no `bun install`. So the smoke, and
// every file it imports at run time, imports only `node:` and `bun:` modules and files of the repository by relative
// path: never a package, a workspace one included. The test walks that graph, copies what it reaches into a scratch
// folder with no node_modules, and runs the copy there as the job runs it, to a command-line refusal (exit 2), which
// it reaches only once every import resolved.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SMOKE = join(ROOT, "scripts", "release-smoke.ts");

/** The files `entry` reaches at run time, itself first, and each import that isn't a built-in or a relative file. */
function reach(entry: string): { files: string[]; packages: string[] } {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const files: string[] = [];
  const packages: string[] = [];
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (files.includes(file)) continue;
    files.push(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (path.startsWith("node:") || path.startsWith("bun:") || path === "bun") continue;
      if (path.startsWith("./") || path.startsWith("../")) queue.push(resolve(dirname(file), path));
      else packages.push(`${relative(ROOT, file)} imports ${path}`);
    }
  }
  return { files, packages };
}

test("the smoke and what it imports at run time import no package", () => {
  expect(reach(SMOKE).packages).toEqual([]);
});

test("the smoke runs from a folder with no node_modules, as release.yml's verify job runs it", () => {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-smoke-alone-")));
  try {
    for (const file of reach(SMOKE).files) {
      const copy = join(scratch, relative(ROOT, file));
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(file, copy);
    }
    const env: Record<string, string | undefined> = { ...process.env, NODE_PATH: undefined };
    // `--no-install`: Bun would otherwise fetch a missing package from npm, and a test calls no network.
    const ran = Bun.spawnSync(
      ["bun", "--no-install", join(scratch, "scripts", "release-smoke.ts"), "--wait"],
      {
        cwd: scratch,
        env,
      },
    );
    expect({ code: ran.exitCode, err: ran.stderr.toString().trim() }).toEqual({
      code: 2,
      err: "--wait waits for the registry: pass --from-registry <version> too",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
