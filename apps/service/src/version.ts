// Lookover's version, from its one source (ADR 0054, 0061): the root `package.json`'s `version`, which
// release-please moves. Read at build time: `rootVersion` is a Bun macro, so Bun inlines the version into the
// program when it builds `dist/lookover(.exe)` (and into the transpiled source when it runs from a clone). The
// service says it in its snapshot and Run checks, and the program's `instance.json`, `lookover --version` and the
// installed skill's stamp read it from here. The packages' own `version` fields stay `0.0.0`: only the root's is
// released.
import { rootVersion } from "./root-version.ts" with { type: "macro" };

export const VERSION: string = rootVersion();
