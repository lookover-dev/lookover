// Finding a line by its text (ADR 0044, I-158): the nearest line a hunk shows on that side whose text matches,
// whitespace aside. The expected lines are read by hand off the diff below.
import { expect, test } from "bun:test";
import type { DiffLocation, DiffSide } from "@lookover/contracts";
import { findLine, findRange, indexDiff, type LineFound } from "./index.ts";

const unified = (lines: string[]) => lines.map((l) => `${l}\n`).join("");

const at = (path: string, side: DiffSide, line: number): DiffLocation => ({ path, side, line });
const found = (line: number): LineFound => ({ kind: "found", line });
const NONE: LineFound = { kind: "none", reason: "not_in_diff" };
const CUT: LineFound = { kind: "none", reason: "diff_truncated" };

// head: 1 a, 2 return x;, 3 b, 4 return x;, 5 c, 6 return y;, 7 d   base: 2 return z; (removed)
const INDEX = indexDiff(
  unified([
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,4 +1,7 @@",
    " a",
    "-  return z;",
    "+  return x;",
    " b",
    "+  return x;",
    "+c",
    "+  return y;",
    " d",
  ]),
);

test("a line whose text matches is kept", () => {
  expect(findLine(INDEX, at("src/a.ts", "head", 4), "  return x;")).toEqual(found(4));
});

test("a line one off moves to the nearest line with the text, the one above on a tie", () => {
  expect(findLine(INDEX, at("src/a.ts", "head", 5), "  return y;")).toEqual(found(6));
  expect(findLine(INDEX, at("src/a.ts", "head", 3), "  return x;")).toEqual(found(2));
  expect(findLine(INDEX, at("src/a.ts", "head", 9), "  return x;")).toEqual(found(4));
});

test("whitespace is not compared: indentation and runs of spaces", () => {
  expect(findLine(INDEX, at("src/a.ts", "head", 6), "return    y;")).toEqual(found(6));
  expect(findLine(INDEX, at("src/a.ts", "head", 6), "\treturn y;  ")).toEqual(found(6));
});

test("only the side asked: a removed line on base, an added or context line on head", () => {
  expect(findLine(INDEX, at("src/a.ts", "base", 1), "return z;")).toEqual(found(2));
  expect(findLine(INDEX, at("src/a.ts", "head", 2), "return z;")).toEqual(NONE);
  // Line 1 `a` is a context line: on base it takes no comment, so it is not offered.
  expect(findLine(INDEX, at("src/a.ts", "base", 1), "a")).toEqual(NONE);
});

test("no line with the text, or no such file: none", () => {
  expect(findLine(INDEX, at("src/a.ts", "head", 2), "return w;")).toEqual(NONE);
  expect(findLine(INDEX, at("src/b.ts", "head", 2), "  return x;")).toEqual(NONE);
});

test("a range is found by its first line's text, its end line moved as far; a single line keeps no end", () => {
  const range = (line: number, endLine: number | null) => ({
    path: "src/a.ts",
    side: "head" as const,
    line,
    endLine,
  });
  expect(findRange(INDEX, range(5, 7), "  return y;")).toEqual({ kind: "found", line: 6, endLine: 8 });
  expect(findRange(INDEX, range(3, 4), "  return x;")).toEqual({ kind: "found", line: 2, endLine: 3 });
  expect(findRange(INDEX, range(5, null), "  return y;")).toEqual({ kind: "found", line: 6, endLine: null });
  expect(findRange(INDEX, range(2, 4), "return w;")).toEqual(NONE);
});

test("in a diff cut short, a text not found may lie past the cut only in the file the cut fell in, or one not read", () => {
  const cut = indexDiff(
    unified([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,3 +1,3 @@",
      " one",
    ]),
  );
  expect(cut.truncated).toBe(true);
  expect(findLine(cut, at("src/a.ts", "head", 1), "elsewhere")).toEqual(NONE);
  expect(findLine(cut, at("src/b.ts", "head", 2), "two")).toEqual(CUT);
  expect(findLine(cut, at("src/c.ts", "head", 2), "two")).toEqual(CUT);
  expect(findLine(cut, at("src/b.ts", "head", 9), "one")).toEqual(found(1));
});
