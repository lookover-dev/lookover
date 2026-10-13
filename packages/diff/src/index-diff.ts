// Reading git's unified diff: one `diff --git` section per file, its header lines, then its hunks.
import type { DiffFile, DiffFileStatus, DiffHunk, DiffIndex, DiffLine, IndexDiff } from "@lookover/contracts";

import { unquotePath } from "./paths.ts";

const FILE_START = /^diff --git (.*)$/;
const HUNK_START = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const RENAME = /^(rename|copy) (from|to) (.*)$/;
const NAME = /^(---|\+\+\+) (.*?)\t?$/;
const BINARY = /^(?:Binary files .* differ|GIT binary patch)$/;
const KINDS: Record<string, DiffLine["kind"]> = { " ": "context", "-": "removed", "+": "added" };

/** What the header lines of one file section said, before its hunks. */
interface Header {
  oldName: string | null;
  newName: string | null;
  status: DiffFileStatus;
  binary: boolean;
  /** A `---`/`+++` pair was read: git prints it only before hunks, so none following means a cut. */
  named: boolean;
}

/** The text's lines without their ending, and whether the text was cut before its last line ended. */
function splitLines(unified: string): { lines: string[]; cutMidLine: boolean } {
  if (unified === "") return { lines: [], cutMidLine: false };
  const cutMidLine = !unified.endsWith("\n");
  const lines = unified.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  // A complete text ends with "\n", so the split leaves an empty last piece; a cut text leaves a partial line.
  lines.pop();
  return { lines, cutMidLine };
}

/** `a/path` or `b/path` as git prints it after `diff --git`, `---`, `+++`, possibly C-quoted. */
function stripPrefix(name: string): string {
  const path = unquotePath(name);
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/** Both names of the `diff --git a/X b/Y` line; equal names may hold spaces, so equal halves are tried first. */
function namesOf(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const [first, second] = rest.split('" "');
    return [stripPrefix(`${first}"`), stripPrefix(`"${second}`)];
  }
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(1) === b.slice(1)) return [stripPrefix(a), stripPrefix(b)];
  }
  const at = rest.lastIndexOf(" b/");
  return [stripPrefix(rest.slice(0, at)), stripPrefix(rest.slice(at + 1))];
}

/** `rename from X`, `rename to Y` (and `copy`, which git prints for a copied file). */
function readRename(header: Header, m: RegExpExecArray): void {
  const name = unquotePath(m[3] ?? "");
  if (m[2] === "from") header.oldName = name;
  else header.newName = name;
  if (m[1] === "rename") header.status = "renamed";
}

/** `--- a/X` and `+++ b/Y`; `/dev/null` names no file. */
function readName(header: Header, m: RegExpExecArray): void {
  header.named = true;
  if (m[2] === "/dev/null") return;
  if (m[1] === "---") header.oldName = stripPrefix(m[2] ?? "");
  else header.newName = stripPrefix(m[2] ?? "");
}

function readHeaderLine(header: Header, line: string): void {
  const rename = RENAME.exec(line);
  const name = NAME.exec(line);
  if (rename) readRename(header, rename);
  else if (name) readName(header, name);
  else if (line.startsWith("new file mode")) header.status = "added";
  else if (line.startsWith("deleted file mode")) header.status = "deleted";
  else if (BINARY.test(line)) header.binary = true;
}

/** Reads the header lines from `from` (the `diff --git` line) up to the first hunk or the next file. */
function readHeader(lines: string[], from: number): { header: Header; next: number } {
  const [a, b] = namesOf(FILE_START.exec(lines[from] ?? "")?.[1] ?? "");
  const header: Header = { oldName: null, newName: null, status: "modified", binary: false, named: false };
  let i = from + 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FILE_START.test(line) || HUNK_START.test(line)) break;
    readHeaderLine(header, line);
  }
  header.oldName ??= a;
  header.newName ??= b;
  return { header, next: i };
}

function toFile(header: Header): DiffFile {
  const { status } = header;
  const newName = header.newName ?? header.oldName ?? "";
  const oldName = header.oldName ?? newName;
  return {
    path: status === "deleted" ? oldName : newName,
    oldPath: status === "renamed" ? oldName : null,
    status,
    binary: header.binary,
    hunks: [],
  };
}

function hunkOf(line: string): DiffHunk {
  const m = HUNK_START.exec(line);
  const count = (s: string | undefined) => (s === undefined ? 1 : Number(s));
  return {
    oldStart: Number(m?.[1]),
    oldLines: count(m?.[2]),
    newStart: Number(m?.[3]),
    newLines: count(m?.[4]),
    lines: [],
  };
}

/** Counts the hunk's lines down on each side as they are read; the hunk is complete when both reach zero. */
class HunkBody {
  private oldLeft: number;
  private newLeft: number;
  private oldLine: number;
  private newLine: number;
  readonly lines: DiffLine[] = [];

  constructor(hunk: DiffHunk) {
    this.oldLeft = hunk.oldLines;
    this.newLeft = hunk.newLines;
    this.oldLine = hunk.oldStart;
    this.newLine = hunk.newStart;
  }

  get complete(): boolean {
    return this.oldLeft === 0 && this.newLeft === 0;
  }

  /** Reads one body line; false when it is not one (the text broke, or a new hunk or file starts). */
  read(line: string): boolean {
    const kind = KINDS[line.charAt(0)];
    if (kind === undefined) return false;
    const text = line.slice(1);
    const oldLine = kind === "added" ? null : this.oldLine++;
    const newLine = kind === "removed" ? null : this.newLine++;
    this.lines.push({ kind, oldLine, newLine, text });
    if (oldLine !== null) this.oldLeft--;
    if (newLine !== null) this.newLeft--;
    return true;
  }
}

/** Reads one hunk from its `@@` line. `complete` is false when the text ended or broke before its last line. */
function readHunk(lines: string[], from: number): { hunk: DiffHunk; next: number; complete: boolean } {
  const hunk = hunkOf(lines[from] ?? "");
  const body = new HunkBody(hunk);
  let i = from + 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // `\ No newline at end of file` says something about the line before it, not a line of its own.
    if (line.startsWith("\\")) continue;
    if (body.complete || !body.read(line)) break;
  }
  hunk.lines = body.lines;
  return { hunk, next: i, complete: body.complete };
}

/** Reads one file section from its `diff --git` line. `cut` is true when the text broke inside it. */
function readFile(lines: string[], from: number): { file: DiffFile; next: number; cut: boolean } {
  const { header, next } = readHeader(lines, from);
  const file = toFile(header);
  // `---`/`+++` are printed only ahead of hunks: a section that named them and shows none was cut there.
  if (header.named && !HUNK_START.test(lines[next] ?? "")) return { file, next, cut: true };
  let i = next;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FILE_START.test(line)) break;
    if (!HUNK_START.test(line)) return { file, next: i, cut: true };
    const read = readHunk(lines, i);
    file.hunks.push(read.hunk);
    if (!read.complete) return { file, next: read.next, cut: true };
    i = read.next;
  }
  return { file, next: i, cut: false };
}

export const indexDiff: IndexDiff = (unified) => {
  const { lines, cutMidLine } = splitLines(unified);
  const index: DiffIndex = { files: [], truncated: cutMidLine };
  let i = lines.findIndex((l) => FILE_START.test(l));
  while (i >= 0 && i < lines.length) {
    const { file, next, cut } = readFile(lines, i);
    index.files.push(file);
    if (cut) {
      index.truncated = true;
      break;
    }
    i = next;
  }
  return index;
};
