// @lookover/process/terminal: the sign-in terminal, process's second entry, for its one caller, the service's
// `engine.signIn` (ADR 0047). What it gives: `openTerminal(invocation, session?, platform?)`, the one program
// Lookover starts outside the runner: visible, detached, uncontained, so the user signs in to the
// vendor's own program in a window that outlives the service. It answers once the start is known, `{ opened:
// true, pid }` or `{ opened: false, reason }`, never a throw, and never waits for the program, reads nothing it
// writes, kills nothing. On Windows (`win32`) the program itself gets a new console window: `CreateProcessW` with
// `CREATE_NEW_CONSOLE`, its command line quoted as the C runtime reads it back (`console-window.ts`). On macOS
// Terminal is told the command through `osascript` and brought to the front; on every other POSIX platform
// Debian's `x-terminal-emulator -e` runs it; both unproven here (ADR 0047). `terminalCommand(invocation,
// platform, session?)` is what `openTerminal` would start, as data: what the tests check, and what a platform
// with no terminal could show instead (ADR 0047). `cwd` is where the program starts; `env` the whole environment
// it gets, never this process's own: the caller gives the engine's allow-listed one (ADR 0048), so a GitHub token
// or an API key in the service's shell never reaches a vendor's login. Off Windows the terminal's own shell (the
// user's login shell on macOS, the server's environment for a Linux terminal such as gnome-terminal) would hand
// the program its own environment, so the program is run under `/usr/bin/env -i` with `env` spelled out (and the
// terminal's `TERM`). On every platform `env` loses a token first: a login never needs one. A proxy URL with
// its password the login does need: on Windows it stays in the environment block, the program's own; off
// Windows, where the environment sits in a process's arguments, it goes through a file only the user reads,
// which the program's shell reads in and removes before the login starts (`privateEnv`). A Linux terminal
// also needs the desktop session to open its window: `session`, the service's own environment, gives it
// `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR`, and nothing else of it is read.
// It must never know: which program signs in (claude, codex), the runner, the registry, Lookover's rules.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREATE_NEW_CONSOLE,
  CREATE_UNICODE_ENVIRONMENT,
  commandLineOf,
  openConsoleWindow,
  type TerminalOpened,
} from "./console-window.ts";

/** What the terminal runs: a program by absolute path with its arguments, from `cwd`, with only `env`. */
export interface TerminalInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * What `openTerminal` starts on a platform. `console` (Windows): the program itself in a new console window,
 * through `CreateProcessW` with `creationFlags`, its command line quoted the way the C runtime reads it back.
 * `program` (elsewhere): the system's terminal, started detached with the command as its arguments. Both with
 * the invocation's `env` as their whole environment.
 */
export type TerminalCommand =
  | {
      kind: "console";
      executable: string;
      commandLine: string;
      cwd: string;
      env: Record<string, string>;
      creationFlags: number;
    }
  | {
      kind: "program";
      executable: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      /**
       * What must reach the program but never a process's arguments (an authenticating proxy): `text`, shell
       * `export` lines, to write at `path` (the user's alone) before the start. The program's shell reads it and
       * removes it and its folder before the program runs. Absent when there is nothing private.
       */
      privateEnv?: PrivateEnv;
    };

/** Variables written to a private file, read and removed by the shell that starts the program. */
export interface PrivateEnv {
  path: string;
  text: string;
}

/** macOS: AppleScript's runner, which tells Terminal to open a window on the command and come to the front. */
const OSASCRIPT = "/usr/bin/osascript";
/** Elsewhere: Debian's alternative for the user's terminal; `-e` takes the command and its arguments. */
const X_TERMINAL_EMULATOR = "/usr/bin/x-terminal-emulator";

/** One word for the shell Terminal opens: single-quoted, a quote inside closed, escaped and reopened. */
const shellWord = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** The text inside an AppleScript string literal: its backslashes and double quotes escaped. */
const appleScriptText = (text: string): string => text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/**
 * The desktop session a Linux terminal needs to open its window (X11, Wayland), taken from the service's own
 * environment: the terminal is the user's own session (ADR 0047), the engine's list leaves them out (ADR 0048).
 */
const DESKTOP_SESSION = ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"] as const;

/** The variables of `session` a desktop terminal needs, those it has, under the engine's own `env`. */
function withDesktopSession(
  env: Record<string, string>,
  session: Record<string, string | undefined>,
): Record<string, string> {
  const desktop = DESKTOP_SESSION.flatMap((name) => {
    const value = session[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return { ...Object.fromEntries(desktop), ...env };
}

/** `env`'s variables sorted by name (by code unit, whatever the locale), so a command reads the same every time. */
const byName = (env: Record<string, string>): [string, string][] =>
  Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** `env` as `/usr/bin/env` assignments, sorted by name. */
const assignments = (env: Record<string, string>): string[] =>
  byName(env).map(([name, value]) => `${name}=${value}`);

/**
 * A name that says its value is a credential: a token, a secret, a password, an API key. Not `XAUTHORITY`,
 * which is a path the terminal needs.
 */
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL/i;
/** A URL that carries a user's password, such as an authenticating proxy's: `scheme://user:password@host`. */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i;

/** A name a POSIX shell can `export`: anything else could not ride in the private file. */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `env` without a credential by its name: the terminal starts a login, which never needs a token the service
 * already has. Then split: `public`, what may be seen, and `secret`, a value that carries a password (an
 * authenticating proxy's URL), which the login does need to reach its service, but which off Windows must never
 * sit in a process's arguments (seen by any user's `ps`, kept in Terminal's window).
 */
function splitCredentials(env: Record<string, string>): {
  public: Record<string, string>;
  secret: Record<string, string>;
} {
  const kept = Object.entries(env).filter(([name]) => !CREDENTIAL_NAME.test(name));
  return {
    public: Object.fromEntries(kept.filter(([, value]) => !URL_WITH_PASSWORD.test(value))),
    secret: Object.fromEntries(kept.filter(([, value]) => URL_WITH_PASSWORD.test(value))),
  };
}

/**
 * The start of a command that runs the program under `/usr/bin/env -i`: its whole environment is what follows,
 * whatever the terminal's shell has, but for the terminal's own `TERM` (its kind, so the login draws right).
 */
const ENV_ONLY = '/usr/bin/env -i TERM="$TERM"';

/**
 * The fixed script that brings the private file in: `$1` is its path, read, removed with its folder, then the
 * rest run in its place. Only the path is an argument, never what the file holds.
 */
const READ_PRIVATE = '. "$1"; rm -f -- "$1"; rmdir -- "$(dirname -- "$1")" 2>/dev/null; shift; exec "$@"';

/** `secret` as the private file's text, one `export NAME='value'` per variable, sorted by name. */
const exportLines = (secret: Record<string, string>): string =>
  byName(secret)
    .filter(([name]) => SHELL_NAME.test(name))
    .map(([name, value]) => `export ${name}=${shellWord(value)}\n`)
    .join("");

/**
 * What `openTerminal` would start for `invocation` on `platform`: data, nothing started. `session` is the
 * service's own environment, read for the desktop session a Linux terminal needs and nothing else.
 * `privateFile` is where, off Windows, a value carrying a password would be written for the program's shell to
 * read (`privateEnv`); without it such a value is dropped. On Windows the environment block is the program's
 * own, so it goes there.
 */
export function terminalCommand(
  invocation: TerminalInvocation,
  platform: NodeJS.Platform,
  session: Record<string, string | undefined> = {},
  privateFile?: string,
): TerminalCommand {
  const { executable, args, cwd } = invocation;
  const split = splitCredentials(invocation.env);
  if (platform === "win32") {
    return {
      kind: "console",
      executable,
      commandLine: commandLineOf([executable, ...args]),
      cwd,
      env: { ...split.public, ...split.secret },
      creationFlags: CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
    };
  }
  // Off Windows the environment is spelled out in arguments: only `public` goes there. What carries a password
  // is written to `privateFile`, and a fixed shell, started by `env -i` before the program, reads it in.
  const env = split.public;
  const text = privateFile === undefined ? "" : exportLines(split.secret);
  const privateEnv = privateFile !== undefined && text !== "" ? { path: privateFile, text } : undefined;
  const program = [
    ...(privateEnv === undefined ? [] : ["/bin/sh", "-c", READ_PRIVATE, "sh", privateEnv.path]),
    executable,
    ...args,
  ];
  const withPrivate = privateEnv === undefined ? {} : { privateEnv };
  if (platform === "darwin") {
    // Terminal's window runs this in the user's login shell, with the shell's environment: `env -i` replaces it.
    const words = [...assignments(env), ...program].map(shellWord).join(" ");
    const line = `cd ${shellWord(cwd)} && ${ENV_ONLY} ${words}`;
    return {
      kind: "program",
      executable: OSASCRIPT,
      args: [
        "-e",
        `tell application "Terminal" to do script "${appleScriptText(line)}"`,
        "-e",
        'tell application "Terminal" to activate',
      ],
      cwd,
      env,
      ...withPrivate,
    };
  }
  // The terminal needs the desktop session to open its window; the program, started by a fixed `sh` script
  // with every word an argument of its own, gets that and the engine's `env` only, whatever the terminal set
  // (a terminal that runs as a server starts it with its own environment).
  const terminalEnv = withDesktopSession(env, session);
  return {
    kind: "program",
    executable: X_TERMINAL_EMULATOR,
    args: ["-e", "/bin/sh", "-c", `exec ${ENV_ONLY} "$@"`, "sh", ...assignments(terminalEnv), ...program],
    cwd,
    env: terminalEnv,
    ...withPrivate,
  };
}

/** The terminal program started detached, with no pipe to us, and let go: `opened` once Node knows the start. */
function startDetached(command: Extract<TerminalCommand, { kind: "program" }>): Promise<TerminalOpened> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: command.env,
        detached: true,
        stdio: "ignore",
      });
    } catch (error) {
      resolve({ opened: false, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    // Kept on, not `once`: an error after the start must never be unhandled, it would end the service.
    child.on("error", (error) => resolve({ opened: false, reason: error.message }));
    child.once("spawn", () => {
      child.unref();
      resolve({ opened: true, pid: child.pid ?? 0 });
    });
  });
}

/**
 * Opens the terminal on `invocation` for `platform` (this one by default), `session` the service's own
 * environment, read for the desktop session only (`terminalCommand`). Never throws.
 */
export function openTerminal(
  invocation: TerminalInvocation,
  session: Record<string, string | undefined> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<TerminalOpened> {
  const start = (command: TerminalCommand): Promise<TerminalOpened> =>
    command.kind === "console" ? Promise.resolve(openConsoleWindow(command)) : startDetached(command);
  if (platform === "win32") return start(terminalCommand(invocation, platform, session));
  // Off Windows: a folder only this user may enter (`mkdtemp` makes it 0700) for the private file, written
  // 0600. Started, the program's shell removes both; not started, nobody would, so it is removed here.
  let folder = "";
  try {
    folder = mkdtempSync(join(tmpdir(), "lookover-signin-"));
    const command = terminalCommand(invocation, platform, session, join(folder, "env"));
    if (command.kind === "console" || command.privateEnv === undefined) {
      rmSync(folder, { recursive: true, force: true });
      return start(command);
    }
    writeFileSync(command.privateEnv.path, command.privateEnv.text, { mode: 0o600, flag: "wx" });
    return start(command).then((opened) => {
      if (!opened.opened) rmSync(folder, { recursive: true, force: true });
      return opened;
    });
  } catch (error) {
    if (folder !== "") rmSync(folder, { recursive: true, force: true });
    return Promise.resolve({ opened: false, reason: error instanceof Error ? error.message : String(error) });
  }
}
