// Reading until GitHub shows a write (ADR 0069): GitHub's reads are eventually consistent after a write, so a live
// check that reads right after one, expecting to see it, reads again until it does, within a bound, then asserts on
// the last read as it always did. The port suites take the bound from their setup: 0 on the fakes, which show a
// write on the next read, so `bun run check` never waits.

/** How long GitHub may take to show a write, live: the push wait's, which saw a head lag about 3 s (spike 03, N5). */
export const LIVE_SHOWN_MS = 30_000;

/** How a suite waits for its host to show a write: fakes `{ boundMs: 0, pauseMs: 0 }`, live `LIVE_SHOWN_MS` and 1 s. */
export interface Patience {
  /** How long to keep reading. 0: one read, no pause. */
  boundMs: number;
  /** The pause between two reads. */
  pauseMs: number;
}

/** How every live check waits for GitHub to show a write: up to `LIVE_SHOWN_MS`, reading again every second. */
export const LIVE_PATIENCE: Readonly<Patience> = { boundMs: LIVE_SHOWN_MS, pauseMs: 1_000 };

export interface ReadUntilOptions {
  boundMs: number;
  /** 1 s unless given. */
  pauseMs?: number;
  /** Where the line saying GitHub didn't show it goes: the console unless given. */
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A wait's predicate asked of the very checks that follow it, so the wait is exactly as strict as they are: whether
 * `check` passes of the read. An error `isFailure` takes for a failed check (any, unless given) is false, run for its
 * verdict alone; any other error goes up. Any, by default, because a read not yet showing a write can make a check
 * throw a `TypeError` as well as a failed `expect`; a check with a real bug then costs one bound, live only, and its
 * error still comes, from the check run again on the last read.
 */
export const holds =
  <T>(check: (read: T) => unknown, isFailure: (error: unknown) => boolean = () => true) =>
  (read: T): boolean => {
    try {
      check(read);
      return true;
    } catch (error) {
      if (isFailure(error)) return false;
      throw error;
    }
  };

/**
 * Reads until `shows` holds of the read or `boundMs` runs out, and returns the last read either way: the assertion
 * after it fails on that read with its own message. Running out (with a bound above 0) logs one line, "GitHub didn't
 * show <what> within <n> s". A read that throws is not read again: its error goes up.
 */
export async function readUntil<T>(
  read: () => T | Promise<T>,
  shows: (read: T) => boolean,
  what: string,
  { boundMs, pauseMs = 1_000, log = console.log, sleep = pause, now = Date.now }: ReadUntilOptions,
): Promise<T> {
  const start = now();
  for (;;) {
    const last = await read();
    if (shows(last)) return last;
    const waited = now() - start;
    if (waited >= boundMs) {
      if (boundMs > 0) log(`GitHub didn't show ${what} within ${Math.round(boundMs / 1_000)} s`);
      return last;
    }
    await sleep(Math.min(pauseMs, boundMs - waited));
  }
}
