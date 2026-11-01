// Start at login's adapters (ADR 0054): the fake in memory, and the real ones, which refuse to run under `bun test`
// (ADR 0045: no test registers anything on the owner's machine). The real ones' own work is tested here on what they
// are given instead of the machine: a `reg` that answers as `reg.exe` would, and a scratch folder for the macOS and
// Linux files. The command each registers is `loginCommand`'s.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchAgentLoginItem,
  loginCommand,
  memoryLoginItem,
  nowhereLoginItem,
  osLoginItem,
  type RegAnswer,
  runValues,
  type System,
  windowsLoginItem,
  xdgLoginItem,
} from "./index.ts";

const windows: System = {
  platform: "win32",
  homedir: "C:\\Users\\Your Name",
  env: { LOCALAPPDATA: "C:\\Users\\Your Name\\AppData\\Local" },
  which: () => null,
};
const BUN = "D:\\tools\\bun\\bun.exe";
const ENTRY = "C:\\code\\my clone\\apps\\service\\src\\main.ts";
const COMMAND = [BUN, ENTRY, "start", "--no-open"];
const RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

test("the command is `lookover start --no-open` by absolute paths, naming the data folder only when it isn't the profile's", () => {
  expect(loginCommand("C:\\Users\\Your Name\\AppData\\Local\\Lookover", windows, [BUN, ENTRY])).toEqual(
    COMMAND,
  );
  // Windows' paths ignore case.
  expect(loginCommand("c:\\users\\your name\\appdata\\local\\lookover", windows, [BUN, ENTRY])).toEqual(
    COMMAND,
  );
  expect(loginCommand("D:\\lookover data", windows, [BUN, ENTRY])).toEqual([
    ...COMMAND,
    "--home=D:\\lookover data",
  ]);
  const linux: System = { platform: "linux", homedir: "/home/sam", env: {}, which: () => null };
  expect(loginCommand("/home/sam/.local/share/lookover", linux, ["/usr/bin/bun", "/c/main.ts"])).toEqual([
    "/usr/bin/bun",
    "/c/main.ts",
    "start",
    "--no-open",
  ]);
  expect(loginCommand("/home/sam/.local/share/Lookover", linux, ["/usr/bin/bun", "/c/main.ts"])).toContain(
    "--home=/home/sam/.local/share/Lookover",
  );
});

test("the real adapters refuse to run under bun test, on every platform (ADR 0045)", () => {
  for (const platform of ["win32", "darwin", "linux"] as const)
    expect(() => osLoginItem(COMMAND, { ...windows, platform })).toThrow(/bun test/);
  expect(() => windowsLoginItem(COMMAND)).toThrow(/bun test/);
  // The Run value Lookover registers is never written by a test, even one that names it.
  expect(() => windowsLoginItem(COMMAND, { name: "Lookover" })).toThrow(/bun test/);
});

/** `reg query` of the whole Run key holding `values`, as `reg.exe` prints it. */
const listing = (values: Map<string, string>): RegAnswer => ({
  code: 0,
  out: `\r\n${RUN}\r\n${[...values].map(([n, v]) => `    ${n}    REG_SZ    ${v}\r\n`).join("")}\r\n`,
  err: "",
});

/** A `reg` keeping the Run key's values, as `reg.exe` answers; every call kept. */
function fakeReg(o: { refuse?: string; values?: Map<string, string> } = {}) {
  const values = o.values ?? new Map<string, string>();
  const calls: string[][] = [];
  const reg = async (args: string[]): Promise<RegAnswer> => {
    calls.push(args);
    const [verb, key, , name = ""] = args;
    // The machine refuses the writes; it still lets the key be read.
    if (o.refuse !== undefined && verb !== "query")
      return { code: 1, out: "", err: `ERROR: ${o.refuse}\r\n` };
    expect(key).toBe(RUN);
    // The whole key: every value it holds.
    if (verb === "query" && args.length === 2) return listing(values);
    if (verb === "add") {
      values.set(name, args[args.indexOf("/d") + 1] ?? "");
      return { code: 0, out: "The operation completed successfully.\r\n", err: "" };
    }
    const value = values.get(name);
    if (value === undefined)
      return {
        code: 1,
        out: "",
        err: "ERROR: The system was unable to find the specified registry key or value.\r\n",
      };
    if (verb === "delete") {
      values.delete(name);
      return { code: 0, out: "The operation completed successfully.\r\n", err: "" };
    }
    return {
      code: 0,
      out: `\r\n${RUN.replace("HKCU", "HKEY_CURRENT_USER")}\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`,
      err: "",
    };
  };
  return { reg, values, calls };
}

test("Windows: the Run value holds the command line, held by this install with this command, and removing it twice is fine", async () => {
  const { reg, values, calls } = fakeReg();
  const item = windowsLoginItem(COMMAND, { reg });
  expect(await item.held()).toBe("none");
  expect(await item.register()).toBe("this");
  expect(calls.find(([verb]) => verb === "add")).toEqual([
    "add",
    RUN,
    "/v",
    "Lookover",
    "/t",
    "REG_SZ",
    "/d",
    `${BUN} "${ENTRY}" start --no-open`,
    "/f",
  ]);
  expect(await item.held()).toBe("this");
  // A clone moved, another data folder: the value runs another command, so another install holds it.
  const moved = windowsLoginItem([BUN, "D:\\moved\\main.ts", "start", "--no-open"], { reg });
  expect(await moved.held()).toEqual({ other: `${BUN} "${ENTRY}" start --no-open` });
  await item.unregister();
  expect(values.size).toBe(0);
  expect(await item.held()).toBe("none");
  await item.unregister();
});

test("Windows: another install's value is never removed, and replaced only when asked to take it over (ADR 0068)", async () => {
  const theirs = "C:\\Users\\Your Name\\AppData\\Local\\Programs\\Lookover\\lookover.exe start --no-open";
  const { reg, values, calls } = fakeReg({ values: new Map([["Lookover", theirs]]) });
  const item = windowsLoginItem(COMMAND, { reg });
  expect(await item.held()).toEqual({ other: theirs });
  await item.unregister();
  expect(await item.register()).toEqual({ other: theirs });
  expect(values.get("Lookover")).toBe(theirs);
  expect(calls.filter(([verb]) => verb === "add" || verb === "delete")).toEqual([]);
  expect(await item.register({ takeOver: true })).toBe("this");
  expect(values.get("Lookover")).toBe(`${BUN} "${ENTRY}" start --no-open`);
});

test("Windows: this install's value reads ignoring case, as Windows' paths do", async () => {
  const { reg } = fakeReg({
    values: new Map([["Lookover", `${BUN} "${ENTRY}" start --no-open`.toLowerCase()]]),
  });
  expect(await windowsLoginItem(COMMAND, { reg }).held()).toBe("this");
});

/** A `reg` that refuses everything, as `reg.exe` does without the rights. */
const denied = async (): Promise<RegAnswer> => ({ code: 1, out: "", err: "ERROR: Access is denied.\r\n" });

test("Windows: a query that fails for another reason than a missing value is said, not read as unregistered", async () => {
  await expect(windowsLoginItem(COMMAND, { reg: denied }).held()).rejects.toThrow(
    "reg.exe refused: Access is denied.",
  );
  await expect(windowsLoginItem(COMMAND, { reg: denied }).unregister()).rejects.toThrow("Access is denied.");
});

test("Windows: runValues names the Run values with the prefix, and says a refused query", async () => {
  const key = new Map([
    ["Lookover", "x"],
    ["lookover-dev-a", "y"],
  ]);
  expect(await runValues("lookover-dev-", { reg: async () => listing(key) })).toEqual(["lookover-dev-a"]);
  await expect(runValues("lookover-dev-", { reg: denied })).rejects.toThrow("Access is denied.");
});

test("Windows: a refused reg.exe is said with its reason", async () => {
  const { reg } = fakeReg({
    refuse: "Access is denied.",
    // This install's, in another case: register writes it again, exactly, and unregister removes it.
    values: new Map([["Lookover", `${BUN} "${ENTRY}" start --no-open`.toLowerCase()]]),
  });
  const item = windowsLoginItem(COMMAND, { reg });
  await expect(item.register()).rejects.toThrow("reg.exe refused: Access is denied.");
  await expect(item.unregister()).rejects.toThrow("Access is denied.");
});

const scratches: string[] = [];
const scratch = () => {
  const made = mkdtempSync(join(tmpdir(), "lookover-login-"));
  scratches.push(made);
  return made;
};
afterEach(() => {
  for (const folder of scratches.splice(0)) rmSync(folder, { recursive: true, force: true });
});

test("macOS: a LaunchAgent run at load with the command's words, held by this install with this command only, removed", async () => {
  const home = scratch();
  const item = launchAgentLoginItem(["/opt/bun", "/c/a & b/main.ts", "start", "--no-open"], { home });
  expect(await item.held()).toBe("none");
  expect(await item.register()).toBe("this");
  const file = join(home, "Library", "LaunchAgents", "dev.lookover.plist");
  expect(readFileSync(file, "utf8")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.lookover</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/bun</string>
    <string>/c/a &amp; b/main.ts</string>
    <string>start</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`);
  expect(await item.held()).toBe("this");
  await item.unregister();
  expect(existsSync(file)).toBe(false);
  await item.unregister();
});

test("macOS: another install's LaunchAgent, named by its words, is never removed, and replaced only when asked (ADR 0068)", async () => {
  const home = scratch();
  const theirs = launchAgentLoginItem(
    ["/usr/local/bin/lookover", "start", "--no-open", "--home=/Users/sam/a & b"],
    {
      home,
    },
  );
  await theirs.register();
  const file = join(home, "Library", "LaunchAgents", "dev.lookover.plist");
  const before = readFileSync(file, "utf8");
  const item = launchAgentLoginItem(["/opt/bun", "/c/main.ts", "start", "--no-open"], { home });
  const other = { other: '/usr/local/bin/lookover start --no-open "--home=/Users/sam/a & b"' };
  expect(await item.held()).toEqual(other);
  await item.unregister();
  expect(await item.register()).toEqual(other);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(await item.register({ takeOver: true })).toBe("this");
  expect(await theirs.held()).toEqual({ other: "/opt/bun /c/main.ts start --no-open" });
});

test("Linux: an XDG autostart entry, in XDG_CONFIG_HOME when set, its Exec quoted, removed", async () => {
  const home = scratch();
  const config = join(home, "conf");
  const item = xdgLoginItem(["/usr/bin/bun", '/c/a "b" $x\\y/main.ts', "start", "--no-open"], {
    home,
    env: { XDG_CONFIG_HOME: config },
  });
  expect(await item.register()).toBe("this");
  const file = join(config, "autostart", "lookover.desktop");
  expect(readFileSync(file, "utf8")).toBe(`[Desktop Entry]
Type=Application
Name=Lookover
Exec="/usr/bin/bun" "/c/a \\\\"b\\\\" \\\\$x\\\\\\\\y/main.ts" "start" "--no-open"
NoDisplay=true
X-GNOME-Autostart-enabled=true
`);
  expect(await item.held()).toBe("this");
  await item.unregister();
  expect(existsSync(file)).toBe(false);
  // No XDG_CONFIG_HOME: ~/.config.
  const plain = xdgLoginItem(["/usr/bin/bun"], { home, env: {} });
  await plain.register();
  expect(existsSync(join(home, ".config", "autostart", "lookover.desktop"))).toBe(true);
});

test("Linux: another install's autostart entry, named by its Exec, is never removed, and replaced only when asked (ADR 0068)", async () => {
  const home = scratch();
  const theirs = xdgLoginItem(["/opt/lookover/lookover", "start", "--no-open"], { home, env: {} });
  await theirs.register();
  const file = join(home, ".config", "autostart", "lookover.desktop");
  const before = readFileSync(file, "utf8");
  const item = xdgLoginItem(["/usr/bin/bun", "/c/main.ts", "start", "--no-open"], { home, env: {} });
  const other = { other: '"/opt/lookover/lookover" "start" "--no-open"' };
  expect(await item.held()).toEqual(other);
  await item.unregister();
  expect(await item.register()).toEqual(other);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(await item.register({ takeOver: true })).toBe("this");
  expect(await theirs.held()).toEqual({ other: '"/usr/bin/bun" "/c/main.ts" "start" "--no-open"' });
});

test("macOS: another install's LaunchAgent words are read with every XML entity decoded, named and numeric", async () => {
  const home = scratch();
  const dir = join(home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "dev.lookover.plist"),
    `<plist version="1.0"><dict><key>ProgramArguments</key><array>
    <string>/Users/sam/O&apos;Brien/lookover</string>
    <string>--home=a&#38;b&#x3C;c&#233;</string>
    <string>&quot;x&quot;&amp;amp;</string>
  </array></dict></plist>`,
  );
  const item = launchAgentLoginItem(["/opt/bun", "/c/main.ts"], { home });
  expect(await item.held()).toEqual({
    other: `/Users/sam/O'Brien/lookover --home=a&b<cé ${JSON.stringify('"x"&amp;')}`,
  });
});

test("Linux: another install's autostart entry written with CRLF line ends is named by its Exec, trimmed", async () => {
  const home = scratch();
  const dir = join(home, ".config", "autostart");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "lookover.desktop"),
    '[Desktop Entry]\r\nType=Application\r\nExec= "/opt/lookover/lookover" "start" \t\r\nNoDisplay=true\r\n',
  );
  const item = xdgLoginItem(["/usr/bin/bun"], { home, env: {} });
  expect(await item.held()).toEqual({ other: '"/opt/lookover/lookover" "start"' });
});

/** This install's LaunchAgent as an older Lookover might have written it: CRLF, another label, no RunAtLoad. */
const OLD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>\r
<plist version="1.0">\r
<dict>\r
  <key>Label</key>\r
  <string>dev.lookover.old</string>\r
  <key>ProgramArguments</key>\r
  <array>\r
    <string>/opt/bun</string>\r
    <string>/c/a &amp; b/main.ts</string>\r
    <string>start</string>\r
  </array>\r
</dict>\r
</plist>\r
`;

test("macOS: this install's LaunchAgent is read by its command, not its text: CRLF or another template is this one's, written again on register (ADR 0068)", async () => {
  const home = scratch();
  const dir = join(home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "dev.lookover.plist");
  writeFileSync(file, OLD_PLIST);
  const item = launchAgentLoginItem(["/opt/bun", "/c/a & b/main.ts", "start"], { home });
  expect(await item.held()).toBe("this");
  expect(await item.register()).toBe("this");
  const written = readFileSync(file, "utf8");
  expect(written).not.toBe(OLD_PLIST);
  expect(written).toContain("<key>RunAtLoad</key>");
  expect(written).not.toContain("\r");
  // Unchanged then: a second register writes nothing.
  writeFileSync(file, written);
  expect(await item.register()).toBe("this");
  expect(readFileSync(file, "utf8")).toBe(written);
  await item.unregister();
  expect(existsSync(file)).toBe(false);
});

test("Linux: this install's autostart entry is read by its Exec, not its text: CRLF or another template is this one's, written again on register (ADR 0068)", async () => {
  const home = scratch();
  const dir = join(home, ".config", "autostart");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "lookover.desktop");
  writeFileSync(
    file,
    '[Desktop Entry]\r\nType=Application\r\nName=Old Lookover\r\nExec="/usr/bin/bun" "start"\r\n',
  );
  const item = xdgLoginItem(["/usr/bin/bun", "start"], { home, env: {} });
  expect(await item.held()).toBe("this");
  expect(await item.register()).toBe("this");
  expect(readFileSync(file, "utf8")).toBe(`[Desktop Entry]
Type=Application
Name=Lookover
Exec="/usr/bin/bun" "start"
NoDisplay=true
X-GNOME-Autostart-enabled=true
`);
  await item.unregister();
  expect(existsSync(file)).toBe(false);
});

test("Windows: this install's value in another case is written again on register, exactly", async () => {
  const line = `${BUN} "${ENTRY}" start --no-open`;
  const { reg, values, calls } = fakeReg({ values: new Map([["Lookover", line.toLowerCase()]]) });
  const item = windowsLoginItem(COMMAND, { reg });
  expect(await item.register()).toBe("this");
  expect(values.get("Lookover")).toBe(line);
  const adds = calls.filter(([verb]) => verb === "add").length;
  expect(await item.register()).toBe("this");
  expect(calls.filter(([verb]) => verb === "add").length).toBe(adds);
});

test("the fake keeps the registration in memory, and refuses with a reason when told to", async () => {
  const item = memoryLoginItem();
  expect(await item.held()).toBe("none");
  expect(await item.register()).toBe("this");
  expect(await item.held()).toBe("this");
  item.refuse("Access is denied.");
  await expect(item.unregister()).rejects.toThrow("Access is denied.");
  expect(await item.held()).toBe("this");
  item.refuse(null);
  await item.unregister();
  expect(await item.held()).toBe("none");
});

test("the fake can be told another install holds it: never removed, replaced only when asked (ADR 0068)", async () => {
  const item = memoryLoginItem();
  const theirs = "C:\\Lookover\\lookover.exe start --no-open";
  item.holdOther(theirs);
  expect(await item.held()).toEqual({ other: theirs });
  await item.unregister();
  expect(await item.register()).toEqual({ other: theirs });
  expect(await item.held()).toEqual({ other: theirs });
  expect(await item.register({ takeOver: true })).toBe("this");
  expect(await item.held()).toBe("this");
});

test("the stand-in registers nothing and always answers none, as `lookover status` does (ADR 0070)", async () => {
  const item = nowhereLoginItem();
  expect(await item.held()).toBe("none");
  expect(await item.register()).toBe("none");
  expect(await item.register({ takeOver: true })).toBe("none");
  await item.unregister();
  expect(await item.held()).toBe("none");
});
