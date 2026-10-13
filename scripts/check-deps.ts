// `bun run imports`: ADR 0033's allowed imports and module shape, the layer Biome can't hold (ADR 0036).
// Biome's `noRestrictedImports` overrides in `biome.jsonc` give per-file messages while editing; this script
// holds the package level. Each package declares its own edges, so two branches adding packages don't collide
// on one central list: its package.json's `"lookover"` field gives `imports` (each allowed `@lookover/*`
// package, with why, from ADR 0033's list), `pure` (no `node:` or `bun:` module, no adapter), an optional
// `note`, and optional `entries`: a second entry, `./<name>` for `src/<name>.ts`, with the audience it serves
// (testkit's `./demo`, for demo mode). `bun run flags` shows every change to that field to the owner. It checks,
// for every package under `packages/` and `apps/`:
// - `package.json`: a well-formed `"lookover"` field, no edge ADR 0033 forbids, `@lookover/*` dependencies
//   that are declared, and for a library an `exports` that is its entry and the second entries it declares;
// - a pure package is covered by a Biome override that bans `node:` and `bun:` modules for its `src/`;
// - every import in `src/`, type-only ones included (`scanImports` drops those, so a regex adds them):
//   another package only by name, never deep, never by a relative path, and only if declared;
//   pure packages import no `node:` or `bun:` module (`bun:test` only in test files);
// - no import cycle between a package's files (type-only imports don't count, as in Biome's `noImportCycles`);
// - where a package has a `src/index.ts`: it opens with a header comment, and its tests import only it, or
//   the test support its test files share (`*.test-support.ts`), held to the same rule and imported by tests
//   alone;
// - a second entry opens with a header comment too, is imported by its path (`@lookover/<package>/<name>`),
//   and never reaches `bun:test`: its audience runs outside a test.
// Exits 1 and prints one line per violation, each naming the allowed seam and the ADR.
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";

// Edges ADR 0033 forbids whatever a package declares: `agent-cli` never imports `github`, so it can never
// hold the App's key or a token (ADR 0021).
const NEVER: Record<string, Record<string, string>> = {
  "@lookover/agent-cli": {
    "@lookover/github": "so it can never hold the App's key or a token (ADR 0021)",
  },
};
const EVERYONE = "@lookover/contracts";
// The fakes and the port suites are for every package's tests (ADR 0039): a test file may import `testkit`,
// and a package may list it as a devDependency. Library code never may: the fakes stand in for adapters.
const TESTKIT = "@lookover/testkit";
const ADR = "(ADR 0033)";
const DECLARE = `"lookover": { "imports": { "@lookover/<package>": "<why>" }, "pure": true } (pure only when it imports no node: or bun: module)`;

/**
 * A package's own declaration: the `@lookover/*` packages it may import, whether it is pure, and its second
 * entries (`./<name>`), each for an audience outside tests.
 */
type Declaration = { imports: string[]; pure: boolean; entries: string[] };
/** `entry`: the package's public `src/index.ts`, when it has one. `apps/web` has none: its entry is `src/main.tsx`. */
type Pkg = {
  name: string;
  dir: string;
  manifest: string;
  json: Manifest;
  entry: string | undefined;
  declared: Declaration | undefined;
};
type Manifest = {
  name?: unknown;
  exports?: unknown;
  lookover?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
type Spec = { path: string; line: number; typeOnly: boolean };

const root = process.cwd();
// One per syntax: a `.ts` file may hold `<T>value`, which the tsx parser rejects.
const TRANSPILERS = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
// Static imports and re-exports, type-only ones included. Stops at `;` so it never spans two statements.
const FROM = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
const NODE_BUILTINS = new Set(builtinModules);
// A test file, or test support: what several test files of a package share (a harness, its helpers). Both are
// tests for these rules: they may import `testkit` and `bun:test`, and reach their package through its entry.
const TEST_FILE = /\.test(?:-support)?\.tsx?$/;
const TEST_SUPPORT = /\.test-support\.tsx?$/;
const errors: string[] = [];

const declared = new Map<string, Declaration>();
const allowedFor = (pkg: string) => new Set([EVERYONE, ...(declared.get(pkg)?.imports ?? [])]);
const list = (pkg: string) => [...allowedFor(pkg)].join(", ");
const isPure = (pkg: string) => declared.get(pkg)?.pure === true;
const entriesOf = (pkg: string) => declared.get(pkg)?.entries ?? [];
/** A second entry's name, `./<name>`: lower-case words joined by `-`, the file `src/<name>.ts`. */
const ENTRY = /^\.\/[a-z]+(?:-[a-z]+)*$/;
const entryFile = (dir: string, entry: string) => resolve(dir, "src", `${entry.slice(2)}.ts`);
const at = (file: string, line?: number) =>
  `${relative(root, file).replaceAll("\\", "/")}${line ? `:${line}` : ""}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasons = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((why) => typeof why === "string" && why !== "");

/**
 * The `"lookover"` field, when well formed: `imports` maps each package to why; `pure`, `note` and `entries`
 * (each second entry, `./<name>`, to the audience it serves) are optional.
 */
function declarationOf(json: Manifest): Declaration | undefined {
  const field = json.lookover;
  if (!isRecord(field) || !isReasons(field.imports)) return undefined;
  if (field.pure !== undefined && typeof field.pure !== "boolean") return undefined;
  if (field.note !== undefined && typeof field.note !== "string") return undefined;
  const entries = field.entries ?? {};
  if (!isReasons(entries) || !Object.keys(entries).every((e) => ENTRY.test(e))) return undefined;
  return { imports: Object.keys(field.imports), pure: field.pure === true, entries: Object.keys(entries) };
}

async function loadPackages(): Promise<Pkg[]> {
  const pkgs: Pkg[] = [];
  for await (const p of new Bun.Glob("{packages,apps}/*/package.json").scan(root)) {
    const manifest = resolve(root, p);
    const json: Manifest = await Bun.file(manifest).json();
    const name = typeof json.name === "string" ? json.name : p;
    const entry = resolve(dirname(manifest), "src", "index.ts");
    const pkg = { name, dir: dirname(manifest), manifest, json, declared: declarationOf(json) };
    pkgs.push({ ...pkg, entry: existsSync(entry) ? entry : undefined });
    // A forbidden edge is never allowed, declared or not; checkManifest reports the declaration.
    const never = NEVER[name] ?? {};
    const imports = (pkg.declared?.imports ?? []).filter((dep) => !(dep in never));
    declared.set(name, { imports, pure: pkg.declared?.pure === true, entries: pkg.declared?.entries ?? [] });
  }
  return pkgs;
}

function checkDeclaration(pkg: Pkg) {
  if (pkg.declared === undefined) {
    errors.push(
      `${at(pkg.manifest)}: ${pkg.name} has no "lookover" field, or a malformed one. Declare its allowed imports from ADR 0033's list, each with why: ${DECLARE} ${ADR}.`,
    );
    return;
  }
  for (const [dep, why] of Object.entries(NEVER[pkg.name] ?? {})) {
    if (pkg.declared.imports.includes(dep)) {
      errors.push(
        `${at(pkg.manifest)}: ${pkg.name} never imports ${dep}, ${why}. Remove it from "lookover" ${ADR}.`,
      );
    }
  }
}

function checkManifest(pkg: Pkg) {
  checkDeclaration(pkg);
  const allowed = allowedFor(pkg.name);
  const deps = { ...pkg.json.dependencies, ...pkg.json.devDependencies, ...pkg.json.peerDependencies };
  for (const dep of Object.keys(deps)) {
    const forTests = dep === TESTKIT && !(dep in { ...pkg.json.dependencies, ...pkg.json.peerDependencies });
    if (dep.startsWith("@lookover/") && !allowed.has(dep) && !forTests) {
      errors.push(
        `${at(pkg.manifest)}: ${pkg.name} may not depend on ${dep}. It may depend only on ${list(pkg.name)}${dep === TESTKIT ? `, or on ${TESTKIT} as a devDependency for its tests` : ""}; a new edge must be on ADR 0033's list and declared in its "lookover" field ${ADR}.`,
      );
    }
  }
  const isLibrary = relative(root, pkg.dir).startsWith("packages");
  const wanted: Record<string, string> = { ".": "./src/index.ts" };
  for (const entry of entriesOf(pkg.name)) wanted[entry] = `./src/${entry.slice(2)}.ts`;
  const exportsOk = JSON.stringify(pkg.json.exports) === JSON.stringify(wanted);
  if (isLibrary && !exportsOk) {
    errors.push(
      `${at(pkg.manifest)}: "exports" must be exactly ${JSON.stringify(wanted)}: src/index.ts is the package's public entry, and a second one only as its "lookover" field's "entries" declares it, with the audience it serves ${ADR}.`,
    );
  }
}

/** The `src/**` globs that a Biome override bans `node:` and `bun:` modules in (a group naming `:NODE:`). */
function biomePureGlobs(): Set<string> {
  const config: unknown = Bun.JSONC.parse(readFileSync(resolve(root, "biome.jsonc"), "utf8"));
  const overrides = isRecord(config) && Array.isArray(config.overrides) ? config.overrides : [];
  const globs = new Set<string>();
  for (const override of overrides) {
    if (!isRecord(override) || !Array.isArray(override.includes) || !bansRuntime(override)) continue;
    for (const glob of override.includes) if (typeof glob === "string") globs.add(glob);
  }
  return globs;
}

/** Whether an override's `noRestrictedImports` has a pattern group naming `:NODE:`. */
function bansRuntime(override: Record<string, unknown>): boolean {
  let node: unknown = override;
  for (const key of ["linter", "rules", "style", "noRestrictedImports", "options", "patterns"]) {
    node = isRecord(node) ? node[key] : undefined;
  }
  const patterns = Array.isArray(node) ? node : [];
  return patterns.some((p) => isRecord(p) && Array.isArray(p.group) && p.group.includes(":NODE:"));
}

/** A pure package must also be pure in the editor: Biome's override is the hidden second half of `pure`. */
function checkBiomeOverride(pkg: Pkg, globs: Set<string>) {
  const glob = `${relative(root, pkg.dir).replaceAll("\\", "/")}/src/**`;
  if (isPure(pkg.name) && !globs.has(glob)) {
    errors.push(
      `${at(pkg.manifest)}: ${pkg.name} is pure, but biome.jsonc has no noRestrictedImports override banning node: and bun: modules for ${glob}. Add "${glob}" to the "includes" of the pure packages' override (ADR 0033, ADR 0036).`,
    );
  }
}

function lineOf(src: string, path: string): number {
  const i = Math.max(src.indexOf(`"${path}"`), src.indexOf(`'${path}'`));
  return i < 0 ? 1 : src.slice(0, i).split("\n").length;
}

function importsOf(file: string, src: string): Spec[] {
  const transpiler = file.endsWith(".tsx") ? TRANSPILERS.tsx : TRANSPILERS.ts;
  const values = new Set(transpiler.scanImports(src).map((i) => i.path));
  const all = new Set([...values, ...[...src.matchAll(FROM)].map((m) => m[1] ?? "")]);
  all.delete("");
  return [...all].map((path) => ({ path, line: lineOf(src, path), typeOnly: !values.has(path) }));
}

/** The file a relative import lands on, as Bun and TypeScript resolve it here. */
function resolveFile(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  return candidates.find((c) => statSync(c, { throwIfNoEntry: false })?.isFile()) ?? base;
}

function checkRelative(pkg: Pkg, pkgs: Pkg[], file: string, s: Spec) {
  const target = resolveFile(file, s.path);
  if (target.startsWith(pkg.dir + sep)) return target;
  const other = pkgs.find((p) => target.startsWith(p.dir + sep));
  const fix = other
    ? `Import ${other.name} by name${allowedFor(pkg.name).has(other.name) ? "" : `, if the list allows it; ${pkg.name} may import only ${list(pkg.name)}`}`
    : `A package reaches other code only through a package's name; ${pkg.name} may import only ${list(pkg.name)}`;
  errors.push(`${at(file, s.line)}: relative import "${s.path}" leaves ${pkg.name}. ${fix} ${ADR}.`);
  return undefined;
}

function checkPackageImport(pkg: Pkg, file: string, s: Spec) {
  const name = s.path.split("/").slice(0, 2).join("/");
  const entry = `.${s.path.slice(name.length)}`;
  if (name !== s.path && !entriesOf(name).includes(entry)) {
    errors.push(
      `${at(file, s.line)}: deep import "${s.path}". Import "${name}": its src/index.ts is the only public entry ${ADR}.`,
    );
  }
  const forTests = name === TESTKIT && TEST_FILE.test(file);
  if (name !== pkg.name && !allowedFor(pkg.name).has(name) && !forTests) {
    errors.push(
      `${at(file, s.line)}: ${pkg.name} may not import ${name}. It may import only ${list(pkg.name)}${name === TESTKIT ? `; a test file may import ${TESTKIT}` : ""} ${ADR}.`,
    );
  }
}

function checkPure(pkg: Pkg, file: string, s: Spec) {
  const runtime = /^(?:node|bun):/.test(s.path) || s.path === "bun" || NODE_BUILTINS.has(s.path);
  const testRunner = s.path === "bun:test" && TEST_FILE.test(file);
  if (runtime && !testRunner) {
    errors.push(
      `${at(file, s.line)}: ${pkg.name} is pure: no "${s.path}". Take time, IDs or I/O as a port from ${EVERYONE}, passed in as a parameter ${ADR}.`,
    );
  }
}

/**
 * A test reaches its package through `src/index.ts` only: it tests the interface, not the internals. Test
 * support counts as a test, so what a test reaches through it is the entry too; library code never imports it.
 */
function checkTestImport(pkg: Pkg, file: string, s: Spec, target: string) {
  const test = TEST_FILE.test(file);
  const support = TEST_SUPPORT.test(target);
  // Only `src/` is read here: test support anywhere else would reach past the entry unseen.
  if (support && !target.startsWith(resolve(pkg.dir, "src") + sep)) {
    errors.push(
      `${at(file, s.line)}: imports "${s.path}", test support outside src/. Test support lives in its package's src/, where its own imports are checked; move it there ${ADR}.`,
    );
  }
  if (pkg.entry && test && target !== pkg.entry && !support) {
    errors.push(
      `${at(file, s.line)}: test imports "${s.path}". A test imports only its package's src/index.ts, the interface it tests, or test support (*.test-support.ts) held to the same rule; export what it needs from there ${ADR}.`,
    );
  }
  if (!test && support) {
    errors.push(
      `${at(file, s.line)}: imports "${s.path}", and only a test or test support imports test support: it may reach testkit and bun:test. Move what library code needs out of it ${ADR}.`,
    );
  }
}

/** Checks one import; returns the file it lands on when it is a value import inside the package. */
function checkImport(pkg: Pkg, pkgs: Pkg[], file: string, s: Spec): string | undefined {
  if (s.path.startsWith(".")) {
    const target = checkRelative(pkg, pkgs, file, s);
    if (target) checkTestImport(pkg, file, s, target);
    return s.typeOnly ? undefined : target;
  }
  if (s.path.startsWith("@lookover/")) checkPackageImport(pkg, file, s);
  else if (isPure(pkg.name)) checkPure(pkg, file, s);
  return undefined;
}

// A comment that opens the file and is not a directive: `/// <reference …>` and `biome-ignore` don't count.
const HEADER = /^\s*(?:\/\/(?!\/)(?!\s*biome-ignore)|\/\*(?!\s*biome-ignore))/;

/** Each entry opens with the module's header: an agent working elsewhere reads it instead of the code. */
async function checkHeader(pkg: Pkg) {
  if (pkg.entry && !HEADER.test(await Bun.file(pkg.entry).text())) {
    errors.push(
      `${at(pkg.entry, 1)}: src/index.ts has no header comment. Open it with the decision ${pkg.name} hides, its interface with invariants and error modes, and what it must never know ${ADR}.`,
    );
  }
  for (const entry of entriesOf(pkg.name)) {
    const file = entryFile(pkg.dir, entry);
    if (!existsSync(file) || !HEADER.test(await Bun.file(file).text())) {
      errors.push(
        `${at(file, 1)}: the second entry "${entry}" has no header comment. Open it with the audience it serves and what it gives them ${ADR}.`,
      );
    }
  }
}

/** A package's files: the files each imports for its values inside the package, and those that import `bun:test`. */
type Sources = { graph: Map<string, string[]>; testRunner: Set<string> };

/** The chain of files from `start` to the first one it reaches that imports the test runner, or null. */
function pathToTestRunner(start: string, { graph, testRunner }: Sources): string[] | null {
  const from = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (testRunner.has(file)) {
      const chain: string[] = [];
      for (let f: string | null | undefined = file; f; f = from.get(f)) chain.unshift(f);
      return chain;
    }
    for (const next of (graph.get(file) ?? []).filter((n) => !from.has(n))) {
      from.set(next, file);
      queue.push(next);
    }
  }
  return null;
}

/** A second entry serves an audience outside tests: no file it reaches imports the test runner. */
function checkEntriesReach(pkg: Pkg, sources: Sources) {
  for (const entry of entriesOf(pkg.name)) {
    const start = entryFile(pkg.dir, entry);
    const chain = pathToTestRunner(start, sources);
    if (chain === null) continue;
    errors.push(
      `${at(start, 1)}: the second entry "${entry}" reaches bun:test (${chain.map((f) => at(f)).join(" → ")}). Its audience runs outside a test: export what imports the test runner from src/index.ts only ${ADR}.`,
    );
  }
}

async function checkSources(pkg: Pkg, pkgs: Pkg[]): Promise<Sources> {
  const graph = new Map<string, string[]>();
  const testRunner = new Set<string>();
  for await (const f of new Bun.Glob("src/**/*.{ts,tsx}").scan(pkg.dir)) {
    const file = resolve(pkg.dir, f);
    const specs = importsOf(file, await Bun.file(file).text());
    if (specs.some((s) => s.path === "bun:test" && !s.typeOnly)) testRunner.add(file);
    graph.set(
      file,
      specs.flatMap((s) => checkImport(pkg, pkgs, file, s) ?? []),
    );
  }
  return { graph, testRunner };
}

/** Reports each import cycle once, as the chain of files that closes it. */
function checkCycles(graph: Map<string, string[]>) {
  const done = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string, path: string[]) => {
    if (done.has(file)) return;
    const loop = path.indexOf(file);
    if (loop >= 0) {
      const chain = [...path.slice(loop), file].map((f) => at(f)).join(" → ");
      const key = [...path.slice(loop)].sort().join("|");
      if (!seen.has(key))
        errors.push(
          `${chain}: import cycle. Move what both files need into a third file they both import; modules stay layered ${ADR}.`,
        );
      seen.add(key);
      return;
    }
    for (const next of graph.get(file) ?? []) visit(next, [...path, file]);
    done.add(file);
  };
  for (const file of graph.keys()) visit(file, []);
}

const pkgs = await loadPackages();
const pureGlobs = biomePureGlobs();
for (const pkg of pkgs) {
  checkManifest(pkg);
  checkBiomeOverride(pkg, pureGlobs);
  await checkHeader(pkg);
  const sources = await checkSources(pkg, pkgs);
  checkCycles(sources.graph);
  checkEntriesReach(pkg, sources);
}
if (errors.length > 0) {
  console.error(`Module boundaries broken (ADR 0033, checked by scripts/check-deps.ts):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
