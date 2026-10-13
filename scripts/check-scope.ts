// Which files the checks read: what the after-edit hook checks, and what makes the pre-commit hook run
// `bun run check`. Anything else (docs, images) can't turn a check red.
import { basename, extname } from "node:path";

// What Biome, tsc, knip, the import check and the tests read, plus the custom lint rules and the lockfile.
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".css", ".grit"]);
const CODE_NAMES = new Set(["bun.lock", "bunfig.toml"]);

export const isCode = (path: string): boolean => CODE.has(extname(path)) || CODE_NAMES.has(basename(path));
