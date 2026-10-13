// "Run all checks" (ADR 0047): what each check found, as data the UI words (`CheckItem`, never a sentence). The
// engines as the UI shows them once their health was read again (the queue's "Check again" does the reading and
// sends what changed), the connection as of the last listing, the service, the settings files that don't read
// (ADR 0049), the data folder's free space, and the
// version, never checked against a newer one before publication (`upToDate: null`).
import { statfs } from "node:fs/promises";
import type { CheckItem, EngineId, KeyProtection, SettingsFileError, State } from "@lookover/contracts";

/** What the items read of the UI's state. */
type Checked = Pick<State, "engines" | "connection" | "service">;

/** The data folder's free space in whole gigabytes (decimal, as the vendors label disks), as the machine has it. */
export async function freeGbOf(dir: string): Promise<number> {
  const { bavail, bsize } = await statfs(dir);
  return Math.floor((bavail * bsize) / 1e9);
}

/** One engine's item: its state, program and version as the UI shows them. */
const engineItem = (engines: State["engines"], id: EngineId): CheckItem => {
  const { state, cli, version, unusable } = engines[id];
  return { check: "engine", engine: id, state, cli, version, unusable };
};

/**
 * The checks' items, in the order the status menu lists them. `invalid`: each settings file that doesn't read, as
 * the settings writer last read them (ADR 0049). `freeGb` null when the folder's space couldn't be read (an odd
 * mount): the disk is then not reported rather than reported wrong. `key`: how the App's key is kept (ADR 0053),
 * null when Lookover keeps none (`live.json`'s is read where it is).
 */
export function checkItems(
  shown: Checked,
  invalid: SettingsFileError[],
  freeGb: number | null,
  key: KeyProtection | null,
): CheckItem[] {
  const { engines, connection, service } = shown;
  return [
    engineItem(engines, "claude"),
    engineItem(engines, "codex"),
    { check: "connection", state: connection.state, cause: connection.cause, bot: connection.bot, key },
    {
      check: "service",
      state: "running",
      startAtLogin: service.startAtLogin,
      startsAtLogin: service.startsAtLogin,
      loginItem: service.loginItem,
    },
    { check: "settings", invalid },
    ...(freeGb === null ? [] : [{ check: "disk", freeGb } as const]),
    { check: "version", version: service.version, upToDate: null },
  ];
}
