// Making the choice of repositories again (ADR 0090): the sign-in changed, so whoever is signed in now chooses
// before anything is asked. Its first half is here: every run under way stopped, every review not finished
// cancelled "the sign-in changed" by the store (`repos.signInChanged`: no check's end, post, dismissal post or
// reaction owed any more), and each review the UI shows waiting or running sent its job as it ended. The events go
// straight to the UI, never through the queue's `changed`, so neither the check follower nor the status block writes
// to GitHub for them, and the follower owes no block any more (`Checks.dropOwed`): a check or a block the earlier
// session left on GitHub stays as it was last written. Its second half is the setup's (`SetupFlow.again`): back at
// the GitHub step, the repositories not chosen. `chooseAgain` runs both in one synchronous turn, so no poll or take
// in between asks a review by itself, and only then waits for the cut runs' end. The install of whoever signs in is
// waited for afterwards, once the caller holds that sign-in (`SetupFlow.signedIn`, or `heldAtStart`). The service's
// tests show it through the room (`sign-in-other.test.ts`: the repositories unchosen while a cut run is slow to end).
// A repository leaving the installation (ADR 0053) sends its ended jobs the same way (`endedSent`).
// It must never know: who signed in, or why the choice is made again (the room's).
import { changeId, type EventBody, type JobState, type State } from "@lookover/contracts";
import type { Store } from "@lookover/store";
import type { Checks } from "./checks.ts";
import type { SetupFlow } from "./setup.ts";

/** The job states that haven't ended: those a cancel of every unfinished review ends. */
const PENDING = {
  queued: true,
  deferred: true,
  running: true,
  done: false,
  skipped: false,
  cancelled: false,
  failed: false,
} as const satisfies Record<JobState, boolean>;

export interface EndedDeps {
  store: Pick<Store, "jobs">;
  /** The UI's state, as the room last sent it. */
  shown(): Pick<State, "reviews">;
  emit(body: EventBody): void;
  now(): number;
}

/**
 * Each review the UI shows waiting or running, of the changes whose ids start with `changes` (every change for ""),
 * sent its change's latest job as the store now keeps it: cancelled, its run gone.
 */
export function endedSent(d: EndedDeps, changes: string): void {
  for (const [id, review] of Object.entries(d.shown().reviews)) {
    if (!id.startsWith(changes) || review.job === null || !PENDING[review.job.state]) continue;
    const ended = d.store.jobs.latest(changeId(id));
    if (ended !== null)
      d.emit({ type: "job.changed", at: d.now(), changeId: ended.changeId, job: ended.job });
  }
}

interface CancelDeps extends EndedDeps {
  store: Pick<Store, "jobs" | "repos">;
  /** The check follower: the status blocks it owes are for the reviews cancelled. */
  checks: Pick<Checks, "dropOwed">;
  /** The queue's: every run under way cut, nothing of it recorded; settles once they have ended. */
  stopRuns(): Promise<void>;
}

/**
 * Every review not finished cancelled as the sign-in changed (ADR 0090), with nothing written to GitHub: the runs
 * under way cut, the store's cancel, no status block owed, each job the UI shows unfinished sent as it ended, all
 * before it returns. The promise settles once the cut runs have ended, so a caller that waits for it holds nothing of
 * them when it goes on (a new sign-in, say).
 */
function cancelUnfinished(d: CancelDeps): Promise<void> {
  const stopped = d.stopRuns();
  d.store.repos.signInChanged(d.now());
  d.checks.dropOwed();
  endedSent(d, "");
  return stopped;
}

interface AgainDeps extends CancelDeps {
  setup: Pick<SetupFlow, "again">;
}

/**
 * The choice of repositories made again (ADR 0090): every review not finished cancelled (`cancelUnfinished`) and the
 * setup back at the GitHub step's start (`SetupFlow.again`), both before it returns, so the repositories are no
 * longer chosen when anything else runs. Settles once the cut runs have ended: then the caller holds the new
 * sign-in, if any, and waits for its install (`SetupFlow.signedIn`).
 */
export function chooseAgain(d: AgainDeps): Promise<void> {
  const stopped = cancelUnfinished(d);
  d.setup.again();
  return stopped;
}
