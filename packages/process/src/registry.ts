// The registry: every pid started and not yet ended, with the OS's creation time of that pid, in one JSON
// file rewritten whole at each change and read again at each use, so what a crashed run wrote is what the
// next run reads. Its shape is part of the leaf's interface (see `index.ts`): a reused pid shows a different
// creation time and is left alone.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface RegistryEntry {
  pid: number;
  /** The OS's creation time of `pid`, opaque; null when it couldn't be read, which never matches. */
  created: string | null;
}

export interface Registry {
  add(entry: RegistryEntry): void;
  remove(pid: number): void;
  /**
   * Drops a program that ended, if the file can be written: false when it can't. The entry left is harmless, since
   * the next sweep finds its pid gone or reused (another creation time).
   */
  ended(pid: number): boolean;
  list(): RegistryEntry[];
}

function isEntry(value: unknown): value is RegistryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "created" in value &&
    (typeof value.created === "string" || value.created === null)
  );
}

/** The entries in the file's text; a file a crash left half-written holds none worth sweeping. */
function parse(text: string): RegistryEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  return Array.isArray(value) ? value.filter(isEntry) : [];
}

export function openRegistry(file: string): Registry {
  const read = (): RegistryEntry[] => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      // No file yet: nothing was ever started.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return parse(text);
  };
  const write = (entries: RegistryEntry[]) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entries));
  };
  return {
    add: (entry) => write([...read().filter((e) => e.pid !== entry.pid), entry]),
    remove: (pid) => write(read().filter((e) => e.pid !== pid)),
    ended: (pid) => {
      try {
        write(read().filter((e) => e.pid !== pid));
        return true;
      } catch {
        return false;
      }
    },
    list: read,
  };
}
