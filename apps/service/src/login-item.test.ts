// Start at login's adapters (ADR 0054): the fake in memory, and the real ones, which refuse to run under `bun test`
// (ADR 0045: no test registers anything on the owner's machine). The real ones' own work is tested here on what they
// are given instead of the machine: a `reg` that answers as `reg.exe` would, and a scratch folder for the macOS and
// Linux files. The command each registers is `loginCommand`'s.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchAgentLoginItem,
  loginCommand,
  memoryLoginItem,
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

test("Windows: the Run value holds the command line, registered means with this command, and removing it twice is fine", async () => {
  const { reg, values, calls } = fakeReg();
  const item = windowsLoginItem(COMMAND, { reg });
  expect(await item.registered()).toBe(false);
  await item.register();
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
  expect(await item.registered()).toBe(true);
  // A clone moved, another data folder: the value runs another command, so it isn't this one's.
  const moved = windowsLoginItem([BUN, "D:\\moved\\main.ts", "start", "--no-open"], { reg });
  expect(await moved.registered()).toBe(false);
  await item.unregister();
  expect(values.size).toBe(0);
  expect(await item.registered()).toBe(false);
  await item.unregister();
});

test("Windows: registered reads the value's command line ignoring case, as Windows' paths do", async () => {
  const { reg } = fakeReg({
    values: new Map([["Lookover", `${BUN} "${ENTRY}" start --no-open`.toLowerCase()]]),
  });
  expect(await windowsLoginItem(COMMAND, { reg }).registered()).toBe(true);
});

/** A `reg` that refuses everything, as `reg.exe` does without the rights. */
const denied = async (): Promise<RegAnswer> => ({ code: 1, out: "", err: "ERROR: Access is denied.\r\n" });

test("Windows: a query that fails for another reason than a missing value is said, not read as unregistered", async () => {
  await expect(windowsLoginItem(COMMAND, { reg: denied }).registered()).rejects.toThrow(
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
    values: new Map([["Lookover", `${BUN} "${ENTRY}" start --no-open`]]),
  });
  const item = windowsLoginItem(COMMAND, { reg });
  await expect(item.register()).rejects.toThrow("reg.exe refused: Access is denied.");
  await expect(item.unregister()).rejects.toThrow("Access is denied.");
});

const scratch = () => mkdtempSync(join(tmpdir(), "lookover-login-"));

test("macOS: a LaunchAgent run at load with the command's words, registered with this command only, removed", async () => {
  const home = scratch();
  const item = launchAgentLoginItem(["/opt/bun", "/c/a & b/main.ts", "start", "--no-open"], { home });
  expect(await item.registered()).toBe(false);
  await item.register();
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
  expect(await item.registered()).toBe(true);
  expect(await launchAgentLoginItem(["/opt/bun", "/moved/main.ts"], { home }).registered()).toBe(false);
  await item.unregister();
  expect(existsSync(file)).toBe(false);
  await item.unregister();
});

test("Linux: an XDG autostart entry, in XDG_CONFIG_HOME when set, its Exec quoted, removed", async () => {
  const home = scratch();
  const config = join(home, "conf");
  const item = xdgLoginItem(["/usr/bin/bun", '/c/a "b" $x\\y/main.ts', "start", "--no-open"], {
    home,
    env: { XDG_CONFIG_HOME: config },
  });
  await item.register();
  const file = join(config, "autostart", "lookover.desktop");
  expect(readFileSync(file, "utf8")).toBe(`[Desktop Entry]
Type=Application
Name=Lookover
Exec="/usr/bin/bun" "/c/a \\\\"b\\\\" \\\\$x\\\\\\\\y/main.ts" "start" "--no-open"
NoDisplay=true
X-GNOME-Autostart-enabled=true
`);
  expect(await item.registered()).toBe(true);
  await item.unregister();
  expect(existsSync(file)).toBe(false);
  // No XDG_CONFIG_HOME: ~/.config.
  const plain = xdgLoginItem(["/usr/bin/bun"], { home, env: {} });
  await plain.register();
  expect(existsSync(join(home, ".config", "autostart", "lookover.desktop"))).toBe(true);
});

test("the fake keeps the registration in memory, and refuses with a reason when told to", async () => {
  const item = memoryLoginItem();
  expect(await item.registered()).toBe(false);
  await item.register();
  expect(await item.registered()).toBe(true);
  item.refuse("Access is denied.");
  await expect(item.unregister()).rejects.toThrow("Access is denied.");
  expect(await item.registered()).toBe(true);
  item.refuse(null);
  await item.unregister();
  expect(await item.registered()).toBe(false);
});
