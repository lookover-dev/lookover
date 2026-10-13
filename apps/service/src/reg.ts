// Windows' `reg.exe`, called directly (ADR 0054, ADR 0058): what start at login and `lookover` on the PATH read and
// write the current user's registry with. Never `setx` (it cuts and expands), never .NET's setter (it rewrites the
// type). One value read here: its type and data as `reg query` prints them, or none.
import { execFile } from "node:child_process";
import { join } from "node:path";

/** What `reg.exe` answered: its exit code and what it printed. */
export interface RegAnswer {
  code: number;
  out: string;
  err: string;
}

/** `reg.exe` with its arguments, or a test's stand-in answering as it would. */
export type Reg = (args: string[]) => Promise<RegAnswer>;

/** Windows' own `reg.exe`, by its full path: never another `reg` earlier on the PATH. */
export function realReg(env: Record<string, string | undefined>): Reg {
  const reg = join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "reg.exe");
  return (args) =>
    new Promise((done) => {
      execFile(reg, args, { windowsHide: true }, (error, out, err) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        done({ code, out, err: err || (error === null ? "" : error.message) });
      });
    });
}

/** What `reg.exe` said went wrong, in one line. */
export const regError = (answer: RegAnswer): Error =>
  new Error(`reg.exe refused: ${(answer.err || answer.out).trim().replace(/^ERROR:\s*/, "")}`);

/** A registry value as `reg query` shows it: its type (`REG_SZ`, `REG_EXPAND_SZ`, …) and its data. */
export interface RegValue {
  type: string;
  data: string;
}

/**
 * The value `name` of `key`; null when there is none. A failed query is no such value only when the key itself reads
 * (`reg.exe`'s own words are in the user's language): any other failure is thrown, with why, and so is an answer
 * holding no row of `name` Lookover can read. A name matches in any case, as Windows' own (`PATH` is `Path`):
 * `reg.exe` prints it as it is stored.
 */
export async function regValue(reg: Reg, key: string, name: string): Promise<RegValue | null> {
  const answer = await reg(["query", key, "/v", name]);
  if (answer.code !== 0) {
    if ((await reg(["query", key])).code === 0) return null;
    throw regError(answer);
  }
  for (const row of answer.out.split(/\r?\n/)) {
    const found = /^\s+(.+?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/.exec(row);
    if (found?.[1]?.toLowerCase() === name.toLowerCase())
      return { type: found[2] ?? "REG_SZ", data: found[3] ?? "" };
  }
  // Answered, yet no row Lookover could read: never taken as empty, which a write would then put in its place.
  throw new Error(`reg.exe showed ${name} in a way Lookover couldn't read: it leaves it as it is.`);
}
