// The service's time: a port of its own, so a test moves time by hand (gotchas: a wait on the clock is injected) and
// the service never reads or sleeps on the wall clock where a test can't reach it.

/** The service's timers: what waits for time to pass (the event stream's keepalive), and what time it is. */
export interface Timers {
  /** Calls `fire` once `ms` have passed; the function returned cancels it. */
  after(ms: number, fire: () => void): () => void;
  /** The time now, in milliseconds since the epoch, on the same clock `after` waits on. */
  now(): number;
}

/** The real timers, on the process's own clock. */
export const REAL_TIMERS: Timers = {
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
  now: () => Date.now(),
};
