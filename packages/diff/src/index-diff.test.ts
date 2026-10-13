// The golden corpus: real `git diff --find-renames -U3` output, written by hand from a scratch repository, and
// the index each piece must give. Every expected value is read off the diff text, never computed.
import { expect, test } from "bun:test";
import type { DiffFile, DiffLine } from "@lookover/contracts";
import { indexDiff } from "./index.ts";

/** Joins diff lines with the ending git printed; a template literal would turn CRLF into LF. */
const unified = (lines: string[], ending = "\n") => lines.map((l) => `${l}${ending}`).join("");

const line = (
  kind: DiffLine["kind"],
  oldLine: number | null,
  newLine: number | null,
  text: string,
): DiffLine => ({
  kind,
  oldLine,
  newLine,
  text,
});

const MODIFIED = unified([
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
]);

test("a modified file: one hunk, every line numbered on the side it is on", () => {
  expect(indexDiff(MODIFIED)).toEqual({
    truncated: false,
    files: [
      {
        path: "keep.txt",
        oldPath: null,
        status: "modified",
        binary: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 8,
            newStart: 1,
            newLines: 9,
            lines: [
              line("context", 1, 1, "a"),
              line("context", 2, 2, "b"),
              line("removed", 3, null, "c"),
              line("added", null, 3, "C"),
              line("context", 4, 4, "d"),
              line("context", 5, 5, "e"),
              line("context", 6, 6, "f"),
              line("context", 7, 7, "g"),
              line("context", 8, 8, "h"),
              line("added", null, 9, "i"),
            ],
          },
        ],
      },
    ],
  });
});

const ADDED_AND_DELETED = unified([
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
]);

test("an added file has only added lines, a deleted file only removed ones, each named by the path it has", () => {
  expect(indexDiff(ADDED_AND_DELETED)).toEqual({
    truncated: false,
    files: [
      {
        path: "added.txt",
        oldPath: null,
        status: "added",
        binary: false,
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: [line("added", null, 1, "new"), line("added", null, 2, "file")],
          },
        ],
      },
      {
        path: "gone.txt",
        oldPath: null,
        status: "deleted",
        binary: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 0,
            newLines: 0,
            lines: [
              line("removed", 1, null, "x"),
              line("removed", 2, null, "y"),
              line("removed", 3, null, "z"),
            ],
          },
        ],
      },
    ],
  });
});

const RENAMED = unified([
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
]);

test("a renamed file keeps both paths; renamed without changes, it has no hunk", () => {
  expect(indexDiff(RENAMED)).toEqual({
    truncated: false,
    files: [
      {
        path: "moved2.txt",
        oldPath: "moved.txt",
        status: "renamed",
        binary: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 4,
            newStart: 1,
            newLines: 4,
            lines: [
              line("context", 1, 1, "alpha"),
              line("removed", 2, null, "beta"),
              line("added", null, 2, "BETA"),
              line("context", 3, 3, "gamma"),
              line("context", 4, 4, "delta"),
            ],
          },
        ],
      },
      { path: "same2.txt", oldPath: "same.txt", status: "renamed", binary: false, hunks: [] },
    ],
  });
});

const CRLF = unified(
  [
    "diff --git a/win.txt b/win.txt",
    "index 7834ef3..0fc1e28 100644",
    "--- a/win.txt",
    "+++ b/win.txt",
    "@@ -1,4 +1,4 @@",
    " l1",
    "-l2",
    "+L2",
    " l3",
    " l4",
  ],
  "\r\n",
);

test("CRLF line endings: the text of a line holds neither", () => {
  expect(indexDiff(CRLF).files[0]?.hunks[0]?.lines).toEqual([
    line("context", 1, 1, "l1"),
    line("removed", 2, null, "l2"),
    line("added", null, 2, "L2"),
    line("context", 3, 3, "l3"),
    line("context", 4, 4, "l4"),
  ]);
  expect(indexDiff(CRLF).truncated).toBe(false);
});

const NO_NEWLINE = unified([
  "diff --git a/nonl.txt b/nonl.txt",
  "index 76c0930..1087cd9 100644",
  "--- a/nonl.txt",
  "+++ b/nonl.txt",
  "@@ -1,2 +1,2 @@",
  " end",
  "-no newline",
  "\\ No newline at end of file",
  "+no newline either",
]);

test("the no-newline marker is not a line", () => {
  expect(indexDiff(NO_NEWLINE)).toEqual({
    truncated: false,
    files: [
      {
        path: "nonl.txt",
        oldPath: null,
        status: "modified",
        binary: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: [
              line("context", 1, 1, "end"),
              line("removed", 2, null, "no newline"),
              line("added", null, 2, "no newline either"),
            ],
          },
        ],
      },
    ],
  });
});

const BINARY = unified([
  "diff --git a/pic.png b/pic.png",
  "index a6a3e7f..1d518ed 100644",
  "Binary files a/pic.png and b/pic.png differ",
  "diff --git a/new.png b/new.png",
  "new file mode 100644",
  "index 0000000..1d518ed",
  "Binary files /dev/null and b/new.png differ",
]);

test("a binary file is indexed as such, with no hunk", () => {
  expect(indexDiff(BINARY)).toEqual({
    truncated: false,
    files: [
      { path: "pic.png", oldPath: null, status: "modified", binary: true, hunks: [] },
      { path: "new.png", oldPath: null, status: "added", binary: true, hunks: [] },
    ],
  });
});

const SPACES = unified([
  "diff --git a/my file.txt b/my file.txt",
  "index e563bc2..4b1287e 100644",
  "--- a/my file.txt\t",
  "+++ b/my file.txt\t",
  "@@ -1,2 +1,2 @@",
  " p",
  "-q",
  "+Q",
]);

test("a path with spaces, which git ends with a tab, is read whole", () => {
  expect(indexDiff(SPACES).files.map((f) => f.path)).toEqual(["my file.txt"]);
});

const QUOTED = unified([
  'diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"',
  "index e563bc2..4b1287e 100644",
  '--- "a/caf\\303\\251 \\"x\\".txt"',
  '+++ "b/caf\\303\\251 \\"x\\".txt"',
  "@@ -1 +1 @@",
  "-q",
  "+Q",
]);

test("a path git C-quotes is decoded; a hunk header without counts means one line", () => {
  expect(indexDiff(QUOTED).files[0]).toMatchObject({
    path: 'café "x".txt',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
  });
});

const TWO_FILES = [
  "diff --git a/keep.txt b/keep.txt",
  "index 71ac1b5..f86782e 100644",
  "--- a/keep.txt",
  "+++ b/keep.txt",
  "@@ -1,3 +1,3 @@",
  " a",
  "-b",
  "+B",
  " c",
  "diff --git a/added.txt b/added.txt",
  "new file mode 100644",
  "index 0000000..07f33c4",
  "--- /dev/null",
  "+++ b/added.txt",
  "@@ -0,0 +1,2 @@",
  "+new",
  "+file",
];

const KEEP_WHOLE: DiffFile = {
  path: "keep.txt",
  oldPath: null,
  status: "modified",
  binary: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        line("context", 1, 1, "a"),
        line("removed", 2, null, "b"),
        line("added", null, 2, "B"),
        line("context", 3, 3, "c"),
      ],
    },
  ],
};

test("a diff cut between two lines of a hunk is truncated; the lines before the cut are kept", () => {
  const cut = indexDiff(unified(TWO_FILES.slice(0, 7)));
  expect(cut.truncated).toBe(true);
  expect(cut.files).toEqual([
    {
      path: "keep.txt",
      oldPath: null,
      status: "modified",
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [line("context", 1, 1, "a"), line("removed", 2, null, "b")],
        },
      ],
    },
  ]);
});

test("a diff cut in a file's header, after its names and before its first hunk, is truncated", () => {
  const cut = indexDiff(unified(TWO_FILES.slice(0, 4)));
  expect(cut).toEqual({
    truncated: true,
    files: [{ path: "keep.txt", oldPath: null, status: "modified", binary: false, hunks: [] }],
  });
});

test("a diff cut in the middle of a line is truncated, and the half line is dropped", () => {
  const cut = indexDiff(`${unified(TWO_FILES.slice(0, 16))}+fi`);
  expect(cut.truncated).toBe(true);
  expect(cut.files[1]?.hunks[0]?.lines).toEqual([line("added", null, 1, "new")]);
});

test("a diff cut right after a complete file is not known to be truncated", () => {
  const cut = indexDiff(unified(TWO_FILES.slice(0, 9)));
  expect(cut).toEqual({ truncated: false, files: [KEEP_WHOLE] });
});

test("a line that can't be read cuts the diff there: what follows is not trusted", () => {
  const broken = [...TWO_FILES.slice(0, 7), "<<<garbage>>>", ...TWO_FILES.slice(7)];
  const cut = indexDiff(unified(broken));
  expect(cut.truncated).toBe(true);
  expect(cut.files.map((f) => f.path)).toEqual(["keep.txt"]);
  expect(cut.files[0]?.hunks[0]?.lines).toHaveLength(2);
});

test("text that is no diff at all indexes nothing, and is not truncated", () => {
  expect(indexDiff("")).toEqual({ files: [], truncated: false });
  expect(indexDiff("fatal: bad revision\n")).toEqual({ files: [], truncated: false });
});
