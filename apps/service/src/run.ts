// The run (ADR 0029, ADR 0039, ADR 0044): one job the take started (its job running and its run recorded, both sent
// to the UI), carried out as prepare → find → confirm → reconcile → save → post, each step in the store and sent as
// the UI's event. Depth Deep (ADR 0044) finds twice in the `finding` step, the finder then the run's second finder,
// and `core` merges the two passes into one before the confirm; the second pass's failure never fails the run: the
// round goes on with the first pass's findings, and says which engine failed and why (`Round.secondFind`). How the finder's answer
// becomes a deferred or failed job is decided here: signed out or at its limit, the job waits as deferred with its
// reason (nothing failed); anything else that stops a step fails the job with a kind the UI words and the detail
// the module gave. Any session of the run (find, Deep's second find, confirm) that answers signed out or at its
// limit has the queue show its engine so (`ranInto`), so the next take defers on it or plans another confirmer. The confirm pass (ADR 0044) runs on the run's confirmer for the
// candidates `core` says are new, in the `confirming` step, skipped when none is or no confirmer is planned; its
// failure never fails the run. Each engine session keeps its raw material in its own sub-folder of the run's
// folder (`find`, `find-2`, `confirm`). The round keeps the settings it started with (ADR 0049): its plan is the
// take's, and the repository's settings reconcile applies and its rule switches (which rules go to neither pass) are
// read once as the run starts; a change while it goes counts from the next round.
// Claims (ADR 0052, ADR 0048): before the worktree is prepared, the run reads the change's Lookover threads (outdated
// ones included, so a reply made before a push is still heard), and `core.readThreads` keeps, per unsettled finding,
// the newest reply not answered yet from the owner or the change's author (the owner alone on a fork's change). The
// finder (and Deep's second finder) is given each such claim with its finding; a claim an earlier round answered is
// never given again. `core.reconcile` answers them. A refused threads read fails the run (`host_failed`), as any host
// read does: a round never goes on without the claims made on its findings. With no posted finding unsettled (round
// 1, a settled loop) there is no thread to hear and nothing is read. The round keeps, with its plan, the thread each
// claim was read on (its root comment's ids: where `publish` replies, and what it minimizes once the finding is
// withdrawn) and the global ids of the requests its job answers, from the store: a resume after a crash reads nothing
// again, and its posts (`publish`'s `postsOf`, replies and comments minimized included) are saved owed with it.
// The outbox (ADR 0044): once reconciled, the round is saved before anything is posted, in one write with the run's
// step, publishing: the round and the ledger it leaves (its findings to post held as not posted until its review
// lands), what its posts are rendered from, and the posts it owes. From then on the engine is free (`freed`): the
// queue may start another change's job on it, while the change stays busy until the posts are sent or given up.
// `publish` sends the owed posts through the store's `posts`, each marked sent before the next. Every post sent,
// the run ends as its round: its job done, and `round.finished` sent to the UI. `publish` tries a transient refusal
// again on the service's timers for about an hour (ADR 0044); a refusal it gives up on gives the posts up:
// the job fails `publish_failed`, the round is kept with what landed (its findings unposted when its review didn't),
// sent to the UI as `round.finished` with the failed job, and the job's check follows that failure. A run a stopped
// service left at publishing is resumed by the queue's recovery (`resume`): its posts go on from where they were,
// and it ends the same way; nothing is found again. Before a round reads the ledger, an earlier round's review whose
// send began and was never marked sent is looked for on GitHub by its marker: found, it is marked sent, so its findings
// count as posted and are not posted again as withheld.
// A full round (ADR 0052: the owner's `/lookover review full`, kept with its job) is reconciled as a first round
// would be: its new `consider` findings are posted too, as strictness lets them.
// A preview (ADR 0047: the first review, "preview here only") runs every step but posts nothing: its job has no
// check, its round is saved with an empty outbox, and it ends as its round at once, `round.finished` saying it was a
// preview; its findings stay held off the pull request, so the next round that posts posts them as withheld.
// Every run ends recorded (a round, deferred or failed). A record the store refuses is tried once more; refused
// again, the job is failed ("unexpected", with what the store said) in a write of its own, so its run ends and its
// engine is free for the next job, and the UI hears of the failure (ADR 0043, #65); each refusal goes to the log.
// Two exceptions leave the job running until the queue's recovery at the next start: the service cut the run
// while stopping (nothing more of it is recorded: a post the host answers after the cut is not marked, and is looked
// for again by its marker), or the store refused that last write too (the log says so).
// The job's check (ADR 0043) follows each end recorded without a round (the service's `checks`); the round
// completes the check its job has had in progress since the run started, which `checks` gives it before the round
// is saved.
// What each engine session does as it goes (ADR 0055: a file read, a search, a listing, a command) is gathered per run,
// its whole text through the log sink's secrets filter and then cut to 200 characters, and sent as `run.activity`
// only when there are new ones, at most one a second; nothing once the run is cut or ended.
// It must never know: which job is next, or whether a job may start (the queue's), or the loop's rules (`core`),
// or the words on the check (`publish`'s).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ChangeId,
  type Clock,
  type ConfirmFailure,
  type Deferral,
  type EngineActivity,
  type EngineId,
  type EventBody,
  type Finding,
  type FindingId,
  type FindRunPass,
  type HostChange,
  HostError,
  type HostIntake,
  type HostThread,
  type IdGen,
  isCounted,
  isUnsettled,
  type JobFailure,
  type LimitMet,
  limitMet,
  type PromptRulesFile,
  type Reconciled,
  type RepositoryId,
  type RepositoryRef,
  type ReviewJob,
  type Round,
  type RoundSession,
  type Rule,
  type Run,
  type RunActivity,
  type RunId,
  type RunPass,
  type RunPosting,
  type RunStep,
  type SecondFind,
  stepsDone,
} from "@lookover/contracts";
import {
  confirmPolicy,
  engineHold,
  mergeFinds,
  parseRules,
  promptRules,
  type ReconcileCandidate,
  readThreads,
  reconcile,
  roundOf,
  type ThreadReading,
  toConfirm,
  unconfirmed,
} from "@lookover/core";
import {
  type Outbox,
  type PostKind,
  type Publisher,
  postsOf,
  type RoundToPost,
  type ThreadRoot,
} from "@lookover/publish";
import { type Prepared, type Retrieval, RetrievalError } from "@lookover/retrieval";
import type { ConfirmPass, EarlierFinding, FindPass, ReviewFailure, ReviewRun } from "@lookover/review";
import type { FailureFacts, Store } from "@lookover/store";
import type { Checks, RunFacts } from "./checks.ts";
import { said } from "./said.ts";
import type { RanInto } from "./self-tests.ts";
import { repoIdOf, rulesOf, type SettingsInForce } from "./snapshot.ts";
import type { Timers } from "./timers.ts";

export interface RunDeps {
  store: Store;
  clock: Clock;
  ids: IdGen;
  intake: HostIntake;
  retrieval: Retrieval;
  review: FindPass;
  /** The confirm pass (ADR 0044): one session on the run's confirmer for the round's new candidates. */
  confirm: ConfirmPass;
  publisher: Publisher;
  /** A repository the room watches, by id: where each change of the run is on the host. */
  repoOf(repoId: RepositoryId): RepositoryRef;
  /** The owner on the host (ADR 0052, ADR 0048): their replies on Lookover's threads are claims, on any change. */
  owner: { id: number };
  /** Each run keeps its raw material in `<runsDir>/<job>/<run>`. */
  runsDir: string;
  /** The engine's wall-clock limit for one find pass, and for the confirm pass. */
  reviewTimeoutMs: number;
  emit(body: EventBody): void;
  /**
   * The settings that hold for a repository: what reconcile applies. Read once as the run starts (ADR 0049): a
   * change while it goes counts from the next round.
   */
  settings(repoId: RepositoryId): SettingsInForce;
  /**
   * Whether the repository's settings file switches a rule off (by its file and text, ADR 0049), as the file says
   * now. Read once as the run starts, like the settings.
   */
  switchedOff(repoId: RepositoryId): (rule: Pick<Rule, "source" | "text">) => boolean;
  /** Where every change of the job goes for its check to follow (ADR 0043), and the check its round completes. */
  checks: Pick<Checks, "follow" | "forRound" | "previewed" | "roundPosted">;
  /**
   * An engine of the run (its finder, Deep's second finder or its confirmer) answered signed out or at its limit:
   * the queue shows it so, and plans on it again only once that has cleared: at its limit, once it resets, as the
   * session said (`met`, ADR 0055).
   */
  ranInto(engine: EngineId, state: RanInto, met: LimitMet): void;
  /**
   * The job as the UI is sent it (the queue's): a run's end that leaves its job deferred on an engine says which
   * engine may step in for it (`stepIn`, ADR 0047).
   */
  withStepIn(stored: { changeId: ChangeId; job: ReviewJob }): { changeId: ChangeId; job: ReviewJob };
  /**
   * The repository's rules may have moved (ADR 0048): read again from its default branch, or a round ended that may
   * cite one. The UI hears of them when they differ from what it was last sent, each switched as the settings file
   * says now (ADR 0049).
   */
  rulesMoved(repoId: RepositoryId): void;
  /** Where a run's failure the record can't explain goes; the console by default. */
  log?(line: string): void;
  /** The room's waits on its clock: how a run's activities are held to one event a second (ADR 0055). */
  timers: Timers;
  /** The log sink's filter (ADR 0055): each activity's whole text passes it before it is cut and sent. */
  secretsRemoved(text: string): string;
}

/** A job the take started: running, with its run, whose reviewer is the engine that reviews it. */
interface Started {
  changeId: ChangeId;
  change: { number: number; repoId: RepositoryId };
  job: ReviewJob;
  run: Run;
  /** The owner asked `/lookover review full` (ADR 0052): the round posts as a first round would. */
  full: boolean;
}

/** A job a stopped service left running at publishing, its round saved: what `resume` goes on with. */
interface LeftPosting {
  changeId: ChangeId;
  job: ReviewJob;
  runId: RunId;
}

/**
 * A run under way: `done` settles once it is recorded; `freed` once its engine is free (its round saved and its
 * posts begun, or its end recorded); `cut` ends it as a crash would, nothing more recorded.
 */
export interface Running {
  done: Promise<void>;
  freed: Promise<void>;
  cut(): void;
}

/** Carries out the run of a job the take started. Never throws: whatever a step throws ends the run recorded. */
export type StartRun = (started: Started) => Running;

/**
 * Goes on with the posts of a run a stopped service left at publishing. Throws only for a run with no round saved
 * (a programming error: the store saves the round in the write that moves the run to publishing).
 */
export type ResumeRun = (left: LeftPosting) => Running;

/**
 * What a round's posts are rendered from, saved with it (ADR 0044): the round as `publish` takes it (the job's check
 * aside, which the posts carry) and the facts of the `Round` the UI is sent once it is through posting.
 */
interface Plan {
  post: Omit<RoundToPost, "checkId">;
  round: Omit<Round, "raised" | "verifiedFixed" | "open" | "endedAt" | "steps">;
  /** The run's (ADR 0047): the round owes no post, and its job has no check. */
  preview: boolean;
}

/**
 * What the confirm pass left of a round (ADR 0044): who ran its session (null when none ran: nothing new to
 * confirm, or no confirmer planned), why it gave no verdicts when it failed, and the candidates it refuted.
 */
type Confirmed = Pick<Round, "confirmer" | "confirmFailure" | "ruledOut">;

/** No confirm session ran: nothing new to confirm, or no confirmer planned (Quick). */
const NO_CONFIRM_PASS: Confirmed = { confirmer: null, confirmFailure: null, ruledOut: [] };

/** How a run ended, before it is recorded. */
type End =
  | { kind: "deferred"; deferral: Deferral }
  | { kind: "failed"; failure: FailureFacts }
  /** Its round saved: every post sent. */
  | { kind: "posted"; plan: Plan }
  /** Its round saved: the posts given up at a host refusal; `reviewed` when its review had landed. */
  | { kind: "given-up"; plan: Plan; failure: FailureFacts; reviewed: boolean }
  /** The service is stopping: the run was cut and records nothing more. */
  | { kind: "stopped" };

/** The run's round saved, and the job's check its posts complete (null: they create one). */
interface Saved {
  kind: "saved";
  plan: Plan;
  checkId: string | null;
}

/**
 * What one run carries along: the started job, its run, its finder (and Deep's second finder) and its confirmer,
 * where its raw material goes (each engine session in a sub-folder of its own: `find`, `find-2`, `confirm`), its
 * step.
 */
interface Carried extends Started {
  engine: EngineId;
  secondFinder: EngineId | null;
  confirmer: EngineId | null;
  artefactsDir: string;
  /** The repository's settings as the run started: the round keeps them whatever changes meanwhile (ADR 0049). */
  settings: SettingsInForce;
  /** The rule switches as the run started (ADR 0049): a rule switched off meanwhile still goes to this round. */
  switchedOff(rule: Pick<Rule, "source" | "text">): boolean;
  advance(step: RunStep): void;
  /** What `engine` does in the run's `pass` goes to the app (ADR 0055): the listener its engine session is given. */
  heard(engine: EngineId, pass: RunPass): (activity: EngineActivity) => void;
  /** The round is saved: the run is at publishing, as the store gives it, and its engine is free. */
  saved(round: Plan, ledger: Finding[], at: number): void;
  signal: AbortSignal;
}

/**
 * What the find step found: the finder's pass, merged with Deep's second pass when it answered; and that second pass
 * (its engine, and why it gave no round when it failed), null with one find pass.
 */
type Found = Extract<ReviewRun, { kind: "reviewed" }> & { secondFind: SecondFind | null };

/**
 * The round this run would be: its number, the ledger it reconciles against, the repository's rules both passes are
 * given, as `core` cut them from the default branch's files `prepare` read (ADR 0048), and every rule of those files
 * as `core`'s reconcile and confirm choice read them: the store's, each with its text (a raised finding's why), and
 * every one on until the owner can switch one off (row 4).
 */
interface SoFar {
  n: number;
  ledger: Finding[];
  rules: PromptRulesFile[];
  switches: { id: string; text: string; enabled: boolean }[];
  /** The claims read on the change's threads before the finder (ADR 0052): each pass hears them, `core` answers them. */
  reading: ThreadReading;
  /** The thread each claim was read on: where the round's reply on it goes, kept with the round (ADR 0052). */
  roots: ThreadRoot[];
}

/** The thread each claim was read on, by its reply's id: its root comment, which a reply goes under. */
function rootsOf(reading: ThreadReading, threads: HostThread[]): ThreadRoot[] {
  return reading.claims.flatMap((claim) => {
    const thread = threads.find((t) => t.replies.some((r) => r.commentId === claim.commentId));
    return thread ? [{ findingId: claim.findingId, commentId: thread.commentId, nodeId: thread.nodeId }] : [];
  });
}

/**
 * The earlier rounds' unsettled findings as the finder is given them: each with the claim this round read on its
 * thread, not answered yet, or none (ADR 0052). The claim a finding holds was answered by an earlier round: it is
 * never quoted again.
 */
function earlierOf(so: SoFar): EarlierFinding[] {
  const heard = new Map(so.reading.claims.map((c) => [c.findingId, c]));
  return so.ledger.filter(isUnsettled).map((f) => {
    const read = heard.get(f.id);
    const claim = read
      ? { kind: read.kind, text: read.text, by: read.by, at: read.at, commentId: read.commentId }
      : null;
    return { ...f, claim };
  });
}

/** The run as the job's check names it. */
const runFacts = (c: Carried): RunFacts => ({ id: c.run.id, engine: c.engine, startedAt: c.run.startedAt });

const failed = (kind: JobFailure["kind"], detail: string): End => ({
  kind: "failed",
  failure: { kind, detail },
});

/** The engine's state a session's failure shows: signed out, or at its limit; null for any other failure. */
function engineShown(reason: ReviewFailure | ConfirmFailure): RanInto | null {
  switch (reason) {
    case "auth_required":
      return "signed-out";
    case "quota_exhausted":
      return "limit";
    default:
      return null;
  }
}

/** The reasons of a find pass that are a reading of its answer, not the engine's own outcome. */
type AnswerUnread = Exclude<ReviewFailure, ConfirmFailure>;
const ANSWER_UNREAD = {
  missing_block: true,
  malformed_block: true,
  invalid_block: true,
} as const satisfies Record<AnswerUnread, true>;
const unread = (reason: ReviewFailure): reason is AnswerUnread => reason in ANSWER_UNREAD;

/** Why Deep's second find pass gave no round, in the confirm pass's words: an answer not read is `unreadable`. */
const secondFailure = (reason: ReviewFailure): ConfirmFailure => (unread(reason) ? "unreadable" : reason);

/**
 * A find pass that did not answer: the engine is signed out or at its limit, and the job waits as `core` says
 * a job waits for an engine in that state; or it failed. A failed engine's own words (a refused prompt, an API
 * error) follow the reason; an unreadable answer's text does not, its problems say what was wrong.
 */
function reviewFailed(engine: EngineId, reason: ReviewFailure, problems: string[], text: string): End {
  const state = engineShown(reason);
  const deferral = state === null ? null : engineHold({ id: engine, state, unusable: null });
  if (deferral) return { kind: "deferred", deferral };
  const words = unread(reason) || text.trim() === "" ? [] : [text.trim()];
  return failed("review_failed", [reason, ...problems, ...words].join("\n"));
}

/** Anything a step threw that it did not answer itself: the host, the store, a bug. */
function threw(error: unknown, signal: AbortSignal): End {
  if (signal.aborted) return { kind: "stopped" };
  if (error instanceof HostError) return failed("host_failed", error.failure);
  return failed("unexpected", said(error));
}

/**
 * The ledger until the round's review lands: the findings this round posts (`post`: raised now, or withheld by an
 * earlier round), held as not posted.
 */
const held = (ledger: Finding[], post: Finding[]): Finding[] => {
  const posting = new Set(post.map((f) => f.id));
  return ledger.map((f) => (posting.has(f.id) ? { ...f, posted: false } : f));
};

/** Why posting stopped: the host's refusal, `publish_failed`; anything else (the store, a bug), `unexpected`. */
function postFailure(error: unknown): FailureFacts {
  if (error instanceof HostError)
    return { kind: "publish_failed", detail: `${error.failure}: ${error.message}` };
  return { kind: "unexpected", detail: said(error) };
}

/** The longest an activity's text leaves the service (ADR 0055), cut once the secrets filter has seen it whole. */
const ACTIVITY_CHARS = 200;
/** A run sends its activities at most this often (ADR 0055). */
const ACTIVITY_EVERY_MS = 1_000;

/** `text` cut to `ACTIVITY_CHARS`, never halving a character a surrogate pair writes. */
function cut(text: string): string {
  if (text.length <= ACTIVITY_CHARS) return text;
  const kept = text.slice(0, ACTIVITY_CHARS);
  return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
}

/** `activity` as it may leave the service (ADR 0055): its whole text through the secrets filter, then cut. */
function cleaned(activity: EngineActivity, secretsRemoved: (text: string) => string): EngineActivity {
  const clean = (text: string) => cut(secretsRemoved(text));
  switch (activity.kind) {
    case "read":
      return { kind: "read", path: clean(activity.path) };
    case "search":
    case "list":
      return { kind: activity.kind, pattern: clean(activity.pattern) };
    case "command":
      return { kind: "command", text: clean(activity.text) };
  }
}

/**
 * A run's activities on their way to the app (ADR 0055): each one heard is held, and sent with the others held as one
 * `run.activity`, at once when the run sent none in the last second, else a second after the last it sent: only when
 * there are new ones, at most one a second. Once the run is cut or `end`ed, what is held is dropped and nothing more is
 * sent. An event that can't be written (a full disk) loses its activities, and `log` says so: they are live lines
 * only, so the run goes on, and a write failing from the timer never reaches the process.
 */
function activitiesOf(
  d: Pick<RunDeps, "clock" | "emit" | "timers" | "secretsRemoved">,
  changeId: ChangeId,
  signal: AbortSignal,
  log: (line: string) => void,
) {
  let held: RunActivity[] = [];
  let sentAt: number | null = null;
  let waiting: (() => void) | null = null;
  let over = false;
  const end = () => {
    over = true;
    waiting?.();
    waiting = null;
    held = [];
  };
  signal.addEventListener("abort", end, { once: true });
  const send = () => {
    waiting = null;
    if (over || held.length === 0) return;
    const activities = held;
    held = [];
    sentAt = d.timers.now();
    try {
      d.emit({ type: "run.activity", at: d.clock.now(), changeId, activities });
    } catch (error) {
      log(`The engine's activity was not sent: ${said(error)}`);
    }
  };
  const hold = (one: RunActivity) => {
    if (over) return;
    held.push(one);
    if (waiting !== null) return;
    const wait = sentAt === null ? 0 : sentAt + ACTIVITY_EVERY_MS - d.timers.now();
    if (wait <= 0) send();
    else waiting = d.timers.after(wait, send);
  };
  return {
    heard:
      (engine: EngineId, pass: RunPass) =>
      (activity: EngineActivity): void =>
        hold({ engine, pass, activity: cleaned(activity, d.secretsRemoved) }),
    end,
  };
}

/** Settles once `signal` aborts: what a post waiting on the host loses to when the service stops. */
const abortion = (signal: AbortSignal): Promise<"cut"> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve("cut");
    else signal.addEventListener("abort", () => resolve("cut"), { once: true });
  });

export function createRun(d: RunDeps): { start: StartRun; resume: ResumeRun } {
  const now = () => d.clock.now();
  const log = d.log ?? ((line: string) => console.error(line));

  /**
   * An earlier round's review whose send began and was never marked sent (GitHub's answer lost, or the store failed
   * to keep it) is looked for on GitHub by its marker before this round reads the ledger: found, it is marked sent,
   * which lands that round's ledger, so its findings count as posted and are never posted again as withheld.
   */
  async function landedUnsure(changeId: ChangeId): Promise<void> {
    for (const { runId, plan, degraded } of d.store.posts.unsure<Plan>(changeId)) {
      const found = await d.publisher.findReview(plan.post, degraded);
      if (found !== null) d.store.posts.sent(runId, "review", found.reviewId, found.commented);
    }
  }

  /** Prepare: the worktree and the diff for the job's commit, or why there is none. */
  async function prepare(c: Carried, host: HostChange): Promise<Prepared | End> {
    try {
      return await d.retrieval.prepare(
        {
          repo: d.repoOf(c.change.repoId),
          job: c.job.id,
          head: c.job.sha,
          base: host.base.sha,
          fetch: await d.intake.fetchSpec(d.repoOf(c.change.repoId)),
        },
        c.signal,
      );
    } catch (error) {
      if (!(error instanceof RetrievalError)) throw error;
      if (c.signal.aborted) return { kind: "stopped" };
      return failed("prepare_failed", `${error.problem}: ${error.detail}`);
    }
  }

  /** A session that failed signed out or at its limit: the queue shows its engine so (stories 10, 20, 21, 31). */
  function ranInto(engine: EngineId, reason: ReviewFailure | ConfirmFailure, session: LimitMet): void {
    const state = engineShown(reason);
    if (state !== null) d.ranInto(engine, state, limitMet(session));
  }

  /** One find pass on `engine` over the prepared worktree, with the earlier rounds' unsettled findings. */
  function findOn(c: Carried, prepared: Prepared, so: SoFar, engine: EngineId, pass: FindRunPass) {
    return d.review.run(
      c.job,
      { cwd: prepared.cwd, diff: prepared.diff },
      {
        engine,
        round: so.n,
        earlier: earlierOf(so),
        timeoutMs: d.reviewTimeoutMs,
        pass,
        artefactsDir: join(c.artefactsDir, pass),
        rules: so.rules,
        diffFile: prepared.diffFile,
        onActivity: c.heard(engine, pass),
      },
      c.signal,
    );
  }

  /**
   * Find: the finder's pass; at Deep, the second finder's too, merged by `core` into one outcome. The finder's
   * failure ends the run (deferred or failed); the second pass's leaves the first pass's round, and says why, its
   * session kept beside the first's all the same (ADR 0055).
   */
  async function find(c: Carried, prepared: Prepared, so: SoFar): Promise<Found | End> {
    const found = await findOn(c, prepared, so, c.engine, "find");
    if (c.signal.aborted) return { kind: "stopped" };
    if (found.kind === "failed") {
      ranInto(c.engine, found.reason, found);
      return reviewFailed(c.engine, found.reason, found.problems, found.text);
    }
    const engine = c.secondFinder;
    if (engine === null) return { ...found, secondFind: null };
    const again = await findOn(c, prepared, so, engine, "find-2");
    if (c.signal.aborted) return { kind: "stopped" };
    if (again.kind === "failed") {
      ranInto(engine, again.reason, again);
      return {
        ...found,
        round: { ...found.round, sessions: [...found.round.sessions, again.session] },
        secondFind: { engine, failure: secondFailure(again.reason) },
      };
    }
    return {
      kind: "reviewed",
      round: mergeFinds([found.round, again.round]),
      secondFind: { engine, failure: null },
    };
  }

  /**
   * Confirm (ADR 0044): the candidates `core` says are new go to one session on the run's confirmer, in the
   * `confirming` step; `core`'s policy then gives each its severity and confirmation, or rules it out. Skipped, with
   * no step, when nothing is new or no confirmer is planned (Quick: the new candidates are then not checked, a
   * blocking one demoted, as any not confirmed). Its failure never fails the run: the candidates go on as found,
   * not checked, and the round says why.
   */
  async function confirm(
    c: Carried,
    prepared: Prepared,
    so: SoFar,
    found: Found,
  ): Promise<{ candidates: ReconcileCandidate[]; confirmed: Confirmed; sessions: RoundSession[] } | End> {
    const { candidates } = found.round;
    const asked = toConfirm(so.ledger, candidates, { round: so.n, rules: so.switches });
    // Quick confirms nothing: each new candidate is not checked, so a blocking one is demoted (ADR 0044).
    if (c.confirmer === null)
      return {
        candidates: unconfirmed(candidates, asked).candidates,
        confirmed: NO_CONFIRM_PASS,
        sessions: [],
      };
    if (asked.length === 0) return { candidates, confirmed: NO_CONFIRM_PASS, sessions: [] };
    c.advance("confirming");
    const answer = await d.confirm.run(
      c.job,
      { cwd: prepared.cwd, diff: prepared.diff },
      asked,
      {
        engine: c.confirmer,
        round: so.n,
        timeoutMs: d.reviewTimeoutMs,
        artefactsDir: join(c.artefactsDir, "confirm"),
        rules: so.rules,
        onActivity: c.heard(c.confirmer, "confirm"),
      },
      c.signal,
    );
    if (c.signal.aborted) return { kind: "stopped" };
    if (answer.failure !== null) ranInto(c.confirmer, answer.failure, answer);
    const applied = confirmPolicy(candidates, answer.judged);
    return {
      candidates: applied.candidates,
      confirmed: { confirmer: c.confirmer, confirmFailure: answer.failure, ruledOut: applied.ruledOut },
      // A confirm pass given candidates always ran its session.
      sessions: answer.session === null ? [] : [answer.session],
    };
  }

  /** Reconcile: the confirmed candidates against the ledger, by `core`'s rules and the repository's settings. */
  function reconcileFound(c: Carried, so: SoFar, found: Found, candidates: ReconcileCandidate[]): Reconciled {
    const { values } = c.settings;
    return reconcile(
      so.ledger,
      { ...found.round, candidates },
      // A finding an earlier round could not post (its review never landed) is posted now, while it is open.
      {
        round: so.n,
        settings: values,
        rules: so.switches,
        withheld: d.store.posts.withheld(c.changeId),
        threads: so.reading,
        full: c.full,
      },
    );
  }

  /** What the round's posts are rendered from, and the facts of its `Round`. */
  function planOf(
    c: Carried,
    host: HostChange,
    prepared: Prepared,
    so: Pick<SoFar, "n" | "roots">,
    reconciled: Reconciled,
    confirmed: Confirmed,
    secondFind: SecondFind | null,
    sessions: RoundSession[],
  ): Plan {
    const { n } = so;
    return {
      post: {
        roots: so.roots,
        // The requests that led to the job, which its round answers: minimized once its check completes.
        requests: d.store.requests.of(c.job.id),
        change: { repo: d.repoOf(c.change.repoId), number: c.change.number, host: host.host, url: host.url },
        sha: c.job.sha,
        base: prepared.mergeBase,
        diff: prepared.diff,
        round: n,
        rounds: d.store.rounds.of(c.changeId),
        run: {
          id: c.run.id,
          job: c.job.id,
          trigger: c.job.trigger,
          engine: c.engine,
          secondFind,
          confirmer: confirmed.confirmer,
          confirmFailure: confirmed.confirmFailure,
          ruledOut: confirmed.ruledOut.length,
          startedAt: c.run.startedAt,
          completedAt: now(),
        },
        reconciled,
      },
      preview: c.run.preview,
      round: {
        n,
        sha: c.job.sha,
        reviewer: c.engine,
        secondFind,
        ...confirmed,
        confirmFallback: confirmed.confirmer === null ? null : c.run.confirmFallback,
        startedAt: c.run.startedAt,
        sessions,
      },
    };
  }

  /** The run up to its round saved: prepare → find → confirm → reconcile → save. An `End` when it stops before. */
  async function carry(c: Carried): Promise<Saved | End> {
    try {
      mkdirSync(c.artefactsDir, { recursive: true });
      const host = await d.intake.getChange(d.repoOf(c.change.repoId), c.change.number);
      await landedUnsure(c.changeId);
      const ledger = d.store.rounds.ledger(c.changeId);
      // The threads, outdated ones included, read before anything else of the round: a refusal fails the run like
      // any host read, so no round goes on without the claims its author made. Only a posted finding still unsettled
      // has a thread a claim counts on: without one (round 1, a settled loop) nothing is read, and nothing can fail.
      const threads = ledger.some(isCounted)
        ? await d.intake.threads({ repo: d.repoOf(c.change.repoId), number: c.change.number })
        : [];
      const prepared = await prepare(c, host);
      if ("kind" in prepared) return prepared;
      try {
        // The rules just read replace the ones kept: an edited rule is a new one, its counts at zero.
        const { repoId } = c.change;
        d.store.rules.read(
          repoId,
          prepared.rules.flatMap((file) => parseRules(repoId, file)),
        );
        d.rulesMoved(repoId);
        // A rule switched off, as the run started, goes to neither pass, with the rules nested in it (ADR 0049).
        const switches = rulesOf(d.store, repoId, c.switchedOff).map((rule) => ({
          ...rule,
          enabled: rule.enabled && !rule.parentOff,
        }));
        const off = new Set(switches.filter((rule) => !rule.enabled).map((rule) => rule.id));
        c.advance("finding");
        // The owner's replies count, and the change's author's unless it comes from a fork (ADR 0048).
        const reading = readThreads(ledger, threads, {
          owner: d.owner,
          author: host.author,
          fork: host.fork,
        });
        const so: SoFar = {
          n: d.store.rounds.of(c.changeId).length + 1,
          ledger,
          rules: promptRules(repoId, prepared.rules, off),
          switches,
          reading,
          roots: rootsOf(reading, threads),
        };
        const found = await find(c, prepared, so);
        if (found.kind !== "reviewed") return found;
        const checked = await confirm(c, prepared, so, found);
        if ("kind" in checked) return checked;
        const reconciled = reconcileFound(c, so, found, checked.candidates);
        // The job's check, in progress since the run started, asked before the round is saved: it names round n. A
        // preview has none.
        const checkId = c.run.preview
          ? null
          : await d.checks.forRound({ changeId: c.changeId, job: c.job }, runFacts(c));
        if (c.signal.aborted) return { kind: "stopped" };
        const sessions = [...found.round.sessions, ...checked.sessions];
        const plan = planOf(c, host, prepared, so, reconciled, checked.confirmed, found.secondFind, sessions);
        c.saved(plan, reconciled.findings, now());
        return { kind: "saved", plan, checkId };
      } finally {
        // The worktree goes whatever happened; the signal is not passed, so a stopping service removes it too.
        await prepared
          .dispose()
          .catch((error: unknown) => log(`worktree of ${c.job.id} not removed: ${error}`));
      }
    } catch (error) {
      return threw(error, c.signal);
    }
  }

  /**
   * Post: the saved round's owed posts, through the store's outbox, on the job's check (`checkId`, created when
   * null). A host refusal gives them up; a cut leaves them as the outbox holds them.
   */
  async function post(
    runId: RunId,
    stored: { changeId: ChangeId; job: ReviewJob },
    plan: Plan,
    checkId: string | null,
    signal: AbortSignal,
  ): Promise<End> {
    // A preview's outbox is empty: nothing to send, the host never hears of it.
    if (plan.preview) return { kind: "posted", plan };
    try {
      const saved = d.store.posts.of<Plan>(runId);
      if (saved === null) throw new Error(`no round saved for run ${runId}`);
      const sent = await Promise.race([
        d.publisher.publish({ ...plan.post, checkId }, outboxOf(runId, stored, saved, signal), signal),
        abortion(signal),
      ]);
      if (sent === "cut") return { kind: "stopped" };
    } catch (error) {
      if (signal.aborted) return { kind: "stopped" };
      // A refusal of the host, or anything else that stopped the posts (the store, a bug): given up, the round kept.
      return { kind: "given-up", plan, failure: postFailure(error), reviewed: reviewLanded(runId) };
    }
    return { kind: "posted", plan };
  }

  /**
   * The run's outbox on the store: nothing is begun once the service is stopping, nor marked after. The app follows it
   * (ADR 0055): `run.posting` says how many posts are sent of the round's, at once, at each post sent and at each
   * wait the host makes it take, and once that wait is over; a post sent ends the wait it followed.
   */
  function outboxOf(
    runId: RunId,
    stored: { changeId: ChangeId; job: ReviewJob },
    saved: Pick<Outbox, "posts" | "degraded">,
    signal: AbortSignal,
  ): Outbox {
    let posting: RunPosting = {
      sent: saved.posts.filter((p) => p.hostId !== null).length,
      owed: saved.posts.length,
      wait: null,
    };
    const show = (next: RunPosting) => {
      if (signal.aborted) return;
      const same =
        next.sent === posting.sent &&
        next.wait?.until === posting.wait?.until &&
        next.wait?.refusal === posting.wait?.refusal;
      posting = next;
      if (!same) d.emit({ type: "run.posting", at: now(), changeId: stored.changeId, posting });
    };
    d.emit({ type: "run.posting", at: now(), changeId: stored.changeId, posting });
    return {
      posts: saved.posts,
      degraded: saved.degraded,
      degrade() {
        if (signal.aborted) throw new Error("the service is stopping");
        d.store.posts.degrade(runId);
      },
      sending(kind: PostKind) {
        if (signal.aborted) throw new Error("the service is stopping");
        d.store.posts.sending(runId, kind);
      },
      sent(kind: PostKind, hostId: string, commented?: readonly FindingId[]) {
        // Answered after the cut: not marked, so the next start looks for it again.
        if (signal.aborted) return;
        d.store.posts.sent(runId, kind, hostId, commented);
        if (kind === "completed") d.checks.roundPosted(stored);
        show({ ...posting, sent: posting.sent + 1, wait: null });
      },
      waiting(wait) {
        show({ ...posting, wait });
      },
    };
  }

  /** Whether the run's review landed, as the outbox kept it; false when the store can't say. */
  function reviewLanded(runId: RunId): boolean {
    try {
      return (
        d.store.posts.of<Plan>(runId)?.posts.some((p) => p.kind === "review" && p.hostId !== null) ?? false
      );
    } catch (error) {
      log(`the posts of run ${runId} could not be read: ${error}`);
      return false;
    }
  }

  /**
   * The run's end, recorded by `write`: tried once more if the store throws; if it throws again, the job is failed
   * in a write of its own, so its run ends and its engine is free, and the UI hears of that instead. Null when even
   * that failed (the error goes to the log, and the job stays running until the next start). The job's check
   * follows that failure, unless the round's posts completed it (`checked`); a round whose review landed (`posted`)
   * still answers the requests that led to its job: their 🚀 is owed all the same.
   */
  function ended(
    r: Recorded,
    t: number,
    write: () => ReviewJob,
    { posted, checked }: { posted: boolean; checked: boolean },
  ): ReviewJob | null {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return write();
      } catch (error) {
        last = error;
        log(`run ${r.runId} of ${r.job.id} could not be recorded: ${error}`);
      }
    }
    const failure: FailureFacts = {
      kind: "unexpected",
      detail: last instanceof Error ? last.message : String(last),
    };
    const job = d.store.jobs.runEnded(r.runId, { kind: "failed", failure, posted }, t);
    d.emit({ type: "job.changed", at: t, changeId: r.changeId, job });
    if (!checked) d.checks.follow({ changeId: r.changeId, job }, { run: r.facts });
    return null;
  }

  /**
   * The round, through posting, sent to the UI with the job as it ended and `findings` as the store holds them. Its
   * open findings and its loop are the round's, as `core` decided them: findings its review never landed are held
   * off the pull request (not posted), and still open, so the round counts them and the loop stays open.
   */
  function finished(r: Recorded, t: number, job: ReviewJob, plan: Plan, findings: Finding[]): void {
    const { reconciled } = plan.post;
    const done = stepsDone(r.steps(), t);
    const steps = plan.preview ? done.filter((s) => s.step !== "publishing") : done;
    const round = roundOf({ ...plan.round, endedAt: t, steps }, reconciled);
    // The job covers the head commit it reviewed: nothing new is left on it.
    d.emit({
      type: "round.finished",
      at: t,
      changeId: r.changeId,
      round,
      job,
      newCommits: 0,
      findings,
      loop: reconciled.loop,
      preview: plan.preview,
    });
    // The round's ledger may cite the repository's rules: their counts may have moved.
    d.rulesMoved(repoIdOf(plan.post.change.repo));
  }

  /**
   * The run's round, every post sent, recorded as its job's end. A preview posted nothing: its findings stay held
   * off the pull request, as the store keeps them, and a check its job had on GitHub before it became one ends there.
   * A preview's end owes no 🚀 to a `/lookover review` request that joined it: the request waits for the change's
   * next round that posts (#126 F8).
   */
  function posted(r: Recorded, t: number, plan: Plan): void {
    const { preview } = plan;
    const write = () => d.store.jobs.runEnded(r.runId, { kind: preview ? "preview" : "round" }, t);
    const job = ended(r, t, write, { posted: !preview, checked: !preview });
    if (job === null) return;
    // As stored: the review's landing marked the findings it commented on, after `core` reconciled them.
    finished(r, t, job, plan, d.store.rounds.ledger(r.changeId));
    if (preview) d.checks.previewed({ changeId: r.changeId, job });
  }

  /** What the end of a run does to the record and the UI. */
  function record(r: Recorded, end: End): void {
    const t = now();
    switch (end.kind) {
      case "stopped":
        return;
      case "posted":
        posted(r, t, end.plan);
        return;
      case "given-up": {
        const write = () =>
          d.store.jobs.runEnded(r.runId, { kind: "failed", failure: end.failure, posted: end.reviewed }, t);
        const job = ended(r, t, write, { posted: end.reviewed, checked: false });
        if (job === null) return;
        // The round stays, with what landed: its findings held off the pull request when its review didn't.
        finished(r, t, job, end.plan, d.store.rounds.ledger(r.changeId));
        d.checks.follow({ changeId: r.changeId, job }, { run: r.facts });
        return;
      }
      case "deferred":
      case "failed": {
        const job = ended(r, t, () => d.store.jobs.runEnded(r.runId, end, t), {
          posted: false,
          checked: false,
        });
        if (job === null) return;
        d.emit({
          type: "job.changed",
          at: t,
          changeId: r.changeId,
          job: d.withStepIn({ changeId: r.changeId, job }).job,
        });
        d.checks.follow({ changeId: r.changeId, job }, { run: r.facts });
        return;
      }
    }
  }

  /** A run's `freed` and its trigger: settled once its engine is free. */
  function freeing(): { freed: Promise<void>; free(): void } {
    let free = () => {};
    const freed = new Promise<void>((resolve) => {
      free = resolve;
    });
    return { freed, free };
  }

  /** Records `end` unless the run was cut, then settles: what every run's `done` is. */
  function settle(r: Recorded, ending: Promise<End>, signal: AbortSignal, free: () => void): Promise<void> {
    return ending
      .then((end) => {
        // A cut run records nothing more: the job stays running, and the next start goes on with it
        // (`core.afterRestart`).
        if (signal.aborted) return;
        record(r, end);
      })
      .catch((error: unknown) => log(`run ${r.runId} of ${r.job.id} could not be recorded: ${error}`))
      .finally(free);
  }

  const start: StartRun = (startedJob) => {
    const { changeId, job, run: started } = startedJob;
    // Made by the run itself: a folder that can't be made fails the job, recorded, like any other step.
    const artefactsDir = join(d.runsDir, job.id, started.id);

    const controller = new AbortController();
    const { freed, free } = freeing();
    const activities = activitiesOf(d, changeId, controller.signal, log);
    // The run's steps as the store last saw them: the record's, computed once.
    let stepped: Pick<Run, "step" | "stepAt" | "steps"> = started;
    const advance = (next: RunStep): void => {
      if (controller.signal.aborted) return;
      const t = now();
      stepped = d.store.jobs.runStepped(started.id, next, t);
      d.emit({ type: "run.step", at: t, changeId, step: next });
    };
    const carried: Carried = {
      ...startedJob,
      engine: started.reviewer,
      secondFinder: started.secondFinder,
      confirmer: started.confirmer,
      artefactsDir,
      settings: d.settings(startedJob.change.repoId),
      switchedOff: d.switchedOff(startedJob.change.repoId),
      advance,
      heard: activities.heard,
      saved: (plan, ledger, at) => {
        // The engines are done: what is still held is dropped, so no activity follows the publishing step.
        activities.end();
        const round = {
          n: plan.round.n,
          held: held(ledger, plan.post.reconciled.post),
          ledger,
          plan,
          posts: plan.preview ? [] : postsOf(plan.post),
        };
        stepped = d.store.posts.saved(started.id, round, at);
        // A preview publishes nothing: the UI never sees the step (the store keeps it, so a restart resumes it).
        if (!plan.preview) d.emit({ type: "run.step", at, changeId, step: "publishing" });
        free();
      },
      signal: controller.signal,
    };
    const recorded: Recorded = {
      changeId,
      job,
      runId: started.id,
      facts: runFacts(carried),
      steps: () => stepped,
    };
    const ending = carry(carried).then((carried) =>
      carried.kind === "saved"
        ? post(started.id, { changeId, job }, carried.plan, carried.checkId, controller.signal)
        : carried,
    );
    // The lines are live only: none is sent once the engines are done (`saved`) or the run ends.
    const done = settle(recorded, ending.finally(activities.end), controller.signal, free);
    return { done, freed, cut: () => controller.abort() };
  };

  const resume: ResumeRun = ({ changeId, job, runId }) => {
    const controller = new AbortController();
    const { freed, free } = freeing();
    // Its engine was freed when its round was saved.
    free();
    // A run reaches publishing in the write that saves its round: one without is a programming error.
    const saved = d.store.posts.of<Plan>(runId);
    if (saved === null) throw new Error(`run ${runId} is at publishing with no round saved`);
    const { plan } = saved;
    const recorded: Recorded = {
      changeId,
      job,
      runId,
      facts: { id: runId, engine: plan.post.run.engine, startedAt: plan.post.run.startedAt },
      steps: () => saved.steps,
    };
    const ending = (async (): Promise<End> => {
      // The job's check on its commit, as kept: the round completes it, or creates one when it has none.
      const { ref } = d.store.jobs.checkOf(job.id);
      return post(runId, { changeId, job }, plan, ref?.sha === job.sha ? ref.id : null, controller.signal);
    })();
    const done = settle(recorded, ending, controller.signal, free);
    return { done, freed, cut: () => controller.abort() };
  };

  return { start, resume };
}

/** What recording a run's end needs: whose run it is, the run as its check names it, and its steps so far. */
interface Recorded {
  changeId: ChangeId;
  job: ReviewJob;
  runId: RunId;
  facts: RunFacts;
  steps(): Pick<Run, "step" | "stepAt" | "steps">;
}
