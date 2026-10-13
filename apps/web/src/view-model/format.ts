// Small formatting helpers for product copy. Plain words, exact numbers.
import { dayText, twoDigits } from "@lookover/contracts";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
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

/** "1:12", "59:59"; from an hour, "1:02:03". The time cell is as wide as "9:59:59" (design system "Running time"). */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m < 60
    ? `${m}:${twoDigits(s % 60)}`
    : `${Math.floor(m / 60)}:${twoDigits(m % 60)}:${twoDigits(s % 60)}`;
}

/** "3 min 14 s"; from an hour, "26 h 5 min" (the seconds dropped). */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const min = Math.round((s % 3600) / 60);
    return min === 0 ? `${h} h` : `${h} h ${min} min`;
  }
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

/** "08:52" */
export function clock(at: number): string {
  const d = new Date(at);
  return `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
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

export function isToday(now: number, at: number): boolean {
  return now - at < 16 * 3600_000;
}

/**
 * A sentence with a command in it: `before`, the command, `after`, joined by spaces. The UI shows the command as
 * inline code (design-system.md "Inline code"); a sentence with none is a plain string. An `after` with a command
 * of its own carries on the sentence with a second one.
 */
export interface WithCommand {
  before: string;
  command: string;
  after: string | WithCommand;
}
