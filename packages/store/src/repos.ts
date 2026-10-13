// A repository's switch (ADR 0047): "does Lookover review here", "the owner turned it on, or off". Its users are the
// snapshot's base and the decisions, which read it, and the setup's "choose repositories" and `repo.setEnabled`,
// which write it. On until turned off: a repository never switched is on, listed or not. The switch sits on the
// inbox's repository row, which it makes when the inbox hasn't listed the repository yet; the inbox's first listing
// still says the repository is new, as it keeps apart whether it listed it.
// And the installation's (ADR 0053): "which repositories were listed", what a start compares the installation's
// listing with, and "this repository left the installation": its jobs cancelled, what it owes the host dropped, its
// listing forgotten, its history kept, in one transaction.
import type { Database } from "bun:sqlite";
import type { RepositoryRef } from "@lookover/contracts";
import { z } from "zod";
import { pastPrefix } from "./prefix.ts";

export interface Repos {
  /** Whether Lookover reviews in the repository: on unless the owner turned it off. */
  enabled(repo: RepositoryRef): boolean;
  /** The owner turned the repository's switch on or off. */
  setEnabled(repo: RepositoryRef, enabled: boolean): void;
  /** The repositories the inbox listed and hasn't forgotten, in the order it first listed them. */
  listed(): RepositoryRef[];
  /**
   * The repository left the installation at `at` (ADR 0053), its changes' ids starting with `changes`: every job of
   * theirs not ended is cancelled as closed (a running one's run ended too); no check's end, round post, dismissal
   * post or reaction is owed for them any more (what the host took stays); the inbox forgets the repository, its
   * changes, its switch and where the poll was in its comments, so it is new again if it comes back. Its jobs,
   * rounds and rules stay, as history.
   */
  removed(repo: RepositoryRef, changes: string, at: number): void;
}

const row = z.object({ enabled: z.union([z.literal(0), z.literal(1)]) });
const listedRows = z.array(z.object({ owner: z.string(), name: z.string() }));

export function repos(db: Database): Repos {
  const select = db.query("SELECT enabled FROM repositories WHERE owner = ? AND name = ?");
  // A row the inbox hasn't made is made here, not listed yet: the inbox's first listing says "new" all the same.
  const upsert = db.query(`
    INSERT INTO repositories (owner, name, enabled, listed) VALUES (?, ?, ?, 0)
    ON CONFLICT (owner, name) DO UPDATE SET enabled = excluded.enabled
  `);
  const selectListed = db.query("SELECT owner, name FROM repositories WHERE listed = 1 ORDER BY rowid");
  // The changes' ids from `?1` up to `?2`, `pastPrefix`'s.
  const inRange = "change_id >= ?1 AND change_id < ?2";
  // The runs under way end while their jobs still say running.
  const endRuns = db.query(`
    UPDATE runs SET ended_at = ?3
    WHERE ended_at IS NULL AND job_id IN (SELECT id FROM jobs WHERE ${inRange} AND state = 'running')
  `);
  // Then their jobs, and every job still waiting, are cancelled, and no job's check owes its end.
  const cancelJobs = db.query(`
    UPDATE jobs SET state = 'cancelled', cancel = 'closed', deferral_reason = NULL, deferral_engine = NULL,
      deferral_unusable = NULL, turn = NULL
    WHERE ${inRange} AND state IN ('queued', 'deferred', 'running')
  `);
  const completeChecks = db.query(
    `UPDATE jobs SET check_completed = 1 WHERE ${inRange} AND check_completed = 0`,
  );
  // The round posts the host hasn't taken.
  const dropPosts = db.query(`
    DELETE FROM posts WHERE host_id IS NULL AND run_id IN (SELECT run_id FROM plans WHERE ${inRange})
  `);
  // The dismissals still owing posts: those posts dropped while they still owe them, then the dismissals ended.
  const dropDismissalPosts = db.query(`
    DELETE FROM dismissal_posts WHERE host_id IS NULL
      AND dismissal_id IN (SELECT id FROM dismissals WHERE ${inRange} AND ended_at IS NULL)
  `);
  const endDismissals = db.query(`UPDATE dismissals SET ended_at = ?3 WHERE ${inRange} AND ended_at IS NULL`);
  // The listing: the requests and the poll's place in the comments, the changes, and the row with its switch.
  const forgetListing = [
    db.query("DELETE FROM comments WHERE repo_owner = ? AND repo_name = ?"),
    db.query("DELETE FROM comment_places WHERE repo_owner = ? AND repo_name = ?"),
    db.query("DELETE FROM changes WHERE repo_owner = ? AND repo_name = ?"),
    db.query("DELETE FROM repositories WHERE owner = ? AND name = ?"),
  ];
  const removed = db.transaction((repo: RepositoryRef, changes: string, at: number) => {
    const past = pastPrefix(changes);
    endRuns.run(changes, past, at);
    cancelJobs.run(changes, past);
    completeChecks.run(changes, past);
    dropPosts.run(changes, past);
    dropDismissalPosts.run(changes, past);
    endDismissals.run(changes, past, at);
    for (const query of forgetListing) query.run(repo.owner, repo.name);
  });
  return {
    enabled: ({ owner, name }) => {
      const found = select.get(owner, name);
      return found === null ? true : row.parse(found).enabled === 1;
    },
    setEnabled: ({ owner, name }, enabled) => {
      upsert.run(owner, name, enabled ? 1 : 0);
    },
    listed: () => listedRows.parse(selectListed.all()).map(({ owner, name }) => ({ owner, name })),
    removed: (repo, changes, at) => removed.immediate(repo, changes, at),
  };
}
