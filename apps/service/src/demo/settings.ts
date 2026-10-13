// Demo mode's settings files (ADR 0049): the real files in the room's folder, through the disk port live mode
// uses, with one lever the drawer pulls (`settings-unwritable`): from then on every write and every removal fails as
// Windows fails a rename onto a file another program holds open, until the scenario is loaded again (a new room).
// The world's planted values are written before the room starts, through the settings writer, as the owner's saves
// would write them: the owner's defaults first, so a repository value equal to them is never kept.
import type { RepositoryRef } from "@lookover/contracts";
import { type SettingsFiles, settingsFiles } from "@lookover/settings";
import {
  diskSettingsFiles,
  OWNER_SETTINGS,
  repositorySettingsFile,
  SettingsUnwritten,
} from "../settings-files.ts";
import type { World } from "./scenario.ts";

/** The room's settings files, and the lever that makes them unwritable. */
export interface DemoSettingsFiles {
  files: SettingsFiles;
  /** Every write and removal fails from now on, as a file held open by another program. */
  breakWrites(): void;
}

export function demoSettingsFiles(home: string): DemoSettingsFiles {
  const disk = diskSettingsFiles(home);
  let broken = false;
  const refused = (file: string) => Promise.reject(new SettingsUnwritten(file, "held-open"));
  return {
    files: {
      read: (file) => disk.read(file),
      write: (file, text) => (broken ? refused(file) : disk.write(file, text)),
      remove: (file) => (broken ? refused(file) : disk.remove(file)),
    },
    breakWrites: () => {
      broken = true;
    },
  };
}

/** The settings the world plants, written into `files`; a value the writer refuses is the fixture's mistake. */
export async function plantSettings(
  files: SettingsFiles,
  repo: RepositoryRef,
  planted: World["settings"],
): Promise<void> {
  if (planted === undefined) return;
  const room = settingsFiles(files);
  const failed = (key: string) => new Error(`The planted setting ${key} was refused`);
  for (const [key, value] of planted.defaults ?? []) {
    if (!(await room.setDefault(OWNER_SETTINGS, key, value)).ok) throw failed(key);
  }
  const repository = repositorySettingsFile(repo);
  if (repository === null) throw new Error(`${repo.owner}/${repo.name} can't have a settings file`);
  const at = { owner: OWNER_SETTINGS, repository, rules: [] };
  for (const [key, value] of planted.repository ?? []) {
    if (!(await room.set(at, key, value)).ok) throw failed(key);
  }
}
