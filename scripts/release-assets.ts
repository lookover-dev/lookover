// `bun scripts/release-assets.ts`: the npm packages of a release (ADR 0061, the esbuild pattern), packed with npm into
// `dist/npm/` from the built executables, with their `SHA256SUMS`:
//
//   - one platform package per platform the main package names (`@lookover/<platform>-<arch>`, its `os` and `cpu`
//     those two words): the executable alone, no `bin`, no script, a README line saying `lookover` installs it;
//   - the main package `lookover`, from `npm/package.template.json` at the release's version: the launcher
//     (`npm/bin/lookover.js`), the README and the licence, the platform packages as `optionalDependencies` at that
//     exact version.
//
// No package has an install script: npm picks the platform package by its `os` and `cpu`, and `--ignore-scripts`
// changes nothing. The version is the root package.json's. Each executable is made executable before it is packed
// (an artifact download loses the bit) and npm keeps the bit, so `--from` packs macOS's and Linux's on one of them and
// refuses on Windows: it has no such bit, and its tarballs of them would install executables nothing can run.
//
//   bun scripts/release-assets.ts --from <dir>   every platform, from <dir>/<platform>/lookover[.exe]
//   bun scripts/release-assets.ts --host         this machine's platform alone, from `dist/lookover[.exe]` (a dry run)
//
// Exit 0 written, 1 a missing executable or a failed pack, 2 usage or `--from` on Windows.
import {
  chmodSync,
  copyFileSync,
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
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const NPM = join(root, "npm");
const SCOPE = "@lookover/";

/** The executable's name in a platform package, as the launcher looks for it. */
export const executableName = (platform: string): string =>
  platform.startsWith("win32-") ? "lookover.exe" : "lookover";

/** The main package's template: what every package says of where it comes from, and the platforms it names. */
type Template = {
  name: string;
  license: string;
  repository: unknown;
  homepage: string;
  bugs?: unknown;
  optionalDependencies: Record<string, string>;
  [field: string]: unknown;
};

const template = (): Template => JSON.parse(readFileSync(join(NPM, "package.template.json"), "utf8"));

/** The platforms a release is built for (`win32-x64`, …): the main package's `optionalDependencies`, unscoped. */
export function releasePlatforms(): string[] {
  return Object.keys(template().optionalDependencies).map((name) => {
    if (!name.startsWith(SCOPE))
      throw new Error(`npm/package.template.json: ${name} isn't an ${SCOPE} package`);
    return name.slice(SCOPE.length);
  });
}

const WORDS: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

/** The platform package's README: one line, since nobody installs it by hand. */
function platformReadme(platform: string): string {
  const [os = "", cpu = ""] = platform.split("-");
  return (
    `# ${SCOPE}${platform}\n\n` +
    `Lookover's executable for ${WORDS[os] ?? os} on ${cpu}, installed by \`lookover\`: run \`npm install -g lookover\`.\n`
  );
}

/** Packs the package in `folder` with npm into `out`; the tarball's file name. */
function pack(folder: string, out: string): string {
  const packed = Bun.spawnSync(["npm", "pack", "--json", "--pack-destination", out, "--loglevel=error"], {
    cwd: folder,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (packed.exitCode !== 0) throw new Error(`npm pack failed in ${folder}: ${packed.stderr.toString()}`);
  const [{ filename }] = JSON.parse(packed.stdout.toString());
  return basename(filename);
}

/**
 * Writes the release's npm packages into `out` (emptied first): each platform of `executables` (its executable's
 * path, by platform), the main package, and `SHA256SUMS` over the tarballs. The tarballs' names, in name order.
 */
export function releaseAssets(o: {
  version: string;
  executables: Record<string, string>;
  out: string;
}): string[] {
  const known = releasePlatforms();
  const unknown = Object.keys(o.executables).filter((platform) => !known.includes(platform));
  if (unknown.length > 0)
    throw new Error(
      `No release is built for ${unknown.join(", ")}: npm/package.template.json names ${known.join(", ")}`,
    );
  const main = template();
  const from = {
    license: main.license,
    repository: main.repository,
    homepage: main.homepage,
    ...(main.bugs === undefined ? {} : { bugs: main.bugs }),
  };
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(o.out, { recursive: true });
  const stage = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-release-assets-")));
  try {
    for (const [platform, executable] of Object.entries(o.executables)) {
      const [os, cpu] = platform.split("-");
      const folder = join(stage, platform);
      mkdirSync(folder);
      const name = executableName(platform);
      copyFileSync(executable, join(folder, name));
      chmodSync(join(folder, name), 0o755);
      copyFileSync(join(root, "LICENSE"), join(folder, "LICENSE"));
      writeFileSync(join(folder, "README.md"), platformReadme(platform));
      const manifest = {
        name: `${SCOPE}${platform}`,
        version: o.version,
        description: `Lookover's executable for ${WORDS[os ?? ""] ?? os} on ${cpu}, installed by lookover.`,
        ...from,
        os: [os],
        cpu: [cpu],
        // Bun's Linux executables are linked against glibc: on Alpine and other musl Linux npm skips the package, and
        // the launcher says none fits, rather than installing one that can't start.
        ...(os === "linux" ? { libc: ["glibc"] } : {}),
        files: [name],
        publishConfig: { access: "public" },
      };
      writeFileSync(join(folder, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      pack(folder, o.out);
    }

    const folder = join(stage, "lookover");
    mkdirSync(join(folder, "bin"), { recursive: true });
    copyFileSync(join(NPM, "bin", "lookover.js"), join(folder, "bin", "lookover.js"));
    chmodSync(join(folder, "bin", "lookover.js"), 0o755);
    copyFileSync(join(root, "README.md"), join(folder, "README.md"));
    copyFileSync(join(root, "LICENSE"), join(folder, "LICENSE"));
    const optionalDependencies = Object.fromEntries(
      known.map((platform) => [`${SCOPE}${platform}`, o.version]),
    );
    writeFileSync(
      join(folder, "package.json"),
      `${JSON.stringify({ ...main, version: o.version, optionalDependencies }, null, 2)}\n`,
    );
    pack(folder, o.out);
  } finally {
    rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  const tarballs = readdirSync(o.out)
    .filter((file) => file.endsWith(".tgz"))
    .sort();
  const sums = tarballs.map(
    (file) =>
      `${new Bun.CryptoHasher("sha256").update(readFileSync(join(o.out, file))).digest("hex")}  ${file}\n`,
  );
  writeFileSync(join(o.out, "SHA256SUMS"), sums.join(""));
  return tarballs;
}

/**
 * The executables `args` ask for, by platform, on a machine running `os`; or why it refuses them. Windows has no
 * execute bit, so it refuses to pack macOS's and Linux's: npm would install executables nothing can run.
 */
export function executablesAsked(
  args: string[],
  os: NodeJS.Platform = process.platform,
): { executables: Record<string, string> } | { refused: string } {
  const [mode, dir, ...rest] = args;
  if (mode === "--host" && dir === undefined) {
    const host = `${os}-${process.arch}`;
    if (!releasePlatforms().includes(host))
      return { refused: `No release is built for this machine, ${host}` };
    return { executables: { [host]: join(root, "dist", executableName(host)) } };
  }
  if (mode === "--from" && dir !== undefined && rest.length === 0) {
    const platforms = releasePlatforms();
    const unrunnable = platforms.filter((platform) => !platform.startsWith("win32-"));
    if (os === "win32" && unrunnable.length > 0)
      return {
        refused:
          `Pack ${unrunnable.join(", ")} on macOS or Linux: Windows has no execute bit, and npm would install ` +
          "their executables unable to run.",
      };
    return {
      executables: Object.fromEntries(
        platforms.map((platform) => [platform, join(resolve(dir), platform, executableName(platform))]),
      ),
    };
  }
  return { refused: "Usage: bun scripts/release-assets.ts --host | --from <dir>" };
}

if (import.meta.main) {
  const asked = executablesAsked(process.argv.slice(2));
  if ("refused" in asked) {
    console.error(asked.refused);
    process.exit(2);
  }
  const { executables } = asked;
  const missing = Object.entries(executables).filter(([, file]) => !existsSync(file));
  if (missing.length > 0) {
    for (const [platform, file] of missing) console.error(`No ${platform} executable at ${file}`);
    console.error("Build it first: bun run build (--baseline on x64).");
    process.exit(1);
  }
  const out = join(root, "dist", "npm");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tarballs = releaseAssets({ version, executables, out });
  for (const file of tarballs)
    console.log(`${file}  ${(statSync(join(out, file)).size / 1e6).toFixed(1)} MB`);
  console.log(`Wrote ${tarballs.length} tarballs and SHA256SUMS into dist/npm, version ${version}.`);
}
