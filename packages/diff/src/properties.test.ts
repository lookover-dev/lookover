// Property tests: random diffs, built from a model and printed the way git prints them. The expected values
// come from the model (the hunk headers number the lines), never from the index, so the parser and the
// placement are checked against the format, not against themselves.
import { expect, test } from "bun:test";
import type {
  DiffFile,
  DiffFileStatus,
  DiffLine,
  DiffLocation,
  DiffSide,
  Placement,
} from "@lookover/contracts";
import { findLine, indexDiff, place, placeRange } from "./index.ts";

// A small seeded generator (mulberry32), so a failure replays with its seed.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, xs: readonly T[]): T => {
  const x = xs[int(r, 0, xs.length - 1)];
  if (x === undefined) throw new Error("pick from an empty list");
  return x;
};

const PATHS = ["src/app.ts", "lib/util.js", "docs/readme.md", "a b.txt", "deep/er/path.py", "x"] as const;
// Texts that look like markers or are empty: the leading marker alone says what a line is.
const TEXTS = ["", "+x", "-y", " z", "\\ not a marker", "@@ not a hunk", "diff --git not a file", "code()"];

interface ModelHunk {
  oldStart: number;
  newStart: number;
  kinds: DiffLine["kind"][];
}
interface ModelFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  hunks: ModelHunk[];
  noNewlineAtEnd: boolean;
}
interface Model {
  files: ModelFile[];
  ending: "\n" | "\r\n";
}

function hunkKinds(r: () => number, status: DiffFileStatus): DiffLine["kind"][] {
  const n = int(r, 1, 6);
  const only = status === "added" ? "added" : status === "deleted" ? "removed" : null;
  return Array.from({ length: n }, () => only ?? pick(r, ["context", "added", "removed"] as const));
}

function hunksOf(r: () => number, status: DiffFileStatus): ModelHunk[] {
  const count = status === "added" || status === "deleted" ? 1 : int(r, status === "renamed" ? 0 : 1, 3);
  const hunks: ModelHunk[] = [];
  let oldNext = 1;
  let newNext = 1;
  for (let i = 0; i < count; i++) {
    const gap = int(r, 0, 4);
    const kinds = hunkKinds(r, status);
    const oldStart = status === "added" ? 0 : oldNext + gap;
    const newStart = status === "deleted" ? 0 : newNext + gap;
    hunks.push({ oldStart, newStart, kinds });
    oldNext = oldStart + kinds.filter((k) => k !== "added").length;
    newNext = newStart + kinds.filter((k) => k !== "removed").length;
  }
  return hunks;
}

/** One file of the model, taking its path (and an old path for a rename) from the pool. */
function fileOf(r: () => number, pool: string[]): ModelFile {
  const wanted = pick(r, ["added", "modified", "deleted", "renamed"] as const);
  const path = pool.pop() ?? "";
  const oldPath = wanted === "renamed" ? (pool.pop() ?? null) : null;
  const status = oldPath === null && wanted === "renamed" ? "modified" : wanted;
  const binary = r() < 0.15;
  return {
    path,
    oldPath,
    status,
    binary,
    hunks: binary ? [] : hunksOf(r, status),
    noNewlineAtEnd: r() < 0.2,
  };
}

function model(seed: number): Model {
  const r = rng(seed);
  const pool = [...PATHS].sort(() => r() - 0.5);
  const files: ModelFile[] = [];
  const count = int(r, 1, 4);
  for (let i = 0; i < count && pool.length > 0; i++) files.push(fileOf(r, pool));
  return { files, ending: r() < 0.3 ? "\r\n" : "\n" };
}

/** A rendered line and what it is, so a cut can be told to fall inside a hunk or not. */
type Rendered = { text: string; role: "file" | "header" | "hunk" | "body" | "marker" };

const named = (path: string) => (path.includes(" ") ? `${path}\t` : path);
const quoted = (path: string) => (path.includes(" ") ? `"${path}"` : path);

function renderHeader(file: ModelFile): Rendered[] {
  const old = file.oldPath ?? file.path;
  const out: Rendered[] = [
    { text: `diff --git ${quoted(`a/${old}`)} ${quoted(`b/${file.path}`)}`, role: "file" },
  ];
  const header = (text: string) => out.push({ text, role: "header" });
  if (file.status === "added") header("new file mode 100644");
  if (file.status === "deleted") header("deleted file mode 100644");
  if (file.status === "renamed") {
    header("similarity index 80%");
    header(`rename from ${old}`);
    header(`rename to ${file.path}`);
  }
  header("index 1234567..89abcde 100644");
  if (file.binary) header(`Binary files a/${old} and b/${file.path} differ`);
  else if (file.hunks.length > 0) {
    header(`--- ${file.status === "added" ? "/dev/null" : named(`a/${old}`)}`);
    header(`+++ ${file.status === "deleted" ? "/dev/null" : named(`b/${file.path}`)}`);
  }
  return out;
}

function renderHunk(r: () => number, hunk: ModelHunk): Rendered[] {
  const oldLines = hunk.kinds.filter((k) => k !== "added").length;
  const newLines = hunk.kinds.filter((k) => k !== "removed").length;
  const range = (start: number, n: number) => (n === 1 ? `${start}` : `${start},${n}`);
  const out: Rendered[] = [
    { text: `@@ -${range(hunk.oldStart, oldLines)} +${range(hunk.newStart, newLines)} @@`, role: "hunk" },
  ];
  for (const kind of hunk.kinds) {
    const marker = kind === "context" ? " " : kind === "added" ? "+" : "-";
    out.push({ text: `${marker}${pick(r, TEXTS)}`, role: "body" });
  }
  return out;
}

function render(seed: number, m: Model): Rendered[] {
  const r = rng(seed + 1);
  const out: Rendered[] = [];
  for (const file of m.files) {
    out.push(...renderHeader(file));
    for (const hunk of file.hunks) out.push(...renderHunk(r, hunk));
    if (file.noNewlineAtEnd && file.hunks.length > 0)
      out.push({ text: "\\ No newline at end of file", role: "marker" });
  }
  return out;
}

const text = (lines: Rendered[], ending: string) => lines.map((l) => `${l.text}${ending}`).join("");

/** The index the model says the diff has: lines numbered from the hunk headers. */
function expectedFiles(m: Model, rendered: Rendered[]): DiffFile[] {
  const texts = rendered.filter((l) => l.role === "body").map((l) => l.text.slice(1));
  let at = 0;
  return m.files.map((file) => ({
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    binary: file.binary,
    hunks: file.hunks.map((hunk) => {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const lines = hunk.kinds.map((kind): DiffLine => {
        const t = texts[at++] ?? "";
        if (kind === "context") return { kind, oldLine: oldLine++, newLine: newLine++, text: t };
        if (kind === "removed") return { kind, oldLine: oldLine++, newLine: null, text: t };
        return { kind, oldLine: null, newLine: newLine++, text: t };
      });
      return {
        oldStart: hunk.oldStart,
        oldLines: hunk.kinds.filter((k) => k !== "added").length,
        newStart: hunk.newStart,
        newLines: hunk.kinds.filter((k) => k !== "removed").length,
        lines,
      };
    }),
  }));
}

const key = (path: string, side: DiffSide, line: number) => `${path}|${side}|${line}`;

/** Every (path, side, line) the model says takes a comment: head for added and context, base for removed. */
function commentable(files: DiffFile[]): Set<string> {
  const keyOf = (file: DiffFile, l: DiffLine) =>
    l.kind === "removed"
      ? key(file.oldPath ?? file.path, "base", l.oldLine ?? 0)
      : key(file.path, "head", l.newLine ?? 0);
  return new Set(
    files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.map((l) => keyOf(file, l)))),
  );
}

/** A hunk of the model holding both lines on one side. */
const sameHunk = (files: DiffFile[], a: DiffLocation, b: DiffLocation) =>
  files.some((file) =>
    file.hunks.some((hunk) => {
      const has = (line: number) =>
        hunk.lines.some((l) => (a.side === "head" ? l.newLine : l.oldLine) === line);
      return (
        (a.side === "head" ? file.path : (file.oldPath ?? file.path)) === a.path && has(a.line) && has(b.line)
      );
    }),
  );

/** A line number the model's file has on that side, from one of its hunks; a random one when it has none. */
function someLine(r: () => number, file: ModelFile, side: DiffSide): number {
  const hunk = file.hunks[int(r, 0, file.hunks.length - 1)];
  if (!hunk || r() < 0.3) return int(r, 0, 25);
  const start = side === "head" ? hunk.newStart : hunk.oldStart;
  const skipped = side === "head" ? "removed" : "added";
  return start + int(r, 0, hunk.kinds.filter((k) => k !== skipped).length);
}

/** A location in or around the model: mostly a line its file has, sometimes the other path or no file. */
function someLocation(r: () => number, m: Model): DiffLocation {
  const file = pick(r, m.files);
  const side: DiffSide = r() < 0.5 ? "head" : "base";
  const roll = r();
  const path =
    roll < 0.1
      ? "nowhere.txt"
      : roll < 0.3
        ? (file.oldPath ?? file.path)
        : side === "head"
          ? file.path
          : (file.oldPath ?? file.path);
  return { path, side, line: someLine(r, file, side) };
}

/** Two ends: mostly a few lines apart on one side; sometimes across sides, in another file, or anywhere. */
function someRange(r: () => number, m: Model): [DiffLocation, DiffLocation] {
  const a = someLocation(r, m);
  const roll = r();
  if (roll < 0.6) return [a, { ...a, line: a.line + int(r, -3, 3) }];
  if (roll < 0.8)
    return [a, { ...a, side: a.side === "head" ? "base" : "head", line: a.line + int(r, -1, 1) }];
  return [a, { ...someLocation(r, m), path: roll < 0.9 ? a.path : "elsewhere.txt" }];
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

test("a diff printed from a model indexes back to the model, whatever its endings, paths and texts", () => {
  for (const seed of SEEDS) {
    const m = model(seed);
    const rendered = render(seed, m);
    const index = indexDiff(text(rendered, m.ending));
    expect([seed, index]).toEqual([seed, { files: expectedFiles(m, rendered), truncated: false }]);
  }
});

/** The location as the host wants it: the path of its side, when the model holds the file. */
function onSide(m: Model, location: DiffLocation): DiffLocation {
  const file = m.files.find((f) => f.path === location.path || f.oldPath === location.path);
  if (!file) return location;
  return { ...location, path: location.side === "head" ? file.path : (file.oldPath ?? file.path) };
}

test("place says inline exactly for the lines a hunk shows on that side, with the path of that side", () => {
  let inlines = 0;
  for (const seed of SEEDS) {
    const m = model(seed);
    const files = expectedFiles(m, render(seed, m));
    const index = indexDiff(text(render(seed, m), m.ending));
    const accepted = commentable(files);
    const r = rng(seed + 2);
    for (let i = 0; i < 20; i++) {
      const location = someLocation(r, m);
      const wanted = onSide(m, location);
      const placed = place(index, location);
      const inline = accepted.has(key(wanted.path, wanted.side, wanted.line));
      const expected: Placement | "outside" = inline ? { kind: "inline", location: wanted } : "outside";
      const actual: Placement | "outside" = placed.kind === "inline" ? placed : "outside";
      expect([seed, location, actual]).toEqual([seed, location, expected]);
      if (inline) inlines++;
    }
  }
  // The property is only worth something if the sample holds inline placements.
  expect(inlines).toBeGreaterThan(500);
});

test("placeRange says inline only for two lines of one hunk on one side, first line first", () => {
  let inlines = 0;
  for (const seed of SEEDS) {
    const m = model(seed);
    const files = expectedFiles(m, render(seed, m));
    const index = indexDiff(text(render(seed, m), m.ending));
    const r = rng(seed + 3);
    for (let i = 0; i < 10; i++) {
      const [a, b] = someRange(r, m);
      const placed = placeRange(index, a, b);
      if (placed.kind !== "inline") continue;
      inlines++;
      expect([seed, a, b, placed.start.side === placed.end.side]).toEqual([seed, a, b, true]);
      expect(placed.start.line).toBeLessThanOrEqual(placed.end.line);
      expect([seed, a, b, sameHunk(files, placed.start, placed.end)]).toEqual([seed, a, b, true]);
    }
  }
  expect(inlines).toBeGreaterThan(100);
});

test("a diff cut anywhere places inline only what the whole diff places inline, and knows it is cut when a hunk is open", () => {
  let inlines = 0;
  for (const seed of SEEDS) {
    const m = model(seed);
    const rendered = render(seed, m);
    const whole = indexDiff(text(rendered, m.ending));
    const r = rng(seed + 4);
    const keep = int(r, 0, rendered.length - 1);
    const partial = r() < 0.3 ? (rendered[keep]?.text ?? "").slice(0, 2) : "";
    const kept = rendered.slice(0, keep);
    const cut = indexDiff(`${text(kept, m.ending)}${partial}`);
    // The cut shows when a hunk is left open, or a file named its `---`/`+++` and got no hunk at all.
    const openHunk = rendered[keep]?.role === "body";
    const section = kept.slice(kept.findLastIndex((l) => l.role === "file") + 1);
    const namedNoHunk =
      section.some((l) => /^(---|\+\+\+) /.test(l.text)) && !section.some((l) => l.role === "hunk");
    if (openHunk || namedNoHunk || partial !== "")
      expect([seed, keep, cut.truncated]).toEqual([seed, keep, true]);
    for (let i = 0; i < 20; i++) {
      const location = someLocation(r, m);
      const placed = place(cut, location);
      if (placed.kind !== "inline") continue;
      inlines++;
      expect([seed, location, place(whole, location)]).toEqual([seed, location, placed]);
    }
  }
  expect(inlines).toBeGreaterThan(200);
});

/** Every line the model says takes a comment, with its path and side as the host wants them, and its text. */
function linesWithText(files: DiffFile[]): { at: DiffLocation; text: string }[] {
  return files.flatMap((file) =>
    file.hunks.flatMap((hunk) =>
      hunk.lines.map((l) =>
        l.kind === "removed"
          ? {
              at: { path: file.oldPath ?? file.path, side: "base" as const, line: l.oldLine ?? 0 },
              text: l.text,
            }
          : { at: { path: file.path, side: "head" as const, line: l.newLine ?? 0 }, text: l.text },
      ),
    ),
  );
}

/** Whitespace aside, as the model writes it: trimmed, inner runs as one space. */
const squash = (t: string) => t.trim().split(/\s+/).join(" ");

test("findLine finds every line the host takes a comment on by its own text, padded or not", () => {
  let found = 0;
  for (const seed of SEEDS) {
    const m = model(seed);
    const files = expectedFiles(m, render(seed, m));
    const index = indexDiff(text(render(seed, m), m.ending));
    for (const { at, text: own } of linesWithText(files)) {
      expect([seed, at, findLine(index, at, `  ${own}\t`)]).toEqual([
        seed,
        at,
        { kind: "found", line: at.line },
      ]);
      found++;
    }
  }
  expect(found).toBeGreaterThan(1000);
});

test("findLine answers the nearest line with the text on that side of that file, the one above on a tie, or none", () => {
  let moved = 0;
  let none = 0;
  for (const seed of SEEDS) {
    const m = model(seed);
    const files = expectedFiles(m, render(seed, m));
    const index = indexDiff(text(render(seed, m), m.ending));
    const all = linesWithText(files);
    const r = rng(seed + 5);
    for (let i = 0; i < 20; i++) {
      const near = someLocation(r, m);
      const wanted = pick(r, TEXTS);
      const host = onSide(m, near);
      const lines = all
        .filter(
          (l) => l.at.path === host.path && l.at.side === host.side && squash(l.text) === squash(wanted),
        )
        .map((l) => l.at.line)
        .sort((a, b) => Math.abs(a - near.line) - Math.abs(b - near.line) || a - b);
      const expected = lines[0] ?? null;
      expect([seed, near, wanted, findLine(index, near, wanted)]).toEqual([
        seed,
        near,
        wanted,
        expected === null ? { kind: "none", reason: "not_in_diff" } : { kind: "found", line: expected },
      ]);
      if (expected === null) none++;
      else if (expected !== near.line) moved++;
    }
  }
  // Worth something only if the sample both moves lines and finds none.
  expect(moved).toBeGreaterThan(300);
  expect(none).toBeGreaterThan(300);
});
