// When a plan's limit resets, from what the program said (ADR 0055): Claude's rejected rate-limit event gives it
// exactly; Codex writes it as text, in the machine's local time. A time in the past or more than 8 days away is
// none: a misreading would hold an engine for nothing, or for weeks. With no time read, the line that names the
// limit is kept for the log, so the reading can be fixed.
import type { EngineRunOutcome, EngineRunResult } from "@lookover/contracts";

const DAY_MS = 24 * 60 * 60_000;
/** The furthest a reset is believed: a week's window, and a day's margin. */
const AHEAD_MS = 8 * DAY_MS;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Codex's "try again at" time (0.154.0's binary, a real run on 0.162.0-alpha.2): dated, "Oct 14th, 2026 10:11 AM",
 * or bare, "1:00 AM".
 */
const TRY_AGAIN =
  /try again at (?:([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2}):(\d{2}) ?([AP])\.?M\b/i;

/** `until` when it is a reset to believe at `now`; null when it is past or too far. */
function believed(until: number, now: number): number | null {
  return until > now && until <= now + AHEAD_MS ? until : null;
}

/** Claude's reset: the rejected rate-limit event's `resetsAt`, in seconds since the epoch. */
export function claudeReset(resetsAt: number | null, now: number): number | null {
  return resetsAt === null ? null : believed(resetsAt * 1000, now);
}

/** Codex's reset, from what it said: a dated time as written, a bare one the next after `now`; local time both. */
export function codexReset(said: string, now: number): number | null {
  const match = TRY_AGAIN.exec(said);
  if (match === null) return null;
  const [, month, day, year, hours, minutes, half] = match;
  const hour = (Number(hours) % 12) + (half?.toUpperCase() === "P" ? 12 : 0);
  if (Number(hours) > 12 || Number(minutes) > 59) return null;
  if (month === undefined) {
    const at = new Date(now);
    at.setHours(hour, Number(minutes), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return believed(at.getTime(), now);
  }
  const m = MONTHS.indexOf(month.toLowerCase());
  const at = new Date(Number(year), m, Number(day), hour, Number(minutes));
  // No such day (Feb 30th): the date rolled over.
  if (m < 0 || at.getDate() !== Number(day)) return null;
  return believed(at.getTime(), now);
}

/** The first line of `text` that names the limit, trimmed; null when none does. */
export function limitLine(text: string, atLimit: RegExp): string | null {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => atLimit.test(line)) ?? null
  );
}

/** What a run's result says of its limit: when it resets, else what the program said; nothing for any other run. */
export function limitOf(
  outcome: EngineRunOutcome,
  until: number | null,
  said: string | null,
): Pick<EngineRunResult, "limitUntil" | "limitSaid"> {
  if (outcome !== "quota_exhausted") return {};
  if (until !== null) return { limitUntil: until };
  return said === null ? {} : { limitSaid: said };
}
