// The case format (ADR 0050): one YAML file per case, read and checked here, so a case that can't be scored right is
// refused with the reason before any session is spent on it.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  type CaseFile,
  type ChangeFile,
  type Corpus,
  type EvalCase,
  LANGUAGES,
  type Language,
  type Place,
  type Planted,
} from "./types.ts";

const CASE_EXTENSION = ".yaml";
const RULES_FILE = "REVIEW.md";
const CASE_FIELDS = ["id", "language", "summary", "base", "change", "planted", "clean"];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Text as git will hold it: LF line ends, whatever the checkout did to the file. */
export const lf = (text: string) => text.replaceAll("\r\n", "\n");

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads one case's fields, each refusal a sentence naming the field. */
function reader(fail: (reason: string) => never) {
  const text = (fields: Fields, key: string, at: string): string => {
    const value = fields[key];
    if (value === undefined || value === null) fail(`${at}${key} is missing`);
    if (typeof value !== "string" || value.trim() === "") fail(`${at}${key} must be a non-empty text`);
    return lf(value);
  };
  const only = (fields: Fields, keys: string[], at: string) => {
    for (const key of Object.keys(fields)) if (!keys.includes(key)) fail(`unknown field ${at}${key}`);
  };
  const list = (fields: Fields, key: string): Fields[] => {
    const value = fields[key];
    if (value === undefined || value === null) fail(`${key} is missing`);
    if (!Array.isArray(value)) fail(`${key} must be a list of files`);
    return value.map((item, i) => {
      if (!isFields(item)) fail(`${key}[${i}] must be a file: path and content`);
      return item;
    });
  };
  const path = (fields: Fields, at: string): string => {
    const value = text(fields, "path", at);
    const parts = value.split("/");
    if (
      value.startsWith("/") ||
      value.includes("\\") ||
      parts.some((p) => p === "" || p === "." || p === "..")
    )
      fail(`${at}path ${value} must be relative, with / between its parts`);
    return value;
  };
  return { text, only, list, path };
}

const isLanguage = (value: string): value is Language => Object.hasOwn(LANGUAGES, value);

/** The base's files and the change's, each path once; a deleted file is one the base has. */
function filesOf(
  parsed: Fields,
  read: ReturnType<typeof reader>,
  fail: (reason: string) => never,
): { base: CaseFile[]; change: ChangeFile[] } {
  const once = (key: string, paths: string[]) => {
    const twice = paths.find((p, i) => paths.indexOf(p) !== i);
    if (twice !== undefined) fail(`${key} lists ${twice} twice`);
  };
  const pathOf = (file: Fields, at: string) => {
    const path = read.path(file, at);
    if (path === RULES_FILE) fail(`${at}path: ${RULES_FILE} is the corpus', shared by every case`);
    return path;
  };
  const base: CaseFile[] = read.list(parsed, "base").map((file, i) => {
    const at = `base[${i}].`;
    read.only(file, ["path", "content"], at);
    return { path: pathOf(file, at), content: read.text(file, "content", at) };
  });
  once(
    "base",
    base.map((f) => f.path),
  );
  const change: ChangeFile[] = read.list(parsed, "change").map((file, i) => {
    const at = `change[${i}].`;
    read.only(file, ["path", "content", "deleted"], at);
    const path = pathOf(file, at);
    if (file.deleted === undefined) {
      const content = read.text(file, "content", at);
      if (base.some((f) => f.path === path && f.content === content))
        fail(`${at}content is ${path} as the base has it: the change doesn't touch it`);
      return { path, content };
    }
    if (file.deleted !== true) fail(`${at}deleted must be true`);
    if (file.content !== undefined) fail(`${at}content: a deleted file has none`);
    if (!base.some((f) => f.path === path)) fail(`${at}path ${path} is deleted but not in the base`);
    return { path, deleted: true };
  });
  if (change.length === 0) fail("change must write or delete at least one file");
  once(
    "change",
    change.map((f) => f.path),
  );
  return { base, change };
}

/** The lines of a file's text: a last line ending in a newline is not followed by an empty one. */
const lineCount = (content: string) => content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

/**
 * One case file: `name` its file name (`<id>.yaml`), `text` its YAML. Throws an `Error` naming the file and the
 * reason when the case can't be scored as written.
 */
export function parseCase(name: string, text: string): EvalCase {
  const fail = (reason: string): never => {
    throw new Error(`${name}: ${reason}`);
  };
  if (!name.endsWith(CASE_EXTENSION)) fail(`a case is a ${CASE_EXTENSION} file`);
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(lf(text));
  } catch (error) {
    fail(`not YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isFields(parsed)) return fail("a case is a mapping of its fields");
  const read = reader(fail);
  read.only(parsed, CASE_FIELDS, "");
  const id = read.text(parsed, "id", "");
  if (!ID.test(id)) fail(`id ${id} must be lowercase words joined by -`);
  const stem = basename(name, CASE_EXTENSION);
  if (id !== stem) fail(`id ${id} is not the file's name (${stem})`);
  const language = read.text(parsed, "language", "");
  if (!isLanguage(language))
    return fail(`language ${language} is not one of ${Object.keys(LANGUAGES).join(", ")}`);
  const summary = read.text(parsed, "summary", "");

  const { base, change } = filesOf(parsed, read, fail);

  const clean = parsed.clean;
  if (clean !== undefined && clean !== true) fail("clean must be true");
  if (parsed.planted !== undefined && clean === true)
    fail("a case is either planted or clean: true, not both");
  if (parsed.planted === undefined && clean !== true) fail("a case needs planted or clean: true");
  const planted = clean === true ? null : plantedOf(parsed.planted, change, read, fail);
  return { id, language, summary, base, change, planted };
}

function plantedOf(
  value: unknown,
  change: ChangeFile[],
  read: ReturnType<typeof reader>,
  fail: (reason: string) => never,
): Planted {
  if (!isFields(value)) return fail("planted must be path, ranges and what");
  read.only(value, ["path", "ranges", "also", "what"], "planted.");
  const { path, ranges } = placeOf(value, "planted.", "planted", change, read, fail);
  const what = read.text(value, "what", "planted.");
  if (value.also === undefined) return { path, ranges, what };
  if (!Array.isArray(value.also) || value.also.length === 0)
    return fail("planted.also must list one or more places: path and ranges");
  const also = value.also.map((place: unknown, i) => {
    const at = `planted.also[${i}]`;
    if (!isFields(place)) return fail(`${at} must be a place: path and ranges`);
    read.only(place, ["path", "ranges"], `${at}.`);
    return placeOf(place, `${at}.`, at, change, read, fail);
  });
  return { path, ranges, also, what };
}

/**
 * A place's path and ranges, `at` naming its fields and `name` it in a range's refusal: a file the change writes,
 * each range within its head lines.
 */
function placeOf(
  value: Fields,
  at: string,
  name: string,
  change: ChangeFile[],
  read: ReturnType<typeof reader>,
  fail: (reason: string) => never,
): Place {
  const path = read.path(value, at);
  const file = change.find((f) => f.path === path);
  if (file === undefined || !("content" in file))
    return fail(`${at}path ${path} is not a file the change writes`);
  const lines = lineCount(file.content);
  const ranges = value.ranges;
  if (ranges === undefined || ranges === null) return fail(`${at}ranges is missing`);
  if (!Array.isArray(ranges) || ranges.length === 0)
    return fail(`${at}ranges must list one or more [start, end]`);
  const checked = ranges.map((range: unknown): [number, number] => {
    const [start, end] = Array.isArray(range) && range.length === 2 ? range : [];
    if (!Number.isInteger(start) || !Number.isInteger(end))
      return fail(`${at}ranges: ${JSON.stringify(range)} is not [start, end]`);
    if (start < 1 || end < start || end > lines)
      fail(`${name} range [${start}, ${end}] is outside ${path}'s ${lines} lines (or ends before it starts)`);
    return [start, end];
  });
  return { path, ranges: checked };
}

/** Every file under `dir`, by its path relative to it. */
function filesUnder(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path, root) : [relative(root, path)];
  });
}

/**
 * The corpus in `dir`: every `<id>.yaml` at its top, in name order, and its `REVIEW.md`. Refuses any other file
 * anywhere under it (a source file there is what the linter and the type checker would read), naming it.
 */
export function loadCorpus(dir: string): Corpus {
  const files = filesUnder(dir).sort();
  const strange = files.find(
    (f) => f !== RULES_FILE && (f.includes("/") || f.includes("\\") || !f.endsWith(CASE_EXTENSION)),
  );
  if (strange !== undefined)
    throw new Error(
      `${join(dir, strange)}: only case files (${CASE_EXTENSION}) and ${RULES_FILE} go in the corpus`,
    );
  if (!files.includes(RULES_FILE))
    throw new Error(`${dir} has no ${RULES_FILE}: every case's default branch carries it`);
  return {
    cases: files.filter((f) => f !== RULES_FILE).map((f) => parseCase(f, readFileSync(join(dir, f), "utf8"))),
    review: lf(readFileSync(join(dir, RULES_FILE), "utf8")),
  };
}
