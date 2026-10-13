// Windows: a new console window of a program, over `bun:ffi` to kernel32's `CreateProcessW` (ADR 0047).
// Node's `spawn` can't ask for one: its `detached` is `DETACHED_PROCESS` (no console at all), `windowsHide`
// only hides the one there is, and `shell` would be a shell. `CREATE_NEW_CONSOLE` gives the program a window of
// its own, started by its absolute path (never a `PATH` search) with the command line it reads back. Nothing of
// ours goes with it: no handle is inherited, no job assigned (the runner's containment is what a sign-in must
// escape), and the two handles the call returns are closed at once. The environment is the one given, as a
// block of its own (never this process's): `Name=Value` strings, sorted without case as Windows wants them.
import { dlopen, FFIType, ptr } from "bun:ffi";

/** `CreateProcessW`: the new process gets a console window of its own instead of its parent's. */
export const CREATE_NEW_CONSOLE = 0x00000010;
/** `CreateProcessW`: the environment block given is UTF-16. */
export const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
// STARTUPINFOW on x64 and arm64: 104 bytes, `cb` first. PROCESS_INFORMATION: 24 bytes, the two handles then the
// process id at byte 16.
const STARTUPINFO_SIZE = 104;
const PROCESS_INFORMATION_SIZE = 24;
const PROCESS_ID_OFFSET = 16;

/** What is started: the program, its whole command line, where, its whole environment, and the creation flags. */
export interface ConsoleStart {
  executable: string;
  commandLine: string;
  cwd: string;
  env: Record<string, string>;
  creationFlags: number;
}

/**
 * A window opened on the program, or why not: what `openTerminal` answers on every platform; with Windows' error
 * code when `CreateProcessW` refused.
 */
export type TerminalOpened =
  | { opened: true; pid: number }
  | { opened: false; reason: string; error?: number };

/**
 * One argument as the Windows C runtime's `CommandLineToArgvW` reads it back: bare when nothing in it would
 * split or quote, else in double quotes, with a quote escaped by a backslash and the backslashes before a
 * quote (or the closing one) doubled. The same rule libuv applies for `spawn`.
 */
function quoted(arg: string): string {
  if (arg === "") return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += `${"\\".repeat(backslashes * 2 + 1)}"`;
    } else {
      out += `${"\\".repeat(backslashes)}${ch}`;
    }
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** `words` as one Windows command line, each read back by the C runtime as it is. */
export const commandLineOf = (words: string[]): string => words.map(quoted).join(" ");

type Kernel32 = ReturnType<typeof loadKernel32>;
/** The binding, made on the first window and kept; never at import, which runs on every platform. */
let kernel32: Kernel32 | undefined;

function loadKernel32() {
  return dlopen("kernel32.dll", {
    CreateProcessW: {
      args: [
        FFIType.ptr, // lpApplicationName
        FFIType.ptr, // lpCommandLine
        FFIType.ptr, // lpProcessAttributes
        FFIType.ptr, // lpThreadAttributes
        FFIType.i32, // bInheritHandles
        FFIType.u32, // dwCreationFlags
        FFIType.ptr, // lpEnvironment
        FFIType.ptr, // lpCurrentDirectory
        FFIType.ptr, // lpStartupInfo
        FFIType.ptr, // lpProcessInformation
      ],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
}

/** `text` as a null-terminated UTF-16 string, the form every `W` call takes. */
function wide(text: string): Uint16Array {
  const out = new Uint16Array(text.length + 1);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/**
 * `env` as `CreateProcessW`'s UTF-16 environment block: each `Name=Value` null-terminated, sorted by name
 * without case, and one more null at the end.
 */
function environmentBlock(env: Record<string, string>): Uint16Array {
  const names = Object.keys(env).sort((a, b) => {
    const [x, y] = [a.toUpperCase(), b.toUpperCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return wide(names.map((name) => `${name}=${env[name]}\0`).join(""));
}

/** Starts `start` in a new console window; `opened: false` with the call's error when Windows refused. */
export function openConsoleWindow(start: ConsoleStart): TerminalOpened {
  kernel32 ??= loadKernel32();
  const k = kernel32;
  const application = wide(start.executable);
  // `lpCommandLine` is writable: the call may edit it in place.
  const commandLine = wide(start.commandLine);
  const cwd = wide(start.cwd);
  const environment = environmentBlock(start.env);
  const startupInfo = new Uint8Array(STARTUPINFO_SIZE);
  new DataView(startupInfo.buffer).setUint32(0, STARTUPINFO_SIZE, true);
  const processInformation = new Uint8Array(PROCESS_INFORMATION_SIZE);
  const created = k.CreateProcessW(
    ptr(application),
    ptr(commandLine),
    null,
    null,
    0,
    start.creationFlags,
    ptr(environment),
    ptr(cwd),
    ptr(startupInfo),
    ptr(processInformation),
  );
  if (created === 0) {
    const error = k.GetLastError();
    return { opened: false, reason: `CreateProcessW failed (error ${error})`, error };
  }
  const view = new DataView(processInformation.buffer);
  // The process and thread handles: closed, so the program is held by nothing of ours.
  k.CloseHandle(view.getBigUint64(0, true));
  k.CloseHandle(view.getBigUint64(8, true));
  return { opened: true, pid: view.getUint32(PROCESS_ID_OFFSET, true) };
}
