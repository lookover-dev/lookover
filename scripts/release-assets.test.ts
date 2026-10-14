// The npm packages at one seam (ADR 0061, spec #319's Testing Decisions): `releaseAssets` packs the six tarballs from
// stand-in executables (a program that prints its arguments and `LOOKOVER_LAUNCHER`, and exits with the code
// `STANDIN_EXIT` names), real npm installs them into a scratch prefix, offline, and the installed `lookover` shim runs.
// Each run costs about 20 s on Windows (the stand-in there is a compiled Bun program, 86 MB to pack and install), so
// it lives with the script tests (`check:full`), not in `bun run check`.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { isNpmShim } from "@lookover/service";
import { executablesAsked, releaseAssets } from "./release-assets.ts";
import { installGlobal, runShim, shimOf } from "./release-smoke.ts";

// Packing, then installing with npm, twice, and compiling the stand-in on Windows: well past Bun's 5 s.
setDefaultTimeout(180_000);

const npm = Bun.which("npm");
if (npm === null)
  console.warn("release-assets.test.ts: no `npm` on the PATH, so the npm packages aren't tested.");

const HOST = `${process.platform}-${process.arch}`;
const PLATFORMS = ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const VERSION = "1.2.3";
const executableOf = (platform: string) => (platform.startsWith("win32") ? "lookover.exe" : "lookover");

let scratch = "";
let out = "";

/**
 * The stand-in for the host's executable: Bun compiled on Windows (npm's launcher spawns an `.exe`), elsewhere a shell
 * script that ends by the signal `STANDIN_SIGNAL` names, if any (a Node script can't end by SIGPIPE: Node ignores it),
 * else runs the Node script.
 */
async function standIn(): Promise<string> {
  const said =
    "console.log(JSON.stringify({ args: process.argv.slice(2), launcher: process.env.LOOKOVER_LAUNCHER ?? null }));\n" +
    "process.exit(Number(process.env.STANDIN_EXIT ?? 0));\n";
  if (process.platform !== "win32") {
    const script = join(scratch, "said.js");
    writeFileSync(script, said);
    const file = join(scratch, "stand-in", "lookover");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      `#!/bin/sh\nif [ -n "$STANDIN_SIGNAL" ]; then kill -s "$STANDIN_SIGNAL" $$; fi\nexec node '${script}' "$@"\n`,
    );
    chmodSync(file, 0o755);
    return file;
  }
  const source = join(scratch, "stand-in.ts");
  writeFileSync(source, said);
  const file = join(scratch, "stand-in", "lookover.exe");
  const built = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", file], {
    cwd: scratch,
  });
  if (built.exitCode !== 0) throw new Error(`the stand-in didn't compile: ${built.stderr.toString()}`);
  return file;
}

/** Every file in the gzipped tarball `tgz`, by its path in it, with its text. */
function tarball(tgz: string): Map<string, string> {
  const tar = gunzipSync(readFileSync(tgz));
  const files = new Map<string, string>();
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name === "") break;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8);
    files.set(
      prefix === "" ? name : `${prefix}/${name}`,
      tar.subarray(at + 512, at + 512 + size).toString("utf8"),
    );
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const manifestOf = (tgz: string) => JSON.parse(tarball(join(out, tgz)).get("package/package.json") ?? "null");

/** Runs the installed `lookover` shim of `prefix` with `args`. */
const runInstalled = (prefix: string, args: string[], exit = 0, signal?: string) =>
  runShim(shimOf(prefix, process.platform), args, {
    cwd: scratch,
    env: { ...process.env, STANDIN_EXIT: String(exit), STANDIN_SIGNAL: signal, LOOKOVER_LAUNCHER: undefined },
  });

beforeAll(async () => {
  if (npm === null) return;
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-t324-assets-")));
  out = join(scratch, "npm");
  const host = await standIn();
  const executables: Record<string, string> = {};
  for (const platform of PLATFORMS) {
    if (platform === HOST) executables[platform] = host;
    else {
      // Never run: a few bytes stand for the other platforms' executables.
      const file = join(scratch, "others", platform, executableOf(platform));
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `the ${platform} executable`);
      executables[platform] = file;
    }
  }
  releaseAssets({ version: VERSION, executables, out });
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("the executables asked for", () => {
  test("--from refuses on Windows, which would pack macOS's and Linux's without their execute bit", () => {
    const asked = executablesAsked(["--from", "artifacts"], "win32");
    expect(asked).toEqual({
      refused: expect.stringContaining(
        "Pack darwin-arm64, darwin-x64, linux-x64, linux-arm64 on macOS or Linux",
      ),
    });
  });

  test("--from on Linux asks for every platform's, from <dir>/<platform>", () => {
    const asked = executablesAsked(["--from", "artifacts"], "linux");
    expect(asked).toEqual({
      executables: Object.fromEntries(
        PLATFORMS.map((platform) => [
          platform,
          join(process.cwd(), "artifacts", platform, executableOf(platform)),
        ]),
      ),
    });
  });
});

describe.skipIf(npm === null)("the npm packages", () => {
  test("the six tarballs and their SHA256SUMS are written", () => {
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    const names = [
      "lookover-1.2.3.tgz",
      "lookover-darwin-arm64-1.2.3.tgz",
      "lookover-darwin-x64-1.2.3.tgz",
      "lookover-linux-arm64-1.2.3.tgz",
      "lookover-linux-x64-1.2.3.tgz",
      "lookover-win32-x64-1.2.3.tgz",
    ];
    expect(sums.map((line) => line.split("  ")[1])).toEqual(names);
    for (const line of sums) {
      const [sum = "", name = ""] = line.split("  ");
      expect(sum).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(join(out, name))).digest("hex"));
    }
  });

  test("each platform package is its executable alone, for its os and cpu, with no bin and no install script", () => {
    for (const platform of PLATFORMS) {
      const [os, cpu] = platform.split("-");
      const manifest = manifestOf(`lookover-${platform}-1.2.3.tgz`);
      expect(manifest).toMatchObject({
        name: `@lookover/${platform}`,
        version: VERSION,
        os: [os],
        cpu: [cpu],
        files: [executableOf(platform)],
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/lookover-dev/lookover.git" },
        homepage: "https://lookover.dev",
        publishConfig: { access: "public" },
      });
      // Bun's Linux executables are linked against glibc: npm skips them on Alpine and other musl Linux.
      expect(manifest.libc).toEqual(os === "linux" ? ["glibc"] : undefined);
      expect(manifest.bin).toBeUndefined();
      expect(manifest.scripts).toBeUndefined();
      const files = tarball(join(out, `lookover-${platform}-1.2.3.tgz`));
      expect(files.get(`package/${executableOf(platform)}`)).toBeDefined();
      expect(files.get("package/README.md")).toContain("installed by `lookover`");
    }
  });

  test("the main package is the launcher, the README and the licence, on the five platforms at its exact version", () => {
    const manifest = manifestOf("lookover-1.2.3.tgz");
    expect(manifest).toMatchObject({
      name: "lookover",
      version: VERSION,
      bin: { lookover: "bin/lookover.js" },
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/lookover-dev/lookover.git" },
      homepage: "https://lookover.dev",
      engines: { node: ">=18" },
      publishConfig: { access: "public" },
    });
    expect(manifest.optionalDependencies).toEqual({
      "@lookover/win32-x64": "1.2.3",
      "@lookover/darwin-arm64": "1.2.3",
      "@lookover/darwin-x64": "1.2.3",
      "@lookover/linux-x64": "1.2.3",
      "@lookover/linux-arm64": "1.2.3",
    });
    expect(manifest.scripts).toBeUndefined();
    expect([...tarball(join(out, "lookover-1.2.3.tgz")).keys()].sort()).toEqual([
      "package/LICENSE",
      "package/README.md",
      "package/bin/lookover.js",
      "package/package.json",
    ]);
  });

  test("installed with npm, the shim runs the host's executable with the same arguments and exit code, as npm's", async () => {
    const prefix = join(scratch, "prefix");
    await installGlobal({
      prefix,
      tarballs: [join(out, "lookover-1.2.3.tgz"), join(out, `lookover-${HOST}-1.2.3.tgz`)],
      scratch,
    });
    const ran = runInstalled(prefix, ["review", "two words", "--home=x"], 3);
    expect({ code: ran.code, err: ran.err }).toEqual({ code: 3, err: "" });
    const said = JSON.parse(ran.out);
    expect(said.args).toEqual(["review", "two words", "--home=x"]);
    const launcher = realpathSync.native(join(npmModules(prefix), "lookover", "bin", "lookover.js"));
    expect(realpathSync.native(said.launcher)).toBe(launcher);
    // What `Self`'s npm kind takes for this install's `lookover` on the PATH (#321).
    expect(isNpmShim(shimOf(prefix, process.platform), said.launcher, process.platform)).toBe(true);
  });

  // Windows has no signals to end by: a process there ends with a code, which the test above covers.
  test.skipIf(process.platform === "win32")(
    "installed with npm, the shim ends as its executable ends by a signal, even one Node ignores",
    () => {
      const prefix = join(scratch, "prefix");
      const ended = runInstalled(prefix, ["serve"], 0, "TERM");
      expect(ended.signal === "SIGTERM" || ended.code === 143).toBe(true);
      // Node ignores SIGPIPE, so the launcher can't end by it: it exits 128 + 13, as a shell would say it.
      expect(runInstalled(prefix, ["serve"], 0, "PIPE")).toMatchObject({ code: 141, signal: null });
    },
  );

  test("installed alone, the launcher says which platforms exist and how to reinstall, and exits 1", async () => {
    const prefix = join(scratch, "alone");
    await installGlobal({ prefix, tarballs: [join(out, "lookover-1.2.3.tgz")], scratch });
    const ran = runInstalled(prefix, ["--version"]);
    expect(ran.code).toBe(1);
    expect(ran.out).toBe("");
    expect(ran.err).toContain(`no executable for ${HOST}`);
    expect(ran.err).toContain("win32-x64, darwin-arm64, darwin-x64, linux-x64, linux-arm64");
    expect(ran.err).toContain("npm install -g lookover --include=optional");
  });
});

/** Where npm puts a global install's packages under `prefix`. */
const npmModules = (prefix: string) =>
  process.platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
