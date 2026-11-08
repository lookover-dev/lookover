// The check follows the job (ADR 0043): every change of a job the store records is sent to `publish`, which
// writes the job's check on the host; the scheduler never writes to the host itself. A job recorded creates its
// check, `queued`, on its commit; a deferral says why it waits; its run's start moves it `in_progress`; the round
// completes it (the run gives `publish` the check's id, and says when the round posted); a job that ends without a
// round completes it `skipped` (cancelled: a newer review of its change took its place, or its change closed;
// skipped by a rule) or `neutral` (failed), as the job itself says. A waiting job moved to a newer commit first
// completes its old commit's check (`skipped`, a newer commit), then creates one on the new commit (a preview's
// makes none: ADR 0047). The store keeps
// the check's id and commit, and whether it is completed. An old skip's end on another author's change, nobody asked
// in person, is never sent, only marked sent (`core.endUnsent`, ADR 0078): an upgrade posts nothing there, unless
// that skip's check was created (its id kept): that check gets its end, never left queued.
// Ordering: one job's changes are sent one at a time, in the order they were recorded, each with the job as it
// was then; different jobs' go side by side. A change the host already shows (the same commit, state and reason,
// and for a job waiting on an engine's limit the same reset, sent with success) is not sent again, and nothing is
// sent for a completed check. A reset learned or moved while jobs wait on that engine's limit is sent to each of
// them (`limitMoved`, ADR 0055): one write per job whose check said another.
// Errors: a write the host refuses (or anything else `publish` or the store throws) goes to the log and never fails
// the job. The job's next change sends where it stands then, a check never created included; an end, after which
// nothing changes, is owed by the job in the store and sent again at every take until the host takes it, after a
// restart too (ADR 0043; a round's own posts are the outbox's, ADR 0044); so is a preview's end, "a preview", on a
// check the host showed before the preview joined (ADR 0047). A check created is kept before anything
// else is sent for it, so an end refused after its check was created completes that check, never a second one.
// The status block follows too (ADR 0074): after each change of a job is sent to its check, the change's block is
// written (`publish`'s `status`), rendered from where the change stands then (`status`, the change's newest job), while
// the job is the change's newest and waits (deferred, or queued behind busy engines: one taken at once is never said
// waiting, and one behind its change's own round leaves that round's block), runs or failed; a job skipped or done
// writes none, nor an older job's late change, nor a change the job has left since (its next change writes, after
// its check), nor a round posting (it writes its own, after its review). A preview's job, and a job cancelled while
// it is the change's newest (a fork pushed, the change closed), put the last posted round back over a block the job
// wrote as it waited, after a restart too (`publish` writes nothing when the description already holds it), with
// that round's own ledger (`status`); with no round posted, the block stays as written: no block is ever taken off
// (I-229). It is written only when it renders other than the block the follower last sent to the change: the
// de-duplication compares the rendered block (in the description's whole room, with no thread read), so a block
// written unlinked (a thread read refused) or cut is not corrected while the status renders the same; each write
// moves the listing's ETag. A round posted forgets that block, since the round wrote its own. A refused block goes
// to the log, like a check's; one the host refused for a moment (a `HostError` thrown: `publish` only says a standing
// refusal) is owed, in memory, and written again at every take where the change's newest job stands then, until a
// write lands or there is none to write (a round posted owes none).
// It must never know: the words on the check or the block (`publish`'s), or the rules that change a job (the
// queue's, `core`).

import {
  type Change,
  type ChangeId,
  type Clock,
  DESCRIPTION_MAX_CHARACTERS,
  type EngineId,
  type GitHost,
  HostError,
  type JobId,
  type JobState,
  type RepositoryRef,
  type ReviewJob,
  type RunId,
} from "@lookover/contracts";
import { endUnsent, loopState } from "@lookover/core";
import {
  type Ended,
  type JobCheck,
  type Publisher,
  type Standing,
  type Status,
  shownFailure,
} from "@lookover/publish";
import type { JobCheckRef, Store, StoredJob, StoredJobCheck } from "@lookover/store";
import { said } from "./said.ts";

/** The run of a job, as its check's result names it. */
export interface RunFacts {
  id: RunId;
  engine: EngineId;
  startedAt: number;
}

/** What the caller knows of a change it sends beside the job: its run. */
interface Followed {
  run?: RunFacts | null;
}

export interface ChecksDeps {
  store: Store;
  publisher: Publisher;
  clock: Clock;
  host: GitHost;
  /** The change on the host: its repository (one the room watches) and its number. */
  changeRef(changeId: ChangeId): { repo: RepositoryRef; number: number };
  /** Whether only Codex may review in the change's repository now: a fork's skip then points to Settings (ADR 0048). */
  onlyCodex(changeId: ChangeId): boolean;
  /** Who opened the change, as the open changes say; null when it is not listed open (none closed is kept). */
  authorOf(changeId: ChangeId): Change["author"] | null;
  /** Until when the engine's limit holds, as the UI is told (ADR 0055); null when none holds or no reset is known. */
  limitUntil(engine: EngineId): number | null;
  /**
   * Where the change stands, as its status block says it now (ADR 0074): its newest job's standing, or its last
   * posted round; null when it gets no block. No thread read: the block `publish` writes reads them.
   */
  status(changeId: ChangeId): Status | null;
  /** Where a refused write goes; the console by default. */
  log?(line: string): void;
}

export interface Checks {
  /** The job changed as `stored` says: its check follows, after the job's earlier changes. Never throws. */
  follow(stored: StoredJob, followed?: Followed): void;
  /**
   * The id of the running job's check, for its round to complete, once its earlier changes are sent: created in
   * progress now if the host refused it until then. Null when the host refuses it again. Never throws.
   */
  forRound(stored: StoredJob, run: RunFacts): Promise<string | null>;
  /**
   * The job's round was a preview (ADR 0047), which posts nothing: a check the host shows for the job (made before a
   * preview joined it) ends skipped, "a preview"; then nothing more is sent for it. A refused end is owed in the
   * store and sent again by `resend`. Never throws.
   */
  previewed(stored: StoredJob): void;
  /**
   * The engine's limit now holds until another time (ADR 0055): each job deferred on that limit sends its check
   * again, written only where it said another time. Never throws.
   */
  limitMoved(engine: EngineId): void;
  /** The job's round completed its check: nothing more is sent for it. Never throws. */
  roundPosted(stored: StoredJob): void;
  /**
   * Sends again each check end the host refused, kept in the store (after a restart too): a job's that ended without
   * a round, and a preview's; then each status block the host refused for a moment (in memory). Never throws.
   */
  resend(): void;
  /** Waits until every change sent so far is settled. */
  idle(): Promise<void>;
}

/** How a job that ended without a round ended, as the job says: cancelled or skipped and why, failed and how. */
function endOf(job: ReviewJob): Ended {
  switch (job.state) {
    case "cancelled":
      if (job.cancel === null) throw new Error(`job ${job.id} is cancelled without a reason`);
      return { kind: "skipped", why: job.cancel };
    case "skipped":
      if (job.skip === null) throw new Error(`job ${job.id} is skipped without a reason`);
      return { kind: "skipped", why: job.skip };
    default:
      return { kind: "failed", failure: shownFailure(job.failure) };
  }
}

/**
 * Where a job stands on its commit, as its check shows it; null once its round completed the check. Deferred on an
 * engine's limit, until when it holds (`limitUntil`).
 */
function standingOf(
  job: ReviewJob,
  rounds: number,
  limitUntil: (engine: EngineId) => number | null,
): Standing | null {
  switch (job.state) {
    case "queued":
      return { kind: "waiting", deferral: null, until: null };
    case "deferred": {
      const { deferral } = job;
      const until = deferral?.reason === "engine-limit" ? limitUntil(deferral.engine) : null;
      return { kind: "waiting", deferral, until };
    }
    case "running":
      return { kind: "running", round: rounds + 1 };
    case "done":
      return null;
    case "skipped":
    case "cancelled":
    case "failed":
      return { kind: "ended", ended: endOf(job) };
  }
}

/** What every check of a job carries, whatever its commit and standing. */
type Base = Omit<JobCheck, "sha" | "standing" | "checkId">;

/** What the host shows of a job's standing: its commit, state and reason, and the reset of a limit it waits on. */
const shownAs = (job: ReviewJob, standing: Standing | null): string =>
  JSON.stringify([
    job.sha,
    job.state,
    job.deferral,
    job.skip,
    job.failure?.kind ?? null,
    standing?.kind === "waiting" ? standing.until : null,
  ]);

/** The job states that write their change's status block: waiting, running, failed. */
const WRITES_BLOCK = {
  queued: true,
  deferred: true,
  running: true,
  failed: true,
  done: false,
  skipped: false,
  cancelled: false,
} satisfies Record<JobState, boolean>;

/** Whether the job waits on the engine's limit. */
const waitsOn = (job: ReviewJob, engine: EngineId): boolean =>
  job.state === "deferred" && job.deferral?.reason === "engine-limit" && job.deferral.engine === engine;

export function createChecks(d: ChecksDeps): Checks {
  const log = d.log ?? ((line: string) => console.error(line));
  /** Each job's changes still being sent, last first. */
  const sending = new Map<JobId, Promise<void>>();
  /** What the host was last shown of each job whose check is not completed, with success. */
  const sent = new Map<JobId, string>();
  /** The run each job's check last named, until its check is completed: a resend names it too. */
  const runs = new Map<JobId, RunFacts>();
  /** The block the follower last sent to each change, as rendered in the description's whole room. */
  const blocks = new Map<ChangeId, string | null>();
  /** The changes whose block GitHub refused for a moment: written again at every take until one write lands. */
  const owed = new Set<ChangeId>();

  /** What every check of the change carries. */
  const facts = (
    changeId: ChangeId,
    job: ReviewJob,
    run: RunFacts | null,
    at: number,
  ): { base: Base; rounds: number } => {
    const rounds = d.store.rounds.of(changeId).length;
    return {
      base: {
        change: { ...d.changeRef(changeId), host: d.host },
        job: { id: job.id, trigger: job.trigger },
        run,
        rounds,
        // No round yet: nothing settled it.
        loop: rounds === 0 ? "open" : loopState(d.store.rounds.ledger(changeId)),
        onlyCodex: d.onlyCodex(changeId),
        at,
      },
      rounds,
    };
  };

  /** Nothing more is sent for the job's check. */
  const completed = (id: JobId): void => {
    d.store.jobs.checkCompleted(id);
    sent.delete(id);
    runs.delete(id);
  };

  /**
   * The job's check on its commit: the one kept, or none when the job moved to a newer commit while it waited,
   * the old commit's check completed there first. A refusal propagates.
   */
  async function onItsCommit(
    job: ReviewJob,
    ref: JobCheckRef | null,
    base: Base,
  ): Promise<JobCheckRef | null> {
    if (ref === null || ref.sha === job.sha) return ref;
    const standing: Standing = { kind: "ended", ended: { kind: "skipped", why: "newer-commit" } };
    await d.publisher.check({ ...base, sha: ref.sha, standing, checkId: ref.id });
    d.store.jobs.checked(job.id, null);
    return null;
  }

  /** Whether the host already shows where the job stands, or its check is completed: nothing to send. */
  const shown = (job: ReviewJob, check: StoredJobCheck, standing: Standing | null): boolean =>
    check.completed || sent.get(job.id) === shownAs(job, standing);

  /** Sends where the job stands; a refusal propagates. */
  async function send({ changeId, job }: StoredJob, followed: Followed, at: number): Promise<void> {
    const check = d.store.jobs.checkOf(job.id);
    const run = followed.run ?? runs.get(job.id) ?? null;
    const { base, rounds } = facts(changeId, job, run, at);
    const standing = standingOf(job, rounds, d.limitUntil);
    if (shown(job, check, standing)) return;
    // An old skip on another author's change, nobody asked in person, with no check created: its end is never sent
    // (ADR 0078).
    if (endUnsent(job, d.authorOf(changeId), { created: check.ref !== null })) return completed(job.id);
    if (followed.run) runs.set(job.id, followed.run);
    const ref = await onItsCommit(job, check.ref, base);
    // A preview's job let go of its old commit's check: it makes none on the new one (ADR 0047).
    if (ref !== check.ref && d.store.jobs.checkOf(job.id).completed) return completed(job.id);
    if (standing === null) return completed(job.id);
    const ended = standing.kind === "ended";
    // A check created is kept before it is completed: a refused end completes that one, never a second.
    await d.publisher.check({ ...base, sha: job.sha, standing, checkId: ref?.id ?? null }, (id) =>
      d.store.jobs.checked(job.id, { id, sha: job.sha }),
    );
    if (ended) return completed(job.id);
    sent.set(job.id, shownAs(job, standing));
  }

  /**
   * Ends the check a preview's job has on the host: skipped, "a preview"; then completed. A refusal propagates, the
   * end left owed in the store (`resend`).
   */
  async function previewEnd({ changeId, job }: StoredJob, at: number): Promise<void> {
    const { ref, completed: done } = d.store.jobs.checkOf(job.id);
    if (done) return;
    if (ref !== null) {
      const { base } = facts(changeId, job, runs.get(job.id) ?? null, at);
      const standing: Standing = { kind: "ended", ended: { kind: "skipped", why: "preview" } };
      await d.publisher.check({ ...base, sha: ref.sha, standing, checkId: ref.id });
    }
    completed(job.id);
  }

  /**
   * Whether the job only puts the last posted round back over a block it wrote as it waited: a preview's, which posts
   * nothing (ADR 0047), or one cancelled (a fork pushed, its change closed), which never reaches a round. A restart
   * forgets which blocks it wrote: `publish` writes nothing when the description already holds that round's block.
   */
  const restores = (job: ReviewJob): boolean => job.state === "cancelled" || d.store.jobs.previewOf(job.id);

  /** Whether the job's change is to say where the job stands, in the job's standing as the store holds it now. */
  const describes = (job: ReviewJob): boolean => {
    if (restores(job)) return true;
    // Queued with no turn said yet (the take that follows starts it, or says what it waits behind), or behind its
    // change's own round: the block says that round until it posts.
    return WRITES_BLOCK[job.state] && !(job.state === "queued" && job.turn?.behind !== "engines");
  };

  /**
   * Where the change stands, for its block to say, when the job is still its newest, in the standing it was followed
   * in, and is described (`describes`); null when the job's change writes nothing.
   */
  function toDescribe({ changeId, job }: StoredJob): Status | null {
    // A change sent late (an older job's, or one the job has left since) writes nothing: the newest one's does.
    const newest = d.store.jobs.latest(changeId)?.job;
    if (newest?.id !== job.id || newest.state !== job.state || !describes(newest)) return null;
    const status = d.status(changeId);
    // A round posting writes its own block, after its review: never before it (but a job putting it back).
    if (status?.kind === "posted" && !restores(newest)) return null;
    return status;
  }

  /**
   * Writes the change's status block when the job's change says where it stands (`toDescribe`) and the block renders
   * other than the one last sent. A refusal propagates; one the host may take later leaves the block owed (`resend`).
   */
  async function describe(stored: StoredJob): Promise<void> {
    const status = toDescribe(stored);
    if (status === null) return;
    const { changeId } = stored;
    const change = d.changeRef(changeId);
    const block = d.publisher.statusBlock(change, status, DESCRIPTION_MAX_CHARACTERS);
    if (blocks.get(changeId) === block) return;
    try {
      await d.publisher.status(change);
    } catch (error) {
      // A standing refusal is `publish`'s to say, never thrown: what the host refused here may pass at the next take.
      if (error instanceof HostError) owed.add(changeId);
      throw error;
    }
    owed.delete(changeId);
    blocks.set(changeId, block);
  }

  /**
   * Writes the block owed to the change where its newest job stands now: nothing is owed once that is settled, the
   * block written or none to write. A refusal propagates, still owed.
   */
  async function owing(changeId: ChangeId): Promise<void> {
    const newest = d.store.jobs.latest(changeId);
    if (newest) await describe(newest);
    owed.delete(changeId);
  }

  /** Runs `step` after the job's earlier changes; what it throws goes to the log. */
  function queue(id: JobId, step: () => Promise<void>, what = "the check"): Promise<void> {
    const next = (sending.get(id) ?? Promise.resolve())
      .then(step)
      .catch((error: unknown) => log(`${what} of job ${id} was not sent: ${said(error)}`));
    sending.set(id, next);
    void next.then(() => {
      if (sending.get(id) === next) sending.delete(id);
    });
    return next;
  }

  /** Sends again each check end the store holds owed: a job's that ended without a round, and a preview's. */
  function resendEnds(): void {
    try {
      for (const { changeId, job } of d.store.jobs.checksEnding()) {
        // An end still being sent is not sent twice.
        if (sending.has(job.id)) continue;
        const at = d.clock.now();
        void queue(job.id, () => send({ changeId, job }, {}, at));
      }
      for (const stored of d.store.jobs.previewsEnding()) {
        if (sending.has(stored.job.id)) continue;
        const at = d.clock.now();
        void queue(stored.job.id, () => previewEnd(stored, at));
      }
    } catch (error) {
      log(`the checks' ends could not be read: ${said(error)}`);
    }
  }

  /** Writes the change's owed block again, after its newest job's changes still being sent (which may write it). */
  function resendBlock(changeId: ChangeId): void {
    try {
      const newest = d.store.jobs.latest(changeId);
      if (newest) void queue(newest.job.id, () => owing(changeId), "the status block");
      else owed.delete(changeId);
    } catch (error) {
      log(`the status block owed to ${changeId} could not be read: ${said(error)}`);
    }
  }

  function follow(stored: StoredJob, followed: Followed = {}): void {
    const at = d.clock.now();
    void queue(stored.job.id, () => send(stored, followed, at));
    void queue(stored.job.id, () => describe(stored), "the status block");
  }

  return {
    follow,
    limitMoved(engine) {
      try {
        for (const stored of d.store.jobs.waiting().jobs) if (waitsOn(stored.job, engine)) follow(stored);
      } catch (error) {
        log(`the checks waiting on ${engine}'s limit could not be read: ${said(error)}`);
      }
    },
    async forRound(stored, run) {
      await queue(stored.job.id, async () => {
        if (d.store.jobs.checkOf(stored.job.id).ref?.sha === stored.job.sha) return;
        // Its start was never shown: refused until now. Sent again, the round has a check to complete.
        sent.delete(stored.job.id);
        await send(stored, { run }, d.clock.now());
      });
      const { ref } = d.store.jobs.checkOf(stored.job.id);
      return ref?.sha === stored.job.sha ? ref.id : null;
    },
    previewed(stored) {
      const at = d.clock.now();
      void queue(stored.job.id, () => previewEnd(stored, at));
    },
    roundPosted(stored) {
      // The round wrote its own block: the next is written whatever it renders, and none is owed.
      blocks.delete(stored.changeId);
      owed.delete(stored.changeId);
      try {
        completed(stored.job.id);
      } catch (error) {
        log(`the check of job ${stored.job.id} was completed by its round, not recorded: ${said(error)}`);
      }
    },
    resend() {
      resendEnds();
      for (const changeId of owed) resendBlock(changeId);
    },
    async idle() {
      while (sending.size > 0) await Promise.all(sending.values());
    },
  };
}
