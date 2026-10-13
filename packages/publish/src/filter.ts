// The output filter (ADR 0056, SR-08): what an engine or a person wrote, made harmless before Lookover posts it again.
// A closed rule, which never guesses how GitHub reads a span: every line end made a line feed (GitHub ends a line at
// a lone carriage return too), hidden and bidirectional control characters removed,
// secrets removed (by the caller's filter: `publish` knows no secret), then, outside fenced code, an invisible break
// (U+200B) put after each `@`, between the `!` and the `[` of each `![`, after the `<` of each tag, after the `&` of
// each entity, and before each run of three backticks or tildes. A break does the same whether GitHub shows that
// place as code or as text: no mention, image, tag or entity forms, and code still reads the same. Fenced code is
// the only code the filter knows, and only where GitHub surely opens it; it stays as written but for secrets and
// hidden characters, so a suggestion still applies. Hidden characters go first, so the filter's own breaks stay.
// Lookover filters again, last, once it has cut, trimmed, flattened or put a filtered text in a comment (render.ts):
// `filteredAgain` keeps the breaks already there, which are the filter's, and adds none twice.
import type { Finding } from "@lookover/contracts";
import { closes, closing, type Fence, opened } from "./fence.ts";
import type { PlacedRound } from "./types.ts";

/** The invisible break the filter puts in: a zero-width space, not a space to markdown. */
const BREAK = "\u{200B}";
/** The hidden characters but the break, as a character class's ranges: zero-width, bidirectional controls, tags, soft hyphen. */
const OTHER_HIDDEN =
  "\\u{00AD}\\u{061C}\\u{180E}\\u{200C}-\\u{200F}\\u{202A}-\\u{202E}\\u{2060}-\\u{2064}\\u{2066}-\\u{2069}\\u{FEFF}\\u{E0000}-\\u{E007F}";
/** Characters that change how text reads without showing: the break and the others, from one list so they can't drift. */
const HIDDEN = new RegExp(`[${BREAK}${OTHER_HIDDEN}]`, "gu");
/** The hidden characters but the break. */
const HIDDEN_BUT_BREAK = new RegExp(`[${OTHER_HIDDEN}]`, "gu");

/** `text` without its hidden characters. */
export const hiddenRemoved = (text: string): string => text.replace(HIDDEN, "");
/** The `&` that begins an entity: a decimal or hexadecimal reference, or a name, up to its `;`. */
const ENTITY = /&(?=(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});)/g;
/** A line end: GitHub ends a line at a lone carriage return too. */
const LINE_END = /\r\n?/g;
/** `text` with every line end a line feed, so the filter splits its lines where GitHub does. */
const lineFeeds = (text: string): string => text.replace(LINE_END, "\n");
/** A table's delimiter row, under its header row. */
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** A line that may close a fence: after its indent, a run of one character and spaces. */
const CLOSER = /^[ \t]*(`+|~+)[ \t]*$/;

/**
 * `text` as no markup can form in it: a break after each `@` (or fullwidth `＠`), inside each `![`, after a `<` a tag
 * may follow (a letter, `/`, `!` or `?`), after the `&` of each entity (`ENTITY`), and before each run of three backticks
 * or tildes, so no fence opens or closes there. A break already in its place is kept, not doubled.
 */
function broken(text: string): string {
  return text
    .replace(/[@\u{FF20}](?!\u{200B})/gu, `$&${BREAK}`)
    .replace(/!(?=\[)/g, `!${BREAK}`)
    .replace(/<(?=[A-Za-z/!?])/g, `<${BREAK}`)
    .replace(ENTITY, `&${BREAK}`)
    .replace(/(?<![\u{200B}`])`{3,}|(?<![\u{200B}~])~{3,}/gu, `${BREAK}$&`);
}

const bare = (line: string) => line.replace(/\n$/, "");
const blank = (line: string) => bare(line).trim() === "";

/** The columns the spaces and tabs that begin `text` take, a tab up to the next multiple of four. */
function indentOf(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === " ") columns++;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/**
 * Tells each line of a text, in order, whether it is fenced code GitHub surely shows as code. A fence opens on a line
 * of up to three spaces then the fence (in a list item or not, GitHub opens it there, since every other fence-like run
 * is broken). It is in a list item whose text begins at a column no further than its own, unknown: so it ends at the
 * first line indented less than its opening line, and at a closing line indented up to three columns more. Where GitHub
 * may read either (a closing line indented otherwise than its opening line, a line indented less), the filter opens no
 * fence again: a fence GitHub keeps open then runs to the end, its text broken, which is harmless.
 */
function fencedLines() {
  let fence: OpenFence | null = null;
  /** Set once GitHub may have read a fence either way: the filter opens none after. */
  let noMoreFences = false;
  const fenced = (line: string): boolean => {
    const text = bare(line);
    if (fence === null) {
      const open = noMoreFences ? null : opened(text);
      if (open) fence = { ...open, indent: indentOf(text) };
      return open !== null;
    }
    const read = blank(line) ? "in" : inFence(text, fence);
    if (read !== "in") fence = null;
    if (read === "dedented" || read === "may-close") noMoreFences = true;
    return read !== "dedented";
  };
  /** The fence still open after the lines read so far, or null. */
  const openAtEnd = (): OpenFence | null => fence;
  return { fenced, openAtEnd };
}

/** A fence the filter opened, and the columns its opening line is indented. */
type OpenFence = Fence & { indent: number };

/**
 * What the line `text` (not blank) is to the open `fence`: in it, its sure closing line, a line that may close it
 * (taken as its last), or a line indented less (taken out of it).
 */
function inFence(text: string, fence: OpenFence): "in" | "closing" | "may-close" | "dedented" {
  const at = indentOf(text);
  const run = CLOSER.exec(text)?.[1];
  if (run !== undefined && closes(run, fence) && at <= fence.indent + 3) {
    return at >= fence.indent && at <= 3 ? "closing" : "may-close";
  }
  return at < fence.indent ? "dedented" : "in";
}

/**
 * `text` as Lookover may post it again (ADR 0056): hidden characters removed, then secrets (`secretsRemoved`, the
 * caller's; none without), then, outside fenced code, a break wherever markup could form (`broken`). Fenced code is
 * left as written but for the first two.
 */
export function postableText(text: string, secretsRemoved: (text: string) => string = (t) => t): string {
  return outsideFences(secretsRemoved(hiddenRemoved(lineFeeds(text))));
}

/**
 * `text`, filtered once already (`postableText`, `postableLine`) and changed since: cut, trimmed, put in a comment,
 * filtered again as it is now. The breaks in it are the filter's: they stay, and none is added twice.
 */
export function filteredAgain(text: string): string {
  return outsideFences(lineFeeds(text).replace(HIDDEN_BUT_BREAK, ""));
}

/**
 * `text`, the fence the filter reads open at its end closed with its own closing line, as indented as its opening
 * line: what Lookover puts after it, its own lines and its hidden marker, then reads as text, not as code.
 */
export function fenceClosed(text: string): string {
  const { fenced, openAtEnd } = fencedLines();
  for (const line of lineFeeds(text).split(/(?<=\n)/)) fenced(line);
  const open = openAtEnd();
  if (open === null) return text;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${" ".repeat(open.indent)}${closing(open)}`;
}

/** `text` broken (`broken`) but in its fenced code. */
function outsideFences(text: string): string {
  const { fenced } = fencedLines();
  return text
    .split(/(?<=\n)/)
    .map((line) => (fenced(line) ? line : broken(line)))
    .join("");
}

/**
 * `text` on one line, as Lookover puts it in a list item or a sentence, filtered as that line: no fence there, every
 * run of backticks broken. A line that would be a table's delimiter row under a line with a `|` begins with a
 * backslash.
 */
export function postableLine(text: string): string {
  const line = broken(hiddenRemoved(text).replace(/\s+/g, " ").trim());
  return DELIMITER_ROW.test(line) ? `\\${line}` : line;
}

/**
 * `path` as Lookover shows it (ADR 0056): hidden characters and secrets (`secretsRemoved`, the caller's) removed. No
 * break: where the path is put, on a line (`postableLine`) or in the result's JSON, does that.
 */
export function postablePath(path: string, secretsRemoved: (text: string) => string = (t) => t): string {
  return secretsRemoved(hiddenRemoved(lineFeeds(path)));
}

/** How a round is filtered: each text an engine or a person wrote, and each finding's path. */
export interface RoundFilters {
  text: (text: string) => string;
  path: (path: string) => string;
}

/**
 * The filter of a round's findings, one object for each finding however often it is given: its category, title, body
 * and reason for closing, the confirm pass's reason and evidence, its claim's text, and its path. The path is for
 * showing only: placement reads the finding as given, so a comment goes on its path as the diff names it.
 */
export function findingFilter({ text: filter, path }: RoundFilters): (f: Finding) => Finding {
  const done = new Map<Finding, Finding>();
  return (f) => {
    const known = done.get(f);
    if (known) return known;
    const { confirmation } = f;
    const clean: Finding = {
      ...f,
      file: path(f.file),
      category: filter(f.category),
      confirmation:
        confirmation.verdict === "not_checked"
          ? confirmation
          : {
              ...confirmation,
              reason: filter(confirmation.reason),
              evidence: confirmation.evidence.map(filter),
            },
      title: filter(f.title),
      body: filter(f.body),
      closedWhy: f.closedWhy === null ? null : filter(f.closedWhy),
      claim: f.claim === null ? null : { ...f.claim, text: filter(f.claim.text) },
    };
    done.set(f, clean);
    return clean;
  };
}

/**
 * `round` with every text an engine or a person wrote filtered: each finding (`finding`, from `findingFilter`) and
 * each reply's reason. A finding listed twice (the ledger and what this round posts) stays one object.
 */
export function filteredRound<R extends PlacedRound>(
  round: R,
  filter: (text: string) => string,
  finding: (f: Finding) => Finding,
): R {
  const { reconciled } = round;
  return {
    ...round,
    reconciled: {
      ...reconciled,
      findings: reconciled.findings.map(finding),
      raised: reconciled.raised.map(finding),
      post: reconciled.post.map(finding),
      replies: reconciled.replies.map((r) => ({ ...r, why: filter(r.why) })),
    },
  };
}
