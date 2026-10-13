// Files only the user who runs the service may open: the App store's (ADR 0053), above all the key kept unencrypted
// when the keychain can't keep it, `instance.json`, and the folders that hold the logs (ADR 0054). Elsewhere the mode,
// 0600 (a folder's 0700). On Windows the mode only toggles read-only and a
// new file inherits its folder's access list, so the list is replaced by one entry: the current user, by SID, full
// control (`icacls`). Two short programs, run directly rather than through the process runner, which is for long
// supervised ones.
import { execFile } from "node:child_process";
import { chmod, stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

let sid: Promise<string> | null = null;

/**
 * The current user's SID, from Windows' own `whoami` by its full path (`cmd` expands `%SystemRoot%`): Git's
 * `whoami`, earlier on many PATHs, prints a name only.
 */
function currentSid(): Promise<string> {
  sid ??= run("cmd.exe", ["/d", "/c", "%SystemRoot%\\System32\\whoami.exe", "/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
  })
    .then(({ stdout }) => {
      const found = /"(S-1-[\d-]+)"/.exec(stdout)?.[1];
      if (found === undefined) throw new Error(`whoami printed no SID: ${stdout.trim()}`);
      return found;
    })
    .catch((error: unknown) => {
      sid = null; // Asked again next time.
      throw error;
    });
  return sid;
}

/**
 * Leaves `path` readable and writable by the current user only; throws when it can't. A folder (ADR 0054: the data
 * folder, its logs) is the user's to open too (0700), and on Windows passes its one entry on to what it holds, so a
 * file made in it later is the user's alone as well.
 */
export async function makeUserOnly(path: string): Promise<void> {
  const folder = (await stat(path)).isDirectory();
  if (process.platform !== "win32") {
    await chmod(path, folder ? 0o700 : 0o600);
    return;
  }
  const user = await currentSid();
  const access = folder ? "(OI)(CI)F" : "F";
  await run("icacls", [path, "/inheritance:r", "/grant:r", `*${user}:${access}`], { windowsHide: true });
}
