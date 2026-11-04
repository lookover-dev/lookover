// Which files the checks read: what the after-edit hook formats, and what the pre-commit hook checks.
// Anything else (docs, images) can't turn a check red.
import { basename, extname } from "node:path";

// What Biome, tsc, knip, the import check and the tests read, plus the custom lint rules and the lockfile.
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".css", ".grit"]);
const CODE_NAMES = new Set(["bun.lock", "bunfig.toml"]);

export const isCode = (path: string): boolean => CODE.has(extname(path)) || CODE_NAMES.has(basename(path));

// The folders `bun run lint` gives Biome; `spikes`, `.claude` and any `node_modules` stay out of it.
const LINTED = /^(?:apps|packages|scripts|npm)\//;
const SKIPPED = /(?:^|\/)(?:node_modules|\.claude|spikes)\//;

/** A repository-relative path Biome checks. */
export const isLinted = (path: string): boolean => LINTED.test(path) && !SKIPPED.test(path) && isCode(path);

// Root config files and the custom lint rules: a change can move any file's result.
const CONFIG = new Set(["package.json", "biome.jsonc", "tsconfig.json", "knip.json"]);

/** A repository-relative path whose change can turn any file red, so the whole tree is checked. */
export const movesEveryFile = (path: string): boolean => CONFIG.has(path) || extname(path) === ".grit";
