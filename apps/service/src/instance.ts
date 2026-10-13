// One service per data folder (ADR 0054). The serving process holds the OS-held lock `<home>/instance.lock`
// (`os-lock.ts`), taken before anything else; a second start on the folder is refused while it is held, and starts
// once its holder stopped or died, whatever process id the system reuses. Once serving, `<home>/instance.json` says
// who serves the folder (process, port, address, version, since), user-only, and is removed at a clean stop; it is
// trusted only while the lock is held, so one a crash left behind is ignored and replaced. `<home>/port` keeps the
// port served last, tried first at the next start. The probe tells held from free without taking the lock.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holderOf, osLockHeld, takeLockNamed } from "./os-lock.ts";
import { writeWholeUserOnly } from "./whole-file.ts";

/** Another service serves this data folder; the message says which, and what to do. */
export class InstanceHeld extends Error {
  override readonly name = "InstanceHeld";
}

/** What `instance.json` says of the service serving the data folder. */
export interface Serving {
  pid: number;
  port: number;
  /** Its own origin, `http://127.0.0.1:<port>`. */
  address: string;
  version: string;
  /** When it started serving, in ms since the epoch. */
  since: number;
}

/** The data folder's instance, held by this process. */
export interface Instance {
  /** Writes `instance.json` (made user-only by `userOnly` before it is put in place) and the port kept. */
  announce(serving: Serving): Promise<void>;
  /** Removes `instance.json`, then lets the lock go; once. */
  release(): void;
}

const lockFile = (home: string) => join(home, "instance.lock");
const servingFile = (home: string) => join(home, "instance.json");
const portFile = (home: string) => join(home, "port");

const isServing = (value: unknown): value is Serving =>
  typeof value === "object" &&
  value !== null &&
  ["pid", "port", "since"].every((key) => typeof Reflect.get(value, key) === "number") &&
  ["address", "version"].every((key) => typeof Reflect.get(value, key) === "string");

/**
 * What `instance.json` says; null when it is absent, half gone or not ours. Trusted only while the lock is held
 * (`probeInstance`): a crash leaves it behind.
 */
export const servingOf = (home: string): Serving | null => holderOf(servingFile(home), isServing);

/** Takes the data folder's instance lock, or throws `InstanceHeld` naming the service that holds it. */
export function takeInstance(home: string, userOnly: (path: string) => Promise<void>): Instance {
  const taken = takeLockNamed(lockFile(home), servingFile(home), isServing);
  if (taken.lock === null) {
    const serving = taken.holder;
    const who =
      serving === null
        ? ""
        : `: process ${serving.pid} at ${serving.address} since ${new Date(serving.since).toISOString()}`;
    throw new InstanceHeld(
      `Another Lookover runs on this data folder (${home})${who}. Stop it before starting another, or pass ` +
        "another --home.",
    );
  }
  // One a crash left was removed as the lock was taken: whoever waits for it never reads the dead service's address.
  const { lock } = taken;
  return {
    async announce(serving) {
      await writeWholeUserOnly(servingFile(home), JSON.stringify(serving, null, 2), userOnly);
      writeFileSync(portFile(home), String(serving.port));
    },
    release: () => lock.release(),
  };
}

/** Whether a service holds the data folder's instance lock, without taking it. */
export function probeInstance(home: string): "held" | "free" {
  return osLockHeld(lockFile(home)) ? "held" : "free";
}

/** The port the data folder's service served last; undefined when none is kept, or the file holds no port. */
export function keptPort(home: string): number | undefined {
  try {
    const text = readFileSync(portFile(home), "utf8").trim();
    const port = Number(text);
    return /^\d+$/.test(text) && port > 0 && port < 65_536 ? port : undefined;
  } catch {
    return undefined;
  }
}
