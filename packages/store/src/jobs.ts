// The queue's record of its jobs (ADR 0029, ADR 0039, ADR 0040, ADR 0043), in the queue's verbs: "a review was asked
// for", "one was skipped, and why", "which jobs wait, and which engines are reviewing", "take the next job", "this
// change was pushed", "a run of this job reached this step, ended", "which jobs were left running", "which job does
// this change have now", "does it have one waiting or running", "the job's check on the host is this one", "it is
// completed", "which ends are owed", "how old is this run" (its folder's retention, ADR 0056).
// At most one waiting job of each kind per change (ADR 0043), a preview and a review that posts, which a unique index
// on the table keeps: a review asked for while the change's job waits joins it (moved to the commit asked for, queued
// again if deferred, the same id); asked for while its job runs, it is a follow-up waiting behind the run. A review
// request comment never joins a preview (the agent asked for a posted review): beside the owner's waiting preview it is
// a review of its own, behind it, as the take starts one job per change. A run's end that would leave its job waiting
// again (deferred, or interrupted by a restart) beside such a follow-up of its kind cancels the job instead: the
// follow-up reviews the newest commit. A push moves the change's waiting jobs to the new head as they wait (ADR 0040):
// deferred stays deferred, and no job is made (whether a push asks for a review is the caller's). An interrupted run
// puts its job back in the queue and counts the retry, which `leftRunning` gives with the step the run reached, for the
// restart's rule (`core.afterRestart`). A joined job keeps its first trigger; a review request comment that asked is
// recorded with the job it led to, joined or new (`requests`), and a job that yields to the follow-up hands its
// requests over. A run's end that says its round was posted (a round, or a failure recorded after its review landed)
// makes their 🚀 owed. A run ends as a round only once its round was saved (`posts.saved`, ADR 0044), which writes the
// round.
// The take (ADR 0043) is one immediate transaction: it offers each waiting job (queued or deferred), oldest first, to
// the caller's decision with the engines reviewing now (the finders and confirmers of the running jobs' runs, a run
// holding both, but a run posting its round, which freed them, ADR 0044), and those an older job left waiting its turn
// holds (first come, first served), and whether its change has a job running; records what the decision changed
// (deferred with a new reason, queued again or behind something else, skipped, cancelled, failed) and stops at the
// first start, whose job runs with its run from then on. A decision that changes nothing (the same reason, a queued
// job left queued behind the same) writes nothing and is not reported. A queued job keeps what it waits behind (its
// turn, ADR 0055) until it leaves the queue, or its change's run ends while it waits behind it. Nothing is held
// between the decision and the record: two takes, in one process or two, never start one job; a second process's
// take waits for the first (SQLite's busy timeout).
// A job that ended without a round (skipped, cancelled, failed) owes its check's end until `checkCompleted`: the end is
// the job's own, kept with it (why it was skipped or cancelled, how it failed), so a refused one is sent again, after a
// restart too.
// A job asked for as a preview (ADR 0047: the first review, "preview here only") is kept so, and the take is offered it
// so: the run it mints posts nothing. A preview sticks to the job it joins and the job a later ask joins (the owner was
// told nothing is posted; the pull request opened after the first listing has an ordinary job queued when the owner
// picks it at the first-review step), while the trigger stays the first ask's; a waiting job that holds a request is
// not joined by a preview, which is a job of its own beside it. A preview has no check (nothing is posted): its check
// is completed from the start, so none is ever created; a job joined by a preview once the host shows its check keeps
// following that one, and once done owes that check's end ("a preview") until `checkCompleted`, after a restart too.
// A job asked for in full (ADR 0052: the owner's `/lookover review full`) is kept so, and sticks as a preview does: to
// the job it joins, whatever joins it later, and to the follow-up a running one yields to with its requests; the take
// offers it so, and gives it with the run it starts. A
// waiting job the owner sent to the other engine (`reroute`, ADR 0047) keeps that engine with it, offered to the take
// as the finder to plan with, through the runs that defer it, until the job ends (as a round, skipped, cancelled or
// failed), when it is cleared: the next job of the change plans as usual.
// The job is contracts' `ReviewJob`, as the UI's events carry it, its failure included; every verb that changes a job
// gives it back as it now is, so the caller sends what was recorded. A run is kept only for what is read back: its job,
// the engines it holds (its finder and its confirmer), its commit, its steps and whether it ended. A job runs only with
// its one run not yet ended: the take's start writes both at once, `runEnded` ends both.
// Programming errors, thrown: a job or run the record doesn't hold; `runStepped` or `runEnded` on a run that has ended;
// `reroute` on a job that isn't waiting. What the decision throws leaves the take's transaction undone, and reaches the
// caller.
import type { Database } from "bun:sqlite";
import {
  type CancelReason,
  type ChangeId,
  type CommitSha,
  changeId,
  commitSha,
  type Deferral,
  deferralEngine,
  type EngineId,
  type EngineUnusable,
  enumOf,
  isWaiting,
  type JobFailure,
  type JobFailureKind,
  type JobId,
  type JobState,
  jobId,
  type ReviewJob,
  type Run,
  type RunId,
  type RunStep,
  runId,
  type SkipReason,
  sameDeferral,
  sameTurn,
  stepsDone,
  type Trigger,
  type Turn,
} from "@lookover/contracts";
import { z } from "zod";
import { pastPrefix } from "./prefix.ts";
import {
  type RequestComment,
  requestMover,
  requestsAnswered,
  requestsHeld,
  requestsUnanswered,
  requestWriter,
} from "./requests.ts";

/** A job as the record holds it: whose it is, and the job. */
export interface StoredJob {
  changeId: ChangeId;
  job: ReviewJob;
}

/**
 * A waiting job as the take is offered it: the job, whether its run is to post nothing (a preview, ADR 0047), whether
 * its round is a full one (ADR 0052: the owner's `/lookover review full`), and the engine the owner sent it to
 * (`reroute`), for the round plan to take as the finder; null when none.
 */
export interface WaitingJob extends StoredJob {
  preview: boolean;
  full: boolean;
  reroute: EngineId | null;
}

/**
 * How a run ends: as its round, saved as it reached publishing (`posts.saved`) and now posted, or as a preview's,
 * saved and posted nowhere (its requests wait for the change's next round that posts, ADR 0043); cut short because the
 * job has to wait (nothing failed, ADR 0029), and why; interrupted by a restart, its job back in the queue for
 * another run (ADR 0043); or failed. A failure with `posted` came after the run's review landed (its round's posts
 * given up after it, or its end as a round could not be recorded): the requests the job answers still get their 🚀.
 */
export type RunEnd =
  | { kind: "round" }
  | { kind: "preview" }
  | { kind: "deferred"; deferral: Deferral }
  | { kind: "interrupted" }
  | { kind: "failed"; failure: FailureFacts; posted?: boolean };

/** How a job failed, as its caller says it: the store adds the engine that was reviewing, the run's, if one ran. */
export type FailureFacts = Pick<JobFailure, "kind" | "detail">;

/** A job a stopped service left running: its open run, the step that run reached, how often a restart retried it. */
export interface LeftRunning extends StoredJob {
  runId: RunId;
  step: RunStep;
  retries: number;
}

/**
 * How old a run is, for its folder's retention (ADR 0056): a run the record doesn't hold, one still open (it, or its
 * job, runs: a round posting or resumed included), or one ended at `at`.
 */
export type RunAge = { kind: "unknown" } | { kind: "open" } | { kind: "ended"; at: number };

/** Where a run is: its step, since when, and the steps it did before, each with how long it took. */
export type RunSteps = Pick<Run, "step" | "stepAt" | "steps">;

/**
 * What the take does with one waiting job: start it with this run (it takes its reviewer and its confirmer), defer
 * it with a reason, put it back in the queue without one (`holds`: the engines it waits for, which the take counts
 * as reviewing for every younger job, first come, first served; `turn`: what it waits behind, kept with it), skip
 * it (nobody may review it: its check says why), cancel it (it will never run), and why, or fail it (whether it may
 * start couldn't be asked). Null leaves it as it is.
 */
export type Taking =
  | { kind: "start"; run: Run }
  | { kind: "defer"; deferral: Deferral }
  | { kind: "queue"; holds: EngineId[]; turn: Turn }
  | { kind: "skip"; reason: SkipReason }
  | { kind: "cancel"; reason: CancelReason }
  | { kind: "fail"; failure: FailureFacts };

/**
 * The take's decision for a waiting job, given the engines reviewing now (a run posting its round reviews no more,
 * ADR 0044), each with the change whose run holds it (null: an older job left waiting its turn holds it), and whether
 * another job of its change still runs, its round posting included. Called inside the transaction: it must not
 * touch the store, and it may mint the run it starts (an id, the clock); the take stops at the first start, so at
 * most one is minted per take, and one minted by a take that is undone is never used.
 */
export type TakeDecide = (
  waiting: WaitingJob,
  reviewing: ReadonlyMap<EngineId, ChangeId | null>,
  changeBusy: boolean,
) => Taking | null;

/** What a take did. */
export interface Took {
  /** The jobs it changed, in the order it decided, as they now are: deferred, queued, cancelled or failed. */
  changed: StoredJob[];
  /** The job it started, now running, its run, and whether its round is a full one; null when none started. */
  started: (StoredJob & { run: Run; full: boolean }) | null;
}

/** The jobs waiting, oldest first, as the take is offered them, and the engines reviewing now. */
export interface Waiting {
  jobs: WaitingJob[];
  reviewing: ReadonlySet<EngineId>;
}

/**
 * A review asked for: the commit, what asked, the id a new job takes (made only when one is), and the review request
 * comment that asked, if one did: recorded, handled, with the job it leads to.
 */
export interface Ask {
  sha: CommitSha;
  trigger: Trigger;
  id(): JobId;
  request?: RequestComment;
  /**
   * The review is to post nothing (ADR 0047: the first review, "preview here only"); false unless said. Sticks to
   * the job: one asked as a preview stays one whatever joins it, and one joined by a preview ask becomes one (a
   * waiting job that holds a request is not joined: the preview is a job of its own).
   */
  preview?: boolean;
  /**
   * The round is to be a full one (ADR 0052: the owner's `/lookover review full`, posted as a first round would);
   * false unless said. Sticks to the job, as a preview does: one asked so stays so whatever joins it, and one joined
   * by a full ask becomes one.
   */
  full?: boolean;
}

/** What a review asked for did to the change's waiting job. */
export interface Asked {
  /** The change's waiting job as it now is: the one it had, joined, or the job asked for. */
  job: ReviewJob;
  /** Whether the record changed: a new job, or the waiting one moved to the commit asked for or queued again. */
  changed: boolean;
  /** Whether it waits behind the change's running job: a follow-up, which starts once that run has ended. */
  followUp: boolean;
}

/** The waiting job a push moved, as it now is, and whether it is a follow-up behind the change's running job. */
export interface Pushed {
  job: ReviewJob;
  followUp: boolean;
}

export interface Jobs {
  /**
   * A review of `ask.sha` was asked for `changeId`, in one transaction. The change's waiting job the ask joins, if
   * it has one, moves to that commit (ADR 0040) and, if deferred, is put back in the queue (ADR 0042), as the same
   * job: a request's, the review that posts, never a preview; a preview's, the waiting preview, else the review
   * that posts unless it holds a request; any other's, the review that posts, else the preview. Otherwise a new
   * job, queued, waits, behind the change's running or waiting one if it has one.
   */
  asked(changeId: ChangeId, ask: Ask): Asked;
  /**
   * A review asked for `changeId` that `core.intake` skipped, and why (ADR 0016's reason on the check): a new job,
   * skipped from the start. It never waits, so it leaves the change's waiting job as it is. A preview's has no check:
   * completed from the start.
   */
  skipped(changeId: ChangeId, ask: Ask & { skip: SkipReason }): ReviewJob;
  /**
   * The waiting jobs, oldest first, and the engines reviewing now. It only looks, so the caller knows whose
   * health to ask before it takes (a job sent to an engine waits on that one); the take reads them again.
   */
  waiting(): Waiting;
  /**
   * The owner sent the waiting job to `to` (`engine.reroute`, ADR 0047): the take is offered it as the finder from
   * now on, until the job ends. A job that isn't waiting is a programming error.
   */
  reroute(id: JobId, to: EngineId): void;
  /**
   * Takes the next job, in one transaction: each waiting job, oldest first, is given to `decide`, and what it
   * decides is recorded, until the first start. Gives what it changed and what it started.
   */
  take(decide: TakeDecide): Took;
  /**
   * The change was pushed: its waiting jobs (its preview, its review that posts) now review `sha`, the new head,
   * each as the same job and in the state it waits in (ADR 0040), in one transaction. Makes no job. Gives each job
   * moved, oldest first, and whether it is a follow-up behind the change's running job; none when the change has no
   * waiting job, or they are already at `sha`.
   */
  pushed(changeId: ChangeId, sha: CommitSha): Pushed[];
  /**
   * The change, from a fork, was pushed to `sha` (ADR 0048): its waiting jobs not at `sha` end cancelled `pushed`
   * on the commit they were asked for, in one transaction, since nobody asked for the new head; their requests get
   * no 🚀. Gives each job ended, oldest first; none when the change has no waiting job, or they are already at `sha`.
   */
  forkPushed(changeId: ChangeId, sha: CommitSha): ReviewJob[];
  /** The run moved on to `step` at `at`. Gives where the run now is, the step done added to its `steps`. */
  runStepped(runId: RunId, step: RunStep, at: number): RunSteps;
  /**
   * The run ended at `at`, and its job with it: done, with the round and its ledger kept; deferred; queued again,
   * a retry more; or failed. A job that would wait again (deferred or interrupted) while its change has a waiting
   * job, the follow-up asked for during the run, is cancelled instead (`replaced`): the follow-up reviews the
   * newest commit. A follow-up waiting behind the change's run has its turn not said yet, until the next take.
   */
  runEnded(runId: RunId, end: RunEnd, at: number): ReviewJob;
  /** The jobs still running, oldest first: at start, those a stopped service left behind. */
  leftRunning(): LeftRunning[];
  /** How old run `id` is (ADR 0056): `id` is a run folder's name, which may be no run the record holds. */
  runAge(id: string): RunAge;
  /** The job the change has now: the last one asked for, or null. */
  latest(changeId: ChangeId): StoredJob | null;
  /**
   * Whether the job's run posts nothing (ADR 0047): asked as a preview, or joined by one while it waited, whatever
   * its trigger.
   */
  previewOf(id: JobId): boolean;
  /** Whether the change has a job waiting (queued or deferred) or running. */
  pending(changeId: ChangeId): boolean;
  /**
   * Whether a change whose id starts with `changes` has a job waiting or running (the service names a repository's
   * changes `<name>#<n>`): the repository is asked, and polled at the hot cadence (ADR 0043).
   */
  pendingIn(changes: string): boolean;
  /** The job's check as kept: the one it has, and whether it is completed. */
  checkOf(id: JobId): StoredJobCheck;
  /**
   * The host created the job's check, or the one it has now is another (on the commit it moved to); null: it has
   * none any more (the one it had was completed on the commit it left). A check made for a preview's job (asked for
   * before the preview joined) is no longer completed: its end, "a preview", is owed. A preview's job left with none
   * is completed: a preview makes no check.
   */
  checked(id: JobId, check: JobCheckRef | null): void;
  /** The job's check is completed, by its end or by the job's round: nothing is sent for it again. */
  checkCompleted(id: JobId): void;
  /**
   * The jobs that ended without a round (skipped, cancelled, failed) and whose check is not completed yet, oldest
   * first: the ends owed, to send again.
   */
  checksEnding(): (StoredJob & { check: StoredJobCheck })[];
  /**
   * The previews done (ADR 0047) whose check the host shows (made before the preview joined) and is not completed,
   * oldest first: each owes that check's end, "a preview", to send again until it is completed.
   */
  previewsEnding(): StoredJob[];
}

/** The check following a job on the host (ADR 0043): the host's id for it, and the commit it is on. */
export interface JobCheckRef {
  id: string;
  sha: CommitSha;
}

/** A job's check as kept: the one the host created (null while none), and whether it is completed. */
export interface StoredJobCheck {
  ref: JobCheckRef | null;
  completed: boolean;
}

// Each column's values, tied to the contracts type they hold: a value added to one and not the other fails the
// typecheck.
const STATE = enumOf<JobState>()(["queued", "deferred", "running", "done", "skipped", "cancelled", "failed"]);
/** The states a job has ended in. */
const ENDED = {
  queued: false,
  deferred: false,
  running: false,
  done: true,
  skipped: true,
  cancelled: true,
  failed: true,
} satisfies Record<JobState, boolean>;
/** The states a job ends in without a round. */
const ENDED_WITHOUT_ROUND = {
  queued: false,
  deferred: false,
  running: false,
  done: false,
  skipped: true,
  cancelled: true,
  failed: true,
} satisfies Record<JobState, boolean>;
const FAILURE = enumOf<JobFailureKind>()([
  "service_stopped",
  "prepare_failed",
  "review_failed",
  "publish_failed",
  "host_failed",
  "unexpected",
]);
const STEP = enumOf<RunStep>()(["preparing", "finding", "confirming", "publishing"]);
const TRIGGER = enumOf<Trigger>()(["opened", "push", "comment", "manual", "first-review"]);
const DEFERRAL = enumOf<Deferral["reason"]>()([
  "paused",
  "connection",
  "engine-signed-out",
  "engine-missing",
  "engine-limit",
  "engine-failed-self-test",
]);
const ENGINE = enumOf<EngineId>()(["claude", "codex"]);
const SKIP = enumOf<SkipReason>()([
  "not-yours",
  "draft",
  "repo-off",
  "on-open-off",
  "codex-not-yours",
  "fork",
]);
const CANCEL = enumOf<CancelReason>()(["closed", "replaced", "pushed"]);

export const jobRow = z.object({
  id: z.string().transform(jobId),
  change_id: z.string().transform(changeId),
  sha: z.string().transform(commitSha),
  trigger: TRIGGER,
  state: STATE,
  deferral_reason: DEFERRAL.nullable(),
  deferral_engine: ENGINE.nullable(),
  deferral_unusable: z.string().nullable(),
  skip: SKIP.nullable(),
  cancel: CANCEL.nullable(),
  failure_kind: FAILURE.nullable(),
  failure_detail: z.string().nullable(),
  failure_engine: ENGINE.nullable(),
  turn: z.string().nullable(),
});
const previewRow = z.object({ preview: z.union([z.literal(0), z.literal(1)]).transform((p) => p === 1) });
const leftRow = jobRow.extend({ run_id: z.string().transform(runId), run_step: STEP, retries: z.int() });
const waitingRow = jobRow.extend({
  preview: z.union([z.literal(0), z.literal(1)]).transform((p) => p === 1),
  full: z.union([z.literal(0), z.literal(1)]).transform((f) => f === 1),
  reroute: ENGINE.nullable(),
});

/** The waiting job as the take is offered it. */
function offered(r: z.infer<typeof waitingRow>): WaitingJob {
  return { ...jobOf(r), preview: r.preview, full: r.full, reroute: r.reroute };
}

const checkRow = z.object({
  check_id: z.string().nullable(),
  check_sha: z.string().transform(commitSha).nullable(),
  check_completed: z.union([z.literal(0), z.literal(1)]).transform((c) => c === 1),
});

// The lists' schemas, built once: a schema made per call costs more than the query it reads, and the poller asks
// for the waiting jobs and the checks' ends on every wake.
const waitingRows = z.array(waitingRow);
const engineRows = z.array(z.object({ engine: ENGINE, change_id: z.string().transform(changeId) }));
/** A turn as written below, from typed values: reading it back is reading our own JSON. */
const turnOf = (text: string | null): Turn | null => (text === null ? null : JSON.parse(text));
/** Why an engine found can't be used, as written below: our own JSON too. */
const unusableOf = (text: string): EngineUnusable => JSON.parse(text);
const changeRows = z.array(z.object({ change_id: z.string() }));
const leftRows = z.array(leftRow);
const ageRow = z.object({ ended_at: z.int().nullable(), state: STATE });
const endingRows = z.array(jobRow.and(checkRow));
const jobRows = z.array(jobRow);

function checkOf(r: z.infer<typeof checkRow>): StoredJobCheck {
  return {
    ref: r.check_id === null || r.check_sha === null ? null : { id: r.check_id, sha: r.check_sha },
    completed: r.check_completed,
  };
}

export const runRow = z.object({
  id: z.string().transform(runId),
  job_id: z.string().transform(jobId),
  reviewer: ENGINE,
  sha: z.string().transform(commitSha),
  step: STEP,
  step_at: z.int(),
  steps: z.string(),
  ended_at: z.int().nullable(),
});

export function jobOf(r: z.infer<typeof jobRow>): StoredJob {
  const deferral = (): ReviewJob["deferral"] => {
    switch (r.deferral_reason) {
      case null:
        return null;
      case "engine-signed-out":
      case "engine-missing":
      case "engine-limit":
      case "engine-failed-self-test":
        // Written with its engine: a row without one doesn't parse, and is never read as some engine's.
        if (r.deferral_engine === null)
          throw new Error(`job ${r.id}: deferral_engine is null for a deferral "${r.deferral_reason}"`);
        if (r.deferral_reason === "engine-missing")
          return {
            reason: r.deferral_reason,
            engine: r.deferral_engine,
            unusable: r.deferral_unusable === null ? null : unusableOf(r.deferral_unusable),
          };
        return { reason: r.deferral_reason, engine: r.deferral_engine };
      default:
        return { reason: r.deferral_reason };
    }
  };
  return {
    changeId: r.change_id,
    job: {
      id: r.id,
      sha: r.sha,
      trigger: r.trigger,
      state: r.state,
      deferral: deferral(),
      stepIn: null,
      skip: r.skip,
      cancel: r.cancel,
      failure:
        r.failure_kind === null
          ? null
          : { kind: r.failure_kind, detail: r.failure_detail ?? "", engine: r.failure_engine },
      turn: turnOf(r.turn),
    },
  };
}

/** `steps` is written below from typed values: reading it back is reading our own JSON. */
export function stepsOf(r: Pick<z.infer<typeof runRow>, "step" | "step_at" | "steps">): RunSteps {
  return { step: r.step, stepAt: r.step_at, steps: JSON.parse(r.steps) };
}

/** The waiting job as the take's decision leaves it; null when that changes nothing. */
function taken(job: ReviewJob, taking: Taking): ReviewJob | null {
  switch (taking.kind) {
    case "start":
      return { ...job, state: "running", deferral: null, turn: null };
    case "defer":
      if (job.state === "deferred" && sameDeferral(job.deferral, taking.deferral)) return null;
      return { ...job, state: "deferred", deferral: taking.deferral, turn: null };
    case "queue":
      if (job.state === "queued" && sameTurn(job.turn, taking.turn)) return null;
      return { ...job, state: "queued", deferral: null, turn: taking.turn };
    case "skip":
      return { ...job, state: "skipped", deferral: null, skip: taking.reason, turn: null };
    case "cancel":
      return { ...job, state: "cancelled", deferral: null, cancel: taking.reason, turn: null };
    case "fail":
      // No run of it started: no engine was reviewing.
      return {
        ...job,
        state: "failed",
        deferral: null,
        failure: { ...taking.failure, engine: null },
        turn: null,
      };
  }
}

/** The engines a job left waiting its turn waits for, added to those the younger jobs find taken. */
function hold(reviewing: Map<EngineId, ChangeId | null>, taking: Taking): void {
  if (taking.kind !== "queue") return;
  for (const engine of taking.holds) if (!reviewing.has(engine)) reviewing.set(engine, null);
}

/** The job after its run, by `reviewer`, ended so. */
function ending(job: ReviewJob, end: RunEnd, reviewer: EngineId): ReviewJob {
  switch (end.kind) {
    case "round":
    case "preview":
      return { ...job, state: "done" };
    case "deferred":
      return { ...job, state: "deferred", deferral: end.deferral, turn: null };
    case "interrupted":
      // The take says what it waits behind.
      return { ...job, state: "queued", deferral: null, turn: null };
    case "failed":
      return {
        ...job,
        state: "failed",
        deferral: null,
        failure: { ...end.failure, engine: reviewer },
        turn: null,
      };
  }
}

export function jobs(db: Database): Jobs {
  const insert = db.query(`
    INSERT INTO jobs (id, change_id, sha, trigger, state, preview, retries, check_completed)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?6)
  `);
  const insertSkipped = db.query(`
    INSERT INTO jobs (id, change_id, sha, trigger, state, skip, preview, retries, check_completed)
    VALUES (?1, ?2, ?3, ?4, 'skipped', ?5, ?6, 0, ?6)
  `);
  const update = db.query(`
    UPDATE jobs SET sha = ?, state = ?, deferral_reason = ?, deferral_engine = ?, deferral_unusable = ?, skip = ?,
      cancel = ?, failure_kind = ?, failure_detail = ?, failure_engine = ?, turn = ?
    WHERE id = ?
  `);
  const selectJob = db.query("SELECT * FROM jobs WHERE id = ?");
  const selectWaiting = db.query("SELECT * FROM jobs WHERE state IN ('queued', 'deferred') ORDER BY rowid");
  const sendTo = db.query("UPDATE jobs SET reroute = ? WHERE id = ? AND state IN ('queued', 'deferred')");
  // A preview has no check: one not asked for yet never will be; one the host shows, or makes later (its creation
  // in flight when the preview joined: `checked`), is followed to its end.
  const previewed = db.query(`
    UPDATE jobs SET preview = 1, check_completed = CASE WHEN check_id IS NULL THEN 1 ELSE check_completed END
    WHERE id = ?
  `);
  const fulled = db.query("UPDATE jobs SET full = 1 WHERE id = ?");
  // A job that yields to a follow-up hands it the owner's full ask with the requests (ADR 0052).
  const fullFrom = db.query(
    "UPDATE jobs SET full = MAX(full, (SELECT full FROM jobs WHERE id = ?1)) WHERE id = ?2",
  );
  const unroute = db.query("UPDATE jobs SET reroute = NULL WHERE id = ?");
  // A run holds its finder and its confirmer (ADR 0044); one posting its round has freed both.
  const selectReviewing = db.query(`
    SELECT runs.reviewer AS engine, jobs.change_id FROM runs JOIN jobs ON jobs.id = runs.job_id
    WHERE jobs.state = 'running' AND runs.ended_at IS NULL AND runs.step <> 'publishing'
    UNION
    SELECT runs.confirmer, jobs.change_id FROM runs JOIN jobs ON jobs.id = runs.job_id
    WHERE jobs.state = 'running' AND runs.ended_at IS NULL AND runs.step <> 'publishing'
      AND runs.confirmer IS NOT NULL
  `);
  // A change is busy while a job of it runs, or a dismissal of it owes posts (ADR 0052): a round never posts over one.
  const selectBusy = db.query(
    "SELECT change_id FROM jobs WHERE state = 'running' UNION SELECT change_id FROM dismissals WHERE ended_at IS NULL",
  );
  const selectSaved = db.query("SELECT 1 FROM plans WHERE run_id = ?");
  const selectWaitingOf = db.query(
    "SELECT * FROM jobs WHERE change_id = ? AND state IN ('queued', 'deferred') ORDER BY rowid",
  );
  const selectPreviewOf = db.query("SELECT preview FROM jobs WHERE id = ?");
  const selectRunningOf = db.query("SELECT 1 FROM jobs WHERE change_id = ? AND state = 'running' LIMIT 1");
  const selectLatest = db.query("SELECT * FROM jobs WHERE change_id = ? ORDER BY rowid DESC LIMIT 1");
  const selectPendingIn = db.query(
    "SELECT 1 FROM jobs WHERE change_id >= ?1 AND change_id < ?2 AND state IN ('queued', 'deferred', 'running') LIMIT 1",
  );
  const selectPending = db.query(
    "SELECT 1 FROM jobs WHERE change_id = ? AND state IN ('queued', 'deferred', 'running') LIMIT 1",
  );
  const selectLeft = db.query(`
    SELECT jobs.*, runs.id AS run_id, runs.step AS run_step FROM jobs
    JOIN runs ON runs.job_id = jobs.id AND runs.ended_at IS NULL
    WHERE jobs.state = 'running' ORDER BY jobs.rowid
  `);
  const insertRun = db.query(
    "INSERT INTO runs (id, job_id, reviewer, confirmer, sha, step, step_at, steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectRun = db.query("SELECT * FROM runs WHERE id = ?");
  const selectAge = db.query(
    "SELECT runs.ended_at, jobs.state FROM runs JOIN jobs ON jobs.id = runs.job_id WHERE runs.id = ?",
  );
  const updateStep = db.query("UPDATE runs SET step = ?, step_at = ?, steps = ? WHERE id = ?");
  const endRun = db.query("UPDATE runs SET ended_at = ? WHERE id = ?");
  const retried = db.query("UPDATE jobs SET retries = retries + 1 WHERE id = ?");
  const selectCheck = db.query("SELECT check_id, check_sha, check_completed FROM jobs WHERE id = ?");
  // A check the host made after a preview joined its job (its creation in flight then) is followed to its end too;
  // one a preview's job let go (moved to a newer commit) is its last: a preview makes none.
  const updateCheck = db.query(`
    UPDATE jobs SET check_id = ?1, check_sha = ?2,
      check_completed = CASE WHEN preview = 1 THEN ?1 IS NULL ELSE check_completed END
    WHERE id = ?3
  `);
  const completeCheck = db.query("UPDATE jobs SET check_completed = 1 WHERE id = ?");
  const selectEnding = db.query(`
    SELECT * FROM jobs WHERE check_completed = 0 AND state IN ('skipped', 'cancelled', 'failed') ORDER BY rowid
  `);
  const selectPreviewsEnding = db.query(`
    SELECT * FROM jobs WHERE check_completed = 0 AND check_id IS NOT NULL AND state = 'done' AND preview = 1
    ORDER BY rowid
  `);
  /** Runs a write on one job; a job the record doesn't hold is a programming error. */
  const onJob = (verb: string, id: JobId, changes: number): void => {
    if (changes === 0) throw new Error(`${verb}: no job ${id}`);
  };
  const addRequest = requestWriter(db);
  const moveRequests = requestMover(db);
  const answered = requestsAnswered(db);
  const unanswered = requestsUnanswered(db);
  const holdsRequests = requestsHeld(db);

  /** The job as the record holds it; one it doesn't hold is a programming error, and the parse throws. */
  const stored = (id: JobId): StoredJob => jobOf(jobRow.parse(selectJob.get(id)));
  /** The run, which must not have ended for `verb` to apply to it. */
  const open = (id: RunId, verb: string): z.infer<typeof runRow> => {
    const run = runRow.parse(selectRun.get(id));
    if (run.ended_at !== null) throw new Error(`${verb}: run ${id} has ended`);
    return run;
  };
  const write = (job: ReviewJob): void => {
    update.run(
      job.sha,
      job.state,
      job.deferral?.reason ?? null,
      deferralEngine(job.deferral),
      job.deferral?.reason === "engine-missing" && job.deferral.unusable !== null
        ? JSON.stringify(job.deferral.unusable)
        : null,
      job.skip,
      job.cancel,
      job.failure?.kind ?? null,
      job.failure?.detail ?? null,
      job.failure?.engine ?? null,
      job.state === "queued" && job.turn !== null ? JSON.stringify(job.turn) : null,
      job.id,
    );
    // Ended without a round: the requests it answers get no 🚀 (those whose round was posted are owed it already).
    if (ENDED_WITHOUT_ROUND[job.state]) unanswered(job.id);
    // Ended: where the owner sent it is the job's alone, and goes with it.
    if (ENDED[job.state]) unroute.run(job.id);
  };
  /** The change's waiting jobs, oldest first: its preview, its review that posts, or both. */
  const waitingAll = (changeId: ChangeId) => waitingRows.parse(selectWaitingOf.all(changeId)).map(offered);
  /** The change's waiting preview (`preview`), or its waiting review that posts, if it has one. */
  const waitingOf = (changeId: ChangeId, preview: boolean): ReviewJob | null =>
    waitingAll(changeId).find((w) => w.preview === preview)?.job ?? null;
  /**
   * The waiting job an ask joins: a request's, the review that posts, never a preview (the agent asked for a posted
   * review, ADR 0043); a preview's, the waiting preview, else the review that posts unless it holds a request; any
   * other's, the review that posts, else the preview. A request never sits on a preview, by construction: nothing else
   * places one.
   */
  const joinedBy = (changeId: ChangeId, ask: Ask): ReviewJob | null => {
    const posts = waitingOf(changeId, false);
    if (ask.request) return posts;
    const preview = waitingOf(changeId, true);
    if (ask.preview !== true) return posts ?? preview;
    if (preview !== null) return preview;
    return posts !== null && !holdsRequests(posts.id) ? posts : null;
  };

  const pushed = db.transaction((changeId: ChangeId, sha: CommitSha): Pushed[] => {
    const followUp = selectRunningOf.get(changeId) !== null;
    return waitingAll(changeId)
      .filter(({ job: was }) => was.sha !== sha)
      .map(({ job: was }) => {
        const job: ReviewJob = { ...was, sha };
        write(job);
        return { job, followUp };
      });
  });

  const forkPushed = db.transaction((changeId: ChangeId, sha: CommitSha): ReviewJob[] =>
    waitingAll(changeId)
      .filter(({ job: was }) => was.sha !== sha)
      .map(({ job: was }) => {
        const job: ReviewJob = { ...was, state: "cancelled", deferral: null, cancel: "pushed", turn: null };
        write(job);
        return job;
      }),
  );

  /** A new job for the ask, queued. */
  const queuedNew = (changeId: ChangeId, ask: Ask): Pick<Asked, "job" | "changed"> => {
    const job: ReviewJob = {
      id: ask.id(),
      sha: ask.sha,
      trigger: ask.trigger,
      state: "queued",
      deferral: null,
      stepIn: null,
      skip: null,
      cancel: null,
      failure: null,
      turn: null,
    };
    insert.run(job.id, changeId, job.sha, job.trigger, job.state, ask.preview === true ? 1 : 0);
    return { job, changed: true };
  };

  /** The waiting job `was`, joined by the ask: moved to its commit, queued again if deferred. */
  const joinedAs = (was: ReviewJob, ask: Ask): Pick<Asked, "job" | "changed"> => {
    // Queued, it waits behind the same; back from deferred, the take says behind what.
    const turn = was.state === "queued" ? was.turn : null;
    const job: ReviewJob = { ...was, sha: ask.sha, state: "queued", deferral: null, turn };
    const changed = job.sha !== was.sha || was.state !== "queued";
    if (changed) write(job);
    // A preview sticks: the UI's job doesn't carry it, so it is no change to send.
    if (ask.preview === true) previewed.run(job.id);
    return { job, changed };
  };

  const asked = db.transaction((changeId: ChangeId, ask: Ask): Asked => {
    const followUp = selectRunningOf.get(changeId) !== null;
    const was = joinedBy(changeId, ask);
    const { job, changed } = was === null ? queuedNew(changeId, ask) : joinedAs(was, ask);
    // A full round sticks to the job, as a preview does; the UI's job doesn't carry it either.
    if (ask.full === true) fulled.run(job.id);
    if (ask.request) addRequest(ask.request, job.id);
    return { job, changed, followUp };
  });

  const skipped = db.transaction((changeId: ChangeId, ask: Ask & { skip: SkipReason }): ReviewJob => {
    const job: ReviewJob = {
      id: ask.id(),
      sha: ask.sha,
      trigger: ask.trigger,
      state: "skipped",
      deferral: null,
      stepIn: null,
      skip: ask.skip,
      cancel: null,
      failure: null,
      turn: null,
    };
    insertSkipped.run(job.id, changeId, job.sha, job.trigger, ask.skip, ask.preview === true ? 1 : 0);
    if (ask.request) addRequest(ask.request, job.id);
    unanswered(job.id);
    return job;
  });

  /** Each engine reviewing now, with the change whose run holds it. */
  const reviewingNow = () =>
    new Map<EngineId, ChangeId | null>(
      engineRows.parse(selectReviewing.all()).map((r) => [r.engine, r.change_id]),
    );
  const waitingNow = (): Waiting => ({
    jobs: waitingRows.parse(selectWaiting.all()).map(offered),
    reviewing: new Set(reviewingNow().keys()),
  });

  const take = db.transaction((decide: TakeDecide): Took => {
    const waiting = waitingRows.parse(selectWaiting.all()).map(offered);
    // The engines reviewing, then those an older job waits for: a younger job finds them taken (first come, first
    // served).
    const reviewing = reviewingNow();
    const busy = new Set(changeRows.parse(selectBusy.all()).map((r) => r.change_id));
    const changed: StoredJob[] = [];
    for (const stored of waiting) {
      const taking = decide(stored, reviewing, busy.has(stored.changeId));
      if (taking === null) continue;
      hold(reviewing, taking);
      const job = taken(stored.job, taking);
      if (job === null) continue;
      write(job);
      if (taking.kind === "start") {
        startRun(job, taking.run);
        return { changed, started: { changeId: stored.changeId, job, run: taking.run, full: stored.full } };
      }
      changed.push({ changeId: stored.changeId, job });
    }
    return { changed, started: null };
  });

  /** The run the take started for `job`, recorded with the engines it holds. */
  function startRun(job: ReviewJob, run: Run): void {
    insertRun.run(
      run.id,
      job.id,
      run.reviewer,
      run.confirmer,
      run.sha,
      run.step,
      run.stepAt,
      JSON.stringify(run.steps),
    );
  }

  /** The change's run is over: a follow-up the take left behind it has its turn not said yet, until the next take. */
  const changeFreed = (changeId: ChangeId): void => {
    for (const { job } of waitingAll(changeId)) {
      if (job.turn?.behind === "change") write({ ...job, turn: null });
    }
  };

  const runEnded = db.transaction((id: RunId, end: RunEnd, at: number): ReviewJob => {
    const run = open(id, "runEnded");
    if ((end.kind === "round" || end.kind === "preview") && selectSaved.get(id) === null) {
      throw new Error(`runEnded: no round saved for run ${id}`);
    }
    const was = stored(run.job_id);
    let job = ending(was.job, end, run.reviewer);
    // Waiting again beside the follow-up of its kind asked for during the run: it yields to it, one waiting job of
    // each kind per change, and the follow-up answers the requests that led to it, a full one in full.
    const followUp = isWaiting(job)
      ? waitingOf(was.changeId, previewRow.parse(selectPreviewOf.get(run.job_id)).preview)
      : null;
    if (followUp !== null) {
      job = { ...job, state: "cancelled", deferral: null, cancel: "replaced" };
      moveRequests(job.id, followUp.id);
      fullFrom.run(job.id, followUp.id);
    }
    // Its round is on the host: the requests it answers are owed their 🚀, before a failure would settle them as never.
    if (end.kind === "round" || (end.kind === "failed" && end.posted === true)) answered(job.id);
    write(job);
    changeFreed(was.changeId);
    if (end.kind === "interrupted") retried.run(job.id);
    endRun.run(at, id);
    return job;
  });

  return {
    // Immediate: whether the change has a waiting job is read under the write lock.
    asked: (changeId, job) => asked.immediate(changeId, job),
    skipped: (changeId, ask) => skipped(changeId, ask),
    waiting: waitingNow,
    reroute: (id, to) => {
      if (sendTo.run(to, id).changes === 0) throw new Error(`reroute: job ${id} is not waiting`);
    },
    // Immediate: the write lock is taken before the waiting jobs are read, so no other take records in between.
    take: (decide) => take.immediate(decide),
    // Immediate, as `asked`: the change's waiting job is read under the write lock.
    pushed: (changeId, sha) => pushed.immediate(changeId, sha),
    forkPushed: (changeId, sha) => forkPushed.immediate(changeId, sha),
    runStepped: (id, step, at) => {
      const next: RunSteps = { step, stepAt: at, steps: stepsDone(stepsOf(open(id, "runStepped")), at) };
      updateStep.run(step, at, JSON.stringify(next.steps), id);
      return next;
    },
    runEnded: (id, end, at) => runEnded(id, end, at),
    leftRunning: () =>
      leftRows
        .parse(selectLeft.all())
        .map((r) => ({ ...jobOf(r), runId: r.run_id, step: r.run_step, retries: r.retries })),
    runAge: (id) => {
      const row = selectAge.get(id);
      if (row === null) return { kind: "unknown" };
      const { ended_at, state } = ageRow.parse(row);
      return ended_at === null || state === "running" ? { kind: "open" } : { kind: "ended", at: ended_at };
    },
    latest: (changeId) => {
      const row = selectLatest.get(changeId);
      return row === null ? null : jobOf(jobRow.parse(row));
    },
    previewOf: (id) => {
      const row = selectPreviewOf.get(id);
      if (row === null) throw new Error(`previewOf: no job ${id}`);
      return previewRow.parse(row).preview;
    },
    pending: (changeId) => selectPending.get(changeId) !== null,
    pendingIn: (changes) => selectPendingIn.get(changes, pastPrefix(changes)) !== null,
    checkOf: (id) => checkOf(checkRow.parse(selectCheck.get(id))),
    checked: (id, check) =>
      onJob("checked", id, updateCheck.run(check?.id ?? null, check?.sha ?? null, id).changes),
    checkCompleted: (id) => onJob("checkCompleted", id, completeCheck.run(id).changes),
    checksEnding: () => endingRows.parse(selectEnding.all()).map((r) => ({ ...jobOf(r), check: checkOf(r) })),
    previewsEnding: () => jobRows.parse(selectPreviewsEnding.all()).map((r) => jobOf(r)),
  };
}
