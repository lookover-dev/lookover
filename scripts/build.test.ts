// `bun run build` through the entry it generates for the compiled binary (ADR 0054): every file of the built web app
// imported as a file the binary carries, mapped by its path in the app, and `main` run as the binary. The build
// itself, the compile and its smoke check, is `bun run build`'s own run: too slow for a test. That smoke check is
// also the evidence that the entry's import of `main.ts` leaves its `import.meta.main` block unrun in the binary: run
// twice, `--version` would print twice and demo mode would start two services on one data folder, and it fails.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryModule, targetArgs, webFilesIn } from "./build.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A built app's folder holding `files`, removed after the test. */
function builtApp(files: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookover-build-")));
  dirs.push(dir);
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  return dir;
}

test("--baseline compiles for this machine's x64 on Bun's baseline target, and nothing else does", () => {
  expect(targetArgs({ baseline: false, platform: "win32", arch: "x64" })).toEqual([]);
  expect(targetArgs({ baseline: true, platform: "win32", arch: "x64" })).toEqual([
    "--target=bun-windows-x64-baseline",
  ]);
  expect(targetArgs({ baseline: true, platform: "linux", arch: "x64" })).toEqual([
    "--target=bun-linux-x64-baseline",
  ]);
  expect(targetArgs({ baseline: true, platform: "darwin", arch: "x64" })).toEqual([
    "--target=bun-darwin-x64-baseline",
  ]);
  expect(() => targetArgs({ baseline: true, platform: "darwin", arch: "arm64" })).toThrow(
    "--baseline is for x64; this machine is arm64",
  );
});

test("the web app's files are listed by their path in the app, with forward slashes, in name order", () => {
  const dist = builtApp(["index.html", "assets/index-b2.js", "assets/fonts/a.woff2", "favicon.svg"]);
  expect(webFilesIn(dist)).toEqual([
    "assets/fonts/a.woff2",
    "assets/index-b2.js",
    "favicon.svg",
    "index.html",
  ]);
});

test("a build with no index.html is refused: the binary would serve no app", () => {
  expect(() => webFilesIn(builtApp(["assets/index-b2.js"]))).toThrow("index.html");
});

test("the entry imports each file as one the binary carries, maps it by its path, and runs main as the binary", () => {
  const module = entryModule(["assets/index-b2.js", "index.html"], {
    web: "../../apps/web/dist",
    service: "../../apps/service/src",
  });
  expect(module).toContain('import { main } from "../../apps/service/src/main.ts";');
  expect(module).toContain('import { programSelf } from "../../apps/service/src/self.ts";');
  expect(module).toContain('import { carriedWebFiles } from "../../apps/service/src/web-files.ts";');
  expect(module).toContain('import f0 from "../../apps/web/dist/assets/index-b2.js" with { type: "file" };');
  expect(module).toContain('import f1 from "../../apps/web/dist/index.html" with { type: "file" };');
  expect(module).toContain('["assets/index-b2.js", f0],');
  expect(module).toContain('["index.html", f1],');
  expect(module).toContain(
    // As its environment says it was started: on its own, or by npm's launcher (ADR 0061).
    "await main(programSelf(process.execPath, process.env, carriedWebFiles(new Map<string, string>([",
  );
});
