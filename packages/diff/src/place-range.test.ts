// A range of lines goes inline only on one side, in one hunk (spikes/03-github step 10: a range from LEFT 9
// to RIGHT 10 is a 422, "start_position could not be resolved").
import { expect, test } from "bun:test";
import type { DiffLocation, DiffSide } from "@lookover/contracts";
import { indexDiff, placeRange, type RangePlacement } from "./index.ts";

const unified = (lines: string[]) => lines.map((l) => `${l}\n`).join("");
const at = (path: string, side: DiffSide, line: number): DiffLocation => ({ path, side, line });
const outside = (reason: Extract<RangePlacement, { kind: "outside" }>["reason"]): RangePlacement => ({
  kind: "outside",
  reason,
});

// Two hunks: lines 1-4 and 20-23 on both sides, with one line replaced in each.
const TWO_HUNKS = indexDiff(
  unified([
    "diff --git a/app.ts b/app.ts",
    "index 71ac1b5..f86782e 100644",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,4 +1,4 @@",
    " a",
    "-b",
    "+B",
    " c",
    " d",
    "@@ -20,4 +20,4 @@",
    " t",
    " u",
    "-v",
    "+V",
    " w",
  ]),
);

test("a range on one side, in one hunk, goes inline, ordered from its first line", () => {
  expect(placeRange(TWO_HUNKS, at("app.ts", "head", 2), at("app.ts", "head", 4))).toEqual({
    kind: "inline",
    start: at("app.ts", "head", 2),
    end: at("app.ts", "head", 4),
  });
  expect(placeRange(TWO_HUNKS, at("app.ts", "head", 4), at("app.ts", "head", 2))).toEqual({
    kind: "inline",
    start: at("app.ts", "head", 2),
    end: at("app.ts", "head", 4),
  });
});

test("a range that crosses sides is rejected", () => {
  expect(placeRange(TWO_HUNKS, at("app.ts", "base", 2), at("app.ts", "head", 3))).toEqual(
    outside("range_crosses_sides"),
  );
});

test("a range that crosses hunks is rejected", () => {
  expect(placeRange(TWO_HUNKS, at("app.ts", "head", 3), at("app.ts", "head", 21))).toEqual(
    outside("range_crosses_hunks"),
  );
});

const TWO_FILES = indexDiff(
  unified([
    "diff --git a/app.ts b/app.ts",
    "index 71ac1b5..f86782e 100644",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,2 +1,2 @@",
    " a",
    "-b",
    "+B",
    "diff --git a/lib.ts b/lib.ts",
    "index 71ac1b5..f86782e 100644",
    "--- a/lib.ts",
    "+++ b/lib.ts",
    "@@ -1,2 +1,2 @@",
    " a",
    "-b",
    "+B",
  ]),
);

test("a range over two files is rejected; a file the diff doesn't hold gives that end's reason", () => {
  expect(placeRange(TWO_FILES, at("app.ts", "head", 1), at("lib.ts", "head", 2))).toEqual(
    outside("range_crosses_files"),
  );
  expect(placeRange(TWO_FILES, at("app.ts", "head", 1), at("other.ts", "head", 2))).toEqual(
    outside("file_not_in_diff"),
  );
});

test("an end the diff doesn't show gives that end's reason", () => {
  expect(placeRange(TWO_HUNKS, at("app.ts", "head", 1), at("app.ts", "head", 10))).toEqual(
    outside("line_not_in_diff"),
  );
  expect(placeRange(TWO_HUNKS, at("app.ts", "base", 1), at("app.ts", "base", 2))).toEqual(
    outside("line_not_in_diff"),
  );
});
