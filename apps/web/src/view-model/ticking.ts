// Running times tick in the browser (ADR 0058, design system "Running time"). The service's `now` moves only with an
// event or the event stream's keepalive (every 15 s), so a running step's time would stand, then jump. Between two,
// the browser counts on from the last `now` it got, at the pace the service's clock flows: 1 for the real one;
// demo mode's speed while its clock flows, 0 while it stands still. Proof's browser clock stands still too, so its
// shots never tick. The time shown never goes back when the next `now` comes in a little behind it.

import type { Review } from "@lookover/contracts";

/** Whether a review runs: the running times are redrawn once a second only then. */
export function somethingRuns(reviews: Record<string, Review>): boolean {
  return Object.values(reviews).some((review) => review.run !== null);
}

/** Where the ticking time counts from: the service's last `now`, the browser's time it arrived, and its pace. */
export interface Tick {
  /** The service's last `now`. */
  said: number;
  /** The time the count starts from: `said`, or the time shown when the pace last changed. */
  from: number;
  /** The browser's time at `from`. */
  at: number;
  /** Service milliseconds per browser millisecond. */
  pace: number;
  /** The time shown when this tick began: nothing shown after it is earlier. */
  floor: number;
}

/** The time to show at the browser's time `browserNow`. */
export function tickingNow(tick: Tick, browserNow: number): number {
  return Math.max(tick.floor, tick.from + Math.max(0, browserNow - tick.at) * tick.pace);
}

/**
 * The tick after the service's `now` and the clock's pace are read again at the browser's time `browserNow`: the
 * same tick when neither changed, else one counting from them, its floor the time shown until then. A `now` behind
 * the service's last one is another clock (a demo scenario loaded again): the time is taken as it comes.
 */
export function follow(tick: Tick | null, now: number, pace: number, browserNow: number): Tick {
  if (tick === null || now < tick.said) return { said: now, from: now, at: browserNow, pace, floor: now };
  if (tick.said === now && tick.pace === pace) return tick;
  const shown = tickingNow(tick, browserNow);
  if (tick.said === now) return { said: now, from: shown, at: browserNow, pace, floor: shown };
  return { said: now, from: now, at: browserNow, pace, floor: shown };
}
