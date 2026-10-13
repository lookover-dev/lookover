// The resolver (ADR 0030, ADR 0011): Lookover's defaults under the owner's layers, lowest first. A layer stores
// only what it changes; resolving says, for every key, what applies, where it comes from and what it overrode.
// A new setting key is added in two places: `SettingValues` in contracts, and `LOOKOVER_DEFAULTS` here.
import type {
  ResolvedSetting,
  ResolvedSettings,
  ResolveSettings,
  SettingKey,
  SettingOrigin,
  SettingsLayer,
  SettingValues,
} from "@lookover/contracts";

/** Lookover's defaults (ADR 0025, ADR 0026, ADR 0044): what applies when the owner sets nothing. */
const LOOKOVER_DEFAULTS: SettingValues = {
  strictness: "recommended",
  reviewers: "both",
  depth: "standard",
  onOpen: true,
  onPush: false,
};

/** Every key, in one fixed order. */
export const KEYS: SettingKey[] = Object.keys(LOOKOVER_DEFAULTS).filter(
  (k): k is SettingKey => k in LOOKOVER_DEFAULTS,
);

/** Every key is there: true by construction when `out` was filled from `KEYS`. */
function complete<T extends object>(out: Partial<T>, keys: (keyof T)[]): T {
  if (!isComplete(out, keys)) throw new Error("A setting key has no value");
  return out;
}

function isComplete<T extends object>(out: Partial<T>, keys: (keyof T)[]): out is T {
  return keys.every((key) => out[key] !== undefined);
}

function above<K extends SettingKey>(
  under: ResolvedSetting<K>,
  value: SettingValues[K] | undefined,
  origin: SettingOrigin,
): ResolvedSetting<K> {
  if (value === undefined) return under;
  return { value, origin, overrode: { value: under.value, origin: under.origin } };
}

function resolveKey<K extends SettingKey>(key: K, layers: SettingsLayer[]): ResolvedSetting<K> {
  const lookover: ResolvedSetting<K> = {
    value: LOOKOVER_DEFAULTS[key],
    origin: "lookover-default",
    overrode: null,
  };
  return layers.reduce((under, layer) => above(under, layer.values[key], layer.origin), lookover);
}

/** Sets one key of a partly built record of resolved settings. */
function setKey<K extends SettingKey>(
  out: { [P in K]?: ResolvedSetting<P> },
  key: K,
  setting: ResolvedSetting<K>,
): void {
  out[key] = setting;
}

/** The order the layers stack in (ADR 0011). Lookover's defaults are this leaf's own, never a layer passed in. */
const RANK: Record<SettingOrigin, number> = {
  "lookover-default": 0,
  "owner-default": 1,
  "owner-repository": 2,
};

/** The layers are lowest first and each origin at most once: anything else is a programming error. */
function checkOrder(layers: SettingsLayer[]): void {
  let below = RANK["lookover-default"];
  for (const layer of layers) {
    const rank = RANK[layer.origin];
    if (rank <= below)
      throw new Error(`Settings layers must be lowest first, each origin once: ${layer.origin}`);
    below = rank;
  }
}

/** Every key over the layers, lowest first, Lookover's defaults under them. */
export const resolve: ResolveSettings = (layers) => {
  checkOrder(layers);
  const out: Partial<ResolvedSettings> = {};
  for (const key of KEYS) setKey(out, key, resolveKey(key, layers));
  return complete(out, KEYS);
};

/** The values that apply, without their origins: what the rules read. */
export function settingValues(settings: ResolvedSettings): SettingValues {
  const values: Partial<SettingValues> = {};
  const take = <K extends SettingKey>(key: K) => {
    values[key] = settings[key].value;
  };
  for (const key of KEYS) take(key);
  return complete(values, KEYS);
}

/**
 * A layer's values with `key` set to `value`. Choosing the value that applies without the layer (`under`) is not
 * stored: a layer keeps only what it changes.
 */
export function withSetting<K extends SettingKey>(
  values: Partial<SettingValues>,
  key: K,
  value: SettingValues[K],
  under: ResolvedSettings,
): Partial<SettingValues> {
  const out = { ...values };
  if (under[key].value === value) delete out[key];
  else out[key] = value;
  return out;
}
