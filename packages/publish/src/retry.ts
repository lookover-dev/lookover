// A refused post tried again (ADR 0044): GitHub's transient refusals (a 5xx, its 422 "An internal error occurred",
// a network failure: `unavailable`; a limit, the secondary one included: `rate_limited`) are waited out on the
// caller's time, backing off from a few seconds to five minutes, for about an hour of refusals in a row; a limit
// waits at least a minute, and until the time the host gave when that is later. Any other refusal is final at once:
// sent again unchanged, it would be refused again. The hour counts per post (a post taken starts the next one's
// hour afresh) and is kept in memory only: a restart resumes the posts with a new hour (accepted, ADR 0044). Each
// wait is said as it starts, until when and why, and its end once the post lands or is given up (ADR 0055).
import { HostError, type HostFailure, type TransientHostFailure } from "@lookover/contracts";
import type { PostTime, PostWait } from "./types.ts";

/** Whether sending the same post again may be taken: the host failed or asked to wait, not refused it as it is. */
const TRANSIENT = {
  unavailable: true,
  rate_limited: true,
  not_found: false,
  unplaceable_comment: false,
  too_large: false,
  missing_marker: false,
  unauthorized: false,
  invalid: false,
} satisfies Record<HostFailure, boolean>;

function transient(failure: HostFailure): failure is TransientHostFailure {
  return TRANSIENT[failure];
}

/** How long refusals in a row are tried again before the last one is final. */
const RETRY_FOR_MS = 60 * 60_000;
const FIRST_WAIT_MS = 5_000;
const LONGEST_WAIT_MS = 5 * 60_000;
/** GitHub's secondary limits: "wait at least one minute" when it doesn't say until when. */
const LIMIT_WAIT_MS = 60_000;

/** The wait before try `n + 1` (from 0) after `refused`, at `now`. */
function waitAfter(refused: HostError, n: number, now: number): number {
  const backoff = Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** n);
  if (refused.failure !== "rate_limited") return backoff;
  return Math.max(backoff, LIMIT_WAIT_MS, (refused.retryAt ?? now) - now);
}

/** Settles once `ms` have passed on `time`; rejects with the signal's reason once it aborts. */
function sleep(time: PostTime, ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const stop = () => {
      cancel();
      reject(signal?.reason);
    };
    const cancel = time.after(ms, () => {
      signal?.removeEventListener("abort", stop);
      resolve();
    });
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * What `attempt` gives, tried again after each transient refusal while the refusals in a row last less than about
 * an hour. Without `time`, nothing is tried again. The last refusal, or one that isn't transient, propagates.
 * `waiting` hears each wait as it starts (until when, the refusal), and null once the attempt after a wait lands or
 * its refusal propagates; never for an attempt that never waited, nor once the signal ended a wait.
 */
export async function persist<T>(
  attempt: () => Promise<T>,
  time: PostTime | undefined,
  signal: AbortSignal | undefined,
  waiting: (wait: PostWait | null) => void = () => {},
): Promise<T> {
  let since: number | null = null;
  const over = () => {
    if (since !== null) waiting(null);
  };
  for (let n = 0; ; n++) {
    try {
      const got = await attempt();
      over();
      return got;
    } catch (error) {
      if (!(time && error instanceof HostError && transient(error.failure))) {
        over();
        throw error;
      }
      const now = time.now();
      const wait = waitAfter(error, n, now);
      if (now + wait - (since ?? now) > RETRY_FOR_MS) {
        over();
        throw error;
      }
      since ??= now;
      waiting({ until: now + wait, refusal: error.failure });
      await sleep(time, wait, signal);
    }
  }
}
