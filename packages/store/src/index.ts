// @lookover/store: Lookover's state on disk (ADR 0011, ADR 0033, ADR 0039, ADR 0041, ADR 0043).
// The decision it hides: the SQLite schema, its migrations and its transactions. One `bun:sqlite` database,
// `lookover.sqlite`, in WAL mode in the data folder; a connection that finds it busy (another process writing)
// waits up to 5 s instead of failing at once. Forward-only migrations, one SQL file each in `src/migrations/`,
// named by timestamp (ADR 0032), run in name order. The store runs them from a generated module that imports
// each `.sql` file as text, so a bundled or compiled service carries them (I-165); a new migration needs
// `bun run migrations` (scripts/migrations.ts). No backup or downgrade guard before 1.0: reset the data folder
// instead (AGENTS.md rule 10). Every column is one something reads: what isn't read isn't kept.
// Interface: `openStore({ home, migrations?, durable?, eventsFrom? })` opens (or creates) the database, applies
// the migrations it lacks (from `migrations`, a folder a test may give; the package's embedded list otherwise)
// and returns the handles, each shaped by its user and never one method per table. A store is durable by
// default: each commit is on the disk before it returns. `durable: false` is for data thrown away after (the
// tests): SQLite never waits for the disk, so a commit survives the process ending but not a power cut, which may
// also spoil the file; the commits a test makes then cost no disk wait each (about 3 ms on Windows). Both kinds
// of connection share one database.
// `eventsFrom` is for a store that takes over from another (a new room's, ADR 0046): its events are numbered after
// that number, so a UI that followed the old store never sees a number go back.
// - `inbox`: the open changes of each repository, as the host last listed them ("record what the host lists
//   now, tell me what differs": opened, marked ready, pushed, closed; "which changes are open now"); it keeps
//   what the next listing is compared against and what the service's decisions read of an open change (its head,
//   draft and fork flags, author id and who wrote it, as the service gives it with a listing, kept until it gives
//   another);
// - `events`: the event log the service numbers and replays (ADR 0038): "record this and number it", "give me
//   every event". The service builds the snapshot from it with `apply` once at start and applies each event it
//   records after that, so a UI that followed the events and one that loaded the snapshot see the same thing;
// - `jobs`: the queue's record, in its verbs (ADR 0029, ADR 0040, ADR 0043): a review asked for (skipped from the
//   start, with the reason; or joining the change's waiting job, or a new one, a follow-up behind its running job;
//   as a preview, which its run posts nothing of, ADR 0047), the jobs waiting and the engines reviewing, a waiting
//   job sent to the other engine (ADR 0047: offered to the take as the finder until the job ends), take the next
//   job (deferring, re-queueing, skipping, cancelling or
//   failing the waiting jobs before it as the caller decides), a change pushed (its waiting job moved to the new
//   head, as it waits; no job made), a run stepped and ended (its job with it: as its round, once `posts` saved it;
//   interrupted by a restart, back in the queue with the retry counted), the jobs left running with the step each
//   run reached and its retries, the latest job of a change (why it waits, was skipped, cancelled or failed), the
//   check following a job on the
//   host (its id and commit, whether it is completed) and the ends owed (jobs that ended without a round whose check
//   is not completed yet: the end is the job's own);
// - `rounds`: "the ledger to reconcile against", "the rounds so far, with the commit each reviewed", "when was
//   the last round posted", and "Too noisy?"'s counts over a repository's last 30 reviewed changes (ADR 0049);
// - `posts`: the outbox (ADR 0044), in the run's and `publish`'s verbs: "this run reached publishing: save its round,
//   the ledger held until its review lands and the posts it owes" (one transaction, with the step), "the round saved
//   for this run and where its posts are" (what a restart resumes), "a send of this post began", "the host took it,
//   as this id" (the check sent is the job's; the review sent lands the ledger; the check completed completes it; a
//   reply on a thread, `reply:<finding>`, and a comment minimized, `minimize:<global id>`, settle nothing else),
//   "the change's latest round that posted, with its plan and its check" (what a dismissal restates), and "the ids
//   of every reply the host took for this change", its rounds' and its dismissals' (`replies(changeId)`: what tells
//   Lookover's replies from the person's it posts as, ADR 0066);
// - `dismissals`: the owner's "This finding is wrong" (ADR 0052), an outbox of its own keyed by the dismissal: "the
//   owner dismissed this finding" (the ledger it leaves, the round's plan's too, and its posts owed, in one
//   transaction, refused while a run of the change goes), "this dismissal and its posts", "a send began", "the host
//   took it", "its posts are over", and "which still owe posts" (what a restart resumes). While one owes posts, its
//   change is busy for the take;
// - `pause`: "are reviews paused, since when and until when", "the owner paused", "reviews resumed" (ADR 0040): one
//   pause at most, kept as it was given; whether a timed one is over is the caller's to say;
// - `requests`: review requests (ADR 0043): "where is the poll in this repository's comments" (the newest comment
//   time seen, only forward, and the floor, the first place; null before the first poll), "which of these comments
//   were handled", "the poll looked at these" (forgetting the plain comments before where it lists from next),
//   "which reactions are owed" (👀 once a request is recorded, 🚀 once its job is done), "this one was sent", "the
//   global ids of the requests this job answers" (what its round minimizes, ADR 0052). A
//   request is recorded by `jobs.asked` or `jobs.skipped`, with its job, in that job's transaction; a job that yields
//   to its change's follow-up hands its requests to it; a job that ends without a round settles their 🚀 as never;
// - `selfTests`: the engines' self-tests (ADR 0044): "did this program, at this version, pass", "it ran, and passed
//   or not" (the last result kept), so a version that passed isn't tested again after a restart;
// - `setup`: how far the owner got in the first-run setup (ADR 0047): "where is it" (at its first step, nothing
//   done, until written), "was it ever written" (`kept`), "this changed" (a patch; the furthest step reached is kept, going back never loses it);
//   beside it, start at login (ADR 0049): "did the owner choose it" (off until chosen), "the owner chose", in its own
//   row, so it never makes the setup kept;
// - `rules`: each repository's rules (ADR 0048): "these were just read from its default branch" (they replace the
//   ones kept), "its rules, with how often each was cited (`raised`) and verified fixed (`acted`)", counted from every
//   change's last round, never kept;
// - `repos`: each repository's switch (ADR 0047): "does Lookover review here" (on unless the owner turned it off,
//   listed by the inbox or not yet), "the owner turned it on, or off"; and the installation's (ADR 0053): "which
//   repositories were listed", "this one left the installation" (in one transaction: its jobs not ended cancelled
//   as closed, a running one's run ended; no check's end, round post, dismissal post or reaction owed for its
//   changes any more; its listing, switch and comment place forgotten, so it is new if it comes back; its jobs,
//   rounds and rules kept as history);
// - `appFlows`: the manifest flows (ADR 0053): "make the App here" (your own account, or an organisation and the
//   person it works for, ADR 0059: chosen last, kept), "a flow was opened with this state for this place" (its hash
//   only), "when was it opened and for where", "it is used up", "forget those opened before then";
// - `installAsks`: the shared App's asks to install (ADR 0067): "which accounts did this person ask to install it
//   on, and when", "they asked on this one" (one ask per account, by GitHub's id for it, the last winning, with its
//   login as last asked), "this one is reached" (forgotten), "this person signed in" (every other person's forgotten).
// Ordering and invariants: a migration runs once, in its own transaction, in name order; `migrated` names the
// ones this open applied, so a second open reports none; a change keeps the moment it was first seen across
// listings; `events.append` numbers one more than the last, even after a restart; a job runs only with its one
// run not yet ended (the take and `runEnded` change the job and the run in one transaction); a round is written as
// its run reaches publishing (`posts.saved`, with the step), and its run ends as a round only once it is saved. A
// change has at most one waiting job (a unique index): a run's end that would leave its job waiting beside the
// change's follow-up cancels the job. `jobs.take` is the only way a job starts:
// one immediate transaction offers each waiting job (queued or deferred), oldest first by when it was added, to
// the caller's pure decision with the engines reviewing now (the running jobs' runs' finders and confirmers, both
// held for the run, but a run posting its round, ADR 0044, and those an older job left queued holds, first come,
// first served) and whether the job's change has a job running (posting included), records each change it decides
// and stops at the first start. Nothing is held between the decision and the record, so two
// takes, in one process or two, never start one job; a decision that changes nothing (the same deferral, a queued
// job left queued) writes nothing and is not reported. What to ask before a take (an engine's health) is the caller's,
// read before it; the decision runs inside the transaction, never touches the store, and may mint the run it starts (an
// id, the clock).
// Error modes: a database holding a migration this Lookover doesn't know refuses to open with a message saying
// to reset the data folder; the file is closed whenever opening fails. Programming errors, thrown: a file in the
// migrations folder not named as a migration; a row that doesn't parse; a job or run the record doesn't hold;
// `jobs.runStepped` or `runEnded` on a run that has ended. What a take's decision throws undoes the take and reaches
// the caller. SQLite's own errors (a database still busy after the wait) reach the caller.
// It must never know: what an event means (it keeps each as the body it was given and gives it back in order),
// the UI snapshot, the rules of `core`, GitHub, the engines, or who the owner is: it keeps the facts and the
// service turns them into what the UI shows.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type AppFlows, appFlows } from "./app-flows.ts";
import { type Dismissals, dismissals } from "./dismissals.ts";
import { type Events, events } from "./events.ts";
import { type Inbox, inbox } from "./inbox.ts";
import { type InstallAsks, installAsks } from "./install-asks.ts";
import { type Jobs, jobs } from "./jobs.ts";
import { migrate } from "./migrations.ts";
import { type Pause, pause } from "./pause.ts";
import { type Posts, posts } from "./posts.ts";
import { type Repos, repos } from "./repos.ts";
import { type Requests, requests } from "./requests.ts";
import { type Rounds, rounds } from "./rounds.ts";
import { type Rules, rules } from "./rules.ts";
import { type SelfTestResults, selfTests } from "./self-tests.ts";
import { type Setup, setup } from "./setup.ts";

export interface StoreOptions {
  /** The data folder, `LOOKOVER_HOME`. Created if missing. */
  home: string;
  /** A folder of migrations to apply, read from the disk, for a test; the package's embedded list otherwise. */
  migrations?: string;
  /**
   * True, the default: each commit is on the disk before it returns (SQLite's `synchronous = FULL`). False, for
   * data thrown away after: SQLite never waits for the disk (`OFF`), so a power cut may lose or spoil what it wrote.
   */
  durable?: boolean;
  /**
   * The number this store's events continue from, when it takes over from another (a new room's store, ADR 0046):
   * its first event is numbered one more, and `events.last()` answers it before then. Ignored by a store that has
   * numbered past it: a number is never given twice. 0, the default: from the start.
   */
  eventsFrom?: number;
}

export interface Store {
  /** The migrations this open applied, in order; empty when the database was already current. */
  migrated: string[];
  inbox: Inbox;
  events: Events;
  jobs: Jobs;
  rounds: Rounds;
  rules: Rules;
  posts: Posts;
  dismissals: Dismissals;
  pause: Pause;
  repos: Repos;
  requests: Requests;
  selfTests: SelfTestResults;
  setup: Setup;
  appFlows: AppFlows;
  installAsks: InstallAsks;
  close(): void;
}

export type { AppChoice, AppFlows, AppPlace } from "./app-flows.ts";
export type {
  Dismissal,
  DismissalPostKind,
  DismissalSaved,
  Dismissals,
  StoredDismissalPost,
} from "./dismissals.ts";
export type { Events } from "./events.ts";
export type { Inbox, InboxDelta, InboxEntry, OpenChange, WriterRead } from "./inbox.ts";
export type { InstallAsk, InstallAsks } from "./install-asks.ts";
export type {
  Ask,
  Asked,
  FailureFacts,
  JobCheckRef,
  Jobs,
  LeftRunning,
  Pushed,
  RunAge,
  RunEnd,
  StoredJob,
  StoredJobCheck,
  TakeDecide,
  Taking,
  Took,
  Waiting,
  WaitingJob,
} from "./jobs.ts";
export type { Pause, Paused } from "./pause.ts";
export type { Posting, PostKind, Posts, RoundSaved, StoredPost } from "./posts.ts";
export type { Repos } from "./repos.ts";
export type { CommentPlace, RequestComment, Requests, SeenComment, Unreacted } from "./requests.ts";
export type { Rounds } from "./rounds.ts";
export type { KeptRule, ReadRule, Rules } from "./rules.ts";
export type { SelfTestResults, TestedProgram } from "./self-tests.ts";
export type { Setup } from "./setup.ts";

/** How long a connection waits on a database another process is writing before SQLite's "busy" error. */
const BUSY_WAIT_MS = 5_000;

/** The database's file in the data folder. */
const DATABASE_FILE = "lookover.sqlite";

export function openStore({ home, migrations, durable = true, eventsFrom = 0 }: StoreOptions): Store {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, DATABASE_FILE), { create: true, strict: true });
  try {
    // `synchronous` first: switching a new file to WAL waits for the disk unless told not to (about 15 ms on
    // Windows, for every store of data thrown away).
    db.run(`PRAGMA synchronous = ${durable ? "FULL" : "OFF"}`);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run(`PRAGMA busy_timeout = ${BUSY_WAIT_MS}`);
    return {
      migrated: migrate(db, migrations),
      inbox: inbox(db),
      events: events(db, eventsFrom),
      jobs: jobs(db),
      rounds: rounds(db),
      rules: rules(db),
      posts: posts(db),
      dismissals: dismissals(db),
      pause: pause(db),
      repos: repos(db),
      requests: requests(db),
      selfTests: selfTests(db),
      setup: setup(db),
      appFlows: appFlows(db),
      installAsks: installAsks(db),
      close: () => db.close(),
    };
  } catch (error) {
    // Refused, or a schema the handles can't use: the file is let go, so the data folder can be reset while the
    // process runs.
    db.close();
    throw error;
  }
}
