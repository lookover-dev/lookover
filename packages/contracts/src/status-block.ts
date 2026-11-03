// The status block in a pull request's description (ADR 0074): where Lookover's block goes and what of the author's
// text it keeps. One rule for every host adapter, fake and real, next to the markers it reads. And where a finding
// with no line comment shows its lines, one rule for `publish`'s block and the app's simulated page.
import type { Finding } from "./finding.ts";
import { STATUS_END_MARKER, STATUS_MARKER } from "./frozen.ts";
import { characterCount, DESCRIPTION_MAX_CHARACTERS, type RepositoryRef } from "./host.ts";
import type { CommitSha } from "./ids.ts";
import type { Round } from "./round.ts";

/** A path as a URL holds it: each part escaped, the slashes kept. */
const urlPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * Where a finding with no line comment shows its lines on GitHub (I-227), a permalink GitHub embeds: its file on the
 * commit its lines are on, `anchoredIn`'s among `rounds`, or `base`, the merge base, for a base-side finding; at its
 * line or range. Null when that commit isn't known.
 */
export function findingPermalink(
  repo: RepositoryRef,
  f: Pick<Finding, "side" | "anchoredIn" | "file" | "line" | "endLine">,
  commits: { base: CommitSha | null; rounds: Pick<Round, "n" | "sha">[] },
): { url: string; sha: CommitSha } | null {
  const sha = f.side === "base" ? commits.base : commits.rounds.find((r) => r.n === f.anchoredIn)?.sha;
  if (sha === null || sha === undefined) return null;
  const range = f.endLine !== null && f.endLine !== f.line ? `#L${f.line}-L${f.endLine}` : `#L${f.line}`;
  return { url: `https://github.com/${repo.owner}/${repo.name}/blob/${sha}/${urlPath(f.file)}${range}`, sha };
}

/** The block's place in a description: from its opening marker to the end of its closing one. */
interface Place {
  start: number;
  end: number;
}

/**
 * The first closing marker that has an opening marker before it, and the last opening marker before that closing
 * one; null when there is no such pair. An opening marker with no end before Lookover's block is never taken.
 */
function placeOf(description: string): Place | null {
  const first = description.indexOf(STATUS_MARKER);
  if (first === -1) return null;
  const close = description.indexOf(STATUS_END_MARKER, first + STATUS_MARKER.length);
  if (close === -1) return null;
  const start = description.lastIndexOf(STATUS_MARKER, close - STATUS_MARKER.length);
  return { start, end: close + STATUS_END_MARKER.length };
}

/**
 * The description with `block` as its status block. A description holding one (the first `STATUS_END_MARKER` with a
 * `STATUS_MARKER` before it, from the last such opening marker) has it replaced, everything outside the two kept byte
 * for byte, CRLF included. Else the block is written at the end: after the author's text with its trailing
 * whitespace trimmed and `---` between, or alone when that text is empty or whitespace (GitHub's null is empty). An
 * opening marker with no end stays in the author's text, on this write and every later one.
 */
export function spliceStatus(description: string | null, block: string): string {
  const text = description ?? "";
  const marked = `${STATUS_MARKER}\n${block}\n${STATUS_END_MARKER}`;
  const place = placeOf(text);
  if (place !== null) return `${text.slice(0, place.start)}${marked}${text.slice(place.end)}`;
  const author = text.trimEnd();
  return author === "" ? marked : `${author}\n\n---\n\n${marked}`;
}

/** The status block a description holds, as it was written; null when it holds none, or one with no end. */
export function statusOf(description: string | null): string | null {
  const text = description ?? "";
  const place = placeOf(text);
  if (place === null) return null;
  const inside = text.slice(place.start + STATUS_MARKER.length, place.end - STATUS_END_MARKER.length);
  return inside.replace(/^\n/, "").replace(/\n$/, "");
}

/** A block as compared: CRLF read as LF (a browser's edit saves the whole description with CRLF), no edge newlines. */
const comparable = (block: string) => block.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");

/**
 * Whether `description` shows `block` as its status block, line endings and newlines at its edges aside: how a host
 * adapter tells a read that caught up with its last write from one that lags it (ADR 0069).
 */
export function showsStatus(description: string | null, block: string): boolean {
  const held = statusOf(description);
  return held !== null && comparable(held) === comparable(block);
}

/**
 * How many characters the block may take in this description: `DESCRIPTION_MAX_CHARACTERS` less everything else
 * the spliced description holds (the author's text, the rule, the markers). Below zero when the author's text alone
 * is past it.
 */
export function statusRoom(description: string | null): number {
  return DESCRIPTION_MAX_CHARACTERS - characterCount(spliceStatus(description, ""));
}
