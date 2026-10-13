// The pause (ADR 0040): what each of the app's choices pauses for, and whether a pause holds at a moment. The
// service asks here, once, so "until tomorrow" means one thing wherever it is read.
import type { PauseFor, Service } from "@lookover/contracts";

type Paused = NonNullable<Service["paused"]>;

const HOUR = 3_600_000;

/** How long each choice pauses for; null: until the owner resumes. */
const LENGTH = {
  hour: HOUR,
  tomorrow: 18 * HOUR,
  forever: null,
} satisfies Record<PauseFor, number | null>;

/** The pause the owner asks for at `at`. */
export function pauseOf(duration: PauseFor, at: number): Paused {
  const length = LENGTH[duration];
  return { since: at, until: length === null ? null : at + length };
}

/** Whether `pause` holds at `now`: a timed pause is over at its end. */
export function pausedAt(pause: Paused | null, now: number): boolean {
  return pause !== null && (pause.until === null || now < pause.until);
}
