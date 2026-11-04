// Cuts a failed step's output to the lines about some files: what the pre-commit check shows of a step, so a
// commit is told about its own files and not about another ticket's red.

// A diagnostic's first line names its file: `a.ts(3,10): error …` (tsc), `a.ts:3:10 lint/…` (Biome, with
// backslashes on Windows), `  a.ts:3: …` (the import check).
const NAMES_FILE = /^\s*((?:[\w@.-]+[\\/])*[\w@.-]+\.(?:[cm]?[jt]sx?|jsonc?|css|grit))\b/;
// Biome's summary lines; the indented lines under its `check ━━━` line are part of it.
const SUMMARY =
  /^(?:Checked \d+ files? in |Found \d+ \w+\.|Skipped \d+ |If you wish to apply |The number of diagnostics exceeds |check ━)/;
// A header whose indented lines are diagnostics, each naming its file or tied to none.
const HEADER = /^Module boundaries broken /;

export type Cut = {
  /** The kept lines, then a line counting the others when there are any. */
  text: string;
  /** Diagnostics naming one of the files. */
  mine: number;
  /** Diagnostics naming another file. */
  others: number;
  /** Kept lines tied to no file that are not a header or a summary: diagnostics that may be any file's. */
  loose: number;
};

/** What a line and the indented and blank lines under it are about. */
type About = "mine" | "other" | "header" | "summary" | "loose";

/**
 * What `line` is about, given what the line above it was and whether it is in a header's list (each indented
 * line a diagnostic), and the diagnostic it starts, if any.
 */
function read(
  line: string,
  files: readonly string[],
  above: About,
  list: boolean,
): [About, "mine" | "other" | "loose" | null] {
  const named = NAMES_FILE.exec(line)?.[1]?.replaceAll("\\", "/");
  if (named !== undefined) {
    const about = files.includes(named) ? "mine" : "other";
    return [about, about];
  }
  if (line.trim() === "") return [above, null];
  // An unnamed indented line belongs to the line above, unless it is an item of a header's list.
  if (/^\s/.test(line)) return list ? ["loose", "loose"] : [above, null];
  if (SUMMARY.test(line)) return ["summary", null];
  if (HEADER.test(line)) return ["header", null];
  return ["loose", "loose"];
}

/**
 * `output` cut to the lines about `files` (repository-relative, forward slashes). A line that names another
 * file, and the indented and blank lines under it, are only counted; a line that names no file and isn't
 * indented is kept, and counted loose unless it is a known header or summary, as is an unnamed indented line
 * under a header or at the start.
 */
export function aboutFiles(output: string, files: readonly string[]): Cut {
  const kept: string[] = [];
  const count = { mine: 0, other: 0, loose: 0 };
  let about: About = "header";
  // Before any line, as under a header: an unnamed indented line is a diagnostic of its own.
  let list = true;
  for (const line of output.split("\n")) {
    const [now, starts] = read(line, files, about, list);
    if (/^\S/.test(line)) list = now === "header";
    about = now;
    if (starts !== null) count[starts]++;
    if (about !== "other") kept.push(line);
  }
  const more = count.other > 0 ? [`(${count.other} more in other files: \`bun run check\` lists them.)`] : [];
  return {
    text: [...kept, ...more].join("\n").trim(),
    mine: count.mine,
    others: count.other,
    loose: count.loose,
  };
}
