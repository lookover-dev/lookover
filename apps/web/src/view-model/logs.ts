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

/** The words of a line about a pull request: the pull request ("sasensi/ledger-api#151"), then the rest. */
const ABOUT = /^([\w.-]+\/[\w.-]+#\d+) (.*)$/;

/** A line as the page shows it: when the service wrote it, null for a line not of the file's shape, and its words. */
interface LogLineShown {
  /** The day, when it isn't the newest line's; else null. */
  day: string | null;
  /** Null for a line not of the file's shape. */
  time: string | null;
  /** Its words, past the pull request it is about: its run's head names that. */
  words: string;
}

/** Consecutive lines about one pull request, under a head naming it; or about none (`pr` null), under no head. */
export interface LogRun {
  pr: string | null;
  /**
   * The run's time column is the day's wider one: some line of it says the day. The column is the run's, not each
   * line's, so a run across midnight keeps its head and every line's words on one x.
   */
  day: boolean;
  lines: LogLineShown[];
}

/**
 * The lines as the page shows them (ADR 0083, round 6): the time the service wrote each, apart from its words, so a
 * long line wraps under its words, clear of the time (design-system.md "Code"); the day before the time when it isn't
 * the newest line's (the tail tops up from yesterday's file). They scan by pull request, each named once: consecutive
 * lines about one are a run under a head naming it, their words the rest, so a message gets the width the name took
 * on every line (round 5: "sasensi/lookover-sandbox#135" on every line drowned the words). Consecutive lines about none
 * are a run of their own, under no head. A line not of the file's shape is all words, and stays in the run before it
 * (a stack's lines under the error). A run's time column is one width for all its lines, the day's when any says it.
 */
export function logRunsShown(lines: string[]): LogRun[] {
  const parsed = lines.map((line) => LINE.exec(line));
  const today = parsed.findLast((match) => match !== null)?.[1];
  const runs: LogRun[] = [];
  lines.forEach((line, i) => {
    const match = parsed[i];
    const last = runs.at(-1);
    if (!match) {
      const shown = { day: null, time: null, words: line };
      if (last) last.lines.push(shown);
      else runs.push({ pr: null, day: false, lines: [shown] });
      return;
    }
    const [, day = "", time = "", words = ""] = match;
    const about = ABOUT.exec(words);
    const pr = about?.[1] ?? null;
    const shown = { day: day === today ? null : day, time, words: about?.[2] ?? words };
    if (last && last.pr === pr) {
      last.lines.push(shown);
      last.day ||= shown.day !== null;
    } else runs.push({ pr, day: shown.day !== null, lines: [shown] });
  });
  return runs;
}
