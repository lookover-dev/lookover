// The hunk a line is in (ADR 0044): what the confirm pass shows the confirmer of each claim. The expected texts
// are read by hand off the diff below.
import { expect, test } from "bun:test";
import type { DiffLocation, DiffSide } from "@lookover/contracts";
import { hunkAt, indexDiff } from "./index.ts";

const unified = (lines: string[]) => lines.map((l) => `${l}\n`).join("");
const at = (path: string, side: DiffSide, line: number): DiffLocation => ({ path, side, line });

const FIRST = ["@@ -1,3 +1,3 @@", " a", "-  return z;", "+  return x;", " b"];
const SECOND = ["@@ -10,2 +10,3 @@", " j", "+k", " l"];
const INDEX = indexDiff(
  unified([
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    ...FIRST,
    ...SECOND,
    "diff --git a/old.ts b/new.ts",
    "similarity index 90%",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -4,1 +4,1 @@",
    "-before",
    "+after",
  ]),
);

test("a line of a hunk on its side gives that hunk, header first, each line with its marker", () => {
  expect(hunkAt(INDEX, at("src/a.ts", "head", 2))).toBe(FIRST.join("\n"));
  expect(hunkAt(INDEX, at("src/a.ts", "head", 11))).toBe(SECOND.join("\n"));
  expect(hunkAt(INDEX, at("src/a.ts", "base", 2))).toBe(FIRST.join("\n"));
});

test("a context line is in its hunk on either side", () => {
  expect(hunkAt(INDEX, at("src/a.ts", "head", 1))).toBe(FIRST.join("\n"));
  expect(hunkAt(INDEX, at("src/a.ts", "base", 10))).toBe(SECOND.join("\n"));
});

test("a renamed file is found by either path, as place finds it", () => {
  const hunk = ["@@ -4,1 +4,1 @@", "-before", "+after"].join("\n");
  expect(hunkAt(INDEX, at("new.ts", "head", 4))).toBe(hunk);
  expect(hunkAt(INDEX, at("old.ts", "head", 4))).toBe(hunk);
});

// A new file of 40 lines, `line 1` to `line 40`: one hunk, every line added.
const BIG = indexDiff(
  unified([
    "diff --git a/big.ts b/big.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/big.ts",
    "@@ -0,0 +1,40 @@",
    ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
  ]),
);

test("around a line, only that many lines of its hunk either side, with the header of what is shown", () => {
  expect(hunkAt(BIG, at("big.ts", "head", 20), 2)).toBe(
    ["@@ -0,0 +18,5 @@", "+line 18", "+line 19", "+line 20", "+line 21", "+line 22"].join("\n"),
  );
  // A range is shown whole, with the lines around it; the hunk's edge stops the window.
  expect(hunkAt(BIG, { ...at("big.ts", "head", 2), endLine: 4 }, 1)).toBe(
    ["@@ -0,0 +1,5 @@", "+line 1", "+line 2", "+line 3", "+line 4", "+line 5"].join("\n"),
  );
  // The counts are the shown lines' on each side; a side with none starts after its last line above, as git's do.
  expect(hunkAt(INDEX, at("src/a.ts", "head", 2), 0)).toBe(["@@ -2,0 +2,1 @@", "+  return x;"].join("\n"));
  expect(hunkAt(INDEX, at("src/a.ts", "head", 2), 1)).toBe(
    ["@@ -2,2 +2,2 @@", "-  return z;", "+  return x;", " b"].join("\n"),
  );
});

test("a line no hunk shows, or a file not in the diff, has no hunk", () => {
  expect(hunkAt(INDEX, at("src/a.ts", "head", 6))).toBeNull();
  expect(hunkAt(INDEX, at("src/b.ts", "head", 1))).toBeNull();
});
