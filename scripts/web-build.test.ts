// The web app's builds (ADR 0054): the program's says so with a marker beside `index.html`; any other leaves none,
// even in a folder a program build filled before. What a build emits, the service's CSP lets through (ADR 0085):
// every face a file of its own, nothing inline in the page (`csp-faults.ts`, its bite in `csp-faults.test.ts`). Real
// `vite build`s into scratch folders, one program build shared by the tests: a few seconds, so here with the other
// slow tests of the scripts, not in `bun run test`.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CSP } from "@lookover/service";
import { cspFaults, emittedOf } from "./csp-faults.ts";

setDefaultTimeout(60_000);

const WEB = resolve(import.meta.dir, "..", "apps", "web");
const out = mkdtempSync(join(tmpdir(), "lookover-web-build-"));
/** The one program build the tests read; a test that builds over it does so on a copy. */
const program = join(out, "program");
beforeAll(() => build("build:program", program), 60_000);
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
  expect(existsSync(join(program, "index.html"))).toBe(true);
  expect(JSON.parse(readFileSync(join(program, MARKER), "utf8"))).toEqual({ mode: "program" });
  for (const text of DEV_ONLY) expect(scripts(program)).not.toContain(text);

  const dir = join(out, "over-program");
  cpSync(program, dir, { recursive: true });
  await build("build", dir);
  expect(existsSync(join(dir, "index.html"))).toBe(true);
  expect(existsSync(join(dir, MARKER))).toBe(false);
  const demo = scripts(dir);
  for (const text of DEV_ONLY) expect(demo).toContain(text);
});

/** Each `url(...)` of each `@font-face` in a stylesheet, as written. */
const faceUrls = (css: string): string[] =>
  (css.match(/@font-face\s*\{[^}]*\}/gi) ?? []).flatMap((face) =>
    [...face.matchAll(/url\(\s*["']?([^"')]+)/gi)].map((m) => m[1] ?? ""),
  );

test("the program's build emits nothing the service's CSP blocks: every face is a file it carries", () => {
  const emitted = emittedOf(program);
  expect(cspFaults(emitted, CSP)).toEqual([]);
  const urls = Object.entries(emitted).flatMap(([name, text]) =>
    name.endsWith(".css") ? faceUrls(text).map((url) => ({ name, url })) : [],
  );
  // The reading face, the device code's and the code face, each in several subsets.
  expect(urls.length).toBeGreaterThan(3);
  for (const { name, url } of urls) {
    expect(url).not.toStartWith("data:");
    const file = url.startsWith("/") ? join(program, url) : join(program, dirname(name), url);
    expect(existsSync(file)).toBe(true);
  }
});
