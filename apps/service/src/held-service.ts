// A service started in-process, held on its data folder as `runService` holds the program's (ADR 0054): `bun run live`
// starts its own through `startService`, and holds it with this, so `lookover open --home`, `status --home` and
// `stop --home` reach it like any other. The instance lock is taken before the start, `instance.json` written once it
// serves, and both let go at its stop: the crash step's restart, on the same folder, takes them again. A stop asked
// through the service (`lookover stop`, `API.stop`) is the same held stop, so the folder is let go, never left held
// for `stop` to end the whole process.
import { takeInstance } from "./instance.ts";
import type { RunningService } from "./service.ts";
import { makeUserOnly } from "./user-only.ts";
import { VERSION } from "./version.ts";

export interface HeldServiceOptions {
  /** The data folder the service serves. */
  home: string;
  /** The process that serves it, as `instance.json` names it. */
  pid: number;
  clock: { now(): number };
  /** Leaves `instance.json` to the user alone; `makeUserOnly` by default. */
  userOnly?: (path: string) => Promise<void>;
  /**
   * Starts the service, once the folder is held. `stopAsked` is what its `API.stop` must run (`startService`'s
   * `stopAsked`): the held stop.
   */
  start(stopAsked: () => void): Promise<RunningService>;
  /**
   * Told when a stop asked through the service is under way; `stopped` settles once the service stopped and the folder
   * is free. Its rejection is the caller's to handle.
   */
  stopAsked?: (stopped: Promise<void>) => void;
}

/**
 * Takes `home`'s instance lock (throwing `InstanceHeld`, nothing started, when another service holds it), starts the
 * service, and announces it there. A start or an announce that fails leaves the folder free. The running service's
 * stop, whether called or asked through the service, stops it once, then lets the folder go.
 */
export async function heldService(o: HeldServiceOptions): Promise<RunningService> {
  const instance = takeInstance(o.home, o.userOnly ?? makeUserOnly);
  let held: RunningService | undefined;
  // A stop asked before the start returned is kept, and done then.
  let askedEarly = false;
  const asked = () => {
    if (held === undefined) {
      askedEarly = true;
      return;
    }
    const stopped = held.stop();
    if (o.stopAsked) o.stopAsked(stopped);
    else stopped.catch(() => {});
  };
  let service: RunningService | undefined;
  try {
    service = await o.start(asked);
    await instance.announce({
      pid: o.pid,
      port: service.port,
      address: service.origin,
      version: VERSION,
      since: o.clock.now(),
    });
  } catch (error) {
    // Stopped before the lock goes: none serves the folder unlocked. The lock goes even when that stop fails.
    try {
      await service?.stop();
    } catch {
      // The start's or the announce's error is the one thrown.
    } finally {
      instance.release();
    }
    throw error;
  }
  const started = service;
  let stopping: Promise<void> | null = null;
  held = {
    ...started,
    stop: () => {
      stopping ??= (async () => {
        try {
          await started.stop();
        } finally {
          instance.release();
        }
      })();
      return stopping;
    },
  };
  if (askedEarly) asked();
  return held;
}

/** What a held service's start prints: its address and folder, and the link that opens it once, when it made one. */
export const heldLines = (service: Pick<RunningService, "origin" | "openUrl">, home: string): string[] => [
  `service: ${service.origin} on ${home}`,
  ...(service.openUrl === null ? [] : [`Open the app: ${service.openUrl}`]),
];
