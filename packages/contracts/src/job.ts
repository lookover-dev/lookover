// The review job (ADR 0029): a review asked for one head commit, from the moment it is asked for until it is
// done, skipped, cancelled or failed. Owned by the service's queue, in demo mode too (ADR 0046).
import type { EngineId, EngineState } from "./engine.ts";
import type { EngineUnusable } from "./engines-port.ts";
import type { ChangeId, CommitSha, JobId } from "./ids.ts";

/**
 * `queued`: waiting for its turn. `deferred`: it can't start yet for a reason outside the review itself,
 * and starts by itself once the reason clears. Nothing failed.
 */
export type JobState = "queued" | "deferred" | "running" | "done" | "skipped" | "cancelled" | "failed";

/** What asked for the review. An agent asks the way the owner does, with a review request comment. */
export type Trigger = "opened" | "push" | "comment" | "manual" | "first-review";

/**
 * Who wrote a review request comment (ADR 0081): `agent`, one with the marker `lookover wait` writes; `person`, the
 * command written by hand.
 */
export type AskedBy = "agent" | "person";

/**
 * Who pushed new commits (ADR 0081): `agent` when a coding agent signed every one GitHub listed; else null, no one
 * named (GitHub doesn't say who pushed).
 */
export type PushedBy = "agent" | null;

/**
 * Why a job was skipped. `not-yours`: another author's change nobody asked for in person (ADR 0016), only on the
 * skips recorded before ADR 0078: no new skip carries it, another author's change is not asked then.
 * `codex-not-yours`: another author's change, or a change from a fork asked for in person (ADR 0048), in a
 * repository where only Codex may review, and Codex reviews only the owner's own changes from the repository while
 * its reads aren't confined (ADR 0044); set by the round plan when the job is taken.
 * `fork`: the owner's change from a fork nobody asked for in person (ADR 0048); before ADR 0078, anyone's.
 */
export type SkipReason = "not-yours" | "draft" | "repo-off" | "on-open-off" | "codex-not-yours" | "fork";

/**
 * Why a waiting job was cancelled (ADR 0043): its change was closed, or a newer review of its change took its place
 * (the follow-up asked for while it ran, which reviews the newest commit). `pushed`: a change from a fork was pushed
 * while the owner's request for it waited (ADR 0048): nobody asked for the new head, so the owner asks again.
 */
export type CancelReason = "closed" | "replaced" | "pushed";

/**
 * Why a deferred job waits. An engine reason names the engine it waits for, one per engine state but `ready`;
 * `engine-failed-self-test`: its version failed Lookover's self-test (ADR 0044); `engine-self-test-unfinished`:
 * its self-test couldn't finish (ADR 0075). `engine-missing`'s `unusable`: a program was found but can't be used,
 * and why, null when none was found (a Codex too old for its model). No reason names the service: one that
 * answers is running (ADR 0046).
 */
export type Deferral =
  | { reason: "paused" | "connection" }
  | {
      reason:
        | "engine-signed-out"
        | "engine-limit"
        | "engine-failed-self-test"
        | "engine-self-test-unfinished";
      engine: EngineId;
    }
  | { reason: "engine-missing"; engine: EngineId; unusable: EngineUnusable | null };

/** The engine a deferral waits for; null for no deferral, or a reason that names none. */
export function deferralEngine(deferral: Deferral | null): EngineId | null {
  return deferral !== null && "engine" in deferral ? deferral.engine : null;
}

/** What each state of an engine but ready makes a review wait for, naming the engine. */
const ENGINE_WAITS: Record<
  Exclude<EngineState, "ready">,
  Extract<Deferral, { engine: EngineId }>["reason"]
> = {
  missing: "engine-missing",
  "signed-out": "engine-signed-out",
  limit: "engine-limit",
  "failed-self-test": "engine-failed-self-test",
  "self-test-unfinished": "engine-self-test-unfinished",
};

/**
 * The deferral an engine's state makes a review wait for (the one mapping: `core.engineHold` decides with it, the
 * app says why a confirm fell back with it); a missing one carries why the program found can't be used, if one was.
 */
export function engineDeferral(
  engine: EngineId,
  state: Exclude<EngineState, "ready">,
  unusable: EngineUnusable | null = null,
): Deferral {
  const reason = ENGINE_WAITS[state];
  return reason === "engine-missing" ? { reason, engine, unusable } : { reason, engine };
}

/**
 * What a queued job waits behind (ADR 0055), when nothing outside the review holds it (that is a deferral).
 * `engines`: engines it needs are busy, reviewing other changes (`changes`, the ones whose reviews hold them, empty
 * when none does: a Standard round's finder and confirmer can be on two) or `testing` (an engine's self-test holds
 * one). `change`: a round of its own change is still running or posting.
 */
export type Turn =
  | { behind: "engines"; engines: EngineId[]; changes: ChangeId[]; testing: boolean }
  | { behind: "change" };

/** The same thing to wait behind: the same engines, changes and self-test, in the same order. */
export function sameTurn(a: Turn | null, b: Turn | null): boolean {
  if (a === null || b === null || a.behind === "change" || b.behind === "change")
    return a?.behind === b?.behind;
  const same = <T>(x: T[], y: T[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return a.testing === b.testing && same(a.engines, b.engines) && same(a.changes, b.changes);
}

/** The same reason to wait, for the same engine, unusable for the same reason. */
export function sameDeferral(a: Deferral | null, b: Deferral | null): boolean {
  if (a === null || b === null) return a === b;
  const why = (d: Deferral) => JSON.stringify("unusable" in d ? d.unusable : null);
  return a.reason === b.reason && deferralEngine(a) === deferralEngine(b) && why(a) === why(b);
}

/**
 * Why a job failed, as a kind the UI words. `service_stopped`: the service stopped while the job ran, and
 * marked it at its next start. `prepare_failed`: the change's code could not be fetched. `review_failed`: the
 * engine gave no round. `publish_failed`: the host refused a post. `host_failed`: the host would not say what
 * the change is. `unexpected`: anything else.
 */
export type JobFailureKind =
  | "service_stopped"
  | "prepare_failed"
  | "review_failed"
  | "publish_failed"
  | "host_failed"
  | "unexpected";

/**
 * What a failure came from, finer than its kind, set where the error is still typed (ADR 0081), never parsed out of
 * `detail`. `git_silent`: git said nothing for retrieval's idle limit; `git_time_limit`: a git command ran past its
 * whole limit, in any step of getting the code ready (the fetch, the worktree, the diff, the commit check);
 * `engine_time_limit`: the engine ran past its limit; `base_not_found`: the commit and its base share no history, or
 * the host no longer has one of them; `path_too_long`: git refused a path too long for the machine; `git_missing`: no
 * git where the service runs; `network`: the host didn't answer (a rate limit has no cause); `engine_answer`:
 * the engine crashed or gave an answer that could not be read.
 */
export type FailureCause =
  | "git_silent"
  | "git_time_limit"
  | "engine_time_limit"
  | "base_not_found"
  | "path_too_long"
  | "git_missing"
  | "network"
  | "engine_answer";

export interface JobFailure {
  kind: JobFailureKind;
  /** What the module that failed said (git's words, the host's failure code…), for the record; never shown as is. */
  detail: string;
  /** The engine that was reviewing when it failed; null when no run had started. */
  engine: EngineId | null;
  /**
   * What it came from, when known; null otherwise. An event stored before ADR 0081 has no such field: a reader
   * treats `undefined` as unknown, the same as null (`failure.cause ?? null`).
   */
  cause: FailureCause | null;
  /**
   * The time limit that ran out, in ms, as it was configured; null for any other cause. `undefined` on an event
   * stored before ADR 0081: unknown, as for `cause`.
   */
  limitMs: number | null;
}

export interface ReviewJob {
  id: JobId;
  /** The head commit the review was asked for. */
  sha: CommitSha;
  trigger: Trigger;
  state: JobState;
  /** Set while the job is deferred. */
  deferral: Deferral | null;
  /**
   * The engine the job could step in to, when the owner asks (`engine.reroute`): set while the job is deferred on
   * an engine, by `core.stepIn` (the other engine, when the repository's reviewers allow it and it may review the
   * change, ADR 0047); null otherwise. The app only counts.
   */
  stepIn: EngineId | null;
  /** Set once the job is skipped. */
  skip: SkipReason | null;
  /** Set once the job is cancelled. */
  cancel: CancelReason | null;
  /** Set once the job failed. */
  failure: JobFailure | null;
  /** What it waits behind, set only while the job is queued (ADR 0055); null otherwise. */
  turn: Turn | null;
  /**
   * Who wrote the review request comment that asked for it, or the first that joined it (ADR 0081); null when no
   * request did. Missing on a job an event stored before ADR 0081 carries: read as null.
   */
  askedBy: AskedBy | null;
}

/** A job that has not started: waiting its turn (queued) or deferred. */
export function isWaiting(job: ReviewJob | null | undefined): job is ReviewJob {
  return job?.state === "queued" || job?.state === "deferred";
}
