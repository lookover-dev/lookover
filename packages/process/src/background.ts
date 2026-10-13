// @lookover/process/background: the service started in the background, process's third entry, for its one caller,
// `lookover start` (ADR 0054), and the browser opened on its link. What it gives: `startInBackground(invocation,
// platform?, create?)` starts a program that outlives the terminal it was started from, with no console, no window
// and nothing of ours: no handle, no pipe, its output going nowhere (the service writes its log itself). It answers
// once the start is known, `{ started: true, pid, inTerminalJob }` or `{ started: false, reason }`, never a throw,
// and never waits for the program. On Windows it is `CreateProcessW` (`console-window.ts`) with `DETACHED_PROCESS`
// (no console), `CREATE_NO_WINDOW` and `CREATE_BREAKAWAY_FROM_JOB` (out of the terminal's job, which would kill it
// when the terminal closes); a job that forbids breaking away refuses that (ERROR_ACCESS_DENIED, and only then),
// and the start is made again inside the job, `inTerminalJob` saying so, for the caller to warn that closing the
// terminal may stop it. `create` is the call, a fake in tests. Elsewhere a shell in a session of its own starts it
// and ends at once (`spawnDetached`), so the program outlives its starter, even under Bun's no-orphans.
// `openInBrowser(url, platform?)` hands a URL to the system's browser (`browserCommand`, as data, is what it starts)
// and says whether it could.
// `commandLineOf(words)` is the one Windows command line the C runtime reads back as `words`, for start at login's
// `Run` value, which runs the same program at login.
// It must never know: what the program is, the service, the data folder.
import { spawn } from "node:child_process";
import {
  type ConsoleStart,
  CREATE_UNICODE_ENVIRONMENT,
  commandLineOf,
  openConsoleWindow,
  type TerminalOpened,
} from "./console-window.ts";

export { commandLineOf };

/** `CreateProcessW`: no console at all, neither the parent's nor one of its own. */
const DETACHED_PROCESS = 0x00000008;
/** `CreateProcessW`: out of the job the parent runs in, when the job allows it. */
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
/** `CreateProcessW`: no console window, for a program that would make one. */
const CREATE_NO_WINDOW = 0x08000000;
/** What `CreateProcessW` says when the job forbids breaking away. */
const ERROR_ACCESS_DENIED = 5;

/** What is started: a program by absolute path with its arguments, from `cwd`, with `env` as its whole environment. */
export interface BackgroundInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** What Windows is asked to start: the program, its whole command line, where, its environment, the flags. */
export type BackgroundStart = ConsoleStart;

/** Started, with its id, and whether it is still in the terminal's job (Windows only); or why not. */
export type BackgroundStarted =
  | { started: true; pid: number; inTerminalJob: boolean }
  | { started: false; reason: string };

/** Starts `invocation` in the background on `platform` (this one by default); `create` is Windows' call. */
export async function startInBackground(
  invocation: BackgroundInvocation,
  platform: NodeJS.Platform = process.platform,
  create: (start: BackgroundStart) => TerminalOpened = openConsoleWindow,
): Promise<BackgroundStarted> {
  if (platform !== "win32") return await spawnDetached(invocation);
  const start = (flags: number) =>
    create({
      executable: invocation.executable,
      commandLine: commandLineOf([invocation.executable, ...invocation.args]),
      cwd: invocation.cwd,
      env: invocation.env,
      creationFlags: DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | flags,
    });
  const out = start(CREATE_BREAKAWAY_FROM_JOB);
  if (out.opened) return { started: true, pid: out.pid, inTerminalJob: false };
  // Refused for anything else, the start inside the job would fail the same and hide why.
  if (out.error !== ERROR_ACCESS_DENIED) return { started: false, reason: out.reason };
  // A job without JOB_OBJECT_LIMIT_BREAKAWAY_OK refuses the whole start: started again inside it.
  const inside = start(0);
  if (inside.opened) return { started: true, pid: inside.pid, inTerminalJob: true };
  return { started: false, reason: inside.reason };
}

/**
 * What `/bin/sh` runs for POSIX, `$1` the program and the rest its arguments, each a word the shell never reads:
 * exit 127 when the program isn't an executable file; else the program started in the background with nothing on
 * its standard streams, and its id printed.
 */
const DETACH = '[ -f "$1" ] && [ -x "$1" ] || exit 127; "$@" </dev/null >/dev/null 2>&1 & echo $!';

/**
 * POSIX: a shell in a session of its own starts the program and ends at once, so the program's parent is the
 * system's, never the starter. Not the program spawned detached itself: under Bun's no-orphans (an agent's shell,
 * `bunfig.toml`'s `noOrphans`), Linux ends a Bun process's children with it, whatever their session and
 * environment (#333). The id is the program's, as the shell printed it. A background job of a non-interactive
 * shell starts with SIGINT and SIGQUIT ignored, and so do the programs it starts: the service sets its own SIGINT
 * handler, and stops engines with SIGKILL, so neither relies on them.
 */
function spawnDetached(invocation: BackgroundInvocation): Promise<BackgroundStarted> {
  return new Promise((resolve) => {
    let shell: ReturnType<typeof spawn>;
    try {
      shell = spawn("/bin/sh", ["-c", DETACH, "sh", invocation.executable, ...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      resolve({ started: false, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    let printed = "";
    shell.stdout?.on("data", (chunk) => {
      printed += chunk;
    });
    // Kept on, not `once`: an error after the start must never be unhandled.
    shell.on("error", (error) => resolve({ started: false, reason: error.message }));
    shell.once("close", (code) => {
      const pid = Number(printed.trim());
      if (code === 0 && Number.isInteger(pid) && pid > 0)
        resolve({ started: true, pid, inTerminalJob: false });
      else if (code === 127)
        resolve({ started: false, reason: `${invocation.executable} isn't a program that runs` });
      else if (code === 0) resolve({ started: false, reason: "the shell that starts it gave no process id" });
      else resolve({ started: false, reason: `the shell that starts it exited ${code}` });
    });
  });
}

/**
 * What opens `url` in the user's browser on `platform`: never a shell, which would read the URL's `&`. Windows'
 * URL handler, macOS's `open`, the desktop's `xdg-open` elsewhere.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
): { executable: string; args: string[] } {
  if (platform === "win32") return { executable: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { executable: "/usr/bin/open", args: [url] };
  return { executable: "xdg-open", args: [url] };
}

/** Opens `url` in the user's browser; false when the opener couldn't start. Never throws. */
export async function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const command = browserCommand(url, platform);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.executable, command.args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
