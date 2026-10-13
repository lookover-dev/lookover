// The Logs page's list (ADR 0055): the log file, not the state. It lives in the page, never in the store (AGENTS.md
// rule 3): `followLogs` listens first, then reads the tail, so no line falls between the two, and keeps the lines
// heard while the tail was on its way that it doesn't end with. Each time the stream opens again it reads the
// tail again, since a line written while it was closed is never sent. The newest 200 lines are kept, newest last; but
// none is dropped from the top while the reader is scrolled away from the newest, so what they read stays put: a tail
// read again then only adds the lines it holds after those kept.
import type { LogMessage, LookoverApi } from "@lookover/contracts";

/** How many lines the page keeps: as many as the tail holds. */
const KEPT = 200;

/**
 * The lines `heard` since a read began that its `tail` doesn't hold. Those it holds were written first, so they are the
 * tail's last lines, in order: the most the tail ends with of the lines heard first are dropped, matched by place, not
 * by words, so a line heard that says what an older one said still shows (on a clock standing still, they are alike).
 */
function notIn(tail: string[], heard: string[]): string[] {
  for (let held = Math.min(tail.length, heard.length); held > 0; held--) {
    const end = tail.length - held;
    if (heard.slice(0, held).every((line, i) => line === tail[end + i])) return heard.slice(held);
  }
  return heard;
}

/**
 * Follows the log file: `show` gets the whole list each time it changes, first once the tail is in. `reading` says
 * whether the reader is scrolled away from the newest line: lines are then added, none dropped. The function returned
 * stops following; nothing is shown after it.
 */
export function followLogs(
  api: Pick<LookoverApi, "logs" | "subscribeLogs">,
  show: (lines: string[]) => void,
  reading: () => boolean = () => false,
): () => void {
  let following = true;
  /** The list shown; null until the first tail is in (or failed). */
  let lines: string[] | null = null;
  /** The lines heard since the latest read began; null when no read is under way. */
  let heard: string[] | null = null;
  /** The latest read's number: an older one answering late is dropped. */
  let reads = 0;
  const shown = (next: string[]) => {
    lines = reading() ? next : next.slice(-KEPT);
    show(lines);
  };
  const read = () => {
    const n = ++reads;
    heard = [];
    api.logs().then(
      (tail) => {
        if (!following || n !== reads) return;
        const during = heard ?? [];
        const fresh = [...tail, ...notIn(tail, during)];
        heard = null;
        if (lines === null || !reading()) return shown(fresh);
        // The reader is scrolled away: the lines kept before this read stay (each line heard since was added to them
        // last), and only what the file holds after them is added.
        const kept = lines.slice(0, lines.length - during.length);
        shown([...kept, ...notIn(kept, fresh)]);
      },
      (error: unknown) => {
        if (!following || n !== reads) return;
        console.error("Lookover's log could not be read", error);
        const after = heard ?? [];
        heard = null;
        // What was shown stays (each line heard since was added to it); else what was heard.
        shown(lines ?? after);
      },
    );
  };
  const stop = api.subscribeLogs((message: LogMessage) => {
    if (message.type === "connected") {
      read();
      return;
    }
    heard?.push(message.line);
    if (lines !== null) shown([...lines, message.line]);
  });
  read();
  return () => {
    following = false;
    stop();
  };
}

/** A line of the file: its stamp's day and time, and its words. */
const LINE = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.\d+\S* (.*)$/;

/**
 * The lines as the page shows them: the time the service wrote each, and its words; the day before the time when it
 * isn't the newest line's (the tail tops up from yesterday's file). A line not of that shape is shown as it is.
 */
export function logLinesShown(lines: string[]): string[] {
  const parsed = lines.map((line) => LINE.exec(line));
  const today = parsed.findLast((match) => match !== null)?.[1];
  return lines.map((line, i) => {
    const match = parsed[i];
    if (!match) return line;
    const [, day, time, words] = match;
    return `${day === today ? "" : `${day} `}${time}  ${words}`;
  });
}
