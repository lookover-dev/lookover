import { utf8Bytes } from "@lookover/contracts";
import { closes, closing, type Fence, opened } from "./fence.ts";

// Every body fits GitHub's limits (ADR 0044, #67): counted in UTF-8 bytes, a body over its budget is cut at a line
// and ends with a pointer to where the rest is. A cut never splits a character, and a code block it leaves open is
// closed with its own fence, so the pointer reads as text. Only when no whole line fits is a line cut, after its last
// character that does. A sentence (`clip`) is cut between two characters, with no pointer.

/** What a cut body ends with: where the rest is. The check's result keeps whole findings only, as many as fit. */
const CUT =
  "Cut to fit GitHub's limit: the rest is in Lookover, and in the check's result when it fits there.";

const POINTER = utf8Bytes(`\n\n${CUT}`);
const MORE = "…";

/** The fence left open after `line`, given the one open before it (null: none). */
function fenceAfter(line: string, open: Fence | null): Fence | null {
  if (open !== null) return closes(line, open) ? null : open;
  return opened(line);
}

/** `kept`, the code block it leaves open closed with its fence, then the pointer. */
function ending(kept: string, open: Fence | null): string {
  return `${kept}${open === null ? "" : `\n${closing(open)}`}\n\n${CUT}`;
}

/** The bytes `ending` adds after the kept text. */
const tail = (open: Fence | null) => POINTER + (open === null ? 0 : 1 + open.length);

/** The longest start of `line` within `room` bytes, whole characters only. */
function startOf(line: string, room: number): string {
  let kept = "";
  let size = 0;
  for (const char of line) {
    size += utf8Bytes(char);
    if (size > room) break;
    kept += char;
  }
  return kept;
}

/**
 * `text` when it is `budget` bytes or less; else its longest start of whole lines that fits with the pointer after
 * it, or, when no line fits whole, the first line cut short.
 */
export function cut(text: string, budget: number): string {
  if (utf8Bytes(text) <= budget) return text;
  const lines = text.split("\n");
  let size = -1;
  let count = 0;
  let open: Fence | null = null;
  for (const line of lines) {
    const next = size + 1 + utf8Bytes(line);
    const after = fenceAfter(line, open);
    if (next + tail(after) > budget) break;
    size = next;
    count += 1;
    open = after;
  }
  const kept = lines.slice(0, count).join("\n").trimEnd();
  if (kept !== "") return ending(kept, open);
  const first = lines[0] ?? "";
  const fence = fenceAfter(first, null);
  const short = `${startOf(first, budget - tail(fence) - utf8Bytes(MORE))}${MORE}`;
  return ending(short, fenceAfter(short, null));
}

/** `text` when it is `max` bytes or less; else its longest start that fits with `…` after it, whole characters only. */
export function clip(text: string, max: number): string {
  return utf8Bytes(text) <= max ? text : `${startOf(text, max - utf8Bytes(MORE))}${MORE}`;
}
