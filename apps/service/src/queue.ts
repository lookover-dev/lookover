// The queue (ADR 0029, ADR 0040, ADR 0042, ADR 0043): which jobs run. Nothing asked is lost (#62, #65):
// - One waiting job per change, kept by the store (`jobs.asked`). "Review now" on a change whose job waits (queued
//   or deferred) joins it: the same job moves to the newest head commit, and a deferred one is only put back in the
//   queue (it waits its turn, with no reason shown), whatever its reason was. Otherwise it makes a job for that
//   commit. Then the take runs. It asks as `core.intake` says, trigger "manual" (a draft and another author's change
//   too): in a repository switched off, a job skipped "repo-off", its check saying why, unless the change has a job
//   waiting or running, which the request joins as above (ADR 0047). The setup's first review (ADR 0047) is that
//   request with trigger "first-review", asked as a preview when the owner said "preview here only": its run posts
//   nothing (the run's header), and the preview sticks to the job it joins (the store's). One that posts, asked
//   while a review of its head commit runs that posts (the poll's, a request's, a first review's: not a preview's,
//   whatever its trigger), follows that run: no follow-up. A preview, or a review of an older commit, still asks its
//   own.
// - What the poll sees (ADR 0043, the poller's header): a change opened or a draft marked ready asks, trigger
//   "opened", as `core.intake` says with the repository's switches: a review (joining the waiting job, as a request
//   does), a job skipped with its reason from the start (another author's or a fork's: its check says why, ADR 0016,
//   ADR 0048), or nothing
//   (a draft, a switch off: nothing was asked, no check; `core.skipOutcome`; nor beside a job waiting or running,
//   such as the owner's request on another author's change: the skip would be the job shown). A push moves the
//   change's waiting job to the new head as it waits, then asks, trigger "push", the same way (a review only with
//   "review after every push" on). The poll's caller takes.
// - The owner's review request comment the poll saw asks, trigger "comment", as `core.intake` says: on a draft and on
//   another author's change too (ADR 0016's "requested by the owner"). It joins the change's waiting job (never a
//   preview: beside the owner's waiting preview it is a review of its own, which posts, behind it), queues a
//   follow-up behind its running one, or makes a job (in a repository switched off, a "repo-off" skip, as "Review
//   now"); the store records the request with that job, which answers it (its 👀 now, its 🚀 once its round is
//   posted; a run's end sends what is owed). The owner's `/lookover review full` makes that job a full round (ADR
//   0052), whatever joins it. A request on a commit already reviewed asks all the same: a new job, a new round (the
//   agent asks again after replying on a thread). The poll's caller takes.
// - A request while the change's job runs is a follow-up: a job for the newest head commit, waiting behind the run,
//   which is never cut. The UI goes on showing the run: nothing of another job of the change (joined, moved,
//   deferred, cancelled) is sent while it goes; once it has ended, the UI is sent the change's latest job, which
//   the take then starts if it waits. A job the run's end would leave waiting (deferred) beside a follow-up yields
//   to it, cancelled.
// - A run's end the store refuses twice fails the job in its own write, so its engine is free (the run's header).
// - Restart (`core.afterRestart`): a job a stopped service left running at publishing goes on with its round's
//   posts (ADR 0044: the round was saved; nothing is found again), its run resumed as if it never stopped. Any
//   other has its run ended, interrupted: it goes back to the queue, first in line as the oldest, unless a restart
//   already retried it once: then it fails, "the service stopped"; beside a follow-up it yields to it. Then the take
//   runs.
// - The host's connection (ADR 0047): while the poller shows it disconnected, every waiting job the pause and its
//   finder's state would let start waits as deferred "connection" instead; "Review now" still records the job, on
//   the head of the last listing, when the listing it asks for is refused as a disconnection. The poll that brings
//   the connection back takes.
// - Reroute (ADR 0047): "send the waiting reviews to the other AI" sends every job deferred on that engine whose
//   change the other may review (`core.stepIn`, never Codex on another author's) to it, kept by the store as the
//   finder its take plans with until the job ends; then the take runs. A job the UI is sent deferred on an engine
//   says which engine may step in for it (`stepIn`), by the same rule, computed each time it is sent.
// - Pause (ADR 0040): kept in the store (`pause`), since when and until when (`core.pauseOf`: an hour, 18 hours for
//   "until tomorrow", or until resumed). While it holds (`core.pausedAt`) nothing starts: every waiting job, a
//   request or a follow-up asked meanwhile included, waits as deferred "paused"; a running review finishes. Pausing
//   and resuming are each sent as `service.changed` and then take; resuming takes the jobs the pause held, oldest
//   first. A timed pause ends on the queue's timers at its end, as a resume; a take that finds it past its end first
//   (the timers lag behind the clock after a sleep) clears and sends it before deciding. While paused a take asks
//   no engine's health, and pausing cancels the tick. At a restart, a pause that ended while the service was stopped
//   is cleared (and sent) before the take; a timed one still on has its end armed again.
// The take is `store`'s (`jobs.take`): one transaction offers each waiting job, oldest first, to `core`'s
// `takeDecision`, with what `core`'s round plan reads (the change's author and who wrote it, the engines' states,
// ADR 0044), the repository's depth, and the engines reviewing now: one run per engine (ADR 0015), a run holding its
// finder and its confirmer, if any (none at Quick; Deep's second finder is its confirmer). A job starts with its plan
// (its run names the finder, Deep's second finder, the confirmer and why the finder confirms when it does),
// waits as deferred with its reason (paused, its finder missing, signed out, at its limit or failed its self-test),
// waits its turn queued while its finder or its confirmer reviews another or runs its self-test (the gate's
// `testing`, ADR 0044: a busy confirmer is waited for, never replaced by the finder) or while its change's last job
// still runs or posts its round (ADR 0044: a run frees its engine once its round is saved, and the take runs then),
// is skipped with its reason (only Codex may review here, and another author wrote the change: its check says why),
// or is cancelled when its change is gone. A queued job carries what it waits behind (its turn, ADR 0055): each busy
// engine is given to `core` with what holds it, the change whose run holds it, its self-test, or an older job.
// Each change is sent as the UI's event; a deferral whose reason didn't change, or a turn that didn't move, is no
// write and no event. The first start ends a take, its run starts, and the queue takes again, until a take starts
// nothing.
// When the take runs: after a job is recorded (a request), after a poll that saw something, after a run ends, after
// a repository's settings moved (`settingsMoved`, ADR 0049: when its reviewers moved, each job deferred on an engine
// is first sent again with who may step in for it now; a run under way keeps the settings it started with), after
// the restart's recovery, after "Check again" (`checkEngines`: every engine's health read and what changed sent,
// whether or not a job waits on it, and a version whose self-test failed or couldn't say tested again), after an
// engine's self-test ends (`tested`: its result sent as `engine.changed` when the UI shows another state), after
// the sign-in watch's look found its engine ready (`checkEngine` reads one engine's health and doesn't take: the
// watch, `sign-in.ts`, takes then), and every 60 s while a job waits on an engine. Before each take, the health of every engine a waiting job would
// take (its finder, its confirmer, and the other engine when the plan found it not ready: it may be ready now), and
// that isn't reviewing, is asked (on a tick, so, only the engines deferred jobs would take), with the state
// it shows once its self-test has its say (`self-tests.ts`: a ready engine whose version never passed is tested
// now); a health that differs from what the UI shows is sent as `engine.changed`. A run that found an engine
// signed out or at its limit (`ranInto`) has it shown so at once, and that state holds over a health that says
// ready (no self-test starts on it) for as long as a self-test's would (at its limit: until the reset the run read,
// ADR 0055, the tick waking then), or until "Check again"; the sign-in's
// look doesn't end it.
// What it reads to decide (#64): the jobs, the pause and the open changes from the store (the inbox, as the last
// listing left it: a change it no longer lists is gone, and its waiting job is cancelled at the next take, which a
// request for it runs too), the settings the service gives, and the engines' states as the UI shows them (the
// service's in-memory copy, which follows every `engine.changed`, whoever sends it); never the snapshot's replay,
// so a decision costs the same whatever the length of the event log.
// Ordering: one take at a time in this process; a take asked for while one runs makes it go round once more, so
// nothing asked is missed and a request never waits on another's health check. The take itself is atomic in the
// store, so two processes never start one job either. Once the service is stopping, a health check that answers
// late reads and writes nothing, no tick or pause end is armed, and pause and resume change nothing.
// Errors: what the host's listing or the store throw before the job is recorded reaches the caller of `request`.
// An engine whose health check throws (an adapter breaking its promise) fails the oldest job that would take it,
// "unexpected" with what was thrown, leaves the others as they are, and the queue takes again. What a take throws
// otherwise (the store) goes to the log, and the queue waits for the next request, run's end or tick.
// The check follows the job (ADR 0043): every job the store gives back changed (asked, taken, started, ended at
// a restart), a follow-up held back from the UI included, goes to the service's `checks`. A cancelled job says why
// (the take cancels a job whose change closed; a run's end, one a follow-up replaced). Every take first has
// `checks` send again the check ends owed, so the first take after a restart does too.
// It must never know: how a job is reviewed (the run's), or the rules themselves (`core`'s).

import type { LimitMet } from "@lookover/contracts";
import {
  type ChangeId,
  type Clock,
  type Connection,
  deferralEngine,
  type Engine,
  type EngineHealth,
  type EngineId,
  type EngineState,
  type Engines,
  type EngineUnusable,
  type EventBody,
  engineName,
  type IdGen,
  type JobId,
  jobId,
  type PauseFor,
  type RepositoryId,
  type ReviewJob,
  type Run,
  runId,
  type SkipReason,
  type Trigger,
} from "@lookover/contracts";
import {
  afterRestart,
  type EngineHold,
  intake,
  pausedAt,
  pauseOf,
  type ReviewPlan,
  roundPlan,
  skipOutcome,
  stepIn,
  type TakeDecision,
  takeDecision,
} from "@lookover/core";
import type {
  Ask,
  FailureFacts,
  RequestComment,
  RunEnd,
  Store,
  StoredJob,
  Taking,
  Took,
  WaitingJob,
} from "@lookover/store";
import type { Checks } from "./checks.ts";
import { disconnects } from "./poller.ts";
import type { Reactions } from "./reactions.ts";
import type { ResumeRun, Running, StartRun } from "./run.ts";
import { said } from "./said.ts";
import { type Gate, RAN_INTO_MS, type RanInto } from "./self-tests.ts";
import { type ChangeFacts, engineDetailOf, engineStateOf, type SettingsInForce } from "./snapshot.ts";
import type { Timers } from "./timers.ts";

/** How often the take looks again while a job waits on an engine (ADR 0043). */
const TICK_MS = 60_000;

export interface QueueDeps {
  store: Store;
  clock: Clock;
  ids: IdGen;
  engines: Engines;
  /**
   * The engines' self-tests (ADR 0044): the state a ready engine shows once its program has been self-tested, and
   * the engines busy testing, which the take treats as reviewing.
   */
  gate: Gate;
  /**
   * Each engine's state, version and limit's end as the UI shows them now: the service's in-memory copy, which
   * follows every `engine.changed`, whoever sends it. Reads nothing from the store.
   */
  engineStates(): Record<EngineId, Pick<Engine, "state" | "version" | "detail" | "limitUntil" | "unusable">>;
  /**
   * The host's connection as the UI shows it now (the poller's report, ADR 0047): the service's in-memory copy.
   * A job waits on it while it isn't connected; the poller takes again once it is.
   */
  connection(): Pick<Connection, "state">;
  /** The open changes, by id, as the inbox keeps them: read from the store at each call. */
  openChanges(): ReadonlyMap<ChangeId, ChangeFacts>;
  /** The settings that hold for a repository. */
  settings(repoId: RepositoryId): SettingsInForce;
  emit(body: EventBody): void;
  /** Lists the open changes of the change's repository again, so a request reviews the newest head commit. */
  list(changeId: ChangeId): Promise<void>;
  /** Starts the run of a job the take started; goes on with the posts of one a stopped service left publishing. */
  runs: { start: StartRun; resume: ResumeRun };
  /** Where every change of a job goes for its check to follow (ADR 0043). */
  checks: Pick<Checks, "follow" | "resend">;
  /** The reactions on review requests: sent once a run has ended (its round's 🚀). */
  reactions: Pick<Reactions, "send">;
  /** The tick's wait. */
  timers: Timers;
  /** Where a failure no request hears of goes; the console by default. */
  log?(line: string): void;
}

export interface Queue {
  /**
   * At start: the jobs a stopped service left running resume their posts, go back to the queue or fail, a line in
   * the log for each (ADR 0055); the take then runs.
   */
  recover(): void;
  /**
   * "Review now": the change's waiting job for its newest head commit, recorded; the take then runs. While the host
   * is down (a listing refused as a disconnection), for the head of the last listing: the job waits on the connection.
   * In a repository switched off, a job skipped "repo-off", unless the change has a job waiting or running, which it
   * joins (ADR 0047).
   */
  request(changeId: ChangeId): Promise<"ok" | "no_such_change">;
  /**
   * The setup's first review of the change (ADR 0047): "Review now" with trigger "first-review", its job a preview
   * when `preview` says so, whose run posts nothing.
   */
  firstReview(changeId: ChangeId, preview: boolean): Promise<"ok" | "no_such_change">;
  /**
   * The poll saw the change opened, or a draft marked ready: a review of its head commit, trigger "opened", as
   * `core.intake` says with the repository's switches. Skipped, the job is recorded so with its reason (its check
   * says why) only where `core.skipOutcome` says (another author's, a fork's): a draft or a switch off asked
   * nothing (ADR 0043). Not taken: the poll's caller takes.
   */
  opened(changeId: ChangeId): void;
  /**
   * The poll saw the change pushed to `sha`: its waiting job moves there (ADR 0040), and a review of it is asked,
   * trigger "push", only as `core.intake` says (with "review after every push" on). Not taken.
   */
  pushed(changeId: ChangeId, sha: ReviewJob["sha"]): void;
  /**
   * The poll saw the owner's review request comment on the change (ADR 0043): a review of its head commit, trigger
   * "comment", as `core.intake` says (a draft and another author's change included), recorded with the request,
   * which its job then answers: joined to the change's waiting job, a follow-up behind its running one, or a new
   * job; skipped with its reason (a repository switched off). Not taken: the poll's caller takes. `full`: the owner
   * asked `/lookover review full` (ADR 0052), which sticks to the job the request leads to.
   */
  requested(changeId: ChangeId, request: RequestComment, full: boolean): void;
  /** Runs the take (after a poll that saw something). */
  take(): void;
  /**
   * "Send the waiting reviews to the other AI" (`engine.reroute`, ADR 0047): every job deferred on `from` whose
   * change the other engine may review (`core.stepIn`: the repository's reviewers allow it, and never Codex on
   * another author's change) is sent to it, the finder its take plans with until the job ends; the take then runs,
   * and each starts on that engine or waits for it. Never automatic (ADR 0029): the owner's one click, on the jobs
   * deferred now; the next job of a change plans as usual.
   */
  reroute(from: EngineId): void;
  /**
   * The job as the UI is sent it: one deferred on an engine carries the engine that may step in for it (`stepIn`,
   * ADR 0047). For the run, whose end can leave its job deferred.
   */
  withStepIn(stored: StoredJob): StoredJob;
  /**
   * A repository's settings moved (ADR 0049): when its reviewers did (`reviewersMoved`), every job deferred on an
   * engine is sent again, saying who may step in for it now (the step-in reads the reviewers alone); then the take
   * runs, so a job waiting on an engine the settings no longer ask for, or on a confirmer a depth no longer plans,
   * moves on. A run under way keeps the settings it started with.
   */
  settingsMoved(reviewersMoved: boolean): void;
  /** Pauses reviews for `duration`, replacing any pause (ADR 0040): nothing starts until the resume or its end. */
  pause(duration: PauseFor): void;
  /** Resumes reviews: the jobs the pause held are taken. No change when none is set. */
  resume(): void;
  /**
   * "Check again": every engine's health read now, a state the UI doesn't show yet sent as `engine.changed`
   * (installing or signing in to an engine shows without a restart); the take then runs.
   */
  checkEngines(): Promise<void>;
  /**
   * The sign-in watch's look (ADR 0047): `engine`'s health read now and a state the UI doesn't show yet sent, as
   * "Check again" does for every engine, but its self-test never asked again. What a run ran into still holds over
   * a health that says ready (a signed-out hold for its minute, a limit until its reset): a sign-in the run disproved
   * isn't believed before then. The state it shows after; null when the service is stopping. Not taken: the watch
   * takes once the engine is ready.
   */
  checkEngine(engine: EngineId): Promise<EngineState | null>;
  /**
   * An engine's self-test ended (the gate's): the state it leads to, null for none, is sent as `engine.changed`
   * when the UI shows another; the take then runs (once the restart's recovery has). At the limit, the engine is
   * held as `ranInto` holds it, on what the self-test's run said (`met`).
   */
  tested(engine: EngineId, state: EngineState | null, met?: LimitMet): void;
  /**
   * A run found the engine signed out or at its limit (its finder, Deep's second finder or its confirmer answered
   * so): the engine shows that state, sent as `engine.changed`, and keeps it over a health that says ready for as
   * long as a self-test's would (`RAN_INTO_MS`), at its limit until the reset the run read (`met.limitUntil`, ADR
   * 0055), or until "Check again" (the sign-in's look, `checkEngine`, doesn't end it): the next take defers the jobs
   * it would find and plans another confirmer, instead of spending a session that fails, and the tick wakes at the
   * hold's end so they start then. A limit with no reset read logs the engine's words (`met.limitSaid`), once per
   * engine and words. Not taken: the run's end takes.
   */
  ranInto(engine: EngineId, state: RanInto, met?: LimitMet): void;
  /**
   * The repository whose changes' ids start with `changes` left the installation (ADR 0053): its runs under way are
   * cut now (nothing of them recorded: the caller records their jobs' end), and nothing follows their end, no
   * follow-up shown and no take; settles once they have ended.
   */
  leave(changes: string): Promise<void>;
  /** Takes no more jobs, cuts the runs in progress (nothing of them recorded) and waits for them. */
  stop(): Promise<void>;
}

/** Every engine, for "Check again". */
const ENGINES = Object.values({ claude: "claude", codex: "codex" } as const satisfies Record<
  EngineId,
  EngineId
>);

/** The engine a decision names: the one it starts with, or the one its deferral waits for. */
function engineNamed(decision: TakeDecision): EngineId | null {
  if (decision.kind === "start") return decision.plan.finder;
  return decision.kind === "deferred" ? deferralEngine(decision.deferral) : null;
}

/** What an engine's health check said: its state, or what it threw. */
type Health =
  | {
      kind: "state";
      state: EngineState;
      version: string | null;
      detail: string;
      unusable: EngineUnusable | null;
    }
  | { kind: "broken"; detail: string };

/**
 * What an ask carries besides its commit and trigger: the review request comment that asked, a preview, a full round.
 */
type Asking = Pick<Ask, "request" | "preview" | "full">;

export function createQueue(d: QueueDeps): Queue {
  /** The runs under way, by job. */
  const running = new Map<JobId, Running>();
  /** The take going round now, if any; `again` once another was asked for meanwhile. */
  let taking: Promise<void> | null = null;
  let again = false;
  /** Cancels the armed tick; null when none is armed. */
  let tick: (() => void) | null = null;
  /** When the armed tick fires. */
  let tickAt = 0;
  let stopping = false;
  /** The restart's recovery has run: a self-test that ends before it doesn't take. */
  let recovered = false;
  const now = () => d.clock.now();
  const log = d.log ?? ((line: string) => console.error(line));

  /** The job whose run is under way on each change: while it runs, the UI shows that run. */
  const runningOn = new Map<ChangeId, JobId>();
  /** The jobs whose runs were cut as their repository left the installation: nothing follows their end. */
  const left = new Set<JobId>();

  /**
   * What a run ran into, by engine (`ranInto`): until when it holds, and the end the UI is told, the reset the run
   * read or null when it read none (the app then says "until it resets", ADR 0055): the hold's own 15 minutes are
   * never shown as a time. In memory: a restart asks afresh.
   */
  const ranInto = new Map<EngineId, { state: RanInto; until: number; shown: number | null }>();

  /** The state a run ran into on `engine`, while it holds; null when none does. */
  const heldState = (engine: EngineId): RanInto | null => {
    const hold = ranInto.get(engine);
    if (hold === undefined) return null;
    if (hold.until > now()) return hold.state;
    ranInto.delete(engine);
    return null;
  };

  /**
   * The job as the UI is sent it (ADR 0047, I-167): deferred on an engine, it says which engine may step in for it
   * when the owner asks (`core.stepIn`: the other engine, when the repository's reviewers allow it and it may
   * review the change; none when its change is gone); otherwise nothing. The store keeps no such fact (#126 F2):
   * it is computed each time the job is sent, so it follows the deferral, and `settingsMoved` sends every job
   * deferred on an engine again, so it follows the repository's reviewers too (ADR 0049).
   */
  const withStepIn = (stored: StoredJob): StoredJob => {
    const engine = deferralEngine(stored.job.deferral);
    const change = engine === null ? undefined : d.openChanges().get(stored.changeId);
    const to =
      engine === null || change === undefined
        ? null
        : stepIn(engine, d.settings(change.repoId).values.reviewers, change);
    return to === stored.job.stepIn ? stored : { ...stored, job: { ...stored.job, stepIn: to } };
  };

  /**
   * The job's check follows the record (ADR 0043), a follow-up's too. The UI hears of the job as the record now
   * holds it, unless another job of its change runs: the UI's review shows one job, so a follow-up's change
   * (joined, moved, deferred, cancelled) is held back until the run has ended, when `followUpOf` sends the
   * change's latest job.
   */
  const changed = (stored: StoredJob): void => {
    d.checks.follow(stored);
    shown(stored);
  };

  /** The UI hears of the job as the record holds it, unless another job of its change runs (`changed`). */
  const shown = (stored: StoredJob): void => {
    const { changeId, job } = stored;
    const runningJob = runningOn.get(changeId);
    if (runningJob !== undefined && runningJob !== job.id) return;
    d.emit({ type: "job.changed", at: now(), changeId, job: withStepIn(stored).job });
  };

  /** Each engine's state as the UI shows it now. */
  const statesNow = (): Record<EngineId, EngineState> => {
    const shown = d.engineStates();
    return { claude: shown.claude.state, codex: shown.codex.state };
  };

  /**
   * The engines whose health a waiting job needs, by `core`'s round plan for its change (with the engine the owner
   * sent the job to as the finder, ADR 0047): none while its finder reviews another (it waits its turn whatever
   * the others' health) or when the change is gone or skipped; its finder alone while the finder isn't ready (it
   * waits for it, and the take asks the others once it is); else its finder, its confirmer (none at Quick), and the
   * other engine when the plan falls back on the finder only because that one wasn't ready (it may be now).
   * Reviewing engines are not asked.
   */
  const needs = (
    open: ReadonlyMap<ChangeId, ChangeFacts>,
    reviewing: ReadonlySet<EngineId>,
    { changeId, reroute }: WaitingJob,
  ): EngineId[] => {
    const change = open.get(changeId);
    if (!change) return [];
    const engines = statesNow();
    const { reviewers, depth } = d.settings(change.repoId).values;
    const plan = roundPlan({ reviewers, change, depth, engines, finder: reroute });
    if (plan.kind === "skipped" || reviewing.has(plan.finder)) return [];
    if (engines[plan.finder] !== "ready") return [plan.finder];
    const fallback = plan.confirmFallback?.reason === "not-ready" ? [plan.confirmFallback.engine] : [];
    const confirmer = plan.confirmer === null ? [] : [plan.confirmer];
    return [plan.finder, ...confirmer, ...fallback].filter((engine) => !reviewing.has(engine));
  };

  /** Asks the engine's health; a check that throws breaks the port's promise and is kept as what it threw. */
  const healthOf = async (engine: EngineId): Promise<[EngineId, EngineHealth | { broken: string }]> => {
    try {
      return [engine, await d.engines.health(engine)];
    } catch (error) {
      return [engine, { broken: said(error) }];
    }
  };

  /**
   * The state an engine shows given the health it answered, once its self-test has its say (the gate's, which may
   * start the self-test: `again` for "Check again").
   */
  const stateOf = (
    engine: EngineId,
    answer: EngineHealth | { broken: string },
    reviewing: ReadonlySet<EngineId>,
    again: boolean,
  ): Health => {
    if ("broken" in answer) return { kind: "broken", detail: answer.broken };
    const shown = d.engineStates()[engine].state;
    if (again) ranInto.delete(engine);
    const held = heldState(engine);
    // What a run ran into holds over a health that says ready: no self-test is started on it meanwhile.
    const state =
      held !== null && engineStateOf(answer) === "ready"
        ? held
        : d.gate.stateOf(engine, answer, { shown, reviewing: reviewing.has(engine), again });
    return {
      kind: "state",
      state,
      version: answer.version,
      detail: engineDetailOf(engine, answer),
      unusable: answer.why ?? null,
    };
  };

  /**
   * Until when the engine's limit holds, for the UI: the reset the run read with state `limit`; null when it read
   * none, or with any other state, so an end once shown never stays on an engine that is ready again.
   */
  const limitUntilOf = (engine: EngineId, state: EngineState): Pick<Engine, "limitUntil"> => ({
    limitUntil: state === "limit" ? (ranInto.get(engine)?.shown ?? null) : null,
  });

  /** The limits' words already logged, by engine: each is written once (ADR 0055). */
  const unreadSaid = new Set<string>();

  /**
   * Holds `engine` in `state` (`ranInto`): at its limit until the reset the run read, else for `RAN_INTO_MS`; the UI
   * is sent the state, or only its new end when it already shows it. A limit with no reset read logs what the
   * engine said, once per engine and words.
   */
  function hold(engine: EngineId, state: RanInto, met: LimitMet): void {
    const at = now();
    const read = state === "limit" ? met.limitUntil : undefined;
    ranInto.set(engine, { state, until: read ?? at + RAN_INTO_MS[state], shown: read ?? null });
    const was = d.engineStates()[engine];
    // At its limit, the UI says until when it holds; signed out has no end to say.
    const end = limitUntilOf(engine, state);
    if (was.state !== state)
      d.emit({ type: "engine.changed", at, id: engine, patch: { state, since: at, ...end } });
    else if (was.limitUntil !== end.limitUntil)
      d.emit({ type: "engine.changed", at, id: engine, patch: end });
    const words = state === "limit" && read === undefined ? met.limitSaid : undefined;
    if (words !== undefined && !unreadSaid.has(`${engine}\0${words}`)) {
      unreadSaid.add(`${engine}\0${words}`);
      log(`${engineName(engine)} gave no reset time Lookover can read: ${words}`);
    }
  }

  /** The engines a waiting job would take and that aren't reviewing: whose health the take needs. */
  const toAsk = (): EngineId[] => {
    const { jobs, reviewing } = d.store.jobs.waiting();
    const open = d.openChanges();
    return [...new Set(jobs.flatMap((stored) => needs(open, reviewing, stored)))];
  };

  /**
   * The health of `engines` (by default every engine a waiting job would take and that isn't reviewing), asked
   * now; a state the UI doesn't show yet is sent. Null when the service began stopping meanwhile (its store may be
   * closed).
   */
  async function askHealth(
    engines: EngineId[] = toAsk(),
    again = false,
  ): Promise<Map<EngineId, Health> | null> {
    const answers = await Promise.all(engines.map(healthOf));
    if (stopping) return null;
    // The gate is asked once every health is in, in one go: a self-test that ended while another engine's health
    // was pending is never overwritten by a state read before it ended (PR #100).
    const { reviewing } = d.store.jobs.waiting();
    const health = new Map(answers.map(([e, answer]) => [e, stateOf(e, answer, reviewing, again)] as const));
    const engineStates = d.engineStates();
    for (const [engine, h] of health) {
      if (h.kind === "broken") continue;
      const was = engineStates[engine];
      const moved = was.state !== h.state || was.version !== h.version;
      if (!moved && was.detail === h.detail) continue;
      const at = now();
      // A new state starts its `since`; a new detail alone (why it is signed out) doesn't.
      d.emit({
        type: "engine.changed",
        at,
        id: engine,
        patch: moved
          ? {
              state: h.state,
              version: h.version,
              detail: h.detail,
              unusable: h.unusable,
              since: at,
              ...limitUntilOf(engine, h.state),
            }
          : { detail: h.detail, unusable: h.unusable },
      });
    }
    return health;
  }

  /**
   * The health the take needs: asked once, then once more for the engines a finder found ready just now makes
   * needed (its confirmer, whose last known state would otherwise decide who confirms). Null as `askHealth`.
   */
  async function askHealthTwice(): Promise<Map<EngineId, Health> | null> {
    const first = await askHealth();
    if (first === null) return null;
    const more = toAsk().filter((engine) => !first.has(engine));
    if (more.length === 0) return first;
    const second = await askHealth(more);
    return second === null ? null : new Map([...first, ...second]);
  }

  /**
   * A new run of `job` as the round plan has it (who finds, twice at Deep, who confirms, and why the finder when it
   * does), now; a preview's posts nothing (ADR 0047).
   */
  const runOf = (job: ReviewJob, plan: ReviewPlan, preview: boolean): Run => {
    const at = now();
    return {
      id: runId(d.ids.next()),
      reviewer: plan.finder,
      secondFinder: plan.secondFinder,
      confirmer: plan.confirmer,
      confirmFallback: plan.confirmFallback,
      sha: job.sha,
      preview,
      startedAt: at,
      step: "preparing",
      stepAt: at,
      steps: [],
      activities: [],
      posting: null,
    };
  };

  /** What the store records of `core`'s decision for a waiting job. */
  const takingOf = ({ job, preview }: WaitingJob, decision: TakeDecision): Taking => {
    switch (decision.kind) {
      case "start":
        return { kind: "start", run: runOf(job, decision.plan, preview) };
      case "deferred":
        return { kind: "defer", deferral: decision.deferral };
      case "queued":
        return { kind: "queue", holds: decision.holds, turn: decision.turn };
      case "skipped":
        return { kind: "skip", reason: decision.reason };
      case "cancelled":
        // The take cancels a job only when its change is gone (`core.takeDecision`): closed.
        return { kind: "cancel", reason: "closed" };
    }
  };

  /**
   * One take: `core`'s decision for each waiting job, recorded by the store, sent to the UI; the job it started
   * runs. True when the queue should take again (a job started, or one failed on a broken health check); false
   * when nothing more can start now, or the service is stopping.
   */
  async function takeOnce(): Promise<boolean> {
    // Paused, nothing can start: no engine's health is asked.
    const health = pausedNow() ? new Map<EngineId, Health>() : await askHealthTwice();
    if (health === null) return false;
    // Read again: a pause may have come while the health was asked.
    const paused = pausedNow();
    const open = d.openChanges();
    const engines = statesNow();
    const shown = d.engineStates();
    const unusable = { claude: shown.claude.unusable, codex: shown.codex.unusable };
    const connection = d.connection().state;
    /** Engines whose broken health check already failed a job in this take. */
    const failedOn = new Set<EngineId>();
    // An engine busy with its self-test counts as reviewing: the jobs it would take wait their turn.
    const testing = d.gate.testing();
    /** What holds each busy engine: the change whose run holds it, else its self-test, else an older job. */
    const busy = (reviewing: ReadonlyMap<EngineId, ChangeId | null>) => {
      const held = new Map<EngineId, EngineHold>();
      for (const [engine, changeId] of reviewing) {
        held.set(engine, changeId === null ? { by: "older" } : { by: "review", changeId });
      }
      for (const engine of testing)
        if (held.get(engine)?.by !== "review") held.set(engine, { by: "self-test" });
      return held;
    };
    const took = d.store.jobs.take((stored, reviewing, changeBusy): Taking | null => {
      const change = open.get(stored.changeId) ?? null;
      // A gone change is cancelled whatever its settings: Lookover's defaults stand in.
      const { reviewers, depth } = change
        ? d.settings(change.repoId).values
        : { reviewers: "both" as const, depth: "standard" as const };
      const decision = takeDecision({
        paused,
        trigger: stored.job.trigger,
        change,
        reviewers,
        depth,
        engines,
        unusable,
        busy: busy(reviewing),
        changeBusy,
        connection,
        finder: stored.reroute,
      });
      const engine = engineNamed(decision);
      const h = engine === null ? undefined : health.get(engine);
      if (engine === null || h?.kind !== "broken") return takingOf(stored, decision);
      // Whether it may start couldn't be asked: the oldest job that would take this engine fails; the others wait.
      if (failedOn.has(engine)) return null;
      failedOn.add(engine);
      return {
        kind: "fail",
        failure: { kind: "unexpected", detail: `${engineName(engine)}'s health check threw: ${h.detail}` },
      };
    });
    // A job failed here is logged by its own change, its detail saying which health check threw (ADR 0055).
    for (const job of took.changed) changed(job);
    if (took.started) begin(open, took.started);
    return took.started !== null || failedOn.size > 0;
  }

  /** The job the take started: the UI hears of it, and its run starts; when it ends, the queue takes again. */
  function begin(
    open: ReadonlyMap<ChangeId, ChangeFacts>,
    { changeId, job, run, full }: NonNullable<Took["started"]>,
  ): void {
    d.emit({ type: "run.started", at: run.startedAt, changeId, job, run });
    d.checks.follow(
      { changeId, job },
      { run: { id: run.id, engine: run.reviewer, startedAt: run.startedAt } },
    );
    const change = open.get(changeId);
    // The take started it with its change open: the inbox read before it holds it.
    if (!change) throw new Error(`job ${job.id} started without its change ${changeId}`);
    follow(
      changeId,
      job.id,
      d.runs.start({ changeId, change: { number: change.number, repoId: change.repoId }, job, run, full }),
    );
  }

  /**
   * A run under way, followed: once its engine is free (its round saved) the queue takes again; once it has ended,
   * its requests get what they are owed, the change's follow-up is shown, and the queue takes again.
   */
  function follow(changeId: ChangeId, id: JobId, r: Running): void {
    running.set(id, r);
    runningOn.set(changeId, id);
    void r.freed.then(() => {
      if (!stopping) take();
    });
    void r.done.then(() => {
      running.delete(id);
      runningOn.delete(changeId);
      // Stopping: the run was cut, and the store may be closed. Its repository left: the run was cut, its job ended.
      if (stopping || left.delete(id)) return;
      // The round posted answers the requests that led to its job: their 🚀.
      d.reactions.send();
      followUpOf(changeId, id);
      take();
    });
  }

  /**
   * Arms the tick while a job waits on an engine, if none is armed or the one armed fires after a hold ends (a
   * reset under a minute away, read since it was armed).
   */
  function armTick(): void {
    if (stopping) return;
    const onEngine = d.store.jobs.waiting().jobs.some(({ job }) => deferralEngine(job.deferral) !== null);
    if (!onEngine) return;
    // A hold that ends before the next tick wakes the take as it ends: its jobs start then (ADR 0055).
    const ends = [...ranInto.values()].map((h) => h.until - now()).filter((left) => left > 0);
    const wait = Math.min(TICK_MS, ...ends);
    if (tick && tickAt <= now() + wait) return;
    tick?.();
    tickAt = now() + wait;
    tick = d.timers.after(wait, () => {
      tick = null;
      take();
    });
  }

  /** Takes until a take starts nothing, and once more for each take asked for meanwhile; then arms the tick. */
  async function goRound(): Promise<void> {
    try {
      do {
        again = false;
        while (!stopping && (await takeOnce()));
      } while (again && !stopping);
    } finally {
      // Also after a take that threw: the tick is what tries again.
      armTick();
    }
  }

  /** Runs the take until nothing more starts; asked for while it runs, it goes round once more. */
  function take(): void {
    if (stopping) return;
    // A check's end the host refused is sent again at every take, the first after a restart too.
    d.checks.resend();
    if (taking !== null) {
      again = true;
      return;
    }
    taking = goRound()
      .catch((error: unknown) => log(`the next job could not be taken: ${said(error)}`))
      .finally(() => {
        taking = null;
      });
  }

  /**
   * The change's job for `sha`, queued, as the store keeps it: its waiting job joined (moved there, ADR 0040, and
   * put back in the queue if deferred, ADR 0042: the take alone asks whether it may start), or a new one, a
   * follow-up if the change's job runs. A follow-up is not sent yet: the UI shows the run until it ends.
   */
  function ask(changeId: ChangeId, sha: ReviewJob["sha"], trigger: Trigger, asking: Asking = {}): void {
    const id = () => jobId(d.ids.next());
    const asked = d.store.jobs.asked(changeId, { sha, trigger, id, ...asking });
    if (asked.changed) changed({ changeId, job: asked.job });
  }

  /**
   * What a trigger asks of an open change's head commit (the poll's, or "Review now"), as `core.intake` says: a
   * review; a job skipped with its reason, when `core.skipOutcome` says so (another author's, a fork's, or a
   * request's: a repository switched off); the change's pending job joined (a request beside it); or nothing (a draft, a switch
   * off, or an automatic skip while the change has a job waiting or running, which it would hide). A review request
   * comment is recorded with the job it led to; a preview asked is the job's.
   */
  function intakeOf(changeId: ChangeId, trigger: Trigger, asking: Asking = {}): void {
    const change = d.openChanges().get(changeId);
    if (!change) return;
    const repository = d.settings(change.repoId);
    const decision = intake(change, { enabled: repository.enabled, settings: repository.values }, trigger);
    if (decision.kind === "job") ask(changeId, change.headSha, trigger, asking);
    if (decision.kind !== "skipped") return;
    // A request beside a pending job joins it, as a review would; never a skip that hides it (ADR 0047).
    const outcome = skipOutcome(trigger, decision.reason, d.store.jobs.pending(changeId));
    if (outcome === "join") ask(changeId, change.headSha, trigger, asking);
    if (outcome !== "record") return;
    const skipped: Ask & { skip: SkipReason } = {
      sha: change.headSha,
      trigger,
      skip: decision.reason,
      id: () => jobId(d.ids.next()),
      // A preview's skip has no check either: nothing goes to the host.
      ...asking,
    };
    changed({ changeId, job: d.store.jobs.skipped(changeId, skipped) });
  }

  /**
   * Once a run has ended, the job asked for during it, if any, is what the UI shows of the change: the change's
   * latest job, whatever its state now (waiting, or cancelled or failed while held back). One waiting behind the run
   * comes with its turn not said yet (the run's end cleared it): the take that follows says it again.
   */
  function followUpOf(changeId: ChangeId, ran: JobId): void {
    const latest = d.store.jobs.latest(changeId);
    if (latest && latest.job.id !== ran) changed(latest);
  }

  /**
   * Whether the change's review of `sha` runs now and posts: the setup's first review that posts follows it rather
   * than asking a second round of the same commit, which would post again with nothing new. A run that posts nothing
   * is a preview's, whatever its job's trigger (a preview joins an opened or manual job that waits), and is not followed.
   */
  function reviewsHead(changeId: ChangeId, sha: ReviewJob["sha"], asking: Asking): boolean {
    const job = d.store.jobs.latest(changeId)?.job;
    return (
      asking.preview !== true &&
      job?.state === "running" &&
      job.sha === sha &&
      !d.store.jobs.previewOf(job.id)
    );
  }

  /**
   * The owner asked from the app ("Review now", the setup's first review): the changes listed again, then the
   * change's head asked as `core.intake` says, and the take runs.
   */
  async function ownerAsked(
    changeId: ChangeId,
    trigger: "manual" | "first-review",
    asking: Asking = {},
  ): Promise<"ok" | "no_such_change"> {
    // A listing refused while the host is down is no answer to "Review now" (ADR 0047): the review is asked on
    // the head of the last listing, and the take defers it on the connection.
    await d.list(changeId).catch((error: unknown) => {
      if (!disconnects(error)) throw error;
    });
    const change = d.openChanges().get(changeId);
    if (!change) {
      // Closed since: the take cancels the job it may have left waiting.
      take();
      return "no_such_change";
    }
    if (!(trigger === "first-review" && reviewsHead(changeId, change.headSha, asking)))
      intakeOf(changeId, trigger, asking);
    take();
    return "ok";
  }

  /** Cancels the timer that ends a timed pause; null when none is armed. */
  let pauseEnd: (() => void) | null = null;

  /** Arms the end of a timed pause: at `until`, reviews resume by themselves. Disarms any end armed before. */
  function armPauseEnd(until: number | null): void {
    pauseEnd?.();
    pauseEnd = null;
    if (until === null || stopping) return;
    pauseEnd = d.timers.after(Math.max(0, until - now()), () => {
      pauseEnd = null;
      resume();
    });
  }

  /** The pause set is cleared and the UI told; false when none was set. */
  function unpause(): boolean {
    armPauseEnd(null);
    if (d.store.pause.current() === null) return false;
    d.store.pause.resumed();
    d.emit({ type: "service.changed", at: now(), patch: { paused: null } });
    return true;
  }

  /**
   * Whether the pause set holds now. One past its end whose timer hasn't fired yet (the process's timers lag
   * behind the clock after a sleep) is over: cleared and sent here, so nothing starts while the UI says "Paused".
   */
  function pausedNow(): boolean {
    const set = d.store.pause.current();
    if (pausedAt(set, now())) return true;
    if (set !== null) unpause();
    return false;
  }

  /** Reviews resume: the jobs the pause held as deferred "paused" are taken. */
  function resume(): void {
    if (stopping) return;
    if (unpause()) take();
  }

  return {
    async checkEngines() {
      if (stopping || (await askHealth(ENGINES, true)) === null) return;
      take();
    },
    async checkEngine(engine) {
      if (stopping) return null;
      const health = await askHealth([engine]);
      if (health === null) return null;
      const looked = health.get(engine);
      return looked?.kind === "state" ? looked.state : d.engineStates()[engine].state;
    },
    tested(engine, state, met = {}) {
      if (stopping) return;
      const was = d.engineStates()[engine];
      if (state === "limit") hold(engine, state, met);
      else if (state !== null && was.state !== state) {
        const at = now();
        d.emit({
          type: "engine.changed",
          at,
          id: engine,
          patch: { state, since: at, ...limitUntilOf(engine, state) },
        });
      }
      if (recovered) take();
    },
    ranInto(engine, state, met = {}) {
      if (stopping) return;
      hold(engine, state, met);
    },
    recover() {
      recovered = true;
      // A pause the last service left: over by now, it is cleared; timed, its end is armed again.
      const left = d.store.pause.current();
      if (left !== null && !pausedAt(left, now())) unpause();
      else armPauseEnd(left?.until ?? null);
      const stopped: FailureFacts = { kind: "service_stopped", detail: "" };
      for (const left of d.store.jobs.leftRunning()) {
        const after = afterRestart(left);
        if (after === "resumes") {
          // No event says it until its round is through posting: the log says it now (ADR 0055). The other two
          // are said by the job's own change (back in the queue from running, or failed `service_stopped`).
          log(`${left.changeId} review resumes its posts: the service stopped while it posted`);
          follow(left.changeId, left.job.id, d.runs.resume(left));
          continue;
        }
        const end: RunEnd =
          after === "runs-again" ? { kind: "interrupted" } : { kind: "failed", failure: stopped };
        changed({ changeId: left.changeId, job: d.store.jobs.runEnded(left.runId, end, now()) });
        followUpOf(left.changeId, left.job.id);
      }
      take();
    },
    request: (changeId) => ownerAsked(changeId, "manual"),
    firstReview: (changeId, preview) => ownerAsked(changeId, "first-review", { preview }),
    opened(changeId) {
      if (stopping) return;
      intakeOf(changeId, "opened");
    },
    pushed(changeId, sha) {
      if (stopping) return;
      // A fork's waiting review was asked for the commit it is on (ADR 0048): the new head, asked by nobody, isn't
      // reviewed in its place; the review ends cancelled (`pushed`), and the owner asks again for the new head.
      const ended = d.openChanges().get(changeId)?.fork
        ? d.store.jobs.forkPushed(changeId, sha)
        : d.store.jobs.pushed(changeId, sha).map((moved) => moved.job);
      for (const job of ended) changed({ changeId, job });
      intakeOf(changeId, "push");
    },
    requested(changeId, request, full) {
      if (stopping) return;
      intakeOf(changeId, "comment", { request, full });
    },
    take,
    reroute(from) {
      if (stopping) return;
      for (const stored of d.store.jobs.waiting().jobs) {
        if (deferralEngine(stored.job.deferral) !== from) continue;
        // The engine the UI offered for this job, if any: the same rule, read now.
        const to = withStepIn(stored).job.stepIn;
        if (to !== null) d.store.jobs.reroute(stored.job.id, to);
      }
      take();
    },
    withStepIn,
    settingsMoved(reviewersMoved) {
      if (stopping) return;
      // The record didn't change, so the check has nothing to follow: only who may step in may have moved.
      if (reviewersMoved)
        for (const stored of d.store.jobs.waiting().jobs)
          if (deferralEngine(stored.job.deferral) !== null) shown(stored);
      take();
    },
    pause(duration) {
      if (stopping) return;
      const paused = pauseOf(duration, now());
      d.store.pause.paused(paused);
      d.emit({ type: "service.changed", at: paused.since, patch: { paused } });
      armPauseEnd(paused.until);
      // No job waits on an engine while paused: the tick has nothing to look at until the resume takes again.
      tick?.();
      tick = null;
      // The jobs waiting their turn now wait for the resume, deferred "paused"; a running review finishes.
      take();
    },
    resume,
    async leave(changes) {
      const cut: Running[] = [];
      for (const [changeId, id] of runningOn) {
        const run = running.get(id);
        if (!changeId.startsWith(changes) || run === undefined) continue;
        left.add(id);
        run.cut();
        cut.push(run);
      }
      await Promise.all(cut.map((r) => r.done));
    },
    async stop() {
      stopping = true;
      tick?.();
      tick = null;
      pauseEnd?.();
      pauseEnd = null;
      // A take still asking an engine's health is not waited for: once it answers, it reads and writes nothing.
      const runs = [...running.values()];
      for (const run of runs) run.cut();
      await Promise.all([...runs.map((r) => r.done), d.gate.stop()]);
    },
  };
}
