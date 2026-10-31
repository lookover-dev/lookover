// How often the service polls a watched repository (ADR 0043, ADR 0068): every 10 s while one of its changes is hot
// or setup shows a list of them, every 60 s otherwise. A change is hot while a review of it is asked, waiting or
// running, and for 30 minutes after one is posted: the agent is likely to push and ask again. Setup's Repositories
// and First review show every watched repository's open changes: a pull request opened then shows within seconds.

/** What makes a repository's changes hot. */
export interface PollFacts {
  /** A review of one of its changes is asked for, waiting or running. */
  asked: boolean;
  /** When a round on one of its changes was last posted; null when none was. */
  lastPostedAt: number | null;
  /** Setup, not done, shows Repositories or First review. */
  setupShowsList: boolean;
  now: number;
}

const HOT_MS = 10_000;
const QUIET_MS = 60_000;
/** How long a change stays hot after a round is posted on it. */
const AFTER_POST_MS = 30 * 60_000;

/** How long until the repository is polled again. */
export function pollEvery({ asked, lastPostedAt, setupShowsList, now }: PollFacts): number {
  const posted = lastPostedAt !== null && now - lastPostedAt < AFTER_POST_MS;
  return asked || posted || setupShowsList ? HOT_MS : QUIET_MS;
}
