// The program's configuration (ADR 0054): with neither `--demo` nor `--live` it is the program, on the user
// profile's data folder unless `LOOKOVER_HOME` or `--home` says another, guarded by a `live.json` when there is one.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carriedWebFiles, readConfig as readOn, type System } from "./index.ts";

/** How this clone runs `lookover`: Bun and its `main.ts`, as `main.ts` says it. */
const SELF = { kind: "clone", bun: process.execPath, main: join(import.meta.dir, "main.ts") } as const;

/** The configuration `argv` describes on `machine`, read by this clone. */
const readConfig = (argv: string[], machine: System) => readOn(argv, machine, SELF);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function folder(): string {
  const made = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-config-"));
  cleanups.push(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

/** A machine: its OS, the user's home, its environment, and git found wherever the PATH says. */
const system = (platform: NodeJS.Platform, homedir: string, env: Record<string, string> = {}): System => ({
  platform,
  homedir,
  env: { PATH: "/usr/bin", ...env },
  which: (program) => `/usr/bin/${program}`,
});

test("on Windows git is found on the PATH whatever its name's case: PowerShell's is Path", () => {
  const searched: string[] = [];
  const config = readConfig(["--demo", `--home=${folder()}`], {
    platform: "win32",
    homedir: "C:\\Users\\Your Name",
    env: { Path: "C:\\Program Files\\Git\\cmd" },
    which: (program, path) => {
      searched.push(path);
      return path === "C:\\Program Files\\Git\\cmd" ? `${path}\\${program}.exe` : null;
    },
  });
  expect(config.git).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  expect(searched).toEqual(["C:\\Program Files\\Git\\cmd"]);
});

const SANDBOX_ONLY = JSON.stringify({ repositories: ["sasensi/lookover-sandbox"] });

test("neither --demo nor --live is the program, on the data folder of the user's profile", () => {
  const windows = readConfig(
    [],
    system("win32", "C:\\Users\\Your Name", { LOCALAPPDATA: "C:\\Users\\Your Name\\AppData\\Local" }),
  );
  expect(windows).toMatchObject({ mode: "program", home: "C:\\Users\\Your Name\\AppData\\Local\\Lookover" });

  const mac = readConfig([], system("darwin", "/Users/ada"));
  expect(mac).toMatchObject({ mode: "program", home: "/Users/ada/Library/Application Support/Lookover" });

  const linux = readConfig([], system("linux", "/home/ada", { XDG_DATA_HOME: "/data/ada" }));
  expect(linux).toMatchObject({ mode: "program", home: "/data/ada/lookover" });
  const linuxDefault = readConfig([], system("linux", "/home/ada"));
  expect(linuxDefault).toMatchObject({ mode: "program", home: "/home/ada/.local/share/lookover" });
});

test("on Windows without LOCALAPPDATA, the profile's own AppData\\Local; on Linux an empty XDG_DATA_HOME is unset", () => {
  expect(readConfig([], system("win32", "C:\\Users\\Your Name")).home).toBe(
    "C:\\Users\\Your Name\\AppData\\Local\\Lookover",
  );
  expect(readConfig([], system("linux", "/home/ada", { XDG_DATA_HOME: "" })).home).toBe(
    "/home/ada/.local/share/lookover",
  );
});

test("LOOKOVER_HOME overrides the profile's folder, and --home overrides both", () => {
  const byEnv = folder();
  const byFlag = folder();
  const machine = system("linux", "/home/ada", { LOOKOVER_HOME: byEnv });
  expect(readConfig([], machine).home).toBe(byEnv);
  expect(readConfig([`--home=${byFlag}`], machine).home).toBe(byFlag);
});

test("the program's start at login runs this clone's lookover start, naming the data folder unless it is the profile's", () => {
  const self = [SELF.bun, SELF.main];
  const machine = system("linux", "/home/ada");
  expect(readConfig([], machine)).toMatchObject({ atLogin: [...self, "start", "--no-open"] });
  const home = folder();
  // `LOOKOVER_HOME` isn't set at login: the folder it names is.
  expect(readConfig([], system("linux", "/home/ada", { LOOKOVER_HOME: home }))).toMatchObject({
    atLogin: [...self, "start", "--no-open", `--home=${home}`],
  });
});

test("your coding agent: the binary offers the PATH through Lookover's own folder; the skill calls it absolutely", () => {
  const binary = {
    kind: "binary",
    path: "C:\\Users\\Your Name\\Downloads\\lookover.exe",
    webFiles: carriedWebFiles(new Map()),
  } as const;
  const machine = system("win32", "C:\\Users\\Your Name", {
    LOCALAPPDATA: "C:\\Users\\Your Name\\AppData\\Local",
  });
  const data = join(folder(), "my data");
  expect(readOn([`--home=${data}`], machine, binary).agent).toEqual({
    offer: "binary",
    folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin",
    executable: "C:\\Users\\Your Name\\Downloads\\lookover.exe",
    command: {
      onPath: `lookover '--home=${data}'`,
      offPath: `& 'C:\\Users\\Your Name\\Downloads\\lookover.exe' '--home=${data}'`,
    },
    // The skill's line: forward slashes, which Git Bash and PowerShell both read, and no `&` (the skill says it).
    skillCommand: `'C:/Users/Your Name/Downloads/lookover.exe' '--home=${data.replaceAll("\\", "/")}'`,
  });
  // A clone: no PATH offer, `bun run lookover` either way, and the skill calls its Bun and main.ts.
  const clone = {
    kind: "clone",
    bun: "/opt/bun/bin/bun",
    main: "/home/ada/my lookover/apps/service/src/main.ts",
  } as const;
  expect(readOn([], system("linux", "/home/ada"), clone).agent).toEqual({
    offer: "clone",
    folder: "/home/ada/.local/bin",
    executable: null,
    command: { onPath: "bun run lookover", offPath: "bun run lookover" },
    skillCommand: "/opt/bun/bin/bun '/home/ada/my lookover/apps/service/src/main.ts'",
  });
});

test("your coding agent: an npm install offers no PATH, names lookover, and the skill calls its executable absolutely", () => {
  const npm = {
    kind: "npm",
    path: "C:\\Users\\Your Name\\AppData\\Roaming\\npm\\node_modules\\lookover\\node_modules\\@lookover\\win32-x64\\lookover.exe",
    launcher: "C:\\Users\\Your Name\\AppData\\Roaming\\npm\\node_modules\\lookover\\bin\\lookover.js",
    webFiles: carriedWebFiles(new Map()),
  } as const;
  const machine = system("win32", "C:\\Users\\Your Name", {
    LOCALAPPDATA: "C:\\Users\\Your Name\\AppData\\Local",
  });
  const data = join(folder(), "my data");
  const config = readOn([`--home=${data}`], machine, npm);
  expect(config.agent).toEqual({
    offer: "npm",
    folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin",
    executable: npm.path,
    launcher: npm.launcher,
    command: { onPath: `lookover '--home=${data}'`, offPath: `lookover '--home=${data}'` },
    skillCommand: `'C:/Users/Your Name/AppData/Roaming/npm/node_modules/lookover/node_modules/@lookover/win32-x64/lookover.exe' '--home=${data.replaceAll("\\", "/")}'`,
  });
  // Start at login runs the executable itself: no Node, and the same path after `npm update -g lookover`.
  expect(config).toMatchObject({ atLogin: [npm.path, "start", "--no-open", `--home=${data}`] });
});

test("a path no skill line holds: the configuration still reads, the skill's command refused with why", () => {
  const odd = {
    kind: "binary",
    path: "/home/o'brien/$tools/lookover",
    webFiles: carriedWebFiles(new Map()),
  } as const;
  const agent = readOn([], system("linux", "/home/ada"), odd).agent;
  expect(agent.skillCommand).toBe("");
  expect(agent.skillRefused).toStartWith(
    "The skill can't be installed: Lookover's command holds a ' and a $",
  );
  expect(agent.command.offPath).toBe(`'/home/o'\\''brien/$tools/lookover'`);
});

test("the program is unguarded without a live.json, and guarded by the data folder's or --live-config's", () => {
  const home = folder();
  const machine = system("linux", "/home/ada");
  const bare = readConfig([`--home=${home}`], machine);
  expect(bare).toMatchObject({ mode: "program", live: undefined, processes: join(home, "processes.json") });

  writeFileSync(join(home, "live.json"), SANDBOX_ONLY);
  expect(readConfig([`--home=${home}`], machine)).toMatchObject({
    mode: "program",
    live: { repositories: [{ owner: "sasensi", name: "lookover-sandbox" }] },
  });

  const other = join(folder(), "elsewhere.json");
  writeFileSync(other, JSON.stringify({ repositories: ["lookover-dev/lookover-private"] }));
  expect(readConfig([`--home=${folder()}`, `--live-config=${other}`], machine)).toMatchObject({
    mode: "program",
    live: { repositories: [{ owner: "lookover-dev", name: "lookover-private" }] },
  });
});

test("live mode and the guarded program run as the organisation's App on its repositories when live.json lists them", () => {
  const home = folder();
  const key = join(home, "app.pem");
  const orgKey = join(home, "org.pem");
  for (const file of [key, orgKey]) writeFileSync(file, "not a key");
  const app = { id: 5202093, keyPath: key };
  const orgApp = { id: 5297673, keyPath: orgKey };
  const personal = {
    app,
    repositories: ["sasensi/lookover-sandbox"],
    fork: "lookover-forks/lookover-sandbox",
  };
  const organisation = { app: orgApp, sandbox: "lookover-dev/lookover-sandbox" };
  const machine = system("linux", "/home/ada");
  const served = {
    live: {
      app: orgApp,
      repositories: [
        { owner: "lookover-dev", name: "lookover-sandbox" },
        { owner: "lookover-dev", name: "lookover-private" },
      ],
    },
    asOrganisation:
      "Runs as lookover-dev's App 5297673 on lookover-dev/lookover-sandbox and lookover-dev/lookover-private.",
  };

  // The owner's file: the guard's allow-list and the App given agree, with no fork and no organisation left.
  writeFileSync(
    join(home, "live.json"),
    JSON.stringify({
      ...personal,
      organisation: { ...organisation, repositories: ["lookover-dev/lookover-private"] },
    }),
  );
  const live = readConfig(["--live", `--home=${home}`], machine);
  expect(live).toMatchObject({ mode: "live", ...served });
  expect(live.mode === "live" && live.live).toEqual(served.live);
  const program = readConfig([`--home=${home}`], machine);
  expect(program).toMatchObject({ mode: "program", ...served });
  expect(program.mode === "program" && program.live).toEqual(served.live);

  // Without the organisation's repositories, nothing changes: the config as read, nothing said.
  writeFileSync(join(home, "live.json"), JSON.stringify({ ...personal, organisation }));
  for (const argv of [["--live", `--home=${home}`], [`--home=${home}`]]) {
    const config = readConfig(argv, machine);
    expect(config).toMatchObject({
      live: {
        app,
        repositories: [{ owner: "sasensi", name: "lookover-sandbox" }],
        fork: { owner: "lookover-forks", name: "lookover-sandbox" },
      },
    });
    expect(config).not.toHaveProperty("asOrganisation");
  }
});

test("a live config named but missing refuses the program rather than run it unguarded", () => {
  const missing = join(folder(), "live.json");
  expect(() =>
    readConfig([`--home=${folder()}`, `--live-config=${missing}`], system("linux", "/home/ada")),
  ).toThrow(`No live config at ${missing}`);
});

test("a live.json in the data folder that isn't a live config refuses the program rather than run it unguarded", () => {
  const machine = system("linux", "/home/ada");
  const malformed = folder();
  writeFileSync(join(malformed, "live.json"), "{");
  expect(() => readConfig([`--home=${malformed}`], machine)).toThrow(
    `${join(malformed, "live.json")}: it is not JSON`,
  );
  const invalid = folder();
  writeFileSync(join(invalid, "live.json"), JSON.stringify({ repositories: [] }));
  expect(() => readConfig([`--home=${invalid}`], machine)).toThrow(
    `${join(invalid, "live.json")}: "repositories" must list`,
  );
});

test("a live.json that can't be looked at refuses the program rather than run it unguarded", () => {
  // A name too long for any file system: the live.json under it is neither there nor known to be missing.
  const unreachable = join(folder(), "y".repeat(40_000));
  expect(() => readConfig([`--home=${unreachable}`], system("linux", "/home/ada"))).toThrow(
    "Can't tell whether there is a live config at",
  );
});

test("--frozen and --scenario are demo mode's: the program refuses them", () => {
  const machine = system("linux", "/home/ada");
  expect(() => readConfig([`--home=${folder()}`, "--frozen=1"], machine)).toThrow(
    "--frozen is for demo mode",
  );
  expect(() => readConfig([`--home=${folder()}`, "--scenario=S1"], machine)).toThrow(
    "--scenario is for demo mode",
  );
});

test("demo and live mode keep their own data folders: the profile's is never theirs", () => {
  const machine = system("linux", "/home/ada");
  expect(() => readConfig(["--demo"], machine)).toThrow("Set LOOKOVER_HOME or pass --home=<dir>");
  expect(() => readConfig(["--live"], machine)).toThrow("Set LOOKOVER_HOME or pass --home=<dir>");
  expect(() => readConfig(["--demo", "--live"], machine)).toThrow("Pass --demo, --live or neither");
  expect(readConfig(["--demo", `--home=${folder()}`], machine)).toMatchObject({
    mode: "demo",
    scenario: "S10",
  });
});

test("an argument serve doesn't read is refused, never left aside: a guard named in two words would go unread", () => {
  const machine = system("linux", "/home/ada");
  const guard = join(folder(), "live.json");
  writeFileSync(guard, SANDBOX_ONLY);
  expect(() => readConfig([`--home=${folder()}`, "--live-config", guard], machine)).toThrow(
    "Pass --live-config as --live-config=<file>, in one word. Usage: lookover serve",
  );
  expect(() => readConfig([`--home=${folder()}`, "--port", "4100"], machine)).toThrow(
    "Pass --port as --port=<n>, in one word.",
  );
  expect(() => readConfig([`--home=${folder()}`, "--verbose"], machine)).toThrow(
    'lookover serve has no option "--verbose". Usage: lookover serve',
  );
  expect(() => readConfig([`--home=${folder()}`, "now"], machine)).toThrow(
    'lookover serve has no option "now".',
  );
  expect(() => readConfig([`--home=${folder()}`, "--demo=yes"], machine)).toThrow(
    'lookover serve has no option "--demo=yes".',
  );
});
