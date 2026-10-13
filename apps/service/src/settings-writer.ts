// The settings writer (ADR 0049, ADR 0053): one for the room, over every repository it watches. The owner's
// defaults and each repository's settings as their files give them, read at start and after each change, and the
// changes `settings.set`, `repo.setSetting`, `repo.resetSetting` and `rule.setEnabled` make, one after the other
// whatever the repository, each reading the files it changes (`@lookover/settings` over the file port), so two quick
// clicks never lose one and the owner's file, shared by all, has one writer. What a decision reads (`now`) is what
// the files said last; what the UI hears is the room's to send.
import type {
  RepositoryId,
  RepositoryRef,
  ResolvedSettings,
  Rule,
  SettingKey,
  SettingsFileError,
  SettingsWriteFailure,
  SettingValues,
} from "@lookover/contracts";
import {
  type RepositoryFiles,
  type SettingsFiles,
  type SettingsWrite,
  settingsFiles,
} from "@lookover/settings";
import { OWNER_SETTINGS, repositorySettingsFile, SettingsUnwritten } from "./settings-files.ts";
import { repoIdOf } from "./snapshot.ts";

/** What applies to one repository, as its files said last. */
export interface RepositorySettingsNow {
  /** Its `Repository.settings`: its own values over the owner's defaults. */
  settings: ResolvedSettings;
  /** Whether its file switches this rule off (by its file and text): any rule, read before or since. */
  switchedOff(rule: Pick<Rule, "source" | "text">): boolean;
}

/** The settings as the files said them last. */
export interface SettingsNow {
  /** The owner's defaults over Lookover's: `State.settings`. */
  defaults: ResolvedSettings;
  /** What applies to each repository watched, by id. */
  repos: ReadonlyMap<RepositoryId, RepositorySettingsNow>;
  /** Each file that doesn't read, the owner's first, each once: Run checks' settings item. */
  invalid: SettingsFileError[];
}

/**
 * Why a change was refused: its layer's file doesn't read (and is never written over), the file couldn't be
 * written (`held-open` when Windows refused the rename, `other` otherwise), or the repository's
 * name is not one that may become a path.
 */
export type SettingsRefusal =
  | { refused: "invalid"; error: SettingsFileError }
  | { refused: "unwritten"; failure: SettingsWriteFailure }
  | { refused: "unnamed" }
  | { refused: "no_such_rule" };

export type SettingsChanged = { ok: true; before: SettingsNow; now: SettingsNow } | SettingsRefusal;

export interface SettingsWriter {
  /** The settings as the files said them at start or after the last change. */
  now(): SettingsNow;
  /**
   * The files read again, after the changes under way: what a repository the room watches since (ADR 0053) has in
   * its own file applies from now on. The settings as they now are.
   */
  reread(): Promise<SettingsNow>;
  /** `settings.set`: the owner's default for `key`. */
  setDefault<K extends SettingKey>(key: K, value: SettingValues[K]): Promise<SettingsChanged>;
  /** `repo.setSetting`: the repository's own value for `key`. */
  set<K extends SettingKey>(repo: RepositoryRef, key: K, value: SettingValues[K]): Promise<SettingsChanged>;
  /** `repo.resetSetting`: the owner's default applies again to the repository. */
  reset(repo: RepositoryRef, key: SettingKey): Promise<SettingsChanged>;
  /** `rule.setEnabled`: one of the repository's rules (by id, among `rules(repo)`) switched in its file. */
  setRule(repo: RepositoryRef, ruleId: string, enabled: boolean): Promise<SettingsChanged>;
}

interface SettingsWriterOptions {
  files: SettingsFiles;
  /** The repositories watched now: each read gives what applies to every one. */
  repos(): readonly RepositoryRef[];
  /** A repository's rules as the store keeps them now: what a rule's switch is matched against. */
  rules(repoId: RepositoryId): readonly Pick<Rule, "id" | "source" | "text">[];
}

/**
 * Reads the files once, and gives the writer that changes them. A file that can't be read (a folder by its name, no
 * permission) is an invalid layer like one that doesn't parse (`@lookover/settings`): reading never rejects, so the
 * service starts, and the read after a write always tells what the file now holds.
 */
export async function openSettings(o: SettingsWriterOptions): Promise<SettingsWriter> {
  const room = settingsFiles(o.files);
  const at = (repo: RepositoryRef, file: string): RepositoryFiles => ({
    owner: OWNER_SETTINGS,
    repository: file,
    rules: o.rules(repoIdOf(repo)),
  });
  /**
   * The owner's layer, then each repository's over it; a repository whose name is no path has the owner's alone.
   * Each repository's read reads the owner's file again: a handful of small files, and each read stands alone.
   */
  const read = async (): Promise<SettingsNow> => {
    const { defaults, invalid } = await room.readDefaults(OWNER_SETTINGS);
    const repos = new Map<RepositoryId, RepositorySettingsNow>();
    const named = new Set(invalid.map((error) => error.file));
    for (const repo of o.repos()) {
      const file = repositorySettingsFile(repo);
      if (file === null) {
        repos.set(repoIdOf(repo), { settings: defaults, switchedOff: () => false });
        continue;
      }
      const own = await room.read(at(repo, file));
      repos.set(repoIdOf(repo), { settings: own.settings, switchedOff: own.switchedOff });
      for (const error of own.invalid.filter((e) => !named.has(e.file))) {
        named.add(error.file);
        invalid.push(error);
      }
    }
    return { defaults, repos, invalid };
  };
  let now = await read();
  /** The changes and the reads again, one after the other: each reads the files once the one before has written them. */
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const done = queue.then(work, work);
    queue = done.catch(() => {});
    return done;
  };
  /** Runs one change: refused as its file says, or the settings read again. */
  const change = (write: () => Promise<SettingsWrite<unknown> | SettingsRefusal>): Promise<SettingsChanged> =>
    serially(async () => {
      const before = now;
      try {
        const answer = await write();
        if ("refused" in answer) return answer;
        if (!answer.ok) return { refused: "invalid", error: answer.error };
      } catch (error) {
        if (!(error instanceof SettingsUnwritten)) throw error;
        return { refused: "unwritten", failure: { file: error.file, why: error.why } };
      }
      // An owner's default can move every repository: all the layers are read again, whichever changed. The read
      // doesn't reject (an unreadable file is an invalid layer), so what is sent is what the files hold.
      now = await read();
      return { ok: true, before, now };
    });
  /** A change to the repository's own file: refused when its name is no path. */
  const own = (
    repo: RepositoryRef,
    write: (at: RepositoryFiles) => Promise<SettingsWrite<unknown> | SettingsRefusal>,
  ) =>
    change(() => {
      const file = repositorySettingsFile(repo);
      return file === null ? Promise.resolve({ refused: "unnamed" }) : write(at(repo, file));
    });
  return {
    now: () => now,
    reread: () =>
      serially(async () => {
        now = await read();
        return now;
      }),
    setDefault: (key, value) => change(() => room.setDefault(OWNER_SETTINGS, key, value)),
    set: (repo, key, value) => own(repo, (files) => room.set(files, key, value)),
    reset: (repo, key) => own(repo, (files) => room.reset(files, key)),
    // Matched against the rules kept when the change runs: a round may have just read others.
    setRule: (repo, ruleId, enabled) =>
      own(repo, (files) =>
        files.rules.some((rule) => rule.id === ruleId && rule.source !== "yours")
          ? room.setRule(files, ruleId, enabled)
          : Promise.resolve({ refused: "no_such_rule" as const }),
      ),
  };
}
