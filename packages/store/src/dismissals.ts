// The owner's dismissals (ADR 0052, "This finding is wrong"), in the service's and `publish`'s verbs: "the owner
// dismissed this finding: write the ledger it leaves and save the posts it owes", "this dismissal and where its posts
// are", "a send of this post began", "the host took it, and this is its id for it", "its posts are over".
// A dismissal is saved in one transaction, refused while a run of its change goes (a round would reconcile and post
// over it): the change's ledger with the finding dismissed (its last round's, and that round's plan's ledger too, so a
// review that lands late lands it dismissed), the dismissal, and the posts it owes, in order, under its own key.
// Until it ends, its change is busy for the take (`jobs.take`): a round never posts while it does. Its posts are
// rendered from the round it names (that run's plan, kept as the run gave it).
// Programming errors, thrown: marking a post of a dismissal never saved, that has ended, or of a kind it doesn't owe.
import type { Database } from "bun:sqlite";
import {
  type ChangeId,
  changeId,
  enumOf,
  type Finding,
  type FindingId,
  findingId,
  type RunId,
} from "@lookover/contracts";
import { z } from "zod";

/** A post of a dismissal, in `publish`'s spelling: the reply, the summary, the round's check, the root minimized. */
export type DismissalPostKind = "reply" | "summary" | "completed" | "minimize";

/** What the service saves as the owner dismisses a finding. */
export interface DismissalSaved {
  /** The dismissal's own key. */
  id: string;
  changeId: ChangeId;
  findingId: FindingId;
  /** The round its posts are rendered from: the run whose plan the change's latest posted round keeps. */
  runId: RunId;
  /** The round's check it rewrites; null leaves it. */
  checkId: string | null;
  /** What the dismissal does to a ledger (`core`'s): applied to the change's last round's, in the transaction. */
  dismiss(ledger: Finding[]): Finding[];
  /** The posts it owes, in the order they are sent. */
  posts: readonly DismissalPostKind[];
  at: number;
}

/** One of a dismissal's posts as kept: the host's id once it took it (null while owed), and how many sends began. */
export interface StoredDismissalPost {
  kind: DismissalPostKind;
  hostId: string | null;
  tries: number;
}

/** A dismissal as kept: what a restart resumes from. */
export interface Dismissal<P> {
  id: string;
  changeId: ChangeId;
  findingId: FindingId;
  /** The plan of the round it restates, as its run gave it. */
  plan: P;
  /** That round's review went with every finding in the summary. */
  degraded: boolean;
  checkId: string | null;
  posts: StoredDismissalPost[];
}

export interface Dismissals {
  /**
   * The owner dismissed a finding: its change's ledger written as `dismiss` leaves it, the dismissal and its posts
   * owed, in one transaction. Gives the ledger as it now is; "reviewing" (nothing written) while a run of the change
   * goes.
   */
  saved(dismissal: DismissalSaved): Finding[] | "reviewing";
  /** The dismissal and its posts as they stand; null when none was saved. */
  of<P>(id: string): Dismissal<P> | null;
  /** The dismissals whose posts haven't ended, oldest first: what a restart resumes. */
  owing(): string[];
  /** A send of `kind` began: counted before the host is asked. */
  sending(id: string, kind: DismissalPostKind): void;
  /** The host took `kind`, or already held it, as `hostId`. */
  sent(id: string, kind: DismissalPostKind, hostId: string): void;
  /** Its posts are over, sent or given up: its change is free for the take. */
  ended(id: string, at: number): void;
}

const dismissalRow = z.object({
  id: z.string(),
  change_id: z.string(),
  finding_id: z.string(),
  check_id: z.string().nullable(),
  plan: z.string(),
  degraded: z.int(),
  ended_at: z.int().nullable(),
});
const postRows = z.array(
  z.object({
    kind: enumOf<DismissalPostKind>()(["reply", "summary", "completed", "minimize"]),
    host_id: z.string().nullable(),
    tries: z.int(),
  }),
);
const idRows = z.array(z.object({ id: z.string() }));
const lastRow = z.object({ n: z.int(), findings: z.string() });
const ledgerRow = z.object({ ledger: z.string() });

export function dismissals(db: Database): Dismissals {
  const selectRunning = db.query("SELECT 1 FROM jobs WHERE change_id = ? AND state = 'running' LIMIT 1");
  const selectLast = db.query("SELECT n, findings FROM rounds WHERE change_id = ? ORDER BY n DESC LIMIT 1");
  const updateLast = db.query("UPDATE rounds SET findings = ? WHERE change_id = ? AND n = ?");
  const selectPlanLedger = db.query("SELECT ledger FROM plans WHERE change_id = ? AND n = ?");
  const updatePlanLedger = db.query("UPDATE plans SET ledger = ? WHERE change_id = ? AND n = ?");
  const insert = db.query(
    "INSERT INTO dismissals (id, change_id, finding_id, run_id, check_id, at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertPost = db.query(
    "INSERT INTO dismissal_posts (dismissal_id, seq, kind, host_id, tries) VALUES (?, ?, ?, NULL, 0)",
  );
  const select = db.query(
    `SELECT d.id, d.change_id, d.finding_id, d.check_id, d.ended_at, plans.plan, plans.degraded
     FROM dismissals AS d JOIN plans ON plans.run_id = d.run_id WHERE d.id = ?`,
  );
  const selectPosts = db.query(
    "SELECT kind, host_id, tries FROM dismissal_posts WHERE dismissal_id = ? ORDER BY seq",
  );
  const selectOwing = db.query("SELECT id FROM dismissals WHERE ended_at IS NULL ORDER BY rowid");
  const begin = db.query("UPDATE dismissal_posts SET tries = tries + 1 WHERE dismissal_id = ? AND kind = ?");
  const took = db.query("UPDATE dismissal_posts SET host_id = ? WHERE dismissal_id = ? AND kind = ?");
  const end = db.query("UPDATE dismissals SET ended_at = ? WHERE id = ? AND ended_at IS NULL");

  const rowOf = (id: string) => {
    const row = select.get(id);
    return row === null ? null : dismissalRow.parse(row);
  };
  /** A post of a dismissal still owing: one never saved, ended, or of a kind it doesn't owe is a programming error. */
  const onPost = (verb: string, id: string, kind: DismissalPostKind, write: () => number): void => {
    const row = rowOf(id);
    if (row === null) throw new Error(`${verb}: no dismissal ${id}`);
    if (row.ended_at !== null) throw new Error(`${verb}: dismissal ${id} has ended`);
    if (write() === 0) throw new Error(`${verb}: dismissal ${id} owes no ${kind} post`);
  };

  const saved = db.transaction((d: DismissalSaved): Finding[] | "reviewing" => {
    if (selectRunning.get(d.changeId) !== null) return "reviewing";
    const last = lastRow.parse(selectLast.get(d.changeId));
    // Written by the rounds and posts from typed values: reading them back is reading our own JSON.
    const ledger = d.dismiss(JSON.parse(last.findings));
    updateLast.run(JSON.stringify(ledger), d.changeId, last.n);
    const planned = selectPlanLedger.get(d.changeId, last.n);
    if (planned !== null) {
      const landing: Finding[] = JSON.parse(ledgerRow.parse(planned).ledger);
      updatePlanLedger.run(JSON.stringify(d.dismiss(landing)), d.changeId, last.n);
    }
    insert.run(d.id, d.changeId, d.findingId, d.runId, d.checkId, d.at);
    d.posts.forEach((kind, seq) => {
      insertPost.run(d.id, seq, kind);
    });
    return ledger;
  });

  return {
    saved: (d) => saved(d),
    of: (id) => {
      const row = rowOf(id);
      if (row === null) return null;
      return {
        id: row.id,
        changeId: changeId(row.change_id),
        findingId: findingId(row.finding_id),
        // Written by `posts.saved` from the run's value: reading it back is reading our own JSON.
        plan: JSON.parse(row.plan),
        degraded: row.degraded === 1,
        checkId: row.check_id,
        posts: postRows
          .parse(selectPosts.all(id))
          .map((p) => ({ kind: p.kind, hostId: p.host_id, tries: p.tries })),
      };
    },
    owing: () => idRows.parse(selectOwing.all()).map((r) => r.id),
    sending: (id, kind) => onPost("sending", id, kind, () => begin.run(id, kind).changes),
    sent: (id, kind, hostId) => onPost("sent", id, kind, () => took.run(hostId, id, kind).changes),
    ended: (id, at) => {
      end.run(at, id);
    },
  };
}
