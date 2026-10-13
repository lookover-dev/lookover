// `lookover` on the PATH (ADR 0058): a port, `CommandPath`, that says whether a terminal's `lookover` reaches this
// Lookover, and puts it there or takes it off through a folder of Lookover's own that holds only its launcher (Windows)
// or its link (macOS, Linux), never the executable's own folder. The fake keeps it in memory, for demo mode, live mode,
// a guarded program, a clone and the tests. The real ones, for the unguarded program's binary (`osCommandPath`):
// Windows' launcher `%LOCALAPPDATA%\Lookover\bin\lookover.cmd` and that folder in the user's `Path` value, through
// `reg.exe` called directly, its type kept, only Lookover's entry ever removed, then the settings-change broadcast,
// best effort; macOS and Linux's link `~/.local/bin/lookover`, never over a file that isn't Lookover's link, those two
// unproven like start at login's. Whether a terminal reaches this Lookover is read from the PATH as saved (Windows: the
// machine's `Path`, then the user's, expanded), never this process's, which a start at login keeps old. The real ones
// refuse to be built under `bun test`, but for `bun run live`'s check of the Windows one on a `lookover-dev-` value
// beside `Path`; the link one writes in the home it is given, a test's scratch folder or, through `osCommandPath`,
// the user's. An npm install's (`npmCommandPath`, ADR 0061) only reads: npm put `lookover` on the PATH, and the first
// one there is this Lookover when it is npm's shim of the install's launcher (`isNpmShim`).
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readlink, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, sep } from "node:path";
import type { CommandPathState, PathReach } from "@lookover/contracts";
import { launcherFolder, type System, underTest } from "./config.ts";
import { DEV_VALUE_PREFIX } from "./login-item.ts";
import { type Reg, realReg, regError, regValue } from "./reg.ts";
import { settingsChanged } from "./settings-changed.ts";

/** Lookover reachable from a terminal as `lookover`, for the user who runs it. */
export interface CommandPath {
  /** The folder of Lookover's own that holds its launcher or link: known without reading the machine. */
  readonly folder: string;
  /**
   * Whether the PATH as saved (the user's and the machine's, not this process's) finds this Lookover, and the folder
   * Lookover's launcher or link is in. Rejects when the machine can't say.
   */
  reachable(): Promise<CommandPathState>;
  /** Puts Lookover's folder, with its launcher or link, on the PATH; nothing when it is. Rejects with why the machine refused. */
  add(): Promise<void>;
  /** Takes Lookover's folder off the PATH, and only it; nothing when it isn't there. Rejects with why the machine refused. */
  remove(): Promise<void>;
}

/**
 * The fake: the PATH in memory. `refuse(reason)` makes `add` and `remove` reject, until `null`; `unreadable(reason)`
 * makes `reachable` reject, until `null`; `linkedOffPath()` is a link left in a folder the PATH doesn't name (macOS and
 * Linux's `~/.local/bin`), until the next `add` or `remove`; `staleLauncher(runs)` is Lookover's own launcher on the
 * PATH running another copy, `runs`, until the next `add` (which points it here) or `remove`; `otherFirst(path)` is a
 * `lookover` that isn't this one ahead of Lookover's folder on the PATH, whatever `add` and `remove` do, until `null`.
 */
export interface MemoryCommandPath extends CommandPath {
  refuse(reason: string | null): void;
  unreadable(reason: string | null): void;
  linkedOffPath(): void;
  staleLauncher(runs: string): void;
  otherFirst(path: string | null): void;
}

/** What the fake keeps of the PATH itself: no other `lookover` in it. */
type Kept = Exclude<PathReach, "other" | "stale">;

export function memoryCommandPath(o: { folder: string; reach?: Kept }): MemoryCommandPath {
  let reach: Kept = o.reach ?? "no";
  let stale: string | null = null;
  let other: string | null = null;
  let refused: string | null = null;
  let unread: string | null = null;
  const change = (to: Kept) => {
    if (refused !== null) return Promise.reject(new Error(refused));
    reach = to;
    stale = null;
    return Promise.resolve();
  };
  return {
    folder: o.folder,
    reachable: () => {
      if (unread !== null) return Promise.reject(new Error(unread));
      const { folder } = o;
      const state: CommandPathState =
        other !== null
          ? { reach: "other", folder, other }
          : stale !== null
            ? { reach: "stale", folder, other: stale }
            : { reach, folder };
      return Promise.resolve(state);
    },
    add: () => change("yes"),
    remove: () => change("no"),
    refuse: (reason) => {
      refused = reason;
    },
    unreadable: (reason) => {
      unread = reason;
    },
    linkedOffPath: () => {
      reach = "linked";
    },
    staleLauncher: (runs) => {
      stale = runs;
    },
    otherFirst: (path) => {
      other = path;
    },
  };
}

/** Thrown by a real adapter built under `bun test`. */
const UNDER_TEST =
  "The real PATH adapter never runs under bun test: a test writes nothing to the user's PATH (ADR 0045). Use memoryCommandPath.";

/** Refuses to go on under `bun test`, unless `allowed` (`bun run live`'s own `lookover-dev-` value). */
function notUnderTest(allowed = false): void {
  if (underTest() && !allowed) throw new Error(UNDER_TEST);
}

/**
 * The machine's own `lookover` on the PATH for the binary at `executable`: its platform's adapter, or, for an npm
 * install, npm's (`launcher`, the npm launcher's absolute path). Throws under `bun test`.
 */
export function osCommandPath(
  executable: string,
  system: System,
  launcher: string | null = null,
): CommandPath {
  notUnderTest();
  if (launcher !== null) return npmCommandPath({ launcher, platform: system.platform, env: system.env });
  if (system.platform === "win32")
    return windowsCommandPath({ executable, folder: launcherFolder(system), env: system.env });
  return linkCommandPath({ executable, home: system.homedir, env: system.env });
}

/** The current user's environment, which a new terminal and Explorer start from. */
const USER_KEY = "HKCU\\Environment";
/** The machine's environment, whose `Path` comes first in every terminal's. */
const MACHINE_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
/** The type a `Path` value is made with when there is none: its entries may name variables. */
const NEW_TYPE = "REG_EXPAND_SZ";

/** The environment's variable `name`, its case ignored as Windows ignores it; undefined when it sets none. */
export function caseBlind(env: Record<string, string | undefined>, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

/** `text` with each `%NAME%` the environment sets replaced by its value, ignoring the name's case; others kept. */
function expanded(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/%([^%;]+)%/g, (whole, name: string) => caseBlind(env, name) ?? whole);
}

/**
 * The PATH a new terminal starts with on Windows, as saved, not this process's (which a start at login keeps old or
 * thin): the machine's `Path`, then the user's `value`, each entry's `%NAME%` expanded from `env`, in this system's
 * separator (Windows reads both, a test on another system only its own). Rejects when `reg` can't read them.
 */
export async function savedPath(
  reg: Reg,
  env: Record<string, string | undefined>,
  value = "Path",
): Promise<string[]> {
  const machine = (await regValue(reg, MACHINE_KEY, "Path"))?.data ?? "";
  const own = (await regValue(reg, USER_KEY, value))?.data ?? "";
  return `${machine};${own}`.split(";").map((entry) => expanded(entry, env).replace(/[\\/]/g, sep));
}

/** A folder as Windows compares it: `/` and `\` alike, case and trailing separators ignored. */
const folderKey = (folder: string): string =>
  folder
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();

/** Two folders as Windows compares them. */
const sameFolder = (a: string, b: string): boolean => folderKey(a) === folderKey(b);

/** What `reg.exe` showed, written back only when it showed every character: one it couldn't is never guessed. */
function readable(data: string): string {
  if (data.includes("�"))
    throw new Error(
      "reg.exe showed your Path with characters Lookover couldn't read: it leaves your Path as it is.",
    );
  return data;
}

/** Whether `path` is a file, links followed. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The first `lookover` a terminal runs on a PATH of `entries`: in each folder in turn, with each of `extensions` in
 * turn (Windows' `PATHEXT`; `[""]` elsewhere), the first that `found` says is there; null when none is.
 */
function firstOn(entries: string[], extensions: string[], found: (file: string) => boolean): string | null {
  for (const entry of entries.map((folder) => folder.trim()).filter((folder) => folder !== ""))
    for (const ext of extensions) {
      const file = join(entry, `lookover${ext.toLowerCase()}`);
      if (found(file)) return file;
    }
  return null;
}

/**
 * The launcher that runs `executable` with the arguments it gets: a batch file reads `%` doubled; paths hold no `"`.
 * cmd.exe reads a batch file in the console's code page, so a path beyond ASCII (`C:\Tools\José`) runs with the
 * console on UTF-8, the file's encoding, then gives back the console's own code page and the exit code.
 */
function launcherOf(executable: string): string {
  const run = `@"${executable.replaceAll("%", "%%")}" %*`;
  if (/^[\x20-\x7e]*$/.test(executable)) return `${run}\r\n`;
  return [
    "@setlocal",
    `@for /f "tokens=2 delims=:." %%c in ('chcp') do @set "page=%%c"`,
    "@chcp 65001>nul",
    run,
    '@set "code=%errorlevel%"',
    "@chcp %page%>nul",
    "@exit /b %code%",
    "",
  ].join("\r\n");
}

/** What a launcher as Lookover writes it (`launcherOf`) runs; null for a file that isn't one, or can't be read. */
function launcherRuns(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n");
    const runs = /^@"([^"]+)" %\*\r?$/m.exec(text)?.[1]?.replaceAll("%%", "%");
    return runs !== undefined && launcherOf(runs) === text ? runs : null;
  } catch {
    return null;
  }
}

/**
 * Windows: Lookover's launcher `lookover.cmd` in `folder` (`%LOCALAPPDATA%\Lookover\bin`), running `executable` with
 * the arguments it gets, and `folder` in the user's `value` (`Path`; `bun run live` names its own `lookover-dev-` one)
 * under `HKCU\Environment`. `reg` is `reg.exe` and `broadcast` the settings-change message unless given; the real
 * ones refuse under `bun test` but for a `lookover-dev-` value. `env` expands the entries and gives `PATHEXT`.
 */
export function windowsCommandPath(o: {
  executable: string;
  folder: string;
  value?: string;
  env?: Record<string, string | undefined>;
  reg?: Reg;
  broadcast?: () => unknown;
}): CommandPath {
  const name = o.value ?? "Path";
  if (o.reg === undefined || o.broadcast === undefined) notUnderTest(name.startsWith(DEV_VALUE_PREFIX));
  const env = o.env ?? {};
  const reg = o.reg ?? realReg(env);
  const broadcast = o.broadcast ?? settingsChanged;
  const launcher = join(o.folder, "lookover.cmd");
  const script = launcherOf(o.executable);
  /** Whether `file` is the launcher of this Lookover. */
  const ours = (file: string): boolean => {
    try {
      return readFileSync(file, "utf8").toLowerCase() === script.toLowerCase();
    } catch {
      return false;
    }
  };
  /** Whether an entry of the PATH names Lookover's folder, spelt as it is or through a variable. */
  const isOurs = (entry: string) => sameFolder(entry, o.folder) || sameFolder(expanded(entry, env), o.folder);
  /** The user's value; none when there is no such value yet. */
  const user = () => regValue(reg, USER_KEY, name);
  const write = async (type: string, data: string) => {
    const answer = await reg(["add", USER_KEY, "/v", name, "/t", type, "/d", data, "/f"]);
    if (answer.code !== 0) throw regError(answer);
    // Not waited for: the broadcast runs in a worker and may take seconds (settings-changed.ts).
    void broadcast();
  };
  return {
    folder: o.folder,
    reachable: async () => {
      const entries = await savedPath(reg, env, name);
      const file = firstOn(
        entries,
        (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean),
        isFile,
      );
      if (file === null) return { reach: "no", folder: o.folder };
      if (sameFolder(file, o.executable) || (sameFolder(file, launcher) && ours(file)))
        return { reach: "yes", folder: o.folder };
      // Lookover's own launcher, written by another copy: "Add to my PATH" points it at this one.
      const runs = sameFolder(file, launcher) ? launcherRuns(file) : null;
      if (runs !== null) return { reach: "stale", folder: o.folder, other: runs };
      return { reach: "other", folder: o.folder, other: file };
    },
    add: async () => {
      await mkdir(o.folder, { recursive: true });
      await writeFile(launcher, script);
      const now = await user();
      if (now === null) return await write(NEW_TYPE, o.folder);
      const data = readable(now.data);
      if (data.split(";").some(isOurs)) return;
      const joined = data === "" || data.endsWith(";") ? data : `${data};`;
      await write(now.type, `${joined}${o.folder}`);
    },
    remove: async () => {
      const now = await user();
      if (now !== null) {
        const entries = readable(now.data).split(";");
        const kept = entries.filter((entry) => !isOurs(entry));
        if (kept.length !== entries.length) await write(now.type, kept.join(";"));
      }
      // The launcher only when it runs this Lookover, then its folder when nothing else is in it.
      if (ours(launcher)) {
        await rm(launcher, { force: true });
        await rmdir(o.folder).catch(() => undefined);
      }
    },
  };
}

/** Whether `path` is a file this user may run. */
export function runnable(path: string): boolean {
  if (!isFile(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `path` leads, links followed; itself when it leads nowhere. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * macOS and Linux: the link `~/.local/bin/lookover` in `home` to `executable`, never over a file that isn't
 * Lookover's link to it. `linked` while the link is there and the PATH (`env.PATH`: the user's, as their session
 * gives it) doesn't name its folder. Writes in `home`: a test's scratch folder, or the user's through `osCommandPath`.
 */
export function linkCommandPath(o: {
  executable: string;
  home: string;
  env: Record<string, string | undefined>;
}): CommandPath {
  const folder = join(o.home, ".local", "bin");
  const link = join(folder, "lookover");
  /** What is at the link's place: nothing, Lookover's link to this executable, or something else. */
  const at = async (): Promise<"none" | "ours" | "else"> => {
    try {
      const stats = await lstat(link);
      if (!stats.isSymbolicLink()) return "else";
      return (await readlink(link)) === o.executable ? "ours" : "else";
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "none";
      throw error;
    }
  };
  return {
    folder,
    reachable: async () => {
      const file = firstOn((o.env.PATH ?? "").split(delimiter), [""], runnable);
      if (file === null) return { reach: (await at()) === "ours" ? "linked" : "no", folder };
      if (realOf(file) === realOf(o.executable)) return { reach: "yes", folder };
      return { reach: "other", folder, other: file };
    },
    add: async () => {
      const now = await at();
      if (now === "ours") return;
      if (now === "else")
        throw new Error(`${link} is already there and isn't Lookover's link: Lookover leaves it.`);
      await mkdir(folder, { recursive: true });
      await symlink(o.executable, link);
    },
    remove: async () => {
      if ((await at()) === "ours") await rm(link);
    },
  };
}

/** Where npm puts a package's `bin`, from its own folder: the launcher's path in the package. */
const LAUNCHER_IN_PACKAGE = ["node_modules", "lookover", "bin", "lookover.js"];
/** npm's shims name the launcher by that path, with either slash. */
const NAMES_LAUNCHER = /node_modules[\\/]lookover[\\/]bin[\\/]lookover\.js/i;
/** The shims npm writes for a `bin` on Windows: for cmd.exe, PowerShell and a POSIX shell. */
const WINDOWS_SHIMS = new Set(["lookover.cmd", "lookover.ps1", "lookover"]);

/**
 * Whether `file`, a `lookover` found on the PATH, is npm's shim of the launcher at `launcher` (ADR 0061), the one
 * `npm install -g lookover` made. On Windows, a `lookover.cmd`, `lookover.ps1` or `lookover` script naming
 * `node_modules/lookover/bin/lookover.js` beside it, which is `launcher` by its real path; elsewhere, a link whose real path is the
 * launcher's. False for a file that isn't there or can't be read.
 */
export function isNpmShim(file: string, launcher: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return isFile(file) && realOf(file) === realOf(launcher);
  if (!WINDOWS_SHIMS.has(basename(file).toLowerCase())) return false;
  // By their real paths: under nvm-windows the PATH names npm's folder through a junction (`C:\nvm4w\nodejs`).
  if (!sameFolder(realOf(join(dirname(file), ...LAUNCHER_IN_PACKAGE)), realOf(launcher))) return false;
  try {
    return NAMES_LAUNCHER.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/**
 * The folder npm puts its shims in, from the launcher's path: `<prefix>` on Windows (`<prefix>\node_modules\lookover`),
 * `<prefix>/bin` elsewhere (`<prefix>/lib/node_modules/lookover`).
 */
function npmBinFolder(launcher: string, platform: NodeJS.Platform): string {
  const modules = dirname(dirname(dirname(launcher)));
  const above = dirname(modules);
  if (platform === "win32" || basename(above) !== "lib") return above;
  return join(dirname(above), "bin");
}

/** Why an npm install's port never changes the PATH: the room offers nothing there (`not_offered`). */
const NPM_LEAVES = "npm put lookover on your PATH: Lookover leaves it to npm.";

/**
 * An npm install's `lookover` on the PATH (ADR 0061): npm put it there, so the port only reads whether the first
 * `lookover` on the PATH (as saved on Windows, through `reg`, which the real one refuses under `bun test`; the
 * session's elsewhere) is npm's shim of `launcher` (`yes`), none (`no`), or another one (`other`). Its folder is npm's
 * own. It adds and removes nothing.
 */
export function npmCommandPath(o: {
  launcher: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  reg?: Reg;
}): CommandPath {
  const windows = o.platform === "win32";
  if (windows && o.reg === undefined) notUnderTest();
  const reg = o.reg ?? realReg(o.env);
  const folder = npmBinFolder(o.launcher, o.platform);
  const refused = () => Promise.reject(new Error(NPM_LEAVES));
  return {
    folder,
    reachable: async () => {
      const file = windows
        ? firstOn(
            await savedPath(reg, o.env),
            (o.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean),
            isFile,
          )
        : firstOn((o.env.PATH ?? "").split(delimiter), [""], runnable);
      if (file === null) return { reach: "no", folder };
      if (isNpmShim(file, o.launcher, o.platform)) return { reach: "yes", folder };
      return { reach: "other", folder, other: file };
    },
    add: refused,
    remove: refused,
  };
}
