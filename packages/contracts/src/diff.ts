// The `diff` leaf's interface (ADR 0033): what it reads (a unified diff), what it builds (the index) and what
// it answers (where a finding can be placed). `publish` places findings with it. A finding (`Finding`, and
// `review`'s candidates) names its location with `DiffSide` and `DiffLocation` without indexing the diff, and
// the Git host ports name a line the same way. The leaf is pure; these are the types it works on.

/** The side of a change a line belongs to: `head` is the new text, `base` the old (GitHub: RIGHT and LEFT). */
export type DiffSide = "head" | "base";

/** One line of one file, as a finding or a comment names it. */
export interface DiffLocation {
  /** The path on that side: the new path on `head`, the old path on `base`. */
  path: string;
  side: DiffSide;
  /** 1-based, on that side's file. */
  line: number;
}

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line's number in the old file; null for an added line. */
  oldLine: number | null;
  /** The line's number in the new file; null for a removed line. */
  newLine: number | null;
  /** Without the leading marker and without its line ending. */
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  /** The new path, or the old one for a deleted file. */
  path: string;
  /** The old path when the file was renamed; null otherwise. */
  oldPath: string | null;
  status: DiffFileStatus;
  /** A binary file has no hunks. */
  binary: boolean;
  hunks: DiffHunk[];
}

/**
 * A unified diff, indexed: every file, hunk and line, with the numbers a host accepts a comment on.
 * `truncated`: the text ended before its last hunk was complete, or a part of it could not be read, so what
 * follows the cut is unknown: a line not found may still be in the real diff. The files and hunks read before
 * the cut are complete and trustworthy.
 */
export interface DiffIndex {
  files: DiffFile[];
  truncated: boolean;
}

/**
 * How `review` anchored a finding by the text of its line (ADR 0044, I-158). `reported`: on the line the engine
 * gave, whose text matched, or which came with no text to check. `moved`: to the nearest line on the same side of
 * the same file whose text matched, the end line shifted by as much. `unmatched`: no line of the diff holds the
 * text, so the finding goes to the summary (`text_not_in_diff`), never to a guessed line.
 */
export type Anchoring = "reported" | "moved" | "unmatched";

/**
 * Where a finding goes. `inline`: the host accepts a comment there (the location, as the host wants it).
 * `outside`: no comment can go there, and why; `publish` puts the finding in the summary instead.
 * `diff_truncated`: not found, but the index was cut, so the line may well be in the diff: the summary says so.
 * `text_not_in_diff`: the finding's anchoring is `unmatched`; `publish` says so without asking the leaf, which
 * places by line number only.
 */
export type Placement =
  | { kind: "inline"; location: DiffLocation }
  | {
      kind: "outside";
      reason: "file_not_in_diff" | "line_not_in_diff" | "binary_file" | "diff_truncated" | "text_not_in_diff";
    };

/** The leaf's entry: a unified diff, as git prints it, to its index. Never throws: a diff it can't read indexes what it could. */
export type IndexDiff = (unified: string) => DiffIndex;

/** The leaf's entry: whether and where a line can take a comment. Pure. */
export type Place = (index: DiffIndex, location: DiffLocation) => Placement;
