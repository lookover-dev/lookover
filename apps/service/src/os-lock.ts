// An OS-held lock (ADR 0054, exploration 14): a SQLite file in exclusive locking mode, taken by a write at once.
// The system holds it for the connection, and releases it however the process ends, a kill included: no process id
// is ever trusted, since Windows reuses them. The connection is kept referenced for as long as the lock is held,
// or the garbage collector closes it and drops the lock (seen under Bun in exploration 14). A second opener is
// refused, in another process or in this one. Its journal is kept in memory, so a kill leaves no `-journal` file
// beside the lock. The probe reads, which never takes the lock: it is refused while the lock is held, and lets go at
// once while it is free; a hot journal some other writer left (one a read-only opener can't roll back) is free too.
// The instance lock and the live lock each keep a file naming their holder beside it (`takeLockNamed`).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/** A lock this process holds, until `release`. */
export interface OsLock {
  readonly file: string;
  /** Lets the lock go; once. */
  release(): void;
}

/** The connections holding a lock: referenced here, so none is collected while its lock is held. */
const held = new Set<Database>();

/** How long a take waits for a probe's read to end: a probe holds the file a few microseconds. */
const PROBE_WAIT_MS = 200;

/** Takes the lock on `file` (made, with its folder, when absent); null when another opener holds it. */
function takeOsLock(file: string): OsLock | null {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  try {
    db.exec(`pragma busy_timeout = ${PROBE_WAIT_MS}`);
    db.exec("pragma locking_mode = exclusive");
    db.exec("pragma journal_mode = memory");
    db.exec("create table if not exists held (n integer)");
    db.exec("begin exclusive; delete from held; insert into held values (1); commit");
  } catch (error) {
    db.close();
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") return null;
    throw error;
  }
  held.add(db);
  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      held.delete(db);
      db.close();
    },
  };
}

/** What `holderOf` reads: the JSON in a holder file, when it has the holder's shape. */
export type IsHolder<T> = (value: unknown) => value is T;

/** The holder `file` names; null when it is absent, half gone or not of the holder's shape. */
export function holderOf<T>(file: string, isHolder: IsHolder<T>): T | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isHolder(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock on `lockFile` with `holderFile` beside it, the JSON naming its holder for whoever is refused: the
 * lock, or the holder the file names (null when it names none) when another opener holds it. The file is trusted
 * only while the lock is held: one a crash left behind is removed as the lock is taken, so whoever waits for it
 * reads only the new holder's, which the caller puts in place whole (`whole-file.ts`); `release` removes it while
 * the lock is still held, so it is never another holder's file, then lets the lock go.
 */
export function takeLockNamed<T>(
  lockFile: string,
  holderFile: string,
  isHolder: IsHolder<T>,
): { lock: OsLock } | { lock: null; holder: T | null } {
  const lock = takeOsLock(lockFile);
  if (lock === null) return { lock: null, holder: holderOf(holderFile, isHolder) };
  rmSync(holderFile, { force: true });
  let released = false;
  return {
    lock: {
      file: lockFile,
      release() {
        if (released) return;
        released = true;
        rmSync(holderFile, { force: true });
        lock.release();
      },
    },
  };
}

/** Whether another opener holds the lock on `file`, without taking it. A file that doesn't exist is free. */
export function osLockHeld(file: string): boolean {
  if (!existsSync(file)) return false;
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    db.exec("pragma busy_timeout = 0");
    db.query("select count(*) from sqlite_master").get();
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "SQLITE_BUSY") return true;
      // A hot journal and nobody holding the file: the next take rolls it back.
      if (error.code === "SQLITE_READONLY_ROLLBACK") return false;
    }
    throw error;
  } finally {
    db?.close();
  }
}
