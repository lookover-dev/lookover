// What `lookover` runs as (ADR 0054): Bun on a clone's `main.ts`, or the compiled binary that carries its web app.
// `start` runs the same `serve` in the background either way, and refuses a clone with no program build only.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  carriedWebFiles,
  loginCommand,
  lookoverCommand,
  programSelf,
  type Self,
  type System,
  selfCommand,
  serveCommand,
  webBuildOf,
} from "./index.ts";

const clone: Self = { kind: "clone", bun: "/usr/bin/bun", main: "/src/lookover/apps/service/src/main.ts" };
const binary: Self = {
  kind: "binary",
  path: "C:\\Tools\\lookover.exe",
  webFiles: carriedWebFiles(new Map()),
};

test("from a clone, serve is Bun running the clone's main.ts", () => {
  expect(serveCommand(clone, ["--home=/h", "--background"])).toEqual({
    executable: "/usr/bin/bun",
    args: ["/src/lookover/apps/service/src/main.ts", "serve", "--home=/h", "--background"],
  });
});

test("the compiled binary runs its own serve: no Bun, no source file, which are inside it", () => {
  expect(serveCommand(binary, ["--background"])).toEqual({
    executable: "C:\\Tools\\lookover.exe",
    args: ["serve", "--background"],
  });
});

test("the clone's web build is what its dist holds; the binary always has the program's, which it carries", () => {
  expect(webBuildOf(clone, () => "missing")).toBe("missing");
  expect(webBuildOf(clone, () => "program")).toBe("program");
  expect(
    webBuildOf(binary, () => {
      throw new Error("the binary read a clone's dist");
    }),
  ).toBe("program");
});

const windows: System = {
  platform: "win32",
  homedir: "C:\\Users\\Your Name",
  env: { LOCALAPPDATA: "C:\\Users\\Your Name\\AppData\\Local" },
  which: () => null,
};

test("lookover is Bun and the clone's main.ts from a clone, the binary alone once compiled", () => {
  expect(selfCommand(clone)).toEqual(["/usr/bin/bun", "/src/lookover/apps/service/src/main.ts"]);
  expect(selfCommand(binary)).toEqual(["C:\\Tools\\lookover.exe"]);
});

test("start at login runs the binary itself once compiled: no Bun, no main.ts, which are inside it", () => {
  expect(
    loginCommand("C:\\Users\\Your Name\\AppData\\Local\\Lookover", windows, selfCommand(binary)),
  ).toEqual(["C:\\Tools\\lookover.exe", "start", "--no-open"]);
  expect(loginCommand("D:\\data", windows, selfCommand(clone))).toEqual([
    "/usr/bin/bun",
    "/src/lookover/apps/service/src/main.ts",
    "start",
    "--no-open",
    "--home=D:\\data",
  ]);
});

// Lookover's command (ADR 0058): the one that reaches this Lookover from a terminal.
const PROFILE = "C:\\Users\\Your Name\\AppData\\Local\\Lookover";
const spaced: Self = { ...binary, path: "C:\\Users\\Your Name\\Downloads\\lookover.exe" };
const linux: System = { platform: "linux", homedir: "/home/ada", env: {}, which: () => null };

test("lookover's command is lookover when the PATH finds this executable", () => {
  expect(lookoverCommand(binary, PROFILE, windows, true)).toBe("lookover");
  expect(lookoverCommand(binary, "D:\\data", windows, true)).toBe("lookover --home=D:\\data");
});

test("else the binary's absolute path, run by PowerShell's call operator when it must be quoted", () => {
  expect(lookoverCommand(binary, PROFILE, windows, false)).toBe("C:\\Tools\\lookover.exe");
  expect(lookoverCommand(spaced, PROFILE, windows, false)).toBe(
    "& 'C:\\Users\\Your Name\\Downloads\\lookover.exe'",
  );
  // PowerShell's single quotes keep `$` and backticks as they are; a `'` inside is doubled.
  const odd: Self = { ...binary, path: "C:\\Users\\$ada`s O'Brien\\lookover.exe" };
  expect(lookoverCommand(odd, PROFILE, windows, false)).toBe("& 'C:\\Users\\$ada`s O''Brien\\lookover.exe'");
  const posix: Self = { ...binary, path: "/home/ada/my tools/lookover" };
  expect(lookoverCommand(posix, "/home/ada/.local/share/lookover", linux, false)).toBe(
    "'/home/ada/my tools/lookover'",
  );
});

test("else, from a clone, bun run lookover, whatever the PATH says", () => {
  expect(lookoverCommand(clone, PROFILE, windows, false)).toBe("bun run lookover");
  expect(lookoverCommand(clone, PROFILE, windows, true)).toBe("bun run lookover");
});

test("a data folder that isn't the profile's is named, quoted when it holds a space", () => {
  // Windows' paths ignore case.
  expect(lookoverCommand(clone, "c:\\users\\your name\\appdata\\local\\lookover", windows, false)).toBe(
    "bun run lookover",
  );
  expect(lookoverCommand(spaced, "C:\\Users\\Your Name\\lookover data", windows, false)).toBe(
    "& 'C:\\Users\\Your Name\\Downloads\\lookover.exe' '--home=C:\\Users\\Your Name\\lookover data'",
  );
  expect(lookoverCommand(clone, "/home/ada/it's here", linux, false)).toBe(
    "bun run lookover '--home=/home/ada/it'\\''s here'",
  );
});

test("a comma is quoted everywhere: PowerShell reads a bare one as an array", () => {
  const comma: Self = { ...binary, path: "C:\\a,b\\lookover.exe" };
  expect(lookoverCommand(comma, PROFILE, windows, false)).toBe("& 'C:\\a,b\\lookover.exe'");
  const posix: Self = { ...binary, path: "/opt/a,b/lookover" };
  expect(lookoverCommand(posix, "/home/ada/.local/share/lookover", linux, false)).toBe("'/opt/a,b/lookover'");
});

test("a backslash is quoted on POSIX, where the shell reads it as an escape", () => {
  expect(lookoverCommand(clone, "/home/ada/a\\b", linux, false)).toBe(
    "bun run lookover '--home=/home/ada/a\\b'",
  );
  // On Windows it is the path separator: plain.
  expect(lookoverCommand(clone, "D:\\data", windows, false)).toBe("bun run lookover --home=D:\\data");
});

// An npm install (ADR 0061): the launcher `npm install -g lookover` puts on the PATH runs the platform package's
// executable with `LOOKOVER_LAUNCHER` set to its own absolute path.
const LAUNCHER = String.raw`C:\Users\Your Name\AppData\Roaming\npm\node_modules\lookover\bin\lookover.js`;
const EXECUTABLE = String.raw`C:\Users\Your Name\AppData\Roaming\npm\node_modules\lookover\node_modules\@lookover\win32-x64\lookover.exe`;
const TOOLS = String.raw`C:\Tools\lookover.exe`;
const webFiles = carriedWebFiles(new Map());
const npm: Self = { kind: "npm", path: EXECUTABLE, launcher: LAUNCHER, webFiles };

test("the executable started by npm's launcher knows it is an npm install; without it, the binary as before", () => {
  const launcher = join(mkdtempSync(join(tmpdir(), "lookover-npm-")), "lookover.js");
  writeFileSync(launcher, "");
  expect(programSelf(TOOLS, { LOOKOVER_LAUNCHER: launcher }, webFiles)).toEqual({
    kind: "npm",
    path: TOOLS,
    launcher,
    webFiles,
  });
  expect(programSelf(TOOLS, {}, webFiles)).toEqual({ kind: "binary", path: TOOLS, webFiles });
  expect(programSelf(TOOLS, { LOOKOVER_LAUNCHER: "" }, webFiles).kind).toBe("binary");
});

test("LOOKOVER_LAUNCHER is trusted only when it names a launcher that exists, by its absolute path", () => {
  expect(programSelf(TOOLS, { LOOKOVER_LAUNCHER: "lookover.js" }, webFiles).kind).toBe("binary");
  const missing = join(mkdtempSync(join(tmpdir(), "lookover-npm-")), "lookover.js");
  expect(programSelf(TOOLS, { LOOKOVER_LAUNCHER: missing }, webFiles).kind).toBe("binary");
  // A wrong one falls back on the launcher beside the executable, as start at login finds it.
  const prefix = mkdtempSync(join(tmpdir(), "lookover-npm-"));
  const beside = join(prefix, "node_modules", "lookover", "bin", "lookover.js");
  mkdirSync(dirname(beside), { recursive: true });
  writeFileSync(beside, "");
  const executable = join(
    prefix,
    "node_modules",
    "lookover",
    "node_modules",
    "@lookover",
    "win32-x64",
    "lookover.exe",
  );
  expect(programSelf(executable, { LOOKOVER_LAUNCHER: missing }, webFiles)).toEqual({
    kind: "npm",
    path: executable,
    launcher: beside,
    webFiles,
  });
});

test("started at login, which runs the executable without Node, an npm install still knows it is one by its place", () => {
  const prefix = mkdtempSync(join(tmpdir(), "lookover-npm-"));
  const place = (...parts: string[]) => {
    mkdirSync(join(prefix, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(prefix, ...parts), "");
    return join(prefix, ...parts);
  };
  // `npm install -g`: the platform package inside the launcher's package.
  const launcher = place("node_modules", "lookover", "bin", "lookover.js");
  const nested = place("node_modules", "lookover", "node_modules", "@lookover", "win32-x64", "lookover.exe");
  expect(programSelf(nested, {}, webFiles)).toEqual({ kind: "npm", path: nested, launcher, webFiles });
  // Beside it, as npm may hoist it.
  const hoisted = place("node_modules", "@lookover", "linux-x64", "bin", "lookover");
  expect(programSelf(hoisted, {}, webFiles)).toEqual({ kind: "npm", path: hoisted, launcher, webFiles });
  // A platform package with no launcher beside it, copied out by hand: the binary.
  const alone = mkdtempSync(join(tmpdir(), "lookover-npm-"));
  const copied = join(alone, "node_modules", "@lookover", "win32-x64", "lookover.exe");
  mkdirSync(dirname(copied), { recursive: true });
  writeFileSync(copied, "");
  expect(programSelf(copied, {}, webFiles).kind).toBe("binary");
});

test("an npm install runs its own executable, by its absolute path: serve, the skill and start at login skip Node", () => {
  expect(serveCommand(npm, ["--background"])).toEqual({
    executable: EXECUTABLE,
    args: ["serve", "--background"],
  });
  expect(selfCommand(npm)).toEqual([EXECUTABLE]);
  expect(loginCommand(PROFILE, windows, selfCommand(npm))).toEqual([EXECUTABLE, "start", "--no-open"]);
  expect(webBuildOf(npm, () => "missing")).toBe("program");
});

test("an npm install's command is lookover, which npm put on the PATH, whatever the PATH as saved says", () => {
  expect(lookoverCommand(npm, PROFILE, windows, false)).toBe("lookover");
  expect(lookoverCommand(npm, PROFILE, windows, true)).toBe("lookover");
  expect(lookoverCommand(npm, "D:\\lookover data", windows, false)).toBe(
    "lookover '--home=D:\\lookover data'",
  );
});
