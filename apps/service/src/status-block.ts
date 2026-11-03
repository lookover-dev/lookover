// Where a change's review stands, as its status block in the pull request's description says it (ADR 0074): read
// from the store each time a block is written, never from a text kept, so a block sent again, or late, never puts
// back an older one. The change's newest job decides: running, "Looking over" its commit ("again" on the last round's
// commit), with no list; waiting (queued, or deferred and why, with the reset of the engine's limit it waits on and
// the time it is written), or failed and how, each listing the last posted round's open findings, if there is one;
// else (no job, or one done, skipped, cancelled or a preview's) the last posted round. A round lists its number, its
// commit, every round's commit (where a finding's lines are), its own ledger as it stands now (a dismissal since
// included; never a preview's round's after it, which posts nothing) and where the loop stands, with the thread
// `publish` just read for each finding. A pull request no round ever posted on and no job of its waits, runs or failed
// on (one Lookover skips) gets no block: null.
// Two traps it holds: while a round posts, its own job is still running and the block says the round posted (the job
// saved the change's latest plan), whatever job waits behind it; and a block written late, for an older job, renders
// the newest job's standing, so it never puts back an older one over a newer job's running block.
// It must never know: the words of the block (`publish`), or the loop's rules (`core`).
import type { ChangeId, EngineId, ReviewJob, RunId } from "@lookover/contracts";
import { loopState } from "@lookover/core";
import type { RoundToPost, Status, StatusRound } from "@lookover/publish";
import type { Store } from "@lookover/store";

/** What a round's posts are rendered from, as the run saved it: the round as `publish` takes it. */
interface SavedPlan {
  post: Pick<RoundToPost, "round" | "sha" | "base">;
}

/** What the block reads beside the store: the time it is written, and until when an engine's limit holds. */
export interface StatusFacts {
  now(): number;
  /** Until when the engine's limit holds, as the UI is told (ADR 0055); null when none holds or no reset is known. */
  limitUntil(engine: EngineId): number | null;
}

/** The change's latest round saved to post, as `posts.latest` gives it (read once a block); null before any. */
type Latest = { runId: RunId; plan: SavedPlan } | null;

/** The change's last round that posted, as its block lists it, from its latest saved; null before any. */
function postedRound(
  store: Store,
  changeId: ChangeId,
  latest: Latest,
  threads: StatusRound["threads"],
): StatusRound | null {
  if (latest === null) return null;
  const { round: n, sha, base } = latest.plan.post;
  // Its own ledger, a dismissal since included: never a preview's after it, which posts nothing (ADR 0047).
  const findings = store.rounds.ledger(changeId, n);
  return {
    n,
    sha,
    base,
    rounds: store.rounds.of(changeId).filter((r) => r.n <= n),
    findings,
    loop: loopState(findings),
    threads,
  };
}

/** The change's latest round saved to post: its number, and its job as it is now; null before any. */
function savedRound(store: Store, latest: Latest): { n: number; job: ReviewJob } | null {
  const job = latest === null ? undefined : store.posts.of(latest.runId)?.job;
  return latest === null || job === undefined ? null : { n: latest.plan.post.round, job };
}

/**
 * The change's status as its block says it now, with `threads` (each finding's thread, as just read on the host):
 * from its newest job's standing, else its last posted round; null when neither says anything, so a pull request
 * Lookover never reviewed gets no block. A job skipped or cancelled since leaves the last posted round standing: a
 * dismissal after it still rewrites the block.
 */
export function statusNow(
  store: Store,
  changeId: ChangeId,
  threads: StatusRound["threads"],
  facts: StatusFacts,
): Status | null {
  const latest = store.posts.latest<SavedPlan>(changeId);
  const posted = postedRound(store, changeId, latest, threads);
  const asPosted: Status | null = posted === null ? null : { kind: "posted", posted };
  const saved = savedRound(store, latest);
  // A round posting (its job still running, its round saved) says the round, whatever job waits behind it.
  if (saved?.job.state === "running") return asPosted;
  const newest = store.jobs.latest(changeId)?.job ?? null;
  if (newest === null || store.jobs.previewOf(newest.id)) return asPosted;
  const rounds = store.rounds.of(changeId);
  // A job's round: the one it saved, else the one after the change's last.
  const round = saved?.job.id === newest.id ? saved.n : rounds.length + 1;
  const { sha } = newest;
  switch (newest.state) {
    case "running":
      return { kind: "running", sha, round, again: rounds.at(-1)?.sha === sha };
    case "queued":
      return { kind: "waiting", sha, round, deferral: null, until: null, now: facts.now(), posted };
    case "deferred": {
      const { deferral } = newest;
      const until = deferral?.reason === "engine-limit" ? facts.limitUntil(deferral.engine) : null;
      return { kind: "waiting", sha, round, deferral, until, now: facts.now(), posted };
    }
    case "failed":
      return {
        kind: "failed",
        sha,
        round,
        failure: newest.failure?.kind ?? "unexpected",
        engine: newest.failure?.engine ?? null,
        posted,
      };
    case "done":
    case "skipped":
    case "cancelled":
      return asPosted;
  }
}
