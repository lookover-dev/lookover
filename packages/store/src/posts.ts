// The outbox (ADR 0044), in the run's and `publish`'s verbs: "this run reached publishing: save its round and the
// posts it owes", "the round saved for this run, and where its posts are", "a send of this post began", "the host
// took it, and this is its id for it", "this round's review goes with its findings in the summary".
// A run that reaches publishing saves, in one transaction: its round (the commit it reviewed, when, and the ledger
// held as it is until the review lands: the findings the review posts not posted yet), what the posts are rendered
// from (the caller's plan, kept as given), the ledger once the review lands, the posts it owes, in order, and its
// step, publishing. From then on the round counts and the ledger has moved. Each post is marked sent with the host's
// id, in a transaction with what that post settles: the check sent is the job's check on the run's commit (the job's
// end completes that one if a later post is refused); the review sent lands the ledger, its findings posted; the
// check completed completes the job's check; a reply on a thread and a comment minimized (ADR 0052), one post each,
// settle nothing else. The run's end (`jobs.runEnded`) is written apart, once every post is
// sent or given up. A send begun is counted before the host is asked (`tries`): one begun and never marked sent may
// be on the host already. A round whose review goes with every finding in the summary (GitHub refused one of its
// comments) is kept so, before the review is sent again. The rounds whose review send began and was never marked
// sent (`unsure`) are the ones the host may hold; the findings of rounds whose review never landed are `withheld`,
// a preview's included (its outbox is empty: its review never lands).
// Programming errors, thrown: saving for a run that has ended or already saved its round; marking a post of a run
// with no round saved, or of a kind it doesn't owe.
import type { Database } from "bun:sqlite";
import {
  type ChangeId,
  changeId,
  type Finding,
  type FindingId,
  type ReviewJob,
  type RunId,
  runId,
  stepsDone,
} from "@lookover/contracts";
import { z } from "zod";
import { jobOf, jobRow, type RunSteps, runRow, stepsOf } from "./jobs.ts";
import { roundWriter } from "./rounds.ts";

/** The ledger `json` with the findings in `commented` marked as holding a comment of the review, as JSON. */
function marked(json: string, commented: readonly FindingId[]): string {
  if (commented.length === 0) return json;
  const ids = new Set(commented);
  const ledger: Finding[] = JSON.parse(json);
  return JSON.stringify(ledger.map((f) => (ids.has(f.id) ? { ...f, commented: true } : f)));
}

/**
 * A post of a round, in `publish`'s spelling: the check, the review, a reply on a finding's thread (`reply:<finding>`),
 * the summary, the check completed, a comment minimized (`minimize:<global id>`).
 */
export type PostKind = PlainPostKind | `${PerPostKind}:${string}`;

/** The posts a round makes once. */
type PlainPostKind = "check" | "review" | "summary" | "completed";
/** The posts a round makes once per thread or comment: the kind, then which. */
type PerPostKind = "reply" | "minimize";

/** What a run saves as it reaches publishing (ADR 0044). */
export interface RoundSaved<P> {
  /** The round's number on the change. */
  n: number;
  /** The ledger until the round's review lands: the findings it posts held as not posted. */
  held: Finding[];
  /** The ledger once the review lands. */
  ledger: Finding[];
  /** What the posts are rendered from, kept as given and given back as it was. */
  plan: P;
  /** The posts the round owes, in the order they are sent. */
  posts: readonly PostKind[];
}

/** One post as kept: the host's id once it took it (null while owed), and how many sends of it began. */
export interface StoredPost {
  kind: PostKind;
  hostId: string | null;
  tries: number;
}

/** The round a run saved, and where its posts are: what a restart resumes from. */
export interface Posting<P> {
  changeId: ChangeId;
  job: ReviewJob;
  plan: P;
  posts: StoredPost[];
  /** The round's review goes with every finding in the summary: GitHub refused one of its comments. */
  degraded: boolean;
  /** Where the run is: publishing, since its round was saved, and the steps before it. */
  steps: RunSteps;
}

export interface Posts {
  /**
   * Run `runId` reached publishing at `at`: its round, its plan and the posts it owes are saved, and the run moves
   * to publishing (unless it is there already), in one transaction. Gives where the run now is.
   */
  saved<P>(runId: RunId, round: RoundSaved<P>, at: number): RunSteps;
  /** The round run `runId` saved, its plan as given and its posts as they stand; null when it saved none. */
  of<P>(runId: RunId): Posting<P> | null;
  /** A send of `kind` began: counted before the host is asked. */
  sending(runId: RunId, kind: PostKind): void;
  /**
   * The host took `kind`, or already held it, as `hostId`: kept with what that post settles, in one transaction. The
   * review lands the ledger, its findings in `commented` marked `commented` (the review holds a comment on each).
   */
  sent(runId: RunId, kind: PostKind, hostId: string, commented?: readonly FindingId[]): void;
  /** The round's review goes with every finding in the summary: kept before it is sent again. */
  degrade(runId: RunId): void;
  /**
   * The change's findings a round raised to post whose review never landed (its posts given up, or still under
   * way while its change is busy, or a preview's, which owes none): the next round posts those still open. Once a
   * round's review lands, none of its.
   */
  withheld(changeId: ChangeId): FindingId[];
  /**
   * The change's rounds whose review send began and was never marked sent (the answer lost, or the store failed to
   * keep it): the host may hold it. Each with its plan as given and whether its review went with every finding in
   * the summary, in round order.
   */
  unsure<P>(changeId: ChangeId): { runId: RunId; plan: P; degraded: boolean }[];
  /**
   * The change's latest round that owes posts (a preview's owes none): its run, its plan as given, whether its review
   * went with every finding in the summary, and its check as sent once the round completed it (null before, and
   * for a round that gave its posts up: its check stays as the job's end left it). What a dismissal restates (ADR
   * 0052). Null before any.
   */
  latest<P>(changeId: ChangeId): { runId: RunId; plan: P; degraded: boolean; checkId: string | null } | null;
  /**
   * The host's ids of every reply the change's rounds and dismissals posted and kept, in order: what tells
   * Lookover's replies on its threads from the person's it posts as (ADR 0066). A reply begun and never marked sent
   * has none.
   */
  replies(changeId: ChangeId): number[];
}

const PLAIN = { check: true, review: true, summary: true, completed: true } satisfies Record<
  PlainPostKind,
  true
>;
const PER = { reply: true, minimize: true } satisfies Record<PerPostKind, true>;
const isPlain = (kind: string): kind is PlainPostKind => kind in PLAIN;
const isPer = (kind: string): kind is PerPostKind => kind in PER;

/** A post's kind less the thread or comment it names: what its send settles by. Null for no post's. */
function baseOf(kind: string): PlainPostKind | PerPostKind | null {
  const colon = kind.indexOf(":");
  if (colon < 0) return isPlain(kind) ? kind : null;
  const base = kind.slice(0, colon);
  return isPer(base) && colon < kind.length - 1 ? base : null;
}

/** Whether `kind` is a post's, as `saved` wrote it. */
const isPostKind = (kind: string): kind is PostKind => baseOf(kind) !== null;
const KIND = z.string().refine(isPostKind, "not a post's kind");

const planRow = z.object({
  change_id: z.string(),
  n: z.int(),
  plan: z.string(),
  ledger: z.string(),
  degraded: z.int(),
});
const unsureRows = z.array(z.object({ run_id: z.string(), plan: z.string(), degraded: z.int() }));
const unpostedRows = z.array(z.object({ ledger: z.string(), held: z.string() }));
const latestRow = z.object({
  run_id: z.string(),
  plan: z.string(),
  degraded: z.int(),
  check_id: z.string().nullable(),
});
const postRows = z.array(z.object({ kind: KIND, host_id: z.string().nullable(), tries: z.int() }));
/** A reply's id as `sent` kept it: the host's numeric id, as text. */
const replyRows = z.array(z.object({ host_id: z.string().regex(/^\d+$/) }));
export function posts(db: Database): Posts {
  const selectRun = db.query("SELECT * FROM runs WHERE id = ?");
  const selectJob = db.query("SELECT * FROM jobs WHERE id = ?");
  const selectPlan = db.query("SELECT change_id, n, plan, ledger, degraded FROM plans WHERE run_id = ?");
  const degradePlan = db.query("UPDATE plans SET degraded = 1 WHERE run_id = ?");
  // The rounds whose review never landed: their ledger as reconciled, and as held.
  const selectUnsure = db.query(
    `SELECT plans.run_id AS run_id, plans.plan AS plan, plans.degraded AS degraded FROM plans
     JOIN posts ON posts.run_id = plans.run_id AND posts.kind = 'review' AND posts.host_id IS NULL AND posts.tries > 0
     WHERE plans.change_id = ? ORDER BY plans.n`,
  );
  // A round whose review never landed: its review owed and not marked sent, or none owed (a preview's empty outbox).
  const selectUnposted = db.query(
    `SELECT plans.ledger AS ledger, rounds.findings AS held FROM plans
     JOIN rounds ON rounds.change_id = plans.change_id AND rounds.n = plans.n
     WHERE plans.change_id = ? AND NOT EXISTS (
       SELECT 1 FROM posts WHERE posts.run_id = plans.run_id AND posts.kind = 'review' AND posts.host_id IS NOT NULL
     ) ORDER BY plans.n`,
  );
  // The latest round that owes posts, with its check as sent, once the round completed it: a check the round gave up
  // on (the job's end completed it as failed) is never rewritten.
  const selectLatest = db.query(
    `SELECT plans.run_id AS run_id, plans.plan AS plan, plans.degraded AS degraded,
       (SELECT check_post.host_id FROM posts AS check_post
        JOIN posts AS completed ON completed.run_id = check_post.run_id AND completed.kind = 'completed'
          AND completed.host_id IS NOT NULL
        WHERE check_post.run_id = plans.run_id AND check_post.kind = 'check') AS check_id
     FROM plans WHERE plans.change_id = ? AND EXISTS (SELECT 1 FROM posts WHERE posts.run_id = plans.run_id)
     ORDER BY plans.n DESC LIMIT 1`,
  );
  // The change's replies kept: its rounds' (`reply:<finding>`) and its dismissals'.
  const selectReplies = db.query(
    `SELECT posts.host_id AS host_id FROM posts JOIN plans ON plans.run_id = posts.run_id
     WHERE plans.change_id = ?1 AND posts.kind LIKE 'reply:%' AND posts.host_id IS NOT NULL
     UNION ALL
     SELECT dismissal_posts.host_id FROM dismissal_posts
     JOIN dismissals ON dismissals.id = dismissal_posts.dismissal_id
     WHERE dismissals.change_id = ?1 AND dismissal_posts.kind = 'reply' AND dismissal_posts.host_id IS NOT NULL`,
  );
  const insertPlan = db.query(
    "INSERT INTO plans (run_id, change_id, n, plan, ledger) VALUES (?, ?, ?, ?, ?)",
  );
  const insertPost = db.query(
    "INSERT INTO posts (run_id, seq, kind, host_id, tries) VALUES (?, ?, ?, NULL, 0)",
  );
  const selectPosts = db.query("SELECT kind, host_id, tries FROM posts WHERE run_id = ? ORDER BY seq");
  const begin = db.query("UPDATE posts SET tries = tries + 1 WHERE run_id = ? AND kind = ?");
  const took = db.query("UPDATE posts SET host_id = ? WHERE run_id = ? AND kind = ?");
  const updateStep = db.query("UPDATE runs SET step = ?, step_at = ?, steps = ? WHERE id = ?");
  const keepCheck = db.query("UPDATE jobs SET check_id = ?, check_sha = ? WHERE id = ?");
  const completeCheck = db.query("UPDATE jobs SET check_completed = 1 WHERE id = ?");
  const landLedger = db.query("UPDATE rounds SET findings = ? WHERE change_id = ? AND n = ?");
  const addRound = roundWriter(db);

  /** The run, which the record must hold. */
  const runOf = (id: RunId, verb: string) => {
    const row = selectRun.get(id);
    if (row === null) throw new Error(`${verb}: no run ${id}`);
    return runRow.parse(row);
  };
  /** The round saved for the run; a run that saved none is a programming error for `verb`. */
  const planOf = (id: RunId, verb: string) => {
    const row = selectPlan.get(id);
    if (row === null) throw new Error(`${verb}: no round saved for run ${id}`);
    return planRow.parse(row);
  };
  /** Runs a write on one owed post; a kind the round doesn't owe is a programming error. */
  const onPost = (verb: string, id: RunId, kind: PostKind, changes: number): void => {
    if (changes === 0) throw new Error(`${verb}: run ${id} owes no ${kind} post`);
  };

  const saved = db.transaction((id: RunId, round: RoundSaved<unknown>, at: number): RunSteps => {
    const run = runOf(id, "saved");
    if (run.ended_at !== null) throw new Error(`saved: run ${id} has ended`);
    const job = jobOf(jobRow.parse(selectJob.get(run.job_id)));
    insertPlan.run(id, job.changeId, round.n, JSON.stringify(round.plan), JSON.stringify(round.ledger));
    round.posts.forEach((kind, seq) => {
      insertPost.run(id, seq, kind);
    });
    addRound(job.changeId, round.n, run.sha, round.held, at);
    const was = stepsOf(run);
    if (was.step === "publishing") return was;
    const next: RunSteps = { step: "publishing", stepAt: at, steps: stepsDone(was, at) };
    updateStep.run(next.step, next.stepAt, JSON.stringify(next.steps), id);
    return next;
  });

  const sent = db.transaction(
    (id: RunId, kind: PostKind, hostId: string, commented: readonly FindingId[]): void => {
      const plan = planOf(id, "sent");
      onPost("sent", id, kind, took.run(hostId, id, kind).changes);
      const run = runOf(id, "sent");
      switch (baseOf(kind)) {
        case "check":
          keepCheck.run(hostId, run.sha, run.job_id);
          return;
        case "review":
          landLedger.run(marked(plan.ledger, commented), plan.change_id, plan.n);
          return;
        case "completed":
          completeCheck.run(run.job_id);
          return;
        case "summary":
        case "reply":
        case "minimize":
        case null:
          // Nothing else to settle (`onPost` above refused a kind the round doesn't owe).
          return;
      }
    },
  );

  return {
    saved: (id, round, at) => saved(id, round, at),
    of: (id) => {
      const row = selectPlan.get(id);
      if (row === null) return null;
      const plan = planRow.parse(row);
      const run = runOf(id, "of");
      return {
        changeId: changeId(plan.change_id),
        job: jobOf(jobRow.parse(selectJob.get(run.job_id))).job,
        // Written by `saved` above from the caller's value: reading it back is reading our own JSON.
        plan: JSON.parse(plan.plan),
        posts: postRows
          .parse(selectPosts.all(id))
          .map((p) => ({ kind: p.kind, hostId: p.host_id, tries: p.tries })),
        degraded: plan.degraded === 1,
        steps: stepsOf(run),
      };
    },
    sending: (id, kind) => {
      planOf(id, "sending");
      onPost("sending", id, kind, begin.run(id, kind).changes);
    },
    sent: (id, kind, hostId, commented = []) => sent(id, kind, hostId, commented),
    unsure: (change) =>
      unsureRows.parse(selectUnsure.all(change)).map((row) => ({
        runId: runId(row.run_id),
        // Written by `saved` above from the caller's value: reading it back is reading our own JSON.
        plan: JSON.parse(row.plan),
        degraded: row.degraded === 1,
      })),
    withheld: (change) => {
      const ids: FindingId[] = [];
      for (const row of unpostedRows.parse(selectUnposted.all(change))) {
        // Both written by `saved` above from typed values: reading them back is reading our own JSON.
        const ledger: Finding[] = JSON.parse(row.ledger);
        const held: Finding[] = JSON.parse(row.held);
        const off = new Set(held.filter((f) => !f.posted).map((f) => f.id));
        ids.push(...ledger.filter((f) => f.posted && off.has(f.id)).map((f) => f.id));
      }
      return ids;
    },
    latest: (change) => {
      const row = selectLatest.get(change);
      if (row === null) return null;
      const latest = latestRow.parse(row);
      return {
        runId: runId(latest.run_id),
        // Written by `saved` above from the caller's value: reading it back is reading our own JSON.
        plan: JSON.parse(latest.plan),
        degraded: latest.degraded === 1,
        checkId: latest.check_id,
      };
    },
    degrade: (id) => {
      planOf(id, "degrade");
      degradePlan.run(id);
    },
    // The host's ids grow with time: in their order, the oldest first.
    replies: (change) =>
      replyRows
        .parse(selectReplies.all(change))
        .map((row) => Number(row.host_id))
        .sort((a, b) => a - b),
  };
}
