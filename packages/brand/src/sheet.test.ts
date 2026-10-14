// The brand sheet: `bun run brand` writes its marked regions (the wordmarks, the drawings its script shows, the
// loader's CSS and the numbers) from the source and keeps the hand-written rest; a hand edit of a region fails the
// check, naming the sheet, and no number of the eyes is typed by hand outside a region.
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLOURS,
  driftedCopies,
  LOADER,
  MARK,
  SHEET,
  sheet,
  WORDMARK,
  wordmark,
  writeCopies,
} from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new folder standing for a checkout with docs/, removed after the test. */
function checkout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookover-brand-sheet-")));
  dirs.push(dir);
  mkdirSync(join(dir, "docs"));
  return dir;
}

const REGIONS = [
  ["/*", "the loader's CSS", "*/"],
  ["<!--", "the wordmark on paper", "-->"],
  ["<!--", "the wordmark on ink", "-->"],
  ["<!--", "the numbers", "-->"],
  ["/*", "the drawings", "*/"],
] as const;

const begin = (open: string, name: string, close: string) =>
  `${open} Written by \`bun run brand\` from @lookover/brand (ADR 0063): ${name}. Never edit by hand. ${close}`;
const end = (open: string, name: string, close: string) =>
  `${open} End of ${name}, written by \`bun run brand\`. ${close}`;

/** A sheet with every region empty, between hand-written lines. */
const skeleton = REGIONS.flatMap(([open, name, close]) => [
  `hand-written before ${name}`,
  begin(open, name, close),
  "long gone 14.25",
  end(open, name, close),
]).join("\n");

/** The sheet without its generated regions: what is written by hand. */
function handWritten(text: string): string {
  return REGIONS.reduce((rest, [open, name, close]) => {
    const from = rest.indexOf(begin(open, name, close));
    const to = rest.indexOf(end(open, name, close));
    if (from < 0 || to < 0) throw new Error(`the sheet has lost a marker of ${name}`);
    return rest.slice(0, from) + rest.slice(to);
  }, text);
}

test("the regions are drawn from the source and the hand-written rest is kept", () => {
  const text = sheet(`${skeleton}\n`);
  for (const [, name] of REGIONS) expect(text).toContain(`hand-written before ${name}`);
  expect(text).not.toContain("long gone");
  expect(text).toContain(".eyes .p {\n  transform: translateY(3.85px);\n}\n");
  expect(text).toContain("vertical-align: -0.0625em;");
  expect(text).toContain(wordmark(COLOURS.ink, COLOURS.accent));
  expect(text).toContain(wordmark(COLOURS.paper, COLOURS.accent, true));
  expect(text).toContain("<td>disc r 13.67 on a 64 × 44 box, centres 13.67 and 50.33</td>");
  expect(text).toContain("<td>ring, outer r 9.4, 3.6 thick</td>");
  expect(text).toContain("var EYES = {");
  expect(sheet(text)).toBe(text);
});

test("an empty sheet is its regions alone, and stays so", () => {
  const text = sheet("");
  for (const [open, name, close] of REGIONS) expect(text).toContain(begin(open, name, close));
  expect(sheet(text)).toBe(text);
});

test("a sheet that lost a region is refused, naming it and the region", () => {
  const lost = skeleton.replace(end("<!--", "the numbers", "-->"), "");
  expect(() => sheet(lost)).toThrow(`${SHEET} has lost the region of the numbers \`bun run brand\` writes`);
});

test("a hand edit of a number in a region fails the check, naming the sheet", () => {
  const root = checkout();
  writeCopies(root);
  expect(driftedCopies(root)).toEqual([]);
  const file = join(root, SHEET);
  writeFileSync(file, readFileSync(file, "utf8").replace("<td>disc r 9.4</td>", "<td>disc r 9.5</td>"));
  expect(driftedCopies(root)).toEqual([`${SHEET} is not what the source draws: run \`bun run brand\`.`]);
});

/** Every number in `value` that is not a whole number, walked through its objects and arrays. */
function fractions(value: unknown): number[] {
  if (typeof value === "number") return Number.isInteger(value) ? [] : [value];
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(fractions);
  return [];
}

test("the numbers looked for are every fraction of the source", () => {
  expect(fractions({ a: 1, b: [2.5, { c: -0.25, d: "3.5" }] })).toEqual([2.5, -0.25]);
});

/** This checkout's sheet: the public tree has no `docs/`, so no sheet to look at there. */
const checkedOutSheet = join(import.meta.dir, "..", "..", "..", SHEET);

test.skipIf(!existsSync(checkedOutSheet))(
  "the sheet in this checkout types no number of the eyes outside its regions",
  () => {
    const text = readFileSync(checkedOutSheet, "utf8").replaceAll("\r\n", "\n");
    const rest = handWritten(text);
    // The source's fractions, and the old loader's numbers the sheet once typed by hand. A number after `px/` is the
    // line height of the page's own `font:` shorthand (`12px/1.2`), not a number of the eyes.
    const numbers = new Set([...fractions([MARK, LOADER, WORDMARK]), 14.25, 5.35, 3.29, 11.95].map(Math.abs));
    expect(numbers).toContain(MARK.solidPupilRx);
    for (const n of numbers)
      expect(rest).not.toMatch(new RegExp(`(?<![\\d.]|px/)${String(n).replace(".", "\\.")}(?![\\d])`));
  },
);
