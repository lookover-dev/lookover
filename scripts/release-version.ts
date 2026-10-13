// A release's version, as every release script reads it (ADR 0061): plain `X.Y.Z`, no `v`, no pre-release, no
// build. The guard judges the manifest by it, the export the changelog, the sync its tag, the smoke the version
// it installs. Public: the smoke is.

/** A release's version: `1.2.3`. */
export const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
