// Settings with their origin (ADR 0030): for every key, the value that applies, where it comes from and what
// it overrode. v1 has three layers, from the bottom: Lookover's defaults, the owner's defaults, the owner's own
// value for one repository. Later layers (the repository file, presets, this review only) add an origin here.

export type Strictness = "recommended" | "blocking" | "everything";
export type Reviewers = "both" | "claude" | "codex";
/**
 * How many engine sessions a review may spend, per repository (ADR 0025, ADR 0044): `quick`, one find pass and
 * no confirm; `standard`, one find pass and the confirm pass (Lookover's default); `deep`, two find passes merged,
 * then the confirm pass.
 */
export type Depth = "quick" | "standard" | "deep";

/** One value per key: what a layer sets, or what the rules read once settings are resolved. */
export interface SettingValues {
  strictness: Strictness;
  reviewers: Reviewers;
  depth: Depth;
  onOpen: boolean;
  onPush: boolean;
}
export type SettingKey = keyof SettingValues;
export type SettingValue = SettingValues[SettingKey];

/** The layer a value comes from. */
export type SettingOrigin = "lookover-default" | "owner-default" | "owner-repository";

export interface ResolvedSetting<K extends SettingKey> {
  value: SettingValues[K];
  origin: SettingOrigin;
  /** What applies without this layer: the value and origin it overrode. Null for Lookover's default. */
  overrode: { value: SettingValues[K]; origin: SettingOrigin } | null;
}

/** Every key, resolved. */
export type ResolvedSettings = { [K in SettingKey]: ResolvedSetting<K> };

/**
 * Why a settings file doesn't read (ADR 0049): the file can't be opened (a folder by that name, no permission), not
 * YAML, a `version` Lookover doesn't know, a key that isn't a setting, or a value of the wrong type for its key.
 */
export type SettingsFileProblem = "unreadable" | "not_yaml" | "wrong_version" | "unknown_key" | "wrong_type";

/**
 * A settings file that doesn't read, as Run checks names it and a refused write says it (ADR 0049): the file, by
 * its path in the data folder (`settings.yaml`, `<owner>/<name>/settings.yaml`), why, and the key at fault
 * (`$schema` or `version` for a wrong version; null only for unreadable and not_yaml, when the file as a whole is at
 * fault).
 */
export interface SettingsFileError {
  file: string;
  problem: SettingsFileProblem;
  key: string | null;
}

/**
 * A settings file that couldn't be written (ADR 0049), as a refused write says it: the file, by its path in the data
 * folder, and why: `held-open` when the system refused to replace it (on Windows, another program has it open: an
 * editor, a virus scanner), `other` for any other failure (a full disk, no permission).
 */
export interface SettingsWriteFailure {
  file: string;
  why: "held-open" | "other";
}

/**
 * Why a settings command was refused when no file is at fault (ADR 0049), sent as the answer's `refused` beside its
 * `error` line, so the UI picks its words from the code, never from the line: the rule isn't in the rules files
 * (404), "Too noisy?" named a finding the pull request hasn't (404) or one that follows no rule (409), "This finding
 * is wrong" named one that is settled or kept off the pull request (409) or came while a round of the change runs
 * (409, ADR 0052), or the repository's name can't be a settings file's path (409, `con` on Windows).
 */
export type SettingsRefusal =
  | "no_such_rule"
  | "no_such_finding"
  | "no_rule"
  | "settled"
  | "reviewing"
  | "unnamed";
