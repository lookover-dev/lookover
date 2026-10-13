// The `settings` leaf's interface (ADR 0011, ADR 0030, ADR 0033): the layers, lowest first, and the resolver
// that merges them per key, keeping each value's origin and what it overrode. The UI-facing shape is
// `ResolvedSettings`; this is what builds it. Reading and writing the files that hold the layers stays inside
// the leaf. A later layer (the repository file) is one more entry in the list, and the screens don't change.
import type { ResolvedSettings, SettingOrigin, SettingValues } from "./settings.ts";

/** One layer: where it comes from, and only the keys it sets. */
export interface SettingsLayer {
  origin: SettingOrigin;
  values: Partial<SettingValues>;
}

/**
 * The leaf's entry. `layers` are the owner's, lowest first; Lookover's defaults are the leaf's own, under them.
 * Every key comes back with the value that applies, its origin, and what it overrode. Pure; a key no layer sets
 * is Lookover's default.
 */
export type ResolveSettings = (layers: SettingsLayer[]) => ResolvedSettings;
