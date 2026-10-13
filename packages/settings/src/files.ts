// The layer files (ADR 0011, ADR 0049, I-166): the owner's defaults and a repository's own values, each a YAML file
// holding `$schema` and `version`, then only the keys the layer changes, in their fixed order; a repository's file
// may also hold `rulesOff`, the rules switched off by their file and their normalised text. Reading is strict: a file
// that isn't YAML, of another version, with a key that isn't a setting or a value its key doesn't accept is invalid,
// named with the key at fault, counted as empty and never written over. File access is the caller's.
import type {
  Depth,
  ResolvedSettings,
  Reviewers,
  Rule,
  RulesFileName,
  SettingKey,
  SettingsFileError,
  SettingsFileProblem,
  SettingsLayer,
  SettingValue,
  SettingValues,
  Strictness,
} from "@lookover/contracts";
import { normalisedRuleText, RULES_FILES } from "@lookover/contracts";
import { parse, stringify } from "yaml";
import { KEYS, resolve, withSetting } from "./resolve.ts";

/** Every layer file opens with these. The format is versioned as a whole: a new version is a new reader. */
const LAYER_SCHEMA = "lookover.settings/v1";
const LAYER_VERSION = 1;
const RULES_OFF = "rulesOff";

/**
 * How the leaf reaches the files: given by the caller, who owns the data folder and names each file by its path in
 * it. `read` gives `null` when there is no such file, and a read that rejects makes the file invalid (`unreadable`);
 * a failing `write` or `remove` throws, and the leaf lets it.
 */
export interface SettingsFiles {
  read(file: string): Promise<string | null>;
  write(file: string, text: string): Promise<void>;
  remove(file: string): Promise<void>;
}

/** A rule as a repository's settings know it: its id, its file and its text, as the store keeps it. */
type KnownRule = Pick<Rule, "id" | "source" | "text">;

/**
 * One repository's two layer files, by their paths in the data folder (the owner's defaults, the repository's own
 * values), and the rules the repository has now: what a rule switch is matched against.
 */
export interface RepositoryFiles {
  owner: string;
  repository: string;
  rules: readonly KnownRule[];
}

/** One repository's settings as its files give them. */
export interface RepositorySettings {
  /** The owner's defaults over Lookover's: what applies to a repository with no value of its own. */
  defaults: ResolvedSettings;
  /** What applies to this repository, each value with its origin and what it overrode. */
  settings: ResolvedSettings;
  /** The ids, among the place's rules, of those switched off. */
  rulesOff: ReadonlySet<string>;
  /**
   * Whether the repository's file switches this rule off, by its file and its text: for a rule read after the files
   * were, which `rulesOff` can't name.
   */
  switchedOff(rule: Pick<Rule, "source" | "text">): boolean;
  /** Each file that doesn't read, owner's first; its layer counted as empty. */
  invalid: SettingsFileError[];
}

/** The owner's defaults as their file gives them, with no repository. */
export interface OwnerSettings {
  /** The owner's defaults over Lookover's: what applies to a repository with no value of its own. */
  defaults: ResolvedSettings;
  /** The owner's file when it doesn't read; its layer counted as empty. */
  invalid: SettingsFileError[];
}

/**
 * A change's answer: the settings read again (`OwnerSettings` for the owner's defaults, `RepositorySettings` for a
 * repository's own values), or the change refused because its layer's file doesn't read.
 */
export type SettingsWrite<T> = { ok: true; now: T } | { ok: false; error: SettingsFileError };

/**
 * The settings over their files. Every call reads the files it needs when it runs, so the caller runs the changes
 * one after the other and each reads what the one before wrote. A change that leaves its layer as it was writes
 * nothing; a layer left with nothing has its file removed.
 */
export interface SettingsRoom {
  /** The owner's defaults, with no repository: `settings.set` and the snapshot's own settings. */
  readDefaults(owner: string): Promise<OwnerSettings>;
  /** Sets `key` in the owner's defaults; Lookover's default value is removed, not kept. */
  setDefault<K extends SettingKey>(
    owner: string,
    key: K,
    value: SettingValues[K],
  ): Promise<SettingsWrite<OwnerSettings>>;
  /** Removes `key` from the owner's defaults: Lookover's default applies. */
  resetDefault(owner: string, key: SettingKey): Promise<SettingsWrite<OwnerSettings>>;
  /** Both layers of a repository resolved, its rules' switches, and each file that doesn't read. */
  read(at: RepositoryFiles): Promise<RepositorySettings>;
  /** Sets `key` in the repository's own values; a value equal to the owner's default for it is removed, not kept. */
  set<K extends SettingKey>(
    at: RepositoryFiles,
    key: K,
    value: SettingValues[K],
  ): Promise<SettingsWrite<RepositorySettings>>;
  /** Removes `key` from the repository's own values: the owner's default applies, with its origin. */
  reset(at: RepositoryFiles, key: SettingKey): Promise<SettingsWrite<RepositorySettings>>;
  /**
   * Switches one of the repository's rules on or off in its file, and drops the lines that match none of `at.rules`
   * any more. A rule `at.rules` doesn't list, or the owner's own, is a programming error: the promise rejects.
   */
  setRule(at: RepositoryFiles, ruleId: string, enabled: boolean): Promise<SettingsWrite<RepositorySettings>>;
}

/** The layers a change may write: the owner's own. */
type OwnerOrigin = "owner-default" | "owner-repository";

/** A rule switched off, as its line in a repository's file: its file and its normalised text. */
interface RuleOff {
  file: RulesFileName;
  text: string;
}

/** A layer as its file holds it. */
interface Layer {
  values: Partial<SettingValues>;
  rulesOff: RuleOff[];
}

const EMPTY: Layer = { values: {}, rulesOff: [] };

/** Accepts every value of the union `T`, and only those: `all` must list each one, so the compiler names a missing value. */
const oneOf =
  <T extends string>(all: Record<T, null>) =>
  (value: unknown): value is T =>
    typeof value === "string" && Object.hasOwn(all, value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** What each key accepts: the one place the file's values are checked. A new key in contracts is added here. */
const ACCEPTS: { [K in SettingKey]: (value: unknown) => value is SettingValues[K] } = {
  strictness: oneOf<Strictness>({ recommended: null, blocking: null, everything: null }),
  reviewers: oneOf<Reviewers>({ both: null, claude: null, codex: null }),
  depth: oneOf<Depth>({ quick: null, standard: null, deep: null }),
  onOpen: isBoolean,
  onPush: isBoolean,
};

/**
 * Whether `value` is one `key` accepts: the check a file's values are read with, for a value that comes from
 * elsewhere (the service's commands), so the two never drift.
 */
export function settingAccepts(key: SettingKey, value: unknown): value is SettingValue {
  return ACCEPTS[key](value);
}

const isRulesFile = (value: unknown): value is RulesFileName => RULES_FILES.some((file) => file === value);

function isMapping(doc: unknown): doc is Record<string, unknown> {
  return typeof doc === "object" && doc !== null && !Array.isArray(doc);
}

function isRuleOff(entry: unknown): entry is RuleOff {
  if (!isMapping(entry)) return false;
  const { file, text, ...rest } = entry;
  return isRulesFile(file) && typeof text === "string" && Object.keys(rest).length === 0;
}

/** Why a file doesn't read, thrown inside the reader and caught at its edge. */
class Invalid extends Error {
  readonly problem: SettingsFileProblem;
  readonly key: string | null;

  constructor(problem: SettingsFileProblem, key: string | null) {
    super(`${problem}${key === null ? "" : ` (${key})`}`);
    this.problem = problem;
    this.key = key;
  }
}

function parseMapping(text: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    throw new Invalid("not_yaml", null);
  }
  if (!isMapping(doc)) throw new Invalid("not_yaml", null);
  return doc;
}

function isKey(key: string): key is SettingKey {
  return Object.hasOwn(ACCEPTS, key);
}

/** Takes one key of the mapping into `layer`, or refuses the file. */
function takeKey(layer: Layer, key: string, value: unknown, origin: OwnerOrigin): void {
  if (key === RULES_OFF && origin === "owner-repository") {
    if (!Array.isArray(value) || !value.every(isRuleOff)) throw new Invalid("wrong_type", key);
    for (const entry of value) addRuleOff(layer.rulesOff, { file: entry.file, text: entry.text });
    return;
  }
  if (!isKey(key)) throw new Invalid("unknown_key", key);
  const set = <K extends SettingKey>(k: K) => {
    if (!ACCEPTS[k](value)) throw new Invalid("wrong_type", k);
    layer.values[k] = value;
  };
  set(key);
}

/** Adds a rule line, its text normalised, unless the same line is there already. */
function addRuleOff(list: RuleOff[], off: RuleOff): void {
  const text = normalisedRuleText(off.text);
  if (!list.some((o) => o.file === off.file && o.text === text)) list.push({ file: off.file, text });
}

function parseLayer(text: string, origin: OwnerOrigin): Layer {
  const { $schema, version, ...rest } = parseMapping(text);
  if ($schema !== LAYER_SCHEMA) throw new Invalid("wrong_version", "$schema");
  if (version !== LAYER_VERSION) throw new Invalid("wrong_version", "version");
  const layer: Layer = { values: {}, rulesOff: [] };
  for (const [key, value] of Object.entries(rest)) takeKey(layer, key, value, origin);
  return layer;
}

type Read = { layer: Layer; error: null } | { layer: Layer; error: SettingsFileError };

/**
 * The layer in `file`. No file: a layer that changes nothing. A file that can't be read or doesn't read: empty, with
 * its error.
 */
async function readLayer(files: SettingsFiles, file: string, origin: OwnerOrigin): Promise<Read> {
  let text: string | null;
  try {
    text = await files.read(file);
  } catch {
    return { layer: EMPTY, error: { file, problem: "unreadable", key: null } };
  }
  if (text === null) return { layer: EMPTY, error: null };
  try {
    return { layer: parseLayer(text, origin), error: null };
  } catch (error) {
    if (!(error instanceof Invalid)) throw error;
    return { layer: EMPTY, error: { file, problem: error.problem, key: error.key } };
  }
}

/** The layer's file: the header, then only the keys the layer sets, in their fixed order, then its rule lines. */
function layerText(layer: Layer): string {
  const doc: Record<string, unknown> = { $schema: LAYER_SCHEMA, version: LAYER_VERSION };
  for (const key of KEYS) if (layer.values[key] !== undefined) doc[key] = layer.values[key];
  if (layer.rulesOff.length > 0) doc[RULES_OFF] = layer.rulesOff;
  return stringify(doc);
}

const isEmpty = (layer: Layer) => Object.keys(layer.values).length === 0 && layer.rulesOff.length === 0;

/** Writes the layer, or removes its file when it changes nothing; when the layer is as it was, does neither. */
async function writeLayer(files: SettingsFiles, file: string, before: Layer, after: Layer): Promise<void> {
  if (isEmpty(before) === isEmpty(after) && layerText(before) === layerText(after)) return;
  if (isEmpty(after)) await files.remove(file);
  else await files.write(file, layerText(after));
}

const isOff = (rule: Pick<Rule, "source" | "text">, rulesOff: RuleOff[]): boolean =>
  rulesOff.some((o) => o.file === rule.source && o.text === normalisedRuleText(rule.text));

const asLayer = (origin: OwnerOrigin, layer: Layer): SettingsLayer => ({ origin, values: layer.values });

const ownerOf = (owner: Read): OwnerSettings => ({
  defaults: resolve([asLayer("owner-default", owner.layer)]),
  invalid: owner.error === null ? [] : [owner.error],
});

function settingsOf(at: RepositoryFiles, owner: Read, repository: Read): RepositorySettings {
  const ownerLayer = asLayer("owner-default", owner.layer);
  return {
    defaults: resolve([ownerLayer]),
    settings: resolve([ownerLayer, asLayer("owner-repository", repository.layer)]),
    rulesOff: new Set(at.rules.filter((r) => isOff(r, repository.layer.rulesOff)).map((r) => r.id)),
    switchedOff: (rule) => isOff(rule, repository.layer.rulesOff),
    invalid: [owner.error, repository.error].filter((e) => e !== null),
  };
}

/** A layer's change: the layer as read, and what applies without it. */
type Edit = (layer: Layer, under: ResolvedSettings) => Layer;

const setting =
  <K extends SettingKey>(key: K, value: SettingValues[K]): Edit =>
  (layer, under) => ({ ...layer, values: withSetting(layer.values, key, value, under) });

const unset =
  (key: SettingKey): Edit =>
  (layer) => {
    const values = { ...layer.values };
    delete values[key];
    return { ...layer, values };
  };

/** The settings over the caller's file access. */
export function settingsFiles(files: SettingsFiles): SettingsRoom {
  const readDefaults = async (owner: string) => ownerOf(await readLayer(files, owner, "owner-default"));

  const read = async (at: RepositoryFiles): Promise<RepositorySettings> =>
    settingsOf(
      at,
      await readLayer(files, at.owner, "owner-default"),
      await readLayer(files, at.repository, "owner-repository"),
    );

  /** Reads the owner's file, changes it with `edit` unless it doesn't read, and reads again. */
  const changeDefaults = async (owner: string, edit: Edit): Promise<SettingsWrite<OwnerSettings>> => {
    const { layer, error } = await readLayer(files, owner, "owner-default");
    if (error !== null) return { ok: false, error };
    await writeLayer(files, owner, layer, edit(layer, resolve([])));
    return { ok: true, now: await readDefaults(owner) };
  };

  /** Reads both files, changes the repository's with `edit` unless it doesn't read, and reads again. */
  const changeRepository = async (
    at: RepositoryFiles,
    edit: Edit,
  ): Promise<SettingsWrite<RepositorySettings>> => {
    const owner = await readLayer(files, at.owner, "owner-default");
    const { layer, error } = await readLayer(files, at.repository, "owner-repository");
    if (error !== null) return { ok: false, error };
    const under = resolve([asLayer("owner-default", owner.layer)]);
    await writeLayer(files, at.repository, layer, edit(layer, under));
    return { ok: true, now: await read(at) };
  };

  return {
    readDefaults,
    setDefault: (owner, key, value) => changeDefaults(owner, setting(key, value)),
    resetDefault: (owner, key) => changeDefaults(owner, unset(key)),
    read,
    set: (at, key, value) => changeRepository(at, setting(key, value)),
    reset: (at, key) => changeRepository(at, unset(key)),
    async setRule(at, ruleId, enabled) {
      const rule = at.rules.find((r) => r.id === ruleId);
      if (rule === undefined) throw new Error(`No such rule: ${ruleId}`);
      const file = rule.source;
      if (file === "yours") throw new Error(`The owner's own rules have no switch in a file: ${ruleId}`);
      return changeRepository(at, (layer) => {
        const kept = layer.rulesOff.filter((o) => at.rules.some((r) => r !== rule && isOff(r, [o])));
        if (!enabled) addRuleOff(kept, { file, text: rule.text });
        return { ...layer, rulesOff: kept };
      });
    },
  };
}
