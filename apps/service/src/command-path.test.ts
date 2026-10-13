// `lookover` on the PATH's real adapters (ADR 0058), which refuse to run under `bun test`: nothing here writes the
// user's `Path`, a launcher in their profile or a link in their home. Their own work is tested on what they are given
// instead: a `reg` that keeps the registry's values as `reg.exe` answers, a broadcast counted, and scratch folders for
// the launcher, the link and the folders on the PATH.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  isNpmShim,
  linkCommandPath,
  npmCommandPath,
  osCommandPath,
  type RegAnswer,
  type System,
  windowsCommandPath,
} from "./index.ts";

const USER = "HKCU\\Environment";
const MACHINE = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const FULL: Record<string, string> = {
  [USER]: "HKEY_CURRENT_USER\\Environment",
  [MACHINE]: "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
};

interface Value {
  type: string;
  data: string;
}

/**
 * A `reg` keeping the user's and the machine's environment values, as `reg.exe` answers: a value's name in any case,
 * printed as it is stored. Every call kept.
 */
function fakeReg(o: { user?: Record<string, Value>; machine?: Record<string, Value>; refuse?: string } = {}) {
  const user = new Map(Object.entries(o.user ?? {}));
  const keys: Record<string, Map<string, Value>> = {
    [USER]: user,
    [MACHINE]: new Map(Object.entries(o.machine ?? {})),
  };
  const calls: string[][] = [];
  const reg = async (args: string[]): Promise<RegAnswer> => {
    calls.push(args);
    const [verb, key = "", , name = ""] = args;
    const values = keys[key];
    if (values === undefined) throw new Error(`no such key in this test: ${key}`);
    if (o.refuse !== undefined && verb !== "query")
      return { code: 1, out: "", err: `ERROR: ${o.refuse}\r\n` };
    const shown = (rows: [string, Value][]) =>
      `\r\n${FULL[key]}\r\n${rows.map(([n, v]) => `    ${n}    ${v.type}    ${v.data}\r\n`).join("")}\r\n`;
    if (verb === "query" && args.length === 2) return { code: 0, out: shown([...values]), err: "" };
    const stored = [...values.keys()].find((n) => n.toLowerCase() === name.toLowerCase()) ?? name;
    if (verb === "add") {
      const at = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
      values.set(stored, { type: at("/t"), data: at("/d") });
      return { code: 0, out: "The operation completed successfully.\r\n", err: "" };
    }
    const value = values.get(stored);
    if (value === undefined)
      return {
        code: 1,
        out: "",
        err: "ERROR: The system was unable to find the specified registry key or value.\r\n",
      };
    if (verb === "delete") {
      values.delete(stored);
      return { code: 0, out: "", err: "" };
    }
    return { code: 0, out: shown([[stored, value]]), err: "" };
  };
  return { reg, user, calls };
}

const scratch = () => mkdtempSync(join(tmpdir(), "lookover-path-"));

/** A Windows-shaped machine in a scratch folder: the profile, Lookover's folder in it, and the executable. */
function windowsMachine(o: Parameters<typeof fakeReg>[0] = {}, user = "Dell XPS") {
  const root = scratch();
  const profile = join(root, user);
  const local = join(profile, "AppData", "Local");
  const folder = join(local, "Lookover", "bin");
  const downloads = join(profile, "Downloads");
  mkdirSync(downloads, { recursive: true });
  const executable = join(downloads, "lookover.exe");
  writeFileSync(executable, "");
  const fake = fakeReg(o);
  let broadcasts = 0;
  const path = windowsCommandPath({
    executable,
    folder,
    reg: fake.reg,
    env: { USERPROFILE: profile, LOCALAPPDATA: local, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    broadcast: () => {
      broadcasts += 1;
    },
  });
  return { root, profile, folder, executable, path, ...fake, broadcasts: () => broadcasts };
}

/** The writes `reg` was asked for. */
const adds = (calls: string[][]) => calls.filter(([verb]) => verb === "add");

const windows: System = { platform: "win32", homedir: "C:\\Users\\Your Name", env: {}, which: () => null };

test("the real adapters refuse to run under bun test, on every platform, the user's Path above all (ADR 0045)", () => {
  for (const platform of ["win32", "darwin", "linux"] as const)
    expect(() => osCommandPath("C:\\Tools\\lookover.exe", { ...windows, platform })).toThrow(/bun test/);
  const o = {
    executable: "C:\\Tools\\lookover.exe",
    folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin",
  };
  expect(() => windowsCommandPath(o)).toThrow(/bun test/);
  // Named, the Path value itself is never written by a test.
  expect(() => windowsCommandPath({ ...o, value: "Path" })).toThrow(/bun test/);
});

test("Windows: adding keeps the Path's type and every entry, %USERPROFILE% ones unexpanded, then broadcasts", async () => {
  const m = windowsMachine({
    user: { Path: { type: "REG_EXPAND_SZ", data: "%USERPROFILE%\\.bun\\bin;C:\\Tools" } },
  });
  await m.path.add();
  expect(adds(m.calls)).toEqual([
    [
      "add",
      USER,
      "/v",
      "Path",
      "/t",
      "REG_EXPAND_SZ",
      "/d",
      `%USERPROFILE%\\.bun\\bin;C:\\Tools;${m.folder}`,
      "/f",
    ],
  ]);
  // The launcher runs this executable with the arguments it gets.
  expect(readFileSync(join(m.folder, "lookover.cmd"), "utf8")).toBe(`@"${m.executable}" %*\r\n`);
  expect(m.broadcasts()).toBe(1);
});

test("Windows: a REG_SZ Path stays REG_SZ; one ending in ; gets no second one", async () => {
  const m = windowsMachine({ user: { Path: { type: "REG_SZ", data: "C:\\Tools;" } } });
  await m.path.add();
  expect(m.user.get("Path")).toEqual({ type: "REG_SZ", data: `C:\\Tools;${m.folder}` });
});

test("Windows: no Path value yet: it is made, REG_EXPAND_SZ, holding Lookover's folder alone", async () => {
  const m = windowsMachine();
  await m.path.add();
  expect(m.user.get("Path")).toEqual({ type: "REG_EXPAND_SZ", data: m.folder });
});

test("Windows: adding twice adds once, whatever the case or a trailing backslash says", async () => {
  const m = windowsMachine({ user: { Path: { type: "REG_EXPAND_SZ", data: "C:\\Tools" } } });
  await m.path.add();
  await m.path.add();
  expect(adds(m.calls)).toHaveLength(1);
  const upper = windowsMachine({ user: { Path: { type: "REG_EXPAND_SZ", data: "C:\\Tools" } } });
  upper.user.set("Path", { type: "REG_EXPAND_SZ", data: `C:\\Tools;${upper.folder.toUpperCase()}\\` });
  await upper.path.add();
  expect(adds(upper.calls)).toHaveLength(0);
  // Named through a variable, it is there too.
  const named = windowsMachine();
  named.user.set("Path", { type: "REG_EXPAND_SZ", data: "%LOCALAPPDATA%\\Lookover\\bin" });
  await named.path.add();
  expect(adds(named.calls)).toHaveLength(0);
  // The launcher is written all the same: the folder may have lost it.
  expect(existsSync(join(named.folder, "lookover.cmd"))).toBe(true);
});

test("Windows: removing takes only Lookover's entry, however spelt, keeps the type, the rest and their order", async () => {
  const m = windowsMachine({
    user: { Path: { type: "REG_EXPAND_SZ", data: "%USERPROFILE%\\bin;C:\\Tools" } },
  });
  await m.path.add();
  m.user.set("Path", {
    type: "REG_EXPAND_SZ",
    data: `%USERPROFILE%\\bin;${m.folder.toUpperCase()}\\;C:\\Tools;%LOCALAPPDATA%\\Lookover\\bin;C:\\Lookover\\bin`,
  });
  await m.path.remove();
  expect(m.user.get("Path")).toEqual({
    type: "REG_EXPAND_SZ",
    data: "%USERPROFILE%\\bin;C:\\Tools;C:\\Lookover\\bin",
  });
  expect(existsSync(join(m.folder, "lookover.cmd"))).toBe(false);
  expect(m.broadcasts()).toBe(2);
  // Removed again: nothing to write.
  const before = adds(m.calls).length;
  await m.path.remove();
  expect(adds(m.calls)).toHaveLength(before);
});

test("Windows: removing leaves a launcher that runs another Lookover", async () => {
  const m = windowsMachine();
  mkdirSync(m.folder, { recursive: true });
  writeFileSync(join(m.folder, "lookover.cmd"), '@"D:\\other\\lookover.exe" %*\r\n');
  await m.path.remove();
  expect(existsSync(join(m.folder, "lookover.cmd"))).toBe(true);
});

test("Windows: reachable reads the user's and the machine's Path as saved, Lookover's launcher or this executable first", async () => {
  const m = windowsMachine({ user: { Path: { type: "REG_EXPAND_SZ", data: "C:\\Tools" } } });
  expect(await m.path.reachable()).toEqual({ reach: "no", folder: m.folder });
  await m.path.add();
  expect(await m.path.reachable()).toEqual({ reach: "yes", folder: m.folder });
  // The executable's own folder on the PATH, through a variable: this one.
  const own = windowsMachine();
  own.user.set("Path", { type: "REG_EXPAND_SZ", data: "%USERPROFILE%\\Downloads\\" });
  expect(await own.path.reachable()).toEqual({ reach: "yes", folder: own.folder });
  await m.path.remove();
  expect(await m.path.reachable()).toEqual({ reach: "no", folder: m.folder });
});

test("Windows: a Path stored as PATH or path is read and written in place, whatever its case", async () => {
  const older = join(scratch(), "Older");
  mkdirSync(older, { recursive: true });
  writeFileSync(join(older, "lookover.exe"), "");
  const m = windowsMachine({
    user: { path: { type: "REG_EXPAND_SZ", data: "C:Tools" } },
    machine: { PATH: { type: "REG_EXPAND_SZ", data: `C:Windows;${older}` } },
  });
  expect(await m.path.reachable()).toEqual({
    reach: "other",
    folder: m.folder,
    other: join(older, "lookover.exe"),
  });
  await m.path.add();
  expect([...m.user]).toEqual([["path", { type: "REG_EXPAND_SZ", data: `C:Tools;${m.folder}` }]]);
  await m.path.remove();
  expect([...m.user]).toEqual([["path", { type: "REG_EXPAND_SZ", data: "C:Tools" }]]);
});

test("Windows: another lookover first on the PATH, the machine's first, is said with its path", async () => {
  const older = join(scratch(), "Program Files", "Lookover");
  mkdirSync(older, { recursive: true });
  writeFileSync(join(older, "lookover.exe"), "");
  // The machine's Path comes before the user's, where Lookover's folder is.
  const fake = windowsMachine({ machine: { Path: { type: "REG_EXPAND_SZ", data: `C:\\Windows;${older}` } } });
  await fake.path.add();
  expect(await fake.path.reachable()).toEqual({
    reach: "other",
    folder: fake.folder,
    other: join(older, "lookover.exe"),
  });
  // A `lookover.cmd` in Lookover's folder that isn't a launcher Lookover writes is another `lookover` too.
  const odd = windowsMachine();
  await odd.path.add();
  writeFileSync(join(odd.folder, "lookover.cmd"), "@echo hello\r\n");
  expect(await odd.path.reachable()).toEqual({
    reach: "other",
    folder: odd.folder,
    other: join(odd.folder, "lookover.cmd"),
  });
});

test("Windows: Lookover's own launcher running another copy is stale, with that copy; adding points it at this one", async () => {
  // The user ran a new download (`lookover (1).exe`): the launcher an earlier copy wrote still runs that one.
  const m = windowsMachine();
  await m.path.add();
  writeFileSync(join(m.folder, "lookover.cmd"), '@"D:\\old 100%%\\lookover.exe" %*\r\n');
  expect(await m.path.reachable()).toEqual({
    reach: "stale",
    folder: m.folder,
    other: "D:\\old 100%\\lookover.exe",
  });
  await m.path.add();
  expect(readFileSync(join(m.folder, "lookover.cmd"), "utf8")).toBe(`@"${m.executable}" %*\r\n`);
  expect(await m.path.reachable()).toEqual({ reach: "yes", folder: m.folder });
});

test("Windows: a path beyond ASCII runs whatever the console's code page, which the launcher gives back", async () => {
  const m = windowsMachine({}, "José");
  await m.path.add();
  const launcher = join(m.folder, "lookover.cmd");
  expect(readFileSync(launcher, "utf8")).toBe(
    [
      "@setlocal",
      `@for /f "tokens=2 delims=:." %%c in ('chcp') do @set "page=%%c"`,
      "@chcp 65001>nul",
      `@"${m.executable}" %*`,
      '@set "code=%errorlevel%"',
      "@chcp %page%>nul",
      "@exit /b %code%",
      "",
    ].join("\r\n"),
  );
  expect(await m.path.reachable()).toEqual({ reach: "yes", folder: m.folder });
  // Written by a copy elsewhere beyond ASCII: stale, with that copy.
  const other = windowsMachine({}, "Zoë");
  await other.path.add();
  writeFileSync(launcher, readFileSync(join(other.folder, "lookover.cmd")));
  expect(await m.path.reachable()).toEqual({ reach: "stale", folder: m.folder, other: other.executable });
  if (process.platform !== "win32") return;
  // On Windows, cmd.exe runs it on US English's code page: a copy of cmd.exe stands in for Lookover, its exit code
  // comes back and so does the code page.
  await m.path.add();
  const line = `copy /y "%ComSpec%" "${m.executable}">nul & chcp 437>nul & "${launcher}" /c exit 7 & echo !errorlevel! & chcp`;
  const ran = spawnSync("cmd.exe", ["/d", "/v:on", "/s", "/c", `"${line}"`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  });
  expect(ran.stdout).toMatch(/^7 \r?\n.*437/);
});

test("Windows: what reg.exe refuses is said with its reason; a Path it couldn't show is never written back", async () => {
  const refused = windowsMachine({ refuse: "Access is denied." });
  await expect(refused.path.add()).rejects.toThrow("reg.exe refused: Access is denied.");
  const garbled = windowsMachine({ user: { Path: { type: "REG_EXPAND_SZ", data: "C:\\Caf\uFFFD\\bin" } } });
  await expect(garbled.path.add()).rejects.toThrow(/couldn't read/);
  await expect(garbled.path.remove()).rejects.toThrow(/couldn't read/);
  expect(adds(garbled.calls)).toHaveLength(0);
  const denied = windowsCommandPath({
    executable: "C:\\Tools\\lookover.exe",
    folder: join(scratch(), "bin"),
    env: {},
    reg: async () => ({ code: 1, out: "", err: "ERROR: Access is denied.\r\n" }),
    broadcast: () => {},
  });
  await expect(denied.reachable()).rejects.toThrow("Access is denied.");
});

test("Windows: a Path reg.exe answered for but printed no row of is never taken as empty, nor written over", async () => {
  const writes: string[][] = [];
  const unparsed = windowsCommandPath({
    executable: "C:\\Tools\\lookover.exe",
    folder: join(scratch(), "bin"),
    env: {},
    reg: async (args) => {
      if (args[0] !== "query") writes.push(args);
      return { code: 0, out: "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ???\r\n\r\n", err: "" };
    },
    broadcast: () => {},
  });
  await expect(unparsed.add()).rejects.toThrow(/couldn't read/);
  await expect(unparsed.remove()).rejects.toThrow(/couldn't read/);
  expect(writes).toEqual([]);
});

/** A POSIX-shaped home in a scratch folder, the executable in it, and the PATH given. */
function posixMachine(path: (home: string) => string[]) {
  const home = scratch();
  const executable = join(home, "Downloads", "lookover");
  mkdirSync(join(home, "Downloads"));
  writeFileSync(executable, "");
  chmodSync(executable, 0o755);
  const folder = join(home, ".local", "bin");
  const port = linkCommandPath({ executable, home, env: { PATH: path(home).join(delimiter) } });
  return { home, executable, folder, link: join(folder, "lookover"), path: port };
}

test("macOS and Linux: a link in ~/.local/bin, said linked while that folder isn't on the PATH", async () => {
  const off = posixMachine(() => []);
  expect(off.path.folder).toBe(off.folder);
  expect(await off.path.reachable()).toEqual({ reach: "no", folder: off.folder });
  await off.path.add();
  expect(lstatSync(off.link).isSymbolicLink()).toBe(true);
  expect(await off.path.reachable()).toEqual({ reach: "linked", folder: off.folder });
  // Added twice: the same link.
  await off.path.add();
  const on = posixMachine((home) => [join(home, ".local", "bin")]);
  await on.path.add();
  expect(await on.path.reachable()).toEqual({ reach: "yes", folder: on.folder });
  await on.path.remove();
  expect(existsSync(on.link)).toBe(false);
  expect(await on.path.reachable()).toEqual({ reach: "no", folder: on.folder });
  await on.path.remove();
});

test("macOS and Linux: never over a file that isn't Lookover's link, and removing leaves it", async () => {
  const m = posixMachine(() => []);
  mkdirSync(m.folder, { recursive: true });
  writeFileSync(m.link, "#!/bin/sh\n");
  await expect(m.path.add()).rejects.toThrow(/isn't Lookover's/);
  await m.path.remove();
  expect(readFileSync(m.link, "utf8")).toBe("#!/bin/sh\n");
});

test("macOS and Linux: another lookover first on the PATH is said with its path", async () => {
  const m = posixMachine((home) => [join(home, "older"), join(home, ".local", "bin")]);
  mkdirSync(join(m.home, "older"));
  writeFileSync(join(m.home, "older", "lookover"), "");
  chmodSync(join(m.home, "older", "lookover"), 0o755);
  await m.path.add();
  expect(await m.path.reachable()).toEqual({
    reach: "other",
    folder: m.folder,
    other: join(m.home, "older", "lookover"),
  });
});

// An npm install (ADR 0061): npm put `lookover` on the PATH, so the port only reads whether a terminal's `lookover`
// is npm's shim of this install's launcher.

/** npm's `cmd-shim` for a package's `bin`, as npm 10 and 11 write it beside `node_modules` (Windows). */
const cmdShim = (bin: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${bin}" %*\r\n`;

/** A Windows npm prefix in a scratch folder (`%APPDATA%\npm`): the launcher, and npm's shim of it when `shim`. */
function npmPrefix(shim = true) {
  const prefix = join(scratch(), "Roaming", "npm");
  const launcher = join(prefix, "node_modules", "lookover", "bin", "lookover.js");
  mkdirSync(join(prefix, "node_modules", "lookover", "bin"), { recursive: true });
  writeFileSync(launcher, "#!/usr/bin/env node\n");
  if (shim) writeFileSync(join(prefix, "lookover.cmd"), cmdShim("lookover\\bin\\lookover.js"));
  return { prefix, launcher };
}

/** The npm install's port on a Windows-shaped machine whose saved Path is `machine`. */
function npmOnWindows(launcher: string, machine: string[]) {
  const fake = fakeReg({ machine: { Path: { type: "REG_EXPAND_SZ", data: machine.join(";") } } });
  return npmCommandPath({
    launcher,
    platform: "win32",
    env: { PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    reg: fake.reg,
  });
}

test("npm, Windows: npm's shim of this launcher first on the PATH as saved is this Lookover; the folder is npm's", async () => {
  const { prefix, launcher } = npmPrefix();
  const port = npmOnWindows(launcher, ["C:\\Windows", prefix]);
  expect(port.folder).toBe(prefix);
  expect(await port.reachable()).toEqual({ reach: "yes", folder: prefix });
  expect(isNpmShim(join(prefix, "lookover.cmd"), launcher, "win32")).toBe(true);
  // PowerShell's shim and the POSIX one npm writes beside it name the launcher the same way.
  writeFileSync(
    join(prefix, "lookover.ps1"),
    '& "node$exe"  "$basedir/node_modules/lookover/bin/lookover.js" $args\n',
  );
  expect(isNpmShim(join(prefix, "lookover.ps1"), launcher, "win32")).toBe(true);
  writeFileSync(
    join(prefix, "lookover"),
    'exec node  "$basedir/node_modules/lookover/bin/lookover.js" "$@"\n',
  );
  expect(isNpmShim(join(prefix, "lookover"), launcher, "win32")).toBe(true);
  // npm's folder not on the PATH: no `lookover` there, nothing offered.
  expect(await npmOnWindows(launcher, ["C:\\Windows"]).reachable()).toEqual({ reach: "no", folder: prefix });
  await expect(port.add()).rejects.toThrow(/npm/);
  await expect(port.remove()).rejects.toThrow(/npm/);
});

test("npm, Windows: under nvm-windows, the PATH names npm's folder through a junction; its shim is still this Lookover", async () => {
  const { prefix, launcher } = npmPrefix();
  // nvm-windows puts `C:\nvm4w\nodejs`, a junction to the Node in use, on the PATH; the launcher has its real path.
  const nvm = join(scratch(), "nvm4w");
  mkdirSync(nvm);
  const linked = join(nvm, "nodejs");
  symlinkSync(prefix, linked, "junction");
  expect(isNpmShim(join(linked, "lookover.cmd"), launcher, "win32")).toBe(true);
  expect(await npmOnWindows(launcher, ["C:\\Windows", linked]).reachable()).toEqual({
    reach: "yes",
    folder: prefix,
  });
  // And the other way round: the launcher through the junction, the shim by its real path.
  expect(
    isNpmShim(
      join(prefix, "lookover.cmd"),
      join(linked, "node_modules", "lookover", "bin", "lookover.js"),
      "win32",
    ),
  ).toBe(true);
});

test("npm, Windows: anything else first on the PATH is another lookover, said with its path", async () => {
  const { prefix, launcher } = npmPrefix();
  // An older download ahead of npm's folder.
  const older = join(scratch(), "Tools");
  mkdirSync(older);
  writeFileSync(join(older, "lookover.exe"), "");
  expect(await npmOnWindows(launcher, [older, prefix]).reachable()).toEqual({
    reach: "other",
    folder: prefix,
    other: join(older, "lookover.exe"),
  });
  // Another npm install of Lookover (another Node's prefix): its shim names its own launcher, not this one.
  const another = npmPrefix();
  expect(await npmOnWindows(launcher, [another.prefix, prefix]).reachable()).toEqual({
    reach: "other",
    folder: prefix,
    other: join(another.prefix, "lookover.cmd"),
  });
  // A `lookover.cmd` in npm's folder that isn't npm's shim of the launcher: another package's, Lookover's own launcher.
  const odd = npmPrefix(false);
  writeFileSync(join(odd.prefix, "lookover.cmd"), cmdShim("not-lookover\\cli.js"));
  expect(isNpmShim(join(odd.prefix, "lookover.cmd"), odd.launcher, "win32")).toBe(false);
  writeFileSync(join(odd.prefix, "lookover.cmd"), '@"C:\\Tools\\lookover.exe" %*\r\n');
  expect(await npmOnWindows(odd.launcher, [odd.prefix]).reachable()).toMatchObject({ reach: "other" });
  // A file that isn't there is no shim.
  expect(isNpmShim(join(scratch(), "lookover.cmd"), launcher, "win32")).toBe(false);
});

test("npm, macOS and Linux: npm's link to this launcher first on the PATH is this Lookover; anything else is other", async () => {
  const prefix = scratch();
  const launcher = join(prefix, "lib", "node_modules", "lookover", "bin", "lookover.js");
  mkdirSync(join(prefix, "lib", "node_modules", "lookover", "bin"), { recursive: true });
  writeFileSync(launcher, "#!/usr/bin/env node\n");
  chmodSync(launcher, 0o755);
  const bin = join(prefix, "bin");
  mkdirSync(bin);
  symlinkSync(join("..", "lib", "node_modules", "lookover", "bin", "lookover.js"), join(bin, "lookover"));
  const on = (path: string[]) =>
    npmCommandPath({ launcher, platform: "linux", env: { PATH: path.join(delimiter) } });
  expect(on([bin]).folder).toBe(bin);
  expect(await on([bin]).reachable()).toEqual({ reach: "yes", folder: bin });
  expect(isNpmShim(join(bin, "lookover"), launcher, "linux")).toBe(true);
  expect(await on([]).reachable()).toEqual({ reach: "no", folder: bin });
  const older = join(prefix, "older");
  mkdirSync(older);
  writeFileSync(join(older, "lookover"), "");
  chmodSync(join(older, "lookover"), 0o755);
  expect(await on([older, bin]).reachable()).toEqual({
    reach: "other",
    folder: bin,
    other: join(older, "lookover"),
  });
  expect(isNpmShim(join(older, "lookover"), launcher, "linux")).toBe(false);
});

test("npm: the real adapter, reading the saved Path through reg.exe, refuses to run under bun test", () => {
  const launcher = "C:\\npm\\node_modules\\lookover\\bin\\lookover.js";
  expect(() => npmCommandPath({ launcher, platform: "win32", env: {} })).toThrow(/bun test/);
  expect(() => osCommandPath("C:\\Tools\\lookover.exe", windows, launcher)).toThrow(/bun test/);
});
