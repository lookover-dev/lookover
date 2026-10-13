// The one `lookover` command (ADR 0054): `serve` runs the service, `wait`, `feedback` and `reply` are the agent's,
// handed to `agent-cli`'s `run` with the App's slug from the data folder when neither `--app` nor `LOOKOVER_APP`
// names it, `--version` and `help`. Here at the dispatcher's seam: what it hands on, and what it prints.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appStore,
  type Config,
  carriedWebFiles,
  type LookoverDeps,
  lookover,
  memoryCommandPath,
  memoryKeychain,
  memoryLoginItem,
  type Printer,
  renderSkill,
  type Self,
  type System,
  skillCommandLine,
} from "./index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function folder(): string {
  const made = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-command-"));
  cleanups.push(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

/** A Linux machine whose profile keeps its data under `data`, with `env` beside it. */
const machine = (data: string, env: Record<string, string> = {}): System => ({
  platform: "linux",
  homedir: "/home/ada",
  env: { PATH: "/usr/bin", XDG_DATA_HOME: data, ...env },
  which: (program) => `/usr/bin/${program}`,
});

/** The App `slug`, kept in the data folder `home` as the service keeps it. */
async function plantApp(home: string, slug: string): Promise<void> {
  const apps = appStore({ home, keychain: memoryKeychain(), userOnly: async () => {} });
  await apps.write(
    {
      id: 5202093,
      slug,
      account: { id: 1, login: "sasensi", type: "User" },
      person: { id: 1, login: "sasensi" },
    },
    "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n",
  );
}

/** A clone of Lookover: Bun on its `main.ts`. */
const CLONE: Self = { kind: "clone", bun: "/usr/bin/bun", main: "/src/lookover/apps/service/src/main.ts" };

/**
 * The command on `system`, run as `self`, with what it printed, what it handed the agent's `run`, the configs it
 * served and the commands start at login was asked about.
 */
function command(system: System, self: Self = CLONE) {
  const out: string[] = [];
  const atLogin: string[][] = [];
  const err: string[] = [];
  const agent: string[][] = [];
  const served: Config[] = [];
  const printers: Printer[] = [];
  const deps: LookoverDeps = {
    print: { out: (line) => out.push(line), err: (line) => err.push(line) },
    system,
    self,
    agent: async (argv) => {
      agent.push(argv);
      return 3;
    },
    serve: async (config, print) => {
      served.push(config);
      printers.push(print);
    },
    background: {
      startServe: async () => {
        throw new Error("nothing starts in the background here");
      },
      openBrowser: async () => false,
      kill: () => {},
      webBuild: () => "program",
      time: { now: () => 0, sleep: async () => {} },
      loginItem: (command) => {
        atLogin.push(command);
        return memoryLoginItem();
      },
      commandPath: () => memoryCommandPath({ folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin" }),
    },
  };
  return {
    run: (...argv: string[]) => lookover(argv, deps),
    out,
    err,
    agent,
    served,
    printers,
    atLogin,
    deps,
  };
}

// Read off the disk, not imported: the one source (the root `package.json`, which release-please moves), whatever
// the build inlined.
const ROOT_VERSION = String(
  JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")).version,
);

test("--version prints Lookover's version, the root package.json's", async () => {
  const c = command(machine(folder()));
  expect(await c.run("--version")).toBe(0);
  expect(ROOT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(c.out).toEqual([ROOT_VERSION]);
});

test("--skill, the build's check and in no help, prints the skill this Lookover installs, or why none", async () => {
  const data = folder();
  const binary = (path: string): Self => ({ kind: "binary", path, webFiles: carriedWebFiles(new Map()) });
  const c = command(machine(folder()), binary("/opt/my tools/lookover"));
  expect(await c.run("--skill", `--home=${data}`)).toBe(0);
  const line = skillCommandLine(["/opt/my tools/lookover", `--home=${data}`]);
  expect(c.out).toEqual([
    renderSkill({ name: "lookover-review-loop", command: line, version: ROOT_VERSION }),
  ]);

  const odd = command(machine(folder()), binary("/opt/it's $here/lookover"));
  expect(await odd.run("--skill", `--home=${data}`)).toBe(1);
  expect(odd.out).toEqual([]);
  expect(odd.err.join("\n")).toStartWith(
    "The skill can't be installed: Lookover's command holds a ' and a $",
  );

  const help = command(machine(folder()));
  await help.run("help");
  expect(help.out.join("\n")).not.toContain("--skill");
});

test("help, or no command, lists every verb the command has, and only those", async () => {
  for (const asked of [["help"], ["--help"], []]) {
    const c = command(machine(folder()));
    expect(await c.run(...asked)).toBe(0);
    const text = c.out.join("\n");
    for (const verb of [
      "serve",
      "start",
      "open",
      "status",
      "stop",
      "wait",
      "feedback",
      "reply",
      "help",
      "--version",
    ])
      expect(text).toContain(`lookover ${verb}`);
    for (const missing of ["restart", "install"]) expect(text).not.toContain(`lookover ${missing}`);
    // One table for the command's own verbs; the agent's keep theirs.
    expect(text).toContain(
      "Exit (all but wait, feedback and reply): 0 done or running, 1 error, 2 usage, 3 not running",
    );
    expect(text).toContain("Exit (wait and feedback): 0 nothing to fix");
  }
});

test("a word that is no verb is a usage error, with the verbs", async () => {
  const c = command(machine(folder()));
  expect(await c.run("restart")).toBe(2);
  expect(c.err[0]).toBe('lookover has no command "restart".');
  expect(c.err.join("\n")).toContain("lookover serve");
});

test("wait, feedback and reply get the App's slug from the profile's data folder when nothing names it", async () => {
  const data = folder();
  await plantApp(join(data, "lookover"), "lookover-ada");
  const c = command(machine(data));
  expect(await c.run("wait", "--pr", "7", "--json")).toBe(3);
  expect(await c.run("feedback")).toBe(3);
  expect(await c.run("reply", "F3", "wont-fix", "The caller checks it.")).toBe(3);
  expect(c.agent).toEqual([
    ["wait", "--pr", "7", "--json", "--app", "lookover-ada"],
    ["feedback", "--app", "lookover-ada"],
    ["reply", "F3", "wont-fix", "The caller checks it.", "--app", "lookover-ada"],
  ]);
});

test("--home, else LOOKOVER_HOME, names the data folder the slug is read from, and is not handed on", async () => {
  const flagged = folder();
  const byEnv = folder();
  await plantApp(flagged, "by-flag");
  await plantApp(byEnv, "by-env");
  const c = command(machine(folder(), { LOOKOVER_HOME: byEnv }));
  await c.run("wait", `--home=${flagged}`);
  await c.run("wait");
  expect(c.agent).toEqual([
    ["wait", "--app", "by-flag"],
    ["wait", "--app", "by-env"],
  ]);
});

test("--app or LOOKOVER_APP still wins over the data folder's App", async () => {
  const data = folder();
  await plantApp(join(data, "lookover"), "lookover-ada");
  const flag = command(machine(data));
  await flag.run("wait", "--app", "other");
  await flag.run("wait", "--app=other");
  expect(flag.agent).toEqual([
    ["wait", "--app", "other"],
    ["wait", "--app=other"],
  ]);
  const env = command(machine(data, { LOOKOVER_APP: "from-env" }));
  await env.run("wait");
  expect(env.agent).toEqual([["wait"]]);
});

test("with no App in the data folder, the agent's command is handed its arguments as they are, to say what's missing", async () => {
  const c = command(machine(folder()));
  expect(await c.run("wait", "--json")).toBe(3);
  expect(c.agent).toEqual([["wait", "--json"]]);
});

test("a data folder whose App record is malformed, foreign or unreadable names no App: the arguments go on as they are", async () => {
  const records: [string, (home: string) => void][] = [
    ["not JSON", (home) => writeFileSync(join(home, "github", "app.json"), "{ not json")],
    ["someone else's JSON", (home) => writeFileSync(join(home, "github", "app.json"), '{"name":"other"}')],
    ["a folder", (home) => mkdirSync(join(home, "github", "app.json"))],
  ];
  for (const [what, plant] of records) {
    const home = folder();
    mkdirSync(join(home, "github"));
    plant(home);
    const c = command(machine(folder(), { LOOKOVER_HOME: home }));
    expect(await c.run("wait", "--json"), what).toBe(3);
    expect(c.agent, what).toEqual([["wait", "--json"]]);
  }
});

test("--home with its folder as the next word is refused for every verb, with the form to use", async () => {
  const home = folder();
  await plantApp(home, "by-flag");
  for (const verb of ["wait", "feedback", "reply"]) {
    const c = command(machine(folder()));
    expect(await c.run(verb, "--home", home)).toBe(2);
    expect(c.err).toEqual(["Pass the data folder as --home=<dir>, in one word."]);
    expect(c.agent).toEqual([]);
  }
  const serve = command(machine(folder()));
  expect(await serve.run("serve", "--home", home)).toBe(2);
  expect(serve.err[0]).toStartWith(
    "Pass the data folder as --home=<dir>, in one word. Usage: lookover serve",
  );
  expect(serve.served).toEqual([]);
});

test("serve runs the service the rest of its arguments describe; arguments it can't read exit 2 with the sentence", async () => {
  const home = folder();
  const c = command(machine(folder()));
  expect(await c.run("serve", "--demo", `--home=${home}`, "--scenario=S4")).toBeNull();
  expect(c.served).toHaveLength(1);
  expect(c.served[0]).toMatchObject({ mode: "demo", home, scenario: "S4" });
  // In the foreground it prints on the terminal.
  expect(c.printers[0]).toBe(c.deps.print);

  // In the background (`lookover start`'s) it prints nothing: the log keeps its lines.
  const quiet = command(machine(folder()));
  expect(await quiet.run("serve", "--demo", `--home=${home}`, "--background")).toBeNull();
  expect(quiet.served[0]).toMatchObject({ mode: "demo", home });
  const printer = quiet.printers[0];
  printer?.out("Open the app: http://127.0.0.1:1/");
  printer?.err("a line");
  expect(printer).not.toBe(quiet.deps.print);
  expect([...quiet.out, ...quiet.err]).toEqual([]);

  const refused = command(machine(folder()));
  expect(await refused.run("serve", "--demo", "--live")).toBe(2);
  expect(refused.err[0]).toStartWith("Pass --demo, --live or neither. Usage: lookover serve");
  expect(refused.served).toEqual([]);

  // Arguments it reads, naming what isn't there: an error, exit 1.
  const missing = join(folder(), "missing.json");
  const unguarded = command(machine(folder()));
  expect(await unguarded.run("serve", `--home=${home}`, `--live-config=${missing}`)).toBe(1);
  expect(unguarded.err[0]).toContain(`No live config at ${missing}`);
  expect(unguarded.served).toEqual([]);
});

test("start at login runs lookover as it runs: the clone's Bun and main.ts, or the compiled binary alone", async () => {
  const home = folder();
  const clone = command(machine(folder()));
  expect(await clone.run("serve", `--home=${home}`)).toBeNull();
  expect(clone.served[0]).toMatchObject({
    mode: "program",
    atLogin: [
      "/usr/bin/bun",
      "/src/lookover/apps/service/src/main.ts",
      "start",
      "--no-open",
      `--home=${home}`,
    ],
  });

  const binary = command(machine(folder()), {
    kind: "binary",
    path: "/opt/lookover/lookover",
    webFiles: carriedWebFiles(new Map()),
  });
  expect(await binary.run("serve", `--home=${home}`)).toBeNull();
  expect(binary.served[0]).toMatchObject({
    mode: "program",
    atLogin: ["/opt/lookover/lookover", "start", "--no-open", `--home=${home}`],
  });
  // `status` asks the machine about the command the program registers.
  expect(await binary.run("status", `--home=${home}`)).toBe(3);
  expect(binary.atLogin).toEqual([["/opt/lookover/lookover", "start", "--no-open", `--home=${home}`]]);
});

test("start, open, status and stop refuse what they don't read before reaching any service: --home <dir> would name another folder", async () => {
  const home = folder();
  // The folder LOOKOVER_HOME names is the one the two-word form would have reached instead.
  const elsewhere = folder();
  const usages = {
    open: "Usage: lookover open [--home=<dir>] [--no-open]",
    status: "Usage: lookover status [--home=<dir>] [--json]",
    stop: "Usage: lookover stop [--home=<dir>]",
  };
  for (const [verb, usage] of Object.entries(usages)) {
    const twoWords = command(machine(folder(), { LOOKOVER_HOME: elsewhere }));
    expect(await twoWords.run(verb, "--home", home), verb).toBe(2);
    expect(twoWords.err, verb).toEqual([`Pass the data folder as --home=<dir>, in one word. ${usage}`]);
    expect(twoWords.out, verb).toEqual([]);
    expect(twoWords.atLogin, verb).toEqual([]);

    const unknown = command(machine(folder()));
    expect(await unknown.run(verb, `--home=${home}`, "--force"), verb).toBe(2);
    expect(unknown.err, verb).toEqual([`lookover ${verb} has no option "--force". ${usage}`]);
    expect(unknown.out, verb).toEqual([]);
  }
  // Another verb's option is no option of this one.
  const json = command(machine(folder()));
  expect(await json.run("stop", "--json")).toBe(2);
  expect(json.err).toEqual([`lookover stop has no option "--json". ${usages.stop}`]);

  // start reads serve's options, and refuses as serve does; nothing is started (the port here would throw).
  const start = command(machine(folder(), { LOOKOVER_HOME: elsewhere }));
  expect(await start.run("start", "--demo", "--home", home)).toBe(2);
  expect(start.err[0]).toStartWith(
    "Pass the data folder as --home=<dir>, in one word. Usage: lookover serve",
  );
  expect(await start.run("start", "--demo", `--home=${home}`, "--force")).toBe(2);
  expect(start.err[1]).toStartWith('lookover serve has no option "--force". Usage: lookover serve');
  expect(start.out).toEqual([]);
});
