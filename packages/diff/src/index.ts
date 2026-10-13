// @lookover/diff: git's diff format and which lines a host accepts a comment on (ADR 0033).
// The decision it hides: how a unified diff is read (file sections, header lines, hunks, CRLF, C-quoted paths,
// `\ No newline at end of file`, binary files, renames with or without changes, a text cut short) and which
// (side, line) pairs a host takes an inline comment on, as the GitHub spike saw it: a line in a hunk, on the
// side it is on (`head` for an added or context line, `base` for a removed line); nothing on a binary file or
// a rename without changes; a range on one side, in one hunk.
// Interface: `indexDiff(unified)` builds the index; `place(index, location)` answers where one line can go;
// `placeRange(index, start, end)` the same for a range (its `RangePlacement` is the leaf's own: contracts'
// `Placement` names one line; `publish` turns an inline range into `InlineComment`'s `line` to `endLine`);
// `findLine(index, near, text)` finds a line by its text (ADR 0044, I-158): the line nearest `near` that takes a
// comment on its side of its file and whose text matches, whitespace aside (`normalizeLineText`), the one above on
// a tie; else none, `diff_truncated` when the cut fell in that file or before it (`LineFound`); `findRange` the
// same for a range, its end line moved as far as its first (how a finding is anchored again); `hunkAt(index,
// location, around?)` prints the hunk that shows a line on its side as git prints it, header first, or null; with
// `around`, only the location's lines (to its `endLine`) and that many lines either side, under a header counting
// what is shown (ADR 0044: what the confirm pass shows of a claim). All pure: same input, same output, nothing thrown.
// Invariants: every `inline` placement names a line of a hunk on its side, with the path the host wants (the
// new path on `head`, the old one on `base`, so a finding naming a renamed file's other path is moved);
// a diff that can't be read indexes what it could and sets `truncated`; in a truncated index, a file not found,
// or a line not found in the last file read (the one the cut fell in), places `outside` with `diff_truncated`.
// The files before it are complete: a line missing there is `line_not_in_diff`.
// Ordering: none: `place` and `placeRange` read an index `indexDiff` built, and nothing keeps state between calls.
// Error modes: none. A text that isn't a diff gives an empty index.
// It must never know: findings, the host ports, how the diff was produced, or any word the screens say.
// It imports only @lookover/contracts, and no node: or bun: module.
export { findLine, findRange, type LineFound, normalizeLineText, type RangeFound } from "./find-line.ts";
export { hunkAt } from "./hunk-at.ts";
export { indexDiff } from "./index-diff.ts";
export { place } from "./place.ts";
export { placeRange, type RangePlacement } from "./place-range.ts";
