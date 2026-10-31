// Start at login (ADR 0054, ADR 0068): a port, `LoginItem`, that registers one command to run when the user logs in,
// says who holds that one registration, and removes it. The real adapters, each for the logged-in user, no
// administrator: Windows' `HKCU` `Run` key through `reg.exe` (the value `Lookover`), a LaunchAgent on macOS and an XDG
// autostart entry on Linux, those two unproven like the sign-in terminal (ADR 0047). The registration belongs to the
// install whose command it holds: this one, none, or another install (a clone moved, another data folder, a swapped
// binary), named by the command it holds. Another install's is never removed, and replaced only when asked to take it
// over. The fake keeps the registration in memory, for demo mode, live mode, a guarded program and the tests: the
// loop never registers anything on the owner's machine (ADR 0045). The real ones (`osLoginItem`, and
// `windowsLoginItem` on the real `reg.exe`) refuse to be built under `bun test`, but for `bun run live`'s check of the
// Windows one on a `lookover-dev-` value of its own; the macOS and Linux ones write in the home they are given, a
// test's scratch folder or, through `osLoginItem`, the user's.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { LoginHolder } from "@lookover/contracts";
import { commandLineOf } from "@lookover/process/background";
import { type System, underTest } from "./config.ts";
import { type Reg, realReg, regError, regValue } from "./reg.ts";

export type { RegAnswer } from "./reg.ts";

/** Lookover registered to start at login, with one command, for the user who runs it. */
export interface LoginItem {
  /** Who holds the registration: this install (this very command), none, or another install with its command. */
  held(): Promise<LoginHolder>;
  /**
   * Registers the command, unless another install holds the registration and `takeOver` isn't asked: that one is
   * left as it is. Answers who holds it after. Rejects with why the machine refused.
   */
  register(o?: { takeOver?: boolean }): Promise<Exclude<LoginHolder, "none">>;
  /** Removes this install's registration; nothing when there is none or another install's. Rejects with why the machine refused. */
  unregister(): Promise<void>;
}

/**
 * The fake: the registration in memory. `refuse(reason)` makes `register` and `unregister` reject, until `null`;
 * `holdOther(command)` makes another install hold it, with that command.
 */
export interface MemoryLoginItem extends LoginItem {
  refuse(reason: string | null): void;
  holdOther(command: string): void;
}

/** The command the fake registers for this install: any other it holds is another install's. */
const MEMORY_COMMAND = "lookover start --no-open";

export function memoryLoginItem(): MemoryLoginItem {
  // What the one registration holds, as a real one holds a command: the adapters' rule decides who that is.
  let value: string | null = null;
  let refused: string | null = null;
  const allowed = () => {
    if (refused !== null) throw new Error(refused);
  };
  const item = ownedLoginItem({
    read: () => {
      if (value === null) return Promise.resolve({ holder: "none", exact: false });
      if (value === MEMORY_COMMAND) return Promise.resolve({ holder: "this", exact: true });
      return Promise.resolve({ holder: { other: value }, exact: false });
    },
    write: async () => {
      allowed();
      value = MEMORY_COMMAND;
    },
    remove: async () => {
      allowed();
      value = null;
    },
  });
  return {
    ...item,
    refuse: (reason) => {
      refused = reason;
    },
    holdOther: (command) => {
      value = command;
    },
  };
}

/**
 * What a registration holds, read: who holds it, by the command it runs, and whether it is exactly what `write`
 * writes (this install's, written by an older template, with other line ends or in another case, is not).
 */
interface Read {
  holder: LoginHolder;
  exact: boolean;
}

/**
 * The adapters' rule (ADR 0068), on what each reads and writes, the fake's included: `read` gives who holds it,
 * `write` registers this command over whatever is there, `remove` removes whatever is there. `register` writes unless
 * another install holds it (and `takeOver` isn't asked) or this install's is already exactly what it writes.
 */
function ownedLoginItem(o: {
  read: () => Promise<Read>;
  write: () => Promise<void>;
  remove: () => Promise<void>;
}): LoginItem {
  return {
    held: async () => (await o.read()).holder,
    register: async (asked) => {
      const now = await o.read();
      if (typeof now.holder === "object" && asked?.takeOver !== true) return now.holder;
      if (now.holder !== "this" || !now.exact) await o.write();
      return "this";
    },
    unregister: async () => {
      if ((await o.read()).holder === "this") await o.remove();
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
  return ownedLoginItem({
    read: async () => {
      const data = (await regValue(reg, RUN_KEY, name))?.data ?? null;
      if (data === null) return { holder: "none", exact: false };
      // Windows' paths ignore case, and so does what it runs.
      const holder = data.toLowerCase() === line.toLowerCase() ? "this" : { other: data };
      return { holder, exact: data === line };
    },
    write: async () => {
      const answer = await reg(["add", RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", line, "/f"]);
      if (answer.code !== 0) throw regError(answer);
    },
    remove: async () => {
      const answer = await reg(["delete", RUN_KEY, "/v", name, "/f"]);
      if (answer.code !== 0) throw regError(answer);
    },
  });
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

/**
 * A file, `text` written to register and removed to unregister. Who holds it is the command `commandIn` reads in it,
 * never its whole text: this install's when it is the one `text` names (a file an older template wrote, or with CRLF
 * line ends, included, and written again on register), another install's otherwise, named by it (the file itself
 * when it names no command).
 */
function fileLoginItem(file: string, text: string, commandIn: (held: string) => string | null): LoginItem {
  const own = commandIn(text);
  return ownedLoginItem({
    read: async () => {
      try {
        const held = await readFile(file, "utf8");
        const command = commandIn(held);
        return {
          holder: command !== null && command === own ? "this" : { other: command ?? file },
          exact: held === text,
        };
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return { holder: "none", exact: false };
        throw error;
      }
    },
    write: async () => {
      await mkdir(posix.dirname(file.replaceAll("\\", "/")), { recursive: true });
      await writeFile(file, text);
    },
    remove: () => rm(file, { force: true }),
  });
}

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
/** XML text decoded in one pass, so `&amp;lt;` stays `&lt;`: the five named entities and the numeric ones. */
const unXml = (text: string) =>
  text.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(lt|gt|quot|apos|amp));/gi, (whole, hex, decimal, name) => {
    if (name !== undefined) return ENTITIES[name] ?? whole;
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(decimal);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

/** A LaunchAgent's `ProgramArguments`, as one line: each word, quoted when it holds a space or a quote. */
function launchAgentCommand(plist: string): string | null {
  const words = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (words === undefined) return null;
  return [...words.matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map(([, word = ""]) => unXml(word))
    .map((word) => (/[\s"]/.test(word) || word === "" ? JSON.stringify(word) : word))
    .join(" ");
}

/** A desktop entry's `Exec` line, as it is written, without the spaces or CR around it. */
const desktopExec = (entry: string): string | null => /^Exec=(.*)$/m.exec(entry)?.[1]?.trim() || null;

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
    launchAgentCommand,
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
    desktopExec,
  );
}
