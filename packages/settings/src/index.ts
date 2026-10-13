// @lookover/settings: settings over their layers and the files that hold them (ADR 0011, ADR 0030, ADR 0033,
// ADR 0049).
// The decisions it hides: how layered settings merge, and how a layer is kept as a file. Lookover's defaults sit
// under the owner's layers (the owner's defaults, the owner's own value for one repository; later the repository
// file), and resolving says, for every key, what applies, where it comes from and what it overrode. Each owner's
// layer is a YAML file: `$schema: lookover.settings/v1`, `version: 1`, then only the keys it changes in a fixed
// order; a repository's file may also hold `rulesOff`, each rule switched off as its file and its text with the
// whitespace collapsed (contracts' `normalisedRuleText`, as the rule's id hashes it).
// Interface: `settingsFiles(files)` over the caller's file access gives a `SettingsRoom`: the owner's defaults alone
// (`readDefaults`, `setDefault`, `resetDefault`, no repository needed) and a repository's (`read`: both layers
// resolved, the ids of its rules switched off and `switchedOff` for a rule read since, each file that doesn't read;
// `set`, `reset`, `setRule`). Each change reads the files, changes one layer, writes or removes its file (nothing
// when the layer is unchanged), and answers the settings read again, or refuses. `resolve(layers)` and
// `settingValues` resolve layers given in memory. `settingAccepts(key, value)` is the check a file's values are read
// with, for a value from elsewhere.
// Ordering: the caller runs changes one after the other; each reads the files it needs when it runs. Layers given
// to `resolve` are lowest first (`owner-default` under `owner-repository`), each origin at most once; Lookover's
// defaults are always under them, never passed.
// Invariants: a layer stores only what it changes (a value equal to what the layer below gives is removed, and a
// layer left empty has its file removed); the origin of a value names a layer whose file holds it; a file that
// doesn't read is never written over.
// Error modes: a file that can't be read (the read rejects: a folder by its name, no permission), that isn't YAML,
// of another `$schema` or `version`, with a key that isn't a setting (or `rulesOff` in the owner's file) or a value
// its key doesn't accept is invalid: named in `invalid` as contracts' `SettingsFileError` (the file, the problem, the key or null), its layer counted as empty, and a change to it
// answered `{ ok: false, error }`. A failing `write` or `remove` throws through, for the caller to refuse. A rule the
// place doesn't list, the owner's own rule, or layers out of order to `resolve` are programming errors that throw.
// It must never know: the disk or a path's meaning (the caller names each file), the snapshot, events or `apply`,
// the service, the UI, or any word the screens say. It imports only @lookover/contracts and yaml, no node: or bun:
// module.
export type {
  OwnerSettings,
  RepositoryFiles,
  RepositorySettings,
  SettingsFiles,
  SettingsRoom,
  SettingsWrite,
} from "./files.ts";
export { settingAccepts, settingsFiles } from "./files.ts";
export { resolve, settingValues } from "./resolve.ts";
