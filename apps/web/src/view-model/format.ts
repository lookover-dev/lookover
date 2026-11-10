// Small formatting helpers for product copy. Plain words, exact numbers.
import { type CommitSha, dayText, type Repository, twoDigits } from "@lookover/contracts";

/**
 * Words with commits in them: text, or a commit, which a review screen draws as `Sha` and the mock GitHub view as a
 * link to it ("Looked over ", a commit, ". Two things to fix.").
 */
export type Words = (string | { commit: CommitSha })[];

/**
 * Whether the text after a chip of inline code starts with punctuation (".", ",", ":", ";", "!", "?", ")"), which then
 * sits against the chip as it would against a word (design-system.md "Inline code").
 */
export function punctuationNext(next: string | undefined): boolean {
  return next !== undefined && /^[.,:;!?)]/.test(next);
}

/** "sasensi/ledger-api": a repository with its owner, as Repositories lists every account's (ADR 0066). */
export function repositoryLabel(repo: Pick<Repository, "owner" | "name">): string {
  return `${repo.owner}/${repo.name}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Items as a list in a sentence, the last joined by `word`: "a", "a or b", "a, b or c". */
export function inSentence(items: readonly string[], word: "and" | "or"): string {
  const last = items.at(-1) ?? "";
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} ${word} ${last}` : last;
}

/**
 * The separator between a meta line's parts, " · ", its dot held to the part after it by a no-break space, so a line
 * that wraps breaks before a dot, never after one (design-system.md "Row").
 */
export const SEPARATOR = " · ";

/** A part's own " · ", each held as `SEPARATOR` holds its dot: for a part the screen puts beside others itself. */
export function holdSeparators(text: string): string {
  return text.replaceAll(" · ", SEPARATOR);
}

/** A meta line from its parts, one `SEPARATOR` between every two, and every " · " inside a part held the same way. */
export function metaLine(parts: readonly string[]): string {
  return parts.map(holdSeparators).join(SEPARATOR);
}

/** The word that points back at `n` things, beside `plural`: "it" for one, "them" for any other count. */
export function itOrThem(n: number): "it" | "them" {
  return n === 1 ? "it" : "them";
}

/** "12 min", "1 h", "yesterday", "3 days" */
export function ago(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days`;
}

export function agoSentence(now: number, at: number): string {
  const a = ago(now, at);
  return a === "just now" || a === "yesterday" ? a : `${a} ago`;
}

/**
 * How long something took or has taken, in words (ADR 0070): "40 s", "12 min 40 s", "12 min"; from an hour,
 * "26 h 5 min" (the seconds dropped). Floored, so a ticking time never shows a second early and the minutes carry
 * into the hour ("1 h 59 min", never "1 h 60 min").
 */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const min = Math.floor((s % 3600) / 60);
    return min === 0 ? `${h} h` : `${h} h ${min} min`;
  }
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

/**
 * The longest `duration`s a running time writes under a hundred hours, one with seconds and one with hours, as many
 * characters each but not as wide in every face: its box is held as wide as the wider of them (design system).
 */
export const LONGEST_RUNNING_TIMES = ["59 min 59 s", "99 h 59 min"] as const;

/** "08:52" */
export function clock(at: number): string {
  const d = new Date(at);
  return `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
}

/**
 * "16:02:31": a time of day to the second, in `timeZone` (the machine's by default), for what changes every few
 * seconds (the look line, ADR 0088), where `clock()`'s minutes would say the same time for a minute. Shown in tabular
 * figures (design-system.md "Clock to the second"), so a new second moves nothing after it.
 */
export function clockToSecond(at: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (type: Intl.DateTimeFormatPartTypes) =>
    twoDigits(Number(parts.find((p) => p.type === type)?.value));
  return `${n("hour")}:${n("minute")}:${n("second")}`;
}

const DAY_MS = 86_400_000;

/** The calendar day (as days since the epoch) and the "10:11" of `at`, in `timeZone` (the machine's by default). */
function local(at: number, timeZone: string | undefined): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const time = `${twoDigits(n("hour"))}:${twoDigits(n("minute"))}`;
  return { day: Date.UTC(n("year"), n("month") - 1, n("day")) / DAY_MS, time };
}

/**
 * When `at` is, against the service's clock `now` (the snapshot's, never the machine's `Date.now()`): its day in
 * calendar days, null for today, "tomorrow", else "Wed 14 Oct"; and its time. Both days are counted in the browser's
 * zone, while the check on GitHub words the reset in the service's: the two agree when the browser and the service
 * share a machine, as they do by default (the app is opened from the service's own link).
 */
function when(now: number, at: number, timeZone?: string): { day: string | null; time: string } {
  const then = local(at, timeZone);
  const days = then.day - local(now, timeZone).day;
  if (days === 0) return { day: null, time: then.time };
  if (days === 1) return { day: "tomorrow", time: then.time };
  return { day: dayText(new Date(then.day * DAY_MS)), time: then.time };
}

/** "until 10:11", "until tomorrow 10:11", "until Wed 14 Oct, 10:11" (ADR 0055). */
export function until(now: number, at: number, timeZone?: string): string {
  const { day, time } = when(now, at, timeZone);
  if (day === null) return `until ${time}`;
  return day === "tomorrow" ? `until tomorrow ${time}` : `until ${day}, ${time}`;
}

/** "at 10:11", "tomorrow at 10:11", "on Wed 14 Oct at 10:11" (ADR 0055). */
export function startsAt(now: number, at: number, timeZone?: string): string {
  const { day, time } = when(now, at, timeZone);
  if (day === null) return `at ${time}`;
  return day === "tomorrow" ? `tomorrow at ${time}` : `on ${day} at ${time}`;
}

/**
 * "at 10:11" today, "on Wed 14 Oct at 10:11" another day, tomorrow included: a reset as the status block on GitHub
 * says it (ADR 0074), in the browser's zone, which is the service's machine's by default.
 */
export function onDayAt(now: number, at: number, timeZone?: string): string {
  const then = local(at, timeZone);
  if (then.day === local(now, timeZone).day) return `at ${then.time}`;
  return `on ${dayText(new Date(then.day * DAY_MS))} at ${then.time}`;
}

/**
 * When a log line happened (ADR 0081): "16:02" on `now`'s day, "Sun 4 Oct 16:02" on another, in the browser's zone,
 * which is the service's machine's by default.
 */
export function logStamp(now: number, at: number, timeZone?: string): string {
  const then = local(at, timeZone);
  if (then.day === local(now, timeZone).day) return then.time;
  return `${dayText(new Date(then.day * DAY_MS))} ${then.time}`;
}

export function isToday(now: number, at: number): boolean {
  return now - at < 16 * 3600_000;
}

/**
 * A sentence with a command in it: `before`, the command, `after`, joined by spaces. The UI shows the command as
 * inline code (design-system.md "Inline code"); a sentence with none is a plain string. An `after` with a command
 * of its own carries on the sentence with a second one. `kind: "device-code"`: the command is a code a person types
 * elsewhere, drawn so its look-alikes can't be taken for each other (design-system.md "Device code"). `kind: "path"`:
 * the command is a path (a folder, a file), whose spaces are its own: a line breaks only after its separators. Any
 * other command breaks at the spaces between its words too (`ui/path.tsx`). `alone`: the sentence said instead when
 * the command is too long to sit in one (`codePlace`, `view-model/said.ts`), ending before it, `before` and `after`
 * folded in; the command then goes on its own line under it.
 */
export interface WithCommand {
  before: string;
  command: string;
  kind?: "device-code" | "path";
  after: string | WithCommand;
  /**
   * The sentence said when the command goes on its own line, ending before it. A string `after` is not said then:
   * fold it in here, or it is lost. An `after` with a command of its own still follows, under the line.
   */
  alone?: string;
  /**
   * The command goes on its own line (after `alone`) however short it is: where another form of the same sentence
   * has a value on that line, so the two hold the same lines (ADR 0086).
   */
  line?: true;
}
