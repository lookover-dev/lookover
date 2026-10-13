// How the engines' programs are found (ADR 0012, ADR 0044), through the entry: `locateClaude` and `locateCodex`
// on install layouts built in a temporary folder. The machine is given (`{ platform, arch }`), so the Windows
// rules are proven on any machine; the PATH separator is this machine's, as the environment is.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { locateClaude, locateCodex } from "@lookover/engines";

const WINDOWS = { platform: "win32", arch: "x64" } as const satisfies {
  platform: NodeJS.Platform;
  arch: string;
};
const LINUX = { platform: "linux", arch: "x64" } as const satisfies {
  platform: NodeJS.Platform;
  arch: string;
};

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-locate-")));
  made.push(dir);
  return dir;
}

/** Writes `path` (its folders made), empty unless given. */
function file(path: string, content = ""): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// What `npm i -g @openai/codex` leaves in its prefix on Windows (codex-cli 0.154.0, nvm-windows): three launchers
// for the package's Node script, and Node itself beside them.
const NPM_CMD = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  "",
].join("\r\n");

/** An npm prefix on Windows: `codex.cmd`, `codex.ps1`, the extensionless sh launcher, `node.exe`, the package. */
function npmPrefix(prefix: string): string {
  file(join(prefix, "codex.cmd"), NPM_CMD);
  file(
    join(prefix, "codex.ps1"),
    '& "$basedir/node$exe" "$basedir/node_modules/@openai/codex/bin/codex.js" $args',
  );
  file(
    join(prefix, "codex"),
    '#!/bin/sh\nexec node "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\n',
  );
  file(join(prefix, "node.exe"));
  const pkg = join(prefix, "node_modules", "@openai", "codex");
  file(join(pkg, "bin", "codex.js"));
  return pkg;
}

const TRIPLE = join("vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");

describe("codex on Windows", () => {
  test("an npm shim leads to the native executable of its package's platform package, nested in it", () => {
    const prefix = folder();
    const pkg = npmPrefix(prefix);
    const native = file(join(pkg, "node_modules", "@openai", "codex-win32-x64", TRIPLE));
    expect(locateCodex({ PATH: prefix }, WINDOWS)).toBe(native);
  });

  test("the platform package hoisted beside the package", () => {
    const prefix = folder();
    npmPrefix(prefix);
    const native = file(join(prefix, "node_modules", "@openai", "codex-win32-x64", TRIPLE));
    expect(locateCodex({ PATH: prefix }, WINDOWS)).toBe(native);
  });

  test("the package's own vendor folder", () => {
    const prefix = folder();
    const pkg = npmPrefix(prefix);
    const native = file(join(pkg, TRIPLE));
    expect(locateCodex({ PATH: prefix }, WINDOWS)).toBe(native);
  });

  test("a shim whose package has no native executable, and a launcher with no extension, are never run", () => {
    const prefix = folder();
    npmPrefix(prefix);
    expect(locateCodex({ PATH: prefix }, WINDOWS)).toBeNull();
  });

  test("a codex.exe on PATH is run as it is; PATH is searched in order", () => {
    const dir = folder();
    const first = file(join(dir, "first", "codex.exe"));
    file(join(dir, "second", "codex.exe"));
    const path = [join(dir, "empty"), join(dir, "first"), join(dir, "second")].join(delimiter);
    expect(locateCodex({ Path: path }, WINDOWS)).toBe(first);
  });

  test("nothing on PATH: the npm prefix, then the desktop app's newest bundle", () => {
    const appData = folder();
    const pkg = npmPrefix(join(appData, "npm"));
    const native = file(join(pkg, "node_modules", "@openai", "codex-win32-x64", TRIPLE));
    expect(locateCodex({ APPDATA: appData }, WINDOWS)).toBe(native);

    const localAppData = folder();
    const bundle = file(join(localAppData, "OpenAI", "Codex", "bin", "9691020b546a15b2", "codex.exe"));
    file(join(localAppData, "OpenAI", "Codex", "bin", "1a2b3c4d5e6f7a8b", "node.exe"));
    expect(locateCodex({ LOCALAPPDATA: localAppData }, WINDOWS)).toBe(bundle);
  });

  test("a pnpm shim: the package is a junction into pnpm's store, its platform package beside it there", () => {
    const pnpm = folder();
    // pnpm's global store: the package and its platform package side by side, under the versioned folder.
    const store = join(pnpm, "global", "5", "node_modules", ".pnpm", "@openai+codex@0.154.0", "node_modules");
    file(join(store, "@openai", "codex", "bin", "codex.js"));
    const native = file(join(store, "@openai", "codex-win32-x64", TRIPLE));
    // What the global folder holds is a junction to the package in the store.
    const linked = join(pnpm, "global", "5", "node_modules", "@openai", "codex");
    mkdirSync(dirname(linked), { recursive: true });
    symlinkSync(join(store, "@openai", "codex"), linked, "junction");
    file(
      join(pnpm, "codex.cmd"),
      '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
    expect(locateCodex({ PATH: pnpm }, WINDOWS)).toBe(native);
  });

  test("not installed anywhere it is looked for", () => {
    expect(locateCodex({ PATH: folder() }, WINDOWS)).toBeNull();
    expect(locateCodex({}, WINDOWS)).toBeNull();
  });
});

describe("codex elsewhere", () => {
  test("a codex on PATH is run as it is", () => {
    const dir = folder();
    const native = file(join(dir, "codex"));
    expect(locateCodex({ PATH: dir }, LINUX)).toBe(native);
  });

  test("a script launcher is never run: it leads to its package's native executable for this machine, or to none", () => {
    const prefix = folder();
    const pkg = npmPrefix(prefix);
    // Only the Windows build is in the package: nothing a Linux machine can run.
    file(join(pkg, "node_modules", "@openai", "codex-win32-x64", TRIPLE));
    expect(locateCodex({ PATH: prefix }, LINUX)).toBeNull();
    const native = file(
      join(
        pkg,
        "node_modules",
        "@openai",
        "codex-linux-x64",
        "vendor",
        "x86_64-unknown-linux-musl",
        "bin",
        "codex",
      ),
    );
    expect(locateCodex({ PATH: prefix }, LINUX)).toBe(native);
  });

  // npm's global link on POSIX: `<prefix>/bin/codex` → `../lib/node_modules/@openai/codex/bin/codex.js`. A file
  // symlink needs an administrator on Windows, so this layout is proven where it exists.
  test.skipIf(process.platform === "win32")(
    "npm's symlink to the package's script leads to the native executable",
    () => {
      const prefix = folder();
      const pkg = join(prefix, "lib", "node_modules", "@openai", "codex");
      file(join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\n");
      const native = file(
        join(
          pkg,
          "node_modules",
          "@openai",
          "codex-linux-x64",
          "vendor",
          "x86_64-unknown-linux-musl",
          "bin",
          "codex",
        ),
      );
      mkdirSync(join(prefix, "bin"));
      symlinkSync(join(pkg, "bin", "codex.js"), join(prefix, "bin", "codex"));
      expect(locateCodex({ PATH: join(prefix, "bin") }, LINUX)).toBe(native);
    },
  );
});

describe("claude on Windows", () => {
  test("an npm prefix's launchers lead to Node, never to claude: an extensionless name or node.exe is never run", () => {
    const prefix = folder();
    file(
      join(prefix, "claude"),
      '#!/bin/sh\nexec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js"\n',
    );
    file(
      join(prefix, "claude.cmd"),
      NPM_CMD.replace("@openai\\codex\\bin\\codex.js", "@anthropic-ai\\claude-code\\cli.js"),
    );
    file(join(prefix, "node.exe"));
    expect(locateClaude({ PATH: prefix }, WINDOWS)).toBeNull();
  });

  test("claude.exe on PATH, ahead of a later folder's", () => {
    const dir = folder();
    const first = file(join(dir, "a", "claude.exe"));
    file(join(dir, "b", "claude.exe"));
    expect(locateClaude({ PATH: [join(dir, "a"), join(dir, "b")].join(delimiter) }, WINDOWS)).toBe(first);
  });
});
