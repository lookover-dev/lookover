// Which test files `bun run check` runs (ADR 0071, the owner's answer on #440): those the change can reach through their
// imports, and every one when in doubt; and the `scripts/` tests that read what changed (ADR 0089). `check:full`, in
// CI, runs them all, whatever this says.
//
// - The change (`changeOf`): every file that differs between the tree of the last green check and the tree checked
//   now (both git tree objects, untracked files and deletions included), else, with no such tree (no green run
//   yet, git no longer holds it), every file that differs from the merge base with `origin/main`, committed,
//   staged, unstaged or untracked: against the tree checked now when there is one, hashed from each file's
//   content, where the working tree's stat data can hide a same-size edit (#462). Sound by induction: the last
//   green tree passed every test its own change reached, as did each green tree before it, and the first base is
//   the merge base. No merge base: doubt.
// - The graph: from each test file `bun run test` runs (`*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*` under
//   `packages/` and `apps/`, outside `node_modules` and dot-folders), every file its static imports reach,
//   type-only and literal dynamic ones included: relative paths, and a workspace package (`@lookover/<name>`) by
//   its package.json's `exports` (every path a conditional export gives). A file named at run time by literal
//   segments from its own folder (`join(import.meta.dir, "main.ts")`, for a CLI a test starts) is reached too, and
//   so is every source file under a folder named that way; so is a file or folder a string names from the checkout
//   (`"apps/service/src/main.ts"`, read or started from the working folder), and a module resolved by one literal
//   specifier (`import.meta.resolve("@lookover/process/background")`). Strings, comments and regular expressions
//   are not otherwise read as code.
// - A test whose imports can't all be followed (a computed path from its own folder, the whole checkout as a place, a
//   dynamic import or `require` of a computed name, a module resolved at run time some other way, the working folder
//   `process.cwd()`, an import that resolves to nothing, a dependency Bun can't resolve, a file Bun can't parse)
//   runs whatever changes.
// - **When in doubt, everything:** a change the graph can't place runs every test file: a change to the tests'
//   setup (a preload, the runner and what it imports, `bunfig.toml`, a `package.json`, `bun.lock`, a tsconfig,
//   `scripts/check*`), to a file other than source code that a test reaches (a fixture, a recording, a doc read at
//   run time), to a file the change deleted, or to any file the graph doesn't hold, `docs/` and `scripts/` included
//   (the owner's rule on #454). The pre-commit hook runs no test at all (ADR 0076): this is the push's check.
// - **The readers** (ADR 0089, `READERS`): the `scripts/` tests that read or run a path at run time rather than
//   import it (the allow-list test reads `scripts/` and `.github/`, the gate test `lint/` and runs `scripts/check*`,
//   …), or take it from outside `scripts/` by an import or a build (the web build's test: the service's CSP,
//   `contracts`). Any change under a row's path, added, changed, renamed (both paths) or removed, selects its
//   tests, gathered from every changed file, in doubt too; a reader the tree doesn't hold is left out. When the
//   change can't be told, `check` runs `everyReader`. A new `scripts/` test that reads a folder adds its row.
//
// `bun scripts/check-reach.ts <file>…`: prints, for those changed files, each test file picked and why, one line
// each (`  <test>: the change to <file> reaches it`), or why everything runs, then the check's line with its
// readers' clause; the gate test runs it on `lint/fixtures` (ADR 0036).
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * What `check` runs: `tests`, of the `total` test files; `doubt` says why when it is all of them; `readers`, the
 * `scripts/` tests that read what changed (ADR 0089), in doubt too.
 */
type Selection = {
  tests: string[];
  total: number;
  doubt?: string;
  /** Each test picked, and why: the changed files that reach it, or why it runs whatever changes. */
  why: Map<string, string[]>;
  readers: string[];
};

const PUBLIC_TREE = "scripts/public-tree.test.ts";
const GATES = "scripts/gates.test.ts";
const RELEASE_PLEASE = "scripts/release-please.test.ts";
const EVAL = "scripts/eval.test.ts";
const MIGRATIONS = "scripts/migrations.test.ts";
const WEB_BUILD = "scripts/web-build.test.ts";
const TEST_PRELOAD = "scripts/test-preload.test.ts";
/** The one row whose `reads` is a name's start rather than a folder or a file: every `scripts/check*`. */
export const CHECK_TOOLS = "scripts/check";
/**
 * The `scripts/` tests that read or run a path at run time, or take it from outside `scripts/` by an import or a
 * build (ADR 0089): a change to a path under `reads` (a folder ends in `/`, else a file, or `CHECK_TOOLS`) selects
 * its `tests`. A new `scripts/` test that reads a folder adds its row here.
 */
export const READERS: readonly { reads: string; tests: readonly string[] }[] = [
  { reads: "scripts/", tests: [PUBLIC_TREE] },
  { reads: ".github/", tests: ["scripts/check-workflows.test.ts", PUBLIC_TREE] },
  { reads: "lint/", tests: [GATES] },
  { reads: "biome.jsonc", tests: [GATES] },
  { reads: "tsconfig.json", tests: [GATES] },
  { reads: CHECK_TOOLS, tests: [GATES] },
  { reads: ".githooks/", tests: ["scripts/githooks.test.ts"] },
  { reads: "release-please-config.json", tests: [RELEASE_PLEASE] },
  { reads: ".release-please-manifest.json", tests: [RELEASE_PLEASE] },
  { reads: "package.json", tests: [PUBLIC_TREE, RELEASE_PLEASE] },
  { reads: "docs/releases/CHANGELOG.md", tests: [RELEASE_PLEASE] },
  { reads: "apps/web/", tests: [WEB_BUILD] },
  // The test imports the CSP through the service's entry and its faults from a script; the build bundles contracts.
  { reads: "apps/service/src/csp.ts", tests: [WEB_BUILD] },
  { reads: "apps/service/src/index.ts", tests: [WEB_BUILD, "scripts/proof-shots.test.ts"] },
  { reads: "scripts/csp-faults.ts", tests: [WEB_BUILD] },
  { reads: "packages/contracts/", tests: [WEB_BUILD] },
  { reads: "apps/web/src/styles/", tests: ["scripts/proof-motion.test.ts"] },
  { reads: "apps/web/src/app.tsx", tests: ["scripts/proof-shots.test.ts"] },
  { reads: "apps/service/src/demo/scenarios.ts", tests: ["scripts/proof-shots.test.ts"] },
  { reads: "apps/service/src/demo/scenarios/", tests: ["scripts/proof-shots.test.ts"] },
  { reads: "docs/product/visual-score.md", tests: ["scripts/visual-score.test.ts"] },
  { reads: "apps/evals/fixtures/replay/", tests: [EVAL] },
  { reads: "apps/evals/cases/", tests: [EVAL] },
  { reads: "packages/store/src/migrations/", tests: [MIGRATIONS] },
  { reads: "packages/store/src/embedded-migrations.ts", tests: [MIGRATIONS] },
  // The preload's test checks bunfig.toml's `[test] preload` and the preload, and starts `bun test` on this test.
  { reads: "apps/service/src/login-item.test.ts", tests: [TEST_PRELOAD] },
  { reads: "bunfig.toml", tests: [TEST_PRELOAD] },
  { reads: "scripts/test-preload.ts", tests: [TEST_PRELOAD] },
];

const isUnder = (file: string, reads: string) =>
  reads.endsWith("/") || reads === CHECK_TOOLS ? file.startsWith(reads) : file === reads;

/** The readers of `changed`'s paths (relative to `root`, with `/`) that the tree at `root` holds, sorted. */
function readersOf(root: string, changed: readonly string[]): string[] {
  const rows = READERS.filter((row) => changed.some((file) => isUnder(file, row.reads)));
  return [...new Set(rows.flatMap((row) => row.tests))].filter((t) => existsSync(join(root, t))).sort();
}

/** Every reader the tree at `root` holds, sorted: what runs when the change can't be told. */
export const everyReader = (root: string): string[] =>
  readersOf(
    root,
    READERS.map((row) => row.reads),
  );

/** The clause ADR 0071's line gains for `readers` (none: none): "…, and 1 scripts test that reads what changed: …". */
export function readersClause(readers: readonly string[]): string {
  if (readers.length === 0) return "";
  const count =
    readers.length === 1 ? "1 scripts test that reads" : `${readers.length} scripts tests that read`;
  return `, and ${count} what changed: ${readers.join(", ")}`;
}

/**
 * The fast check's reach when the selection failed (`failure`, its message): every `packages/` and `apps/` test,
 * no list, and `readers` through the list `write` returns. It never throws: when that list can't be written either
 * (a full disk, a locked file), no reader runs, since `test:scripts` without its list would run every scripts test,
 * and the doubt says so.
 */
export function reachInDoubt(
  failure: string,
  readers: readonly string[],
  write: (files: readonly string[]) => string,
): { line: string; doubt: string; none: false; readersList?: string } {
  const line = "ran every test file";
  const doubt = `the selection failed: ${failure}`;
  if (readers.length === 0) return { line, doubt, none: false };
  try {
    return { line: `${line}${readersClause(readers)}`, doubt, none: false, readersList: write(readers) };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const none = `the readers' list couldn't be written (${why}), so no scripts test that reads what changed runs`;
    return { line, doubt: `${doubt}; ${none}`, none: false };
  }
}

/**
 * The fast check's test runs, one per run with something to run: the `packages/` and `apps/` tests the change
 * reaches (unless none is, with `timings`, then `list` when there is one), and the readers through
 * `test:scripts`' runner with their list, without timings (`test` is the timings file's one writer).
 */
export function testRuns(
  reached: { none: boolean; list?: string; readersList?: string },
  timings: readonly string[],
): { step: string; args: string[] }[] {
  const runs: { step: string; args: string[] }[] = [];
  if (!reached.none) {
    const list = reached.list === undefined ? [] : [`--files-from=${reached.list}`];
    runs.push({ step: "test", args: [...timings, ...list] });
  }
  if (reached.readersList !== undefined)
    runs.push({ step: "test:scripts", args: [`--files-from=${reached.readersList}`] });
  return runs;
}

/** What `bun run test` passes `bun test`: the folders whose test files it runs. */
const TEST_ROOTS = ["packages", "apps"];
const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
/** The tests' setup: the graph can't place what these change. */
const SETUP = [
  /(?:^|\/)package\.json$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /^bunfig\.toml$/,
  /^bun\.lock$/,
  /^scripts\/check[^/]*$/,
  /^scripts\/test-run\.ts$/,
  /^scripts\/test-preload\.ts$/,
];
/** The test runner and its preload, whose imports are the tests' setup too. */
const RUNNER = ["scripts/test-run.ts", "scripts/test-preload.ts"];

const slash = (path: string) => path.replaceAll("\\", "/");
// One per syntax: a `.ts` file may hold `<T>value`, which the tsx parser rejects.
const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
};
// Static imports and re-exports, type-only ones included (`scanImports` drops those). Stops at `;`.
const FROM = /^\s*(?:import|export)\b[^;]*?\bfrom\s*(["'])/gm;
// `import(` or `require(` whose argument is not one plain string literal.
const COMPUTED_LOAD = /\b(?:import|require)\s*\(\s*(?!(?:"[^"]*"|'[^']*')\s*[,)])/;
// A module resolved at run time: followed when its argument is one plain string literal, else lost.
const RESOLVE = /\b(?:import\.meta\.resolve|require\.resolve|Bun\.resolveSync)\s*\(/g;
const ONE_LITERAL = /^\s*(["'])([^"'\n]*)\1\s*\)/;
// The working folder. A test's is the checkout: what test code names from it some other way than by literal
// segments can't be told. A program's is wherever it was started (a session's clone, the person's repository).
const WORKING_FOLDER = /\bprocess\.cwd\s*\(\s*\)/g;
const LITERAL_FROM_CWD =
  /\b(?:join|resolve)\(\s*process\.cwd\(\s*\)((?:\s*,\s*(?:"[^"]*"|'[^']*'))*)\s*,?\s*\)/g;
// Test code: test files and their support files (`*.test-support.ts`).
const TEST_CODE = /[._](?:test|spec)[.-]/;
// The file's own folder or path, as Bun, Node and CommonJS name it.
const OWN_PLACE = /\bimport\.meta\.(?:dir|dirname|path|url|filename)\b|\b__dirname\b|\b__filename\b/g;
// `join(import.meta.dir, "a", "b")` or `resolve(…)`: a place from the file's folder by literal segments only.
// Or `new URL("../a", import.meta.url)`.
const LITERAL_PLACE =
  /\b(?:join|resolve)\(\s*import\.meta\.dir(?:name)?(?:\s*,\s*(?:"[^"]*"|'[^']*'))*\s*,?\s*\)|\bnew URL\(\s*(?:"[^"]*"|'[^']*')\s*,\s*import\.meta\.url\s*\)/g;
// After one of these characters or words, a `/` opens a regular expression rather than dividing.
const BEFORE_REGEX = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/**
 * Reading a file's text as code: `out` is the text with what isn't code blanked; `templates` holds, for each template
 * expression open (`${`), the brace depth it opened at; `prev` the last code character and `word` the word it ends.
 */
type Lexer = { src: string; out: string[]; templates: number[]; depth: number; prev: string; word: string };

const blank = (lex: Lexer, from: number, to: number) => {
  for (let i = from; i < to; i++) if (lex.out[i] !== "\n") lex.out[i] = " ";
};

/** The index of the first `j` from `from` where `stop(j)` holds, a backslash escaping the next character; or the end. */
function scan(src: string, from: number, stop: (j: number) => boolean, escapes: boolean): number {
  let j = from;
  while (j < src.length && !stop(j)) j += escapes && src[j] === "\\" ? 2 : 1;
  return Math.min(j, src.length);
}

/** Blanks template text from `i` to the template's end or its next `${`; the index after that. */
function templateText(lex: Lexer, i: number): number {
  const { src } = lex;
  const j = scan(src, i, (k) => src[k] === "`" || (src[k] === "$" && src[k + 1] === "{"), true);
  blank(lex, i, j);
  if (src[j] !== "$") return j + 1;
  lex.templates.push(lex.depth);
  return j + 2;
}

/** The index after the regular expression opening at `i`, its inside blanked. */
function regex(lex: Lexer, i: number): number {
  const { src } = lex;
  let inClass = false;
  const j = scan(
    src,
    i + 1,
    (k) => {
      if (src[k] === "[") inClass = true;
      else if (src[k] === "]") inClass = false;
      return src[k] === "\n" || (!inClass && src[k] === "/");
    },
    true,
  );
  blank(lex, i + 1, j);
  return j + 1;
}

/** The index after a string opening at `i` with `quote`, its inside blanked. */
function quoted(lex: Lexer, i: number, quote: string): number {
  const j = scan(lex.src, i + 1, (k) => lex.src[k] === quote || lex.src[k] === "\n", true);
  blank(lex, i + 1, j);
  return j + 1;
}

/** The index after a comment opening at `i`, blanked whole. */
function comment(lex: Lexer, i: number): number {
  const { src } = lex;
  const line = src[i + 1] === "/";
  const j = line
    ? scan(src, i, (k) => src[k] === "\n", false)
    : scan(src, i + 2, (k) => src.startsWith("*/", k), false) + 2;
  blank(lex, i, j);
  return j;
}

/** When a literal or comment opens at `i`: the index after it, blanked. Undefined at code. */
function literalEnd(lex: Lexer, i: number): number | undefined {
  const c = lex.src[i] ?? "";
  const next = lex.src[i + 1];
  if (c === "/" && (next === "/" || next === "*")) return comment(lex, i);
  if (c === '"' || c === "'") return quoted(lex, i, c);
  if (c === "`") return templateText(lex, i + 1);
  if (c === "}" && lex.templates.at(-1) === lex.depth) {
    lex.templates.pop();
    return templateText(lex, i + 1);
  }
  const regexMayOpen = lex.prev === "" || BEFORE_REGEX.has(lex.prev) || REGEX_WORDS.has(lex.word);
  return c === "/" && regexMayOpen ? regex(lex, i) : undefined;
}

/** Follows one character of code. */
function code(lex: Lexer, c: string) {
  if (c === "{") lex.depth++;
  else if (c === "}") lex.depth--;
  if (/\s/.test(c)) return;
  lex.word = /\w/.test(c) ? (/\w/.test(lex.prev) ? lex.word + c : c) : "";
  lex.prev = c;
}

/** `src` with the insides of its strings, comments, template text and regular expressions blanked, same length. */
function codeOnly(src: string): string {
  const lex: Lexer = { src, out: src.split(""), templates: [], depth: 0, prev: "", word: "" };
  let i = src.startsWith("#!") ? scan(src, 0, (k) => src[k] === "\n", false) : 0;
  blank(lex, 0, i);
  while (i < src.length) {
    const end = literalEnd(lex, i);
    if (end === undefined) {
      code(lex, src[i] ?? "");
      i++;
    } else {
      lex.prev = "a";
      lex.word = "";
      i = end;
    }
  }
  return lex.out.join("");
}

/** Every file under `dir`, relative to `root`, outside `node_modules` and dot-folders. */
function filesUnder(root: string, dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    let entries: Dirent[] = [];
    if (statSync(at, { throwIfNoEntry: false })?.isDirectory())
      entries = readdirSync(at, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && keep(entry.name)) out.push(slash(relative(root, path)));
    }
  };
  walk(dir);
  return out.sort();
}

/** The test files `bun run test` runs, relative to `root`, sorted. */
const testFiles = (root: string) =>
  TEST_ROOTS.flatMap((top) => filesUnder(root, join(root, top), (name) => TEST_FILE.test(name))).sort();

type Exports = string | { [key: string]: Exports } | null | undefined;
/** Each workspace package by name: each of its entries (`.`, `./<sub>`) and the files it points at. */
type Packages = Map<string, Map<string, string[]>>;

/** Every path an export gives, under each of its conditions. */
function stringsOf(value: Exports): string[] {
  if (typeof value === "string") return [value];
  return Object.values(value ?? {}).flatMap(stringsOf);
}

/** A manifest's entries, from its `exports`, else its `module` or `main`. */
function entriesOf(dir: string, json: { exports?: Exports; module?: string; main?: string }) {
  const { exports } = json;
  const pairs: [string, Exports][] =
    exports && typeof exports === "object" && Object.keys(exports).every((k) => k.startsWith("."))
      ? Object.entries(exports)
      : [[".", exports ?? json.module ?? json.main]];
  const entries = new Map<string, string[]>();
  for (const [key, value] of pairs) {
    const targets = stringsOf(value);
    if (targets.length > 0) entries.set(key, [...new Set(targets.map((t) => resolve(dir, t)))]);
  }
  return entries;
}

function workspacePackages(root: string): Packages {
  const packages: Packages = new Map();
  for (const manifest of new Bun.Glob(`{${TEST_ROOTS.join(",")}}/*/package.json`).scanSync(root)) {
    const json = JSON.parse(readFileSync(join(root, manifest), "utf8"));
    if (typeof json.name === "string")
      packages.set(json.name, entriesOf(dirname(join(root, manifest)), json));
  }
  return packages;
}

/** The file a relative import lands on, as Bun resolves it here; undefined when none. */
function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${stem}.ts`, `${stem}.tsx`];
  candidates.push(join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.js"));
  return candidates.find((c) => statSync(c, { throwIfNoEntry: false })?.isFile());
}

/** Whether Bun resolves a dependency's specifier from `dir`, as the import would at run time. */
function resolvesFrom(dir: string, spec: string): boolean {
  try {
    Bun.resolveSync(spec, dir);
    return true;
  } catch {
    return false;
  }
}

/** Where an import specifier lands: files, nowhere we follow (a dependency), or why it can't be followed. */
function landing(abs: string, raw: string, packages: Packages): { files?: string[]; lost?: string } {
  const spec = raw.replace(/\?.*$/, "");
  if (spec.startsWith(".")) {
    const file = resolveRelative(abs, spec);
    return file === undefined ? { lost: `imports "${raw}", which resolves to nothing` } : { files: [file] };
  }
  if (spec.startsWith("/")) return { lost: `imports "${raw}" by an absolute path` };
  const parts = spec.split("/");
  const count = spec.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, count).join("/");
  const entries = packages.get(name);
  if (entries === undefined) {
    if (name.startsWith("@lookover/")) return { lost: `imports "${raw}", no package here` };
    return resolvesFrom(dirname(abs), spec) ? {} : { lost: `imports "${raw}", which Bun can't resolve` };
  }
  const rest = parts.slice(count).join("/");
  const files = (entries.get(rest === "" ? "." : `./${rest}`) ?? []).filter((f) => existsSync(f));
  return files.length > 0 ? { files } : { lost: `imports "${raw}", which ${name}'s exports don't hold` };
}

/** The specifiers a file resolves at run time by one literal, and whether it resolves one some other way. */
function resolvedOf(src: string, code: string): { specs: string[]; computed: boolean } {
  const specs: string[] = [];
  let computed = false;
  for (const m of code.matchAll(RESOLVE)) {
    const literal = ONE_LITERAL.exec(src.slice((m.index ?? 0) + m[0].length));
    if (literal?.[2] === undefined) computed = true;
    else specs.push(literal[2]);
  }
  return { specs, computed };
}

/** The checkout's top folders: a string starting with one names a path from the working folder. */
const topFolders = (root: string) =>
  readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
    .map((e) => e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const isSourceNotTest = (name: string) => SOURCE.test(name) && !TEST_FILE.test(name);

/** The files strings name from the checkout (`"apps/service/src/main.ts"`; a folder: its source files, tests aside). */
function namedFromCheckout(root: string, src: string, code: string, tops: string[]): string[] {
  if (tops.length === 0) return [];
  const named = new RegExp(`(["'\`])((?:${tops.join("|")})/[^"'\`\\n$]*)\\1`, "g");
  const files: string[] = [];
  for (const m of src.matchAll(named)) {
    // A string of the code, not one inside a comment or another string.
    if (code[m.index ?? 0] !== m[1] || code[(m.index ?? 0) + m[0].length - 1] !== m[1]) continue;
    const place = resolve(root, m[2] ?? "");
    const stat = statSync(place, { throwIfNoEntry: false });
    if (stat?.isFile()) files.push(place);
    else if (stat?.isDirectory())
      files.push(...filesUnder(root, place, isSourceNotTest).map((f) => join(root, f)));
  }
  return files;
}

/** The specifiers a file imports, type-only and literal dynamic ones included; undefined when Bun can't parse it. */
function specifiersOf(file: string, src: string, code: string): string[] | undefined {
  const ext = /\.[cm]?([jt])s(x?)$/.exec(file);
  const loader = `${ext?.[1] ?? "t"}s${ext?.[2] ?? ""}`;
  const transpiler = TRANSPILERS[loader === "js" || loader === "jsx" || loader === "tsx" ? loader : "ts"];
  try {
    const specs = transpiler.scanImports(src.startsWith("#!") ? `//${src}` : src).map((i) => i.path);
    // The type-only ones, read where the code (not a string) says `from`; the specifier from the source itself.
    for (const m of code.matchAll(FROM)) {
      const at = (m.index ?? 0) + m[0].length;
      specs.push(src.slice(at, src.indexOf(m[1] ?? '"', at)));
    }
    return specs;
  } catch {
    return undefined;
  }
}

/** The places a file names from its own folder by literal segments, or why it names one some other way. */
function placesOf(root: string, abs: string, src: string, code: string): { places: string[]; lost?: string } {
  const literal = [...code.matchAll(LITERAL_PLACE)];
  if ([...code.matchAll(OWN_PLACE)].length > literal.length) {
    return { places: [], lost: "names a place from its own folder by a computed path" };
  }
  const places: string[] = [];
  for (const m of literal) {
    const text = src.slice(m.index ?? 0, (m.index ?? 0) + m[0].length);
    const segments = [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((s) => s[1] ?? s[2] ?? "");
    const place = resolve(dirname(abs), ...segments);
    const stat = statSync(place, { throwIfNoEntry: false });
    if (stat?.isFile()) places.push(place);
    else if (stat?.isDirectory() && relative(place, root).startsWith("..") === false) {
      return { places, lost: `names the whole checkout (${slash(relative(root, place)) || "."}) as a place` };
    } else if (stat?.isDirectory())
      places.push(...filesUnder(root, place, (n) => SOURCE.test(n)).map((f) => join(root, f)));
  }
  return { places };
}

/** The places a file names from the working folder by literal segments, or why test code names one otherwise. */
function fromWorkingFolder(root: string, file: string, src: string, code: string) {
  const literal = [...code.matchAll(LITERAL_FROM_CWD)];
  if (TEST_CODE.test(file) && [...code.matchAll(WORKING_FOLDER)].length > literal.length) {
    return { places: [], lost: "names a place from the working folder by a computed path" };
  }
  const places: string[] = [];
  for (const m of literal) {
    const text = src.slice(m.index ?? 0, (m.index ?? 0) + m[0].length);
    const place = resolve(root, ...[...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((s) => s[1] ?? s[2] ?? ""));
    const stat = statSync(place, { throwIfNoEntry: false });
    if (stat?.isFile()) places.push(place);
    else if (stat?.isDirectory() && place === root) {
      return { places, lost: "names the whole checkout (.) as a place from the working folder" };
    } else if (stat?.isDirectory())
      places.push(...filesUnder(root, place, isSourceNotTest).map((f) => join(root, f)));
  }
  return { places };
}

/** What one source file leads to:the files it reaches, and why its imports can't all be followed, if so. */
function edgesOf(
  root: string,
  file: string,
  packages: Packages,
  tops: string[],
): { to: string[]; lost?: string } {
  const abs = join(root, file);
  const src = readFileSync(abs, "utf8");
  const code = codeOnly(src);
  const specs = specifiersOf(file, src, code);
  if (specs === undefined) return { to: [], lost: `${file} can't be parsed` };
  const to: string[] = [];
  const lost: string[] = [];
  const resolved = resolvedOf(src, code);
  for (const raw of new Set([...specs, ...resolved.specs].filter((s) => s !== ""))) {
    const landed = landing(abs, raw, packages);
    for (const f of landed.files ?? []) to.push(slash(relative(root, f)));
    if (landed.lost !== undefined) lost.push(landed.lost);
  }
  if (COMPUTED_LOAD.test(code)) lost.push("loads a module by a computed name");
  if (resolved.computed) lost.push("resolves a module at run time by a computed name");
  const cwd = fromWorkingFolder(root, file, src, code);
  if (cwd.lost !== undefined) lost.push(cwd.lost);
  to.push(
    ...[...cwd.places, ...namedFromCheckout(root, src, code, tops)].map((p) => slash(relative(root, p))),
  );
  const { places, lost: placeLost } = placesOf(root, abs, src, code);
  to.push(...places.map((p) => slash(relative(root, p))));
  if (placeLost !== undefined) lost.push(placeLost);
  return lost.length > 0 ? { to, lost: `${file} ${lost[0]}` } : { to };
}

/** Every file the starts reach (them included), each with the files it leads to; and those that lose the trail. */
function graphOf(root: string, starts: string[]) {
  const packages = workspacePackages(root);
  const tops = topFolders(root);
  const graph = new Map<string, string[]>();
  const lost = new Map<string, string>();
  const queue = [...starts];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (graph.has(file)) continue;
    if (!SOURCE.test(file) || !existsSync(join(root, file))) {
      graph.set(file, []);
      continue;
    }
    const edges = edgesOf(root, file, packages, tops);
    graph.set(file, edges.to);
    if (edges.lost !== undefined) lost.set(file, edges.lost);
    queue.push(...edges.to);
  }
  return { graph, lost };
}

/** For each file of `graph`, the files that lead to it. */
function backwards(graph: Map<string, string[]>): Map<string, string[]> {
  const back = new Map<string, string[]>();
  for (const [file, targets] of graph) {
    for (const target of targets) back.set(target, [...(back.get(target) ?? []), file]);
  }
  return back;
}

/** The files that reach `from`, `from` included. */
function reaching(back: Map<string, string[]>, from: string): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const next of (back.get(file) ?? []).filter((n) => !seen.has(n))) {
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** Why `file`, changed, runs every test file; undefined when the graph places it. */
function doubtOf(root: string, file: string, graph: Map<string, string[]>, setup: Set<string>) {
  const doubt = (why: string) => `${file} changed, and the import graph can't place it: ${why}`;
  if (SETUP.some((pattern) => pattern.test(file)) || setup.has(file)) return doubt("it sets up the tests");
  if (graph.has(file)) return SOURCE.test(file) ? undefined : doubt("a test reads it at run time");
  if (!existsSync(join(root, file))) return doubt("the change deleted it");
  if (!SOURCE.test(file)) return doubt("not source code, so a test may read it at run time");
  return doubt("no test file's imports reach it");
}

/** The test files `changed` (paths relative to `root`, with `/`) can reach, or all of them when in doubt. */
export function selectTests(root: string, changed: readonly string[]): Selection {
  const tests = testFiles(root);
  const { graph, lost } = graphOf(root, tests);
  const setup = new Set(
    graphOf(
      root,
      RUNNER.filter((f) => existsSync(join(root, f))),
    ).graph.keys(),
  );
  // From every changed file: the loop below stops at the first one in doubt.
  const readers = readersOf(root, changed);
  for (const file of changed) {
    const doubt = doubtOf(root, file, graph, setup);
    if (doubt !== undefined) {
      const why = new Map(tests.map((t) => [t, [doubt]]));
      return { tests, total: tests.length, doubt, why, readers };
    }
  }
  const back = backwards(graph);
  const testSet = new Set(tests);
  const why = new Map<string, string[]>();
  const note = (from: string, reason: string) => {
    for (const test of reaching(back, from))
      if (testSet.has(test)) why.set(test, [...(why.get(test) ?? []), reason]);
  };
  for (const file of changed) note(file, `the change to ${file} reaches it`);
  for (const [file, reason] of lost) note(file, `it runs whatever changes: ${reason}`);
  return { tests: tests.filter((t) => why.has(t)), total: tests.length, why, readers };
}

/** The files the change holds (see the header), relative to `root` with `/`, sorted; or why it can't be told. */
export function changeOf(
  root: string,
  env: Record<string, string | undefined> = process.env,
  trees?: { green?: string | undefined; now?: string | undefined },
): { files: string[] } | { doubt: string } {
  const git = (args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "ignore" });
    return done.exitCode === 0 ? done.stdout.toString() : undefined;
  };
  // Two tree objects: exact, untracked files and deletions included, whatever the index holds.
  const between = (from: string, to: string) => {
    const diff = git(["diff", "--name-only", "--no-renames", "-z", from, to, "--"]);
    return diff === undefined
      ? undefined
      : {
          files: diff
            .split("\0")
            .filter((f) => f !== "")
            .sort(),
        };
  };
  const fromGreen =
    trees?.green && trees.now && git(["cat-file", "-e", `${trees.green}^{tree}`]) !== undefined
      ? between(trees.green, trees.now)
      : undefined;
  if (fromGreen !== undefined) return fromGreen;
  const base = git(["merge-base", "HEAD", "origin/main"])?.trim();
  if (base === undefined || base === "") return { doubt: "no merge base with origin/main" };
  const fromBase = trees?.now ? between(base, trees.now) : undefined;
  if (fromBase !== undefined) return fromBase;
  const diff = git(["diff", "--name-only", "--no-renames", "-z", base, "--"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (diff === undefined || untracked === undefined) return { doubt: "git can't list the change" };
  const files = new Set([...diff.split("\0"), ...untracked.split("\0")].filter((f) => f !== ""));
  return { files: [...files].sort() };
}

if (import.meta.main) {
  const selection = selectTests(process.cwd(), Bun.argv.slice(2).map(slash));
  if (selection.doubt !== undefined) console.log(`everything runs: ${selection.doubt}`);
  for (const test of selection.doubt === undefined ? selection.tests : []) {
    for (const why of selection.why.get(test) ?? []) console.log(`  ${test}: ${why}`);
  }
  const ran = `ran ${selection.tests.length} of ${selection.total} test files (the change reaches these)`;
  console.log(`${ran}${readersClause(selection.readers)}`);
}
