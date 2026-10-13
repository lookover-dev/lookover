// Where an engine's program is (ADR 0012, ADR 0044): one walk for both engines, a rule per engine. `PATH` first,
// in order, then the engine's known install folders; the first found wins. What is run is an executable by
// absolute path, never a `.cmd` shim or a script a shell would have to read:
// - On Windows only `<name>.exe` is run. A name without an extension (npm's sh launcher) never is, and a `.cmd`
//   shim is read, never run: Codex's npm or pnpm shim leads to its package, whose native executable is found as
//   the package's own `bin/codex.js` finds it, from the package's real folder (a pnpm junction followed): the
//   platform package nested in it, hoisted beside it, or its `vendor` folder. Claude's shim is unwrapped to the
//   program it names, unless that is Node (npm's `cli.js` launcher): Node running a script is not Claude, and
//   `claudeNpmLauncher` names that shim for whoever says why Claude wasn't found.
// - Elsewhere `<name>` is taken, its symlink followed. Codex: one that ends at the package's `bin/codex.js` (npm's
//   global link), or a `#!` script launcher naming that script, leads to the native executable as above; any
//   other `#!` script is never run. Claude: run as it is (npm's link to `cli.js` included: the system follows its
//   `#!/usr/bin/env node` line, no shell reads it).
// - Claude's known folders: `~/.local/bin`, the winget package, the desktop app's bundle (exploration 02).
//   Codex's: npm's prefix (`%APPDATA%\npm`), nvm-windows' link (`NVM_SYMLINK`), the desktop app's bundle on
//   Windows; `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` elsewhere (survey of spec #87).
// Never throws: a folder or file that can't be read is passed over.
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, sep } from "node:path";

/** The machine the program runs on: its platform decides what may be run, its architecture Codex's package. */
export interface Host {
  platform: NodeJS.Platform;
  arch: string;
}

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/** A folder's entries; none when it can't be read (a file, no permission): the search goes on, never throws. */
function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A file's text; empty when it can't be read. */
function text(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Whether the file is a script (it starts with `#!`); false when it can't be read. Reads two bytes, not the file. */
function isScript(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    try {
      const start = Buffer.alloc(2);
      return readSync(fd, start, 0, 2, 0) === 2 && start.toString("latin1") === "#!";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Where a path leads, its links followed; the path itself when it can't be resolved. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The variable's value, whatever its case: Windows environments spell `Path` and `PATH` alike. */
function variable(env: Record<string, string>, name: string): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? "" : (env[key] ?? "");
}

/** A shim's text with its own folder put in for the spellings shims use for it, and `%VARIABLES%` expanded. */
function expanded(shim: string, env: Record<string, string>): string {
  const dir = dirname(shim);
  return text(shim)
    .replace(/%~dp0\\?|%dp0%\\?|\$basedir\//g, `${dir}\\`)
    .replace(/%([^%\s"]+)%/g, (_, name: string) => variable(env, name));
}

/** A path a shim names, in this machine's separators: shims write `\`, the files are where this machine has them. */
const native = (path: string): string => path.split(/[\\/]+/).join(sep);

/** One engine's rule: the program in a folder, if that folder holds one. */
type Probe = (dir: string, env: Record<string, string>, host: Host) => string | null;

/** The first folder of `PATH`, in order, that holds the program. */
function onPath(env: Record<string, string>, host: Host, probe: Probe): string | null {
  for (const dir of variable(env, "PATH").split(delimiter)) {
    const found = dir === "" ? null : probe(dir, env, host);
    if (found) return found;
  }
  return null;
}

/** The first of `dirs` (an empty one skipped) that holds the program. */
function inFolders(dirs: string[], env: Record<string, string>, host: Host, probe: Probe): string | null {
  for (const dir of dirs) {
    const found = dir === "" ? null : probe(dir, env, host);
    if (found) return found;
  }
  return null;
}

/** The first `<name>` found in one of `root`'s sub-folders (the desktop apps' bundles), newest name first. */
function inBundles(root: string, name: string, order: (a: string, b: string) => number): string | null {
  for (const sub of entries(root).sort(order)) {
    const candidate = join(root, sub, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

const home = (env: Record<string, string>): string => variable(env, "USERPROFILE") || variable(env, "HOME");

// Claude --------------------------------------------------------------------------------------------------------

/** The program a `.cmd` shim runs: its first quoted path, or null when it names none. */
function claudeShimTarget(shim: string, env: Record<string, string>): string | null {
  const quoted = /"([^"\r\n]+)"/.exec(expanded(shim, env));
  return quoted?.[1] === undefined ? null : native(quoted[1]);
}

const isNode = (path: string): boolean => /^node(\.exe)?$/i.test(basename(path));

/** The program a `.cmd` shim runs; null when it names none, or names Node. */
function unwrapClaudeShim(shim: string, env: Record<string, string>): string | null {
  const target = claudeShimTarget(shim, env);
  if (target === null || isNode(target)) return null;
  return isFile(target) ? target : null;
}

const claudeIn: Probe = (dir, env, host) => {
  if (host.platform !== "win32") {
    const candidate = join(dir, "claude");
    return isFile(candidate) ? candidate : null;
  }
  const exe = join(dir, "claude.exe");
  if (isFile(exe)) return exe;
  const shim = join(dir, "claude.cmd");
  return isFile(shim) ? unwrapClaudeShim(shim, env) : null;
};

function claudeWinget(localAppData: string): string | null {
  const root = join(localAppData, "Microsoft", "WinGet", "Packages");
  for (const name of entries(root)) {
    const candidate = join(root, name, "claude.exe");
    if (name.startsWith("Anthropic.ClaudeCode_") && isFile(candidate)) return candidate;
  }
  return null;
}

/** The newest `claude.exe` under the desktop app's `claude-code/<version>/<build>/` folders. */
function claudeDesktop(appData: string): string | null {
  const root = join(appData, "Claude", "claude-code");
  const versions = entries(root).sort((a, b) => Bun.semver.order(b, a));
  for (const version of versions) {
    const found = inBundles(join(root, version), "claude.exe", () => 0);
    if (found) return found;
  }
  return null;
}

/**
 * On Windows, the first `claude.cmd` on `PATH` that runs Node (npm's launcher of Claude Code's `cli.js`), which
 * `locateClaude` passes over; null when there is none, or elsewhere.
 */
export function claudeNpmLauncher(env: Record<string, string>, host: Host = process): string | null {
  if (host.platform !== "win32") return null;
  return onPath(env, host, (dir) => {
    const shim = join(dir, "claude.cmd");
    const target = isFile(shim) ? claudeShimTarget(shim, env) : null;
    return target !== null && isNode(target) ? shim : null;
  });
}

/** The absolute path of the `claude` executable, or null when none is found. */
export function locateClaude(env: Record<string, string>, host: Host = process): string | null {
  const found =
    onPath(env, host, claudeIn) ??
    (home(env) === "" ? null : claudeIn(join(home(env), ".local", "bin"), env, host));
  if (found) return found;
  const localAppData = variable(env, "LOCALAPPDATA");
  const winget = localAppData === "" ? null : claudeWinget(localAppData);
  if (winget) return winget;
  const appData = variable(env, "APPDATA");
  return appData === "" ? null : claudeDesktop(appData);
}

// Codex ---------------------------------------------------------------------------------------------------------

/** Codex's build for each machine it ships for: its platform package's name ends `<platform>-<arch>`. */
const TRIPLES: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

/**
 * `@openai/codex`'s native executable, from the package's folder: as its own `bin/codex.js` looks for it, from
 * the folder the package really is in (pnpm links it from its store, where the platform package sits beside it).
 */
function codexNative(linked: string, host: Host): string | null {
  const pkg = real(linked);
  const machine = `${host.platform}-${host.arch}`;
  const triple = TRIPLES[machine];
  if (triple === undefined) return null;
  const inVendor = (root: string) =>
    join(root, "vendor", triple, "bin", host.platform === "win32" ? "codex.exe" : "codex");
  const platformPackage = join("@openai", `codex-${machine}`);
  const candidates = [
    // Nested in the package, hoisted beside it (`<node_modules>/@openai/codex` → `<node_modules>/@openai/…`),
    // or in its own `vendor` folder.
    inVendor(join(pkg, "node_modules", platformPackage)),
    inVendor(join(dirname(dirname(pkg)), platformPackage)),
    inVendor(pkg),
  ];
  return candidates.find(isFile) ?? null;
}

/** The package an npm or pnpm shim launches (`…\node_modules\@openai\codex\bin\codex.js`), or null. */
function codexShimPackage(shim: string, env: Record<string, string>): string | null {
  const script = /"([^"\r\n]*node_modules[\\/]@openai[\\/]codex)[\\/]bin[\\/]codex\.js"/.exec(
    expanded(shim, env),
  );
  return script?.[1] === undefined ? null : native(script[1]);
}

const codexIn: Probe = (dir, env, host) => {
  if (host.platform !== "win32") {
    const candidate = join(dir, "codex");
    if (!isFile(candidate)) return null;
    // npm's global link ends at the package's script: the native executable is in the package.
    const target = real(candidate);
    if (basename(target) === "codex.js") return codexNative(dirname(dirname(target)), host);
    if (!isScript(target)) return candidate;
    // A script launcher (npm's sh shim) is never run; the package it names may hold the native executable.
    const pkg = codexShimPackage(target, env);
    return pkg === null ? null : codexNative(pkg, host);
  }
  const exe = join(dir, "codex.exe");
  if (isFile(exe)) return exe;
  const shim = join(dir, "codex.cmd");
  const pkg = isFile(shim) ? codexShimPackage(shim, env) : null;
  return pkg === null ? null : codexNative(pkg, host);
};

/** The newest `codex.exe` of the Codex desktop app (`%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\`). */
function codexDesktop(localAppData: string): string | null {
  const root = join(localAppData, "OpenAI", "Codex", "bin");
  const newest = (a: string, b: string) =>
    (statSync(join(root, b), { throwIfNoEntry: false })?.mtimeMs ?? 0) -
    (statSync(join(root, a), { throwIfNoEntry: false })?.mtimeMs ?? 0);
  return inBundles(root, "codex.exe", newest);
}

/** The absolute path of Codex's native executable, or null when none is found. */
export function locateCodex(env: Record<string, string>, host: Host = process): string | null {
  const found = onPath(env, host, codexIn);
  if (found) return found;
  if (host.platform !== "win32") {
    const known = [
      home(env) === "" ? "" : join(home(env), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
    return inFolders(known, env, host, codexIn);
  }
  const appData = variable(env, "APPDATA");
  const npm = inFolders(
    [appData === "" ? "" : join(appData, "npm"), variable(env, "NVM_SYMLINK")],
    env,
    host,
    codexIn,
  );
  if (npm) return npm;
  const localAppData = variable(env, "LOCALAPPDATA");
  return localAppData === "" ? null : codexDesktop(localAppData);
}
