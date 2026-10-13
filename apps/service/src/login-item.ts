// Start at login (ADR 0054): a port, `LoginItem`, that registers one command to run when the user logs in, says whether
// that command is the one registered, and removes it. The real adapters, each for the logged-in user, no administrator:
// Windows' `HKCU` `Run` key through `reg.exe` (the value `Lookover`), a LaunchAgent on macOS and an XDG autostart entry
// on Linux, those two unproven like the sign-in terminal (ADR 0047). "Registered" means registered with this command:
// a clone moved, or another data folder, reads as not registered. The fake keeps the registration in memory, for demo
// mode, live mode, a guarded program and the tests: the loop never registers anything on the owner's machine (ADR
// 0045). The real ones (`osLoginItem`, and `windowsLoginItem` on the real `reg.exe`) refuse to be built under
// `bun test`, but for `bun run live`'s check of the Windows one on a `lookover-dev-` value of its own; the macOS and
// Linux ones write in the home they are given, a test's scratch folder or, through `osLoginItem`, the user's.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { commandLineOf } from "@lookover/process/background";
import { type System, underTest } from "./config.ts";
import { type Reg, realReg, regError, regValue } from "./reg.ts";

export type { RegAnswer } from "./reg.ts";

/** Lookover registered to start at login, with one command, for the user who runs it. */
export interface LoginItem {
  /** Whether the command runs at login: registered, with this very command. */
  registered(): Promise<boolean>;
  /** Registers the command, replacing whatever this item's name held. Rejects with why the machine refused. */
  register(): Promise<void>;
  /** Removes the registration; nothing when there is none. Rejects with why the machine refused. */
  unregister(): Promise<void>;
}

/** The fake: the registration in memory. `refuse(reason)` makes `register` and `unregister` reject, until `null`. */
export interface MemoryLoginItem extends LoginItem {
  refuse(reason: string | null): void;
}

export function memoryLoginItem(): MemoryLoginItem {
  let held = false;
  let refused: string | null = null;
  const change = (to: boolean) => {
    if (refused !== null) return Promise.reject(new Error(refused));
    held = to;
    return Promise.resolve();
  };
  return {
    registered: () => Promise.resolve(held),
    register: () => change(true),
    unregister: () => change(false),
    refuse: (reason) => {
      refused = reason;
    },
  };
}

/** Thrown by a real adapter built under `bun test`. */
const UNDER_TEST =
  "The real start at login never runs under bun test: a test registers nothing on this machine (ADR 0045). Use memoryLoginItem.";

/** Refuses to go on under `bun test`, unless `allowed` (`bun run live`'s own `lookover-dev-` value). */
function notUnderTest(allowed = false): void {
  if (underTest() && !allowed) throw new Error(UNDER_TEST);
}

/** The machine's own start at login, for `command`: its platform's adapter. Throws under `bun test`. */
export function osLoginItem(command: string[], system: System): LoginItem {
  notUnderTest();
  if (system.platform === "win32") return windowsLoginItem(command, { env: system.env });
  if (system.platform === "darwin") return launchAgentLoginItem(command, { home: system.homedir });
  return xdgLoginItem(command, { home: system.homedir, env: system.env });
}

/** The current user's `Run` key: what it names runs at their login, with their environment. */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** The value Lookover's own start at login is. */
const RUN_VALUE = "Lookover";

/**
 * Windows: the `Run` value `name` (`Lookover`; `bun run live` names its own `lookover-dev-` one) holding the command
 * as one command line. `reg` is `reg.exe` unless given; the real one refuses under `bun test` but for a `lookover-dev-`
 * value.
 */
export function windowsLoginItem(
  command: string[],
  o: {
    name?: string;
    reg?: Reg;
    env?: Record<string, string | undefined>;
  } = {},
): LoginItem {
  const name = o.name ?? RUN_VALUE;
  if (o.reg === undefined) notUnderTest(name.startsWith(DEV_VALUE_PREFIX));
  const reg = o.reg ?? realReg(o.env ?? {});
  const line = commandLineOf(command);
  /** The value's data; null when there is none. */
  const held = async (): Promise<string | null> => (await regValue(reg, RUN_KEY, name))?.data ?? null;
  return {
    // Windows' paths ignore case, and so does what it runs.
    registered: async () => (await held())?.toLowerCase() === line.toLowerCase(),
    register: async () => {
      const answer = await reg(["add", RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", line, "/f"]);
      if (answer.code !== 0) throw regError(answer);
    },
    unregister: async () => {
      if ((await held()) === null) return;
      const answer = await reg(["delete", RUN_KEY, "/v", name, "/f"]);
      if (answer.code !== 0) throw regError(answer);
    },
  };
}

/** The prefix of every `Run` value `bun run live` makes, and sweeps (never `Lookover` itself). */
export const DEV_VALUE_PREFIX = "lookover-dev-";

/** The names of the current user's `Run` values that start with `prefix`. `reg` is `reg.exe`, found in `env`, unless given. */
export async function runValues(
  prefix: string,
  o: { reg?: Reg; env?: Record<string, string | undefined> } = {},
): Promise<string[]> {
  const reg = o.reg ?? realReg(o.env ?? {});
  const answer = await reg(["query", RUN_KEY]);
  if (answer.code !== 0) throw regError(answer);
  return answer.out
    .split(/\r?\n/)
    .map((row) => /^\s+(.+?)\s{4}REG_/.exec(row)?.[1])
    .filter((found): found is string => found?.startsWith(prefix) === true);
}

/** A file holding exactly `text`, written to register and removed to unregister. */
function fileLoginItem(file: string, text: string): LoginItem {
  return {
    registered: async () => {
      try {
        return (await readFile(file, "utf8")) === text;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    },
    register: async () => {
      await mkdir(posix.dirname(file.replaceAll("\\", "/")), { recursive: true });
      await writeFile(file, text);
    },
    unregister: () => rm(file, { force: true }),
  };
}

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * macOS: `<home>/Library/LaunchAgents/dev.lookover.plist`, run at load, which launchd reads at the next login
 * (unproven, ADR 0054). The machine's is `osLoginItem`'s, on the user's home.
 */
export function launchAgentLoginItem(command: string[], o: { home: string }): LoginItem {
  const words = command.map((word) => `    <string>${xml(word)}</string>\n`).join("");
  return fileLoginItem(
    join(o.home, "Library", "LaunchAgents", "dev.lookover.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.lookover</string>
  <key>ProgramArguments</key>
  <array>
${words}  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`,
  );
}

/**
 * One word of a desktop entry's `Exec`, quoted: `"`, `` ` ``, `$` and `\` escaped inside the quotes, then every `\`
 * doubled as a string value's are, and `%` doubled as a field code's.
 */
const execWord = (word: string): string =>
  `"${word.replace(/["`$\\]/g, "\\$&")}"`.replaceAll("\\", "\\\\").replaceAll("%", "%%");

/**
 * Linux: the XDG autostart entry `lookover.desktop` in `$XDG_CONFIG_HOME/autostart` (else `<home>/.config/autostart`),
 * which a desktop session starts at login (unproven, ADR 0054). The machine's is `osLoginItem`'s, on the user's home.
 */
export function xdgLoginItem(
  command: string[],
  o: { home: string; env: Record<string, string | undefined> },
): LoginItem {
  const config = o.env.XDG_CONFIG_HOME || join(o.home, ".config");
  return fileLoginItem(
    join(config, "autostart", "lookover.desktop"),
    `[Desktop Entry]
Type=Application
Name=Lookover
Exec=${command.map(execWord).join(" ")}
NoDisplay=true
X-GNOME-Autostart-enabled=true
`,
  );
}
