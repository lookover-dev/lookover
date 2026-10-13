// Where a finding goes: inline on a line the host accepts, or outside the diff with the reason.
import { expect, test } from "bun:test";
import type { DiffLocation, DiffSide, Placement } from "@lookover/contracts";
import { indexDiff, place } from "./index.ts";

const unified = (lines: string[], ending = "\n") => lines.map((l) => `${l}${ending}`).join("");

const at = (path: string, side: DiffSide, line: number): DiffLocation => ({ path, side, line });
const inline = (path: string, side: DiffSide, line: number): Placement => ({
  kind: "inline",
  location: at(path, side, line),
});
const outside = (reason: Extract<Placement, { kind: "outside" }>["reason"]): Placement => ({
  kind: "outside",
  reason,
});

const MODIFIED = indexDiff(
  unified([
    "diff --git a/keep.txt b/keep.txt",
    "index 71ac1b5..f86782e 100644",
    "--- a/keep.txt",
    "+++ b/keep.txt",
    "@@ -1,8 +1,9 @@",
    " a",
    " b",
    "-c",
    "+C",
    " d",
    " e",
    " f",
    " g",
    " h",
    "+i",
  ]),
);

test("an added or context line takes a comment on head; a removed line on base", () => {
  expect(place(MODIFIED, at("keep.txt", "head", 3))).toEqual(inline("keep.txt", "head", 3));
  expect(place(MODIFIED, at("keep.txt", "head", 1))).toEqual(inline("keep.txt", "head", 1));
  expect(place(MODIFIED, at("keep.txt", "head", 9))).toEqual(inline("keep.txt", "head", 9));
  expect(place(MODIFIED, at("keep.txt", "base", 3))).toEqual(inline("keep.txt", "base", 3));
});

test("a line the hunk doesn't show on that side goes outside: a context line on base, a line past the hunk, a removed line asked on head", () => {
  expect(place(MODIFIED, at("keep.txt", "base", 1))).toEqual(outside("line_not_in_diff"));
  expect(place(MODIFIED, at("keep.txt", "head", 10))).toEqual(outside("line_not_in_diff"));
  expect(place(MODIFIED, at("keep.txt", "base", 9))).toEqual(outside("line_not_in_diff"));
});

test("a file the diff doesn't hold goes outside", () => {
  expect(place(MODIFIED, at("other.txt", "head", 1))).toEqual(outside("file_not_in_diff"));
});

const ADDED_AND_DELETED = indexDiff(
  unified([
    "diff --git a/added.txt b/added.txt",
    "new file mode 100644",
    "index 0000000..07f33c4",
    "--- /dev/null",
    "+++ b/added.txt",
    "@@ -0,0 +1,2 @@",
    "+new",
    "+file",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "index 04ec35a..0000000",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-x",
    "-y",
    "-z",
  ]),
);

test("an added file takes comments on head only, a deleted file on base only", () => {
  expect(place(ADDED_AND_DELETED, at("added.txt", "head", 2))).toEqual(inline("added.txt", "head", 2));
  expect(place(ADDED_AND_DELETED, at("added.txt", "base", 1))).toEqual(outside("line_not_in_diff"));
  expect(place(ADDED_AND_DELETED, at("gone.txt", "base", 3))).toEqual(inline("gone.txt", "base", 3));
  expect(place(ADDED_AND_DELETED, at("gone.txt", "head", 1))).toEqual(outside("line_not_in_diff"));
});

const RENAMED = indexDiff(
  unified([
    "diff --git a/moved.txt b/moved2.txt",
    "similarity index 78%",
    "rename from moved.txt",
    "rename to moved2.txt",
    "index 7a28df3..3cc64f7 100644",
    "--- a/moved.txt",
    "+++ b/moved2.txt",
    "@@ -1,4 +1,4 @@",
    " alpha",
    "-beta",
    "+BETA",
    " gamma",
    " delta",
    "diff --git a/same.txt b/same2.txt",
    "similarity index 100%",
    "rename from same.txt",
    "rename to same2.txt",
  ]),
);

test("a renamed file is commented on its new path on head and its old path on base, whichever path the finding named", () => {
  expect(place(RENAMED, at("moved2.txt", "head", 2))).toEqual(inline("moved2.txt", "head", 2));
  expect(place(RENAMED, at("moved.txt", "head", 2))).toEqual(inline("moved2.txt", "head", 2));
  expect(place(RENAMED, at("moved.txt", "base", 2))).toEqual(inline("moved.txt", "base", 2));
  expect(place(RENAMED, at("moved2.txt", "base", 2))).toEqual(inline("moved.txt", "base", 2));
});

const BINARY = indexDiff(
  unified([
    "diff --git a/pic.png b/pic.png",
    "index a6a3e7f..1d518ed 100644",
    "Binary files a/pic.png and b/pic.png differ",
  ]),
);

test("a binary file takes no comment, and says so", () => {
  expect(place(BINARY, at("pic.png", "head", 1))).toEqual(outside("binary_file"));
});

// The modified file's hunk, cut after its second line; the second file is lost with the cut.
const TRUNCATED = indexDiff(
  unified([
    "diff --git a/keep.txt b/keep.txt",
    "index 71ac1b5..f86782e 100644",
    "--- a/keep.txt",
    "+++ b/keep.txt",
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
  ]),
);

test("in a truncated index, a line read before the cut still takes a comment", () => {
  expect(place(TRUNCATED, at("keep.txt", "head", 1))).toEqual(inline("keep.txt", "head", 1));
  expect(place(TRUNCATED, at("keep.txt", "base", 2))).toEqual(inline("keep.txt", "base", 2));
});

test("in a truncated index, a line or a file not found may lie past the cut, and the placement says so", () => {
  expect(place(TRUNCATED, at("keep.txt", "head", 3))).toEqual(outside("diff_truncated"));
  expect(place(TRUNCATED, at("added.txt", "head", 1))).toEqual(outside("diff_truncated"));
});

// The first file is complete; the cut falls in the second.
const TRUNCATED_LATER = indexDiff(
  unified([
    "diff --git a/keep.txt b/keep.txt",
    "index 71ac1b5..f86782e 100644",
    "--- a/keep.txt",
    "+++ b/keep.txt",
    "@@ -1,2 +1,2 @@",
    " a",
    "-b",
    "+B",
    "diff --git a/added.txt b/added.txt",
    "new file mode 100644",
    "index 0000000..07f33c4",
    "--- /dev/null",
    "+++ b/added.txt",
    "@@ -0,0 +1,2 @@",
    "+new",
  ]),
);

test("a line missing from a file read whole before the cut is not in the diff; only the cut file is in doubt", () => {
  expect(place(TRUNCATED_LATER, at("keep.txt", "head", 3))).toEqual(outside("line_not_in_diff"));
  expect(place(TRUNCATED_LATER, at("added.txt", "head", 2))).toEqual(outside("diff_truncated"));
});

test("a file renamed without changes takes no comment, on either path", () => {
  expect(place(RENAMED, at("same2.txt", "head", 1))).toEqual(outside("line_not_in_diff"));
  expect(place(RENAMED, at("same.txt", "base", 1))).toEqual(outside("line_not_in_diff"));
});
