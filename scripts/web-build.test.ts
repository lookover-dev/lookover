// The web app's builds (ADR 0054): the program's says so with a marker beside `index.html`; any other leaves none,
// even in a folder a program build filled before. Real `vite build`s into scratch folders: a few seconds, so here
// with the other slow tests of the scripts, not in `bun run test`.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(60_000);

const WEB = resolve(import.meta.dir, "..", "apps", "web");
const out = mkdtempSync(join(tmpdir(), "lookover-web-build-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** `bun run <script>` in the web app, its output in `dir`; throws with what it printed when it fails. */
async function build(script: "build" | "build:program", dir: string): Promise<void> {
  const proc = Bun.spawn(
    [process.execPath, "run", script, "--outDir", dir, "--emptyOutDir", "--logLevel", "error"],
    {
      cwd: WEB,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, said, failed] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${script} exited ${code}: ${said}${failed}`);
}

const MARKER = "lookover-program.json";

/** What only the developer's tools carry: the drawer's own copy and the demo client's verb. */
const DEV_ONLY = ["Open the developer drawer", "not part of the app", "demo.load"];

/** Every script a build left under `assets/`, as one text. */
const scripts = (dir: string): string =>
  readdirSync(join(dir, "assets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(dir, "assets", name), "utf8"))
    .join("\n");

test("the program's build writes the marker and carries no developer's tool; the plain build, over it, the tools and no marker", async () => {
  const dir = join(out, "dist");
  await build("build:program", dir);
  expect(existsSync(join(dir, "index.html"))).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, MARKER), "utf8"))).toEqual({ mode: "program" });
  const program = scripts(dir);
  for (const text of DEV_ONLY) expect(program).not.toContain(text);

  await build("build", dir);
  expect(existsSync(join(dir, "index.html"))).toBe(true);
  expect(existsSync(join(dir, MARKER))).toBe(false);
  const demo = scripts(dir);
  for (const text of DEV_ONLY) expect(demo).toContain(text);
});
