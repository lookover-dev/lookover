// The inbox: the open changes of each repository, as the host last listed them. Its users are the service's listing
// ("record what the host lists now, and who wrote these changes; tell me what differs"), so one call replaces a
// repository's list and returns whether the repository is new to it, the changes it opened, the drafts listed ready,
// the heads it moved, the changes no longer listed (closed) and those whose writer or opened time changed (a data
// folder from before ADR 0068 kept the first listing's time: the next listing corrects it, and says so); a listing
// that changes nothing writes nothing; and the service's decisions ("which changes are open now, at which head,
// written by whom, from a fork or not, read through which commit"), which read it instead of the UI's snapshot (#64).
// Who wrote a change (ADR 0044) is the service's to read from the host: the inbox keeps what it is given with a
// listing, with the head commit it was read through, and a change the listing says nothing of keeps both (unknown,
// through no commit, for a new one). The snapshot is built from the events, not from here.
import type { Database } from "bun:sqlite";
import {
  type CommitSha,
  commitSha,
  type EngineId,
  enumOf,
  type HostChange,
  type RepositoryRef,
} from "@lookover/contracts";
import { z } from "zod";

/** A change in the inbox: whose it is, what the host shows (when it was opened too), and who wrote it. */
export interface InboxEntry {
  repo: RepositoryRef;
  change: HostChange;
  /** The engine whose coding agent wrote it, as kept after this listing; null when unknown. */
  writtenBy: EngineId | null;
}

/**
 * An open change as the inbox keeps it: what a decision reads of it (its head, whether it is a draft or a fork's,
 * its author's host id, who wrote it and the head commit that was read through, null until a read succeeded).
 */
export interface OpenChange {
  repo: RepositoryRef;
  number: number;
  head: CommitSha;
  draft: boolean;
  /** Its head repository isn't its base's, or is gone, as the last listing said (ADR 0048). */
  fork: boolean;
  authorId: number;
  writtenBy: EngineId | null;
  writerThrough: CommitSha | null;
}

/** Who wrote a change, as read from its commits up to `through`, the head commit read. */
export interface WriterRead {
  by: EngineId | null;
  through: CommitSha;
}

/** What one listing changed. */
export interface InboxDelta {
  /** The repository was not in the inbox before this listing. */
  repositoryAdded: boolean;
  opened: InboxEntry[];
  /** A draft the last listing had, listed ready for review now. */
  ready: InboxEntry[];
  /** The head moved: the entry as it is now, and the commit it was at. */
  pushed: (InboxEntry & { from: CommitSha })[];
  /** The numbers of the changes the last listing had and this one doesn't: closed or merged, and gone. */
  closed: number[];
  /**
   * A change the last listing had, whose writer or opened time this listing changed: the entry as it is now. Its
   * opened time moves only where a data folder kept another (ADR 0068), so the snapshot's age is right again.
   */
  written: InboxEntry[];
}

export interface Inbox {
  /**
   * Records the open changes of `repo` as the host lists them now, and who wrote those `writers` names (by number;
   * the others keep theirs). Returns what differs from last time.
   */
  replace(repo: RepositoryRef, changes: HostChange[], writers?: ReadonlyMap<number, WriterRead>): InboxDelta;
  /** The open changes of `repo` as the last listing left them, by number; none for a repository never listed. */
  open(repo: RepositoryRef): OpenChange[];
}

// Kept: what the next listing is compared against (the change's number, its head commit, when it was opened)
// and what decisions read (draft, fork, author, who wrote it, through which commit). What else the host shows of a
// change is given back from the listing.
const rows = z.array(
  z.object({
    number: z.int(),
    head_sha: z.string().transform(commitSha),
    draft: z.union([z.literal(0), z.literal(1)]).transform((d) => d === 1),
    fork: z.union([z.literal(0), z.literal(1)]).transform((f) => f === 1),
    author_id: z.int(),
    written_by: enumOf<EngineId>()(["claude", "codex"]).nullable(),
    writer_sha: z.string().transform(commitSha).nullable(),
    opened_at: z.int(),
  }),
);
type Row = z.infer<typeof rows>[number];

/** What `delta` says of a change listed now, `was` being its row from the last listing. */
function said(delta: InboxDelta, was: Row | undefined, now: InboxEntry): void {
  if (!was) {
    delta.opened.push(now);
    return;
  }
  if (was.draft && !now.change.draft) delta.ready.push(now);
  if (was.head_sha !== now.change.head.sha) delta.pushed.push({ ...now, from: was.head_sha });
  if (was.written_by !== now.writtenBy || was.opened_at !== now.change.openedAt) delta.written.push(now);
}

export function inbox(db: Database): Inbox {
  const selectRepo = db.query(
    `SELECT number, head_sha, draft, fork, author_id, written_by, writer_sha, opened_at FROM changes
     WHERE repo_owner = ? AND repo_name = ? ORDER BY number`,
  );
  // Listed now: new to the inbox when no listing made the row before (its switch may have, `repos`).
  const upsertRepo = db.query(`
    INSERT INTO repositories (owner, name, listed) VALUES (?, ?, 1)
    ON CONFLICT (owner, name) DO UPDATE SET listed = 1 WHERE listed = 0
  `);
  const upsert = db.query(`
    INSERT INTO changes
      (repo_owner, repo_name, number, head_sha, draft, fork, author_id, written_by, writer_sha, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo_owner, repo_name, number) DO UPDATE SET
      head_sha = excluded.head_sha, draft = excluded.draft, fork = excluded.fork, author_id = excluded.author_id,
      written_by = excluded.written_by, writer_sha = excluded.writer_sha, opened_at = excluded.opened_at
  `);
  const remove = db.query("DELETE FROM changes WHERE repo_owner = ? AND repo_name = ? AND number = ?");

  const kept = (repo: RepositoryRef) => rows.parse(selectRepo.all(repo.owner, repo.name));

  /** Keeps `now` as listed, unless the row already says so: a listing that changes nothing writes nothing. */
  const keep = (now: InboxEntry, through: CommitSha | null, was: Row | undefined): void => {
    const { repo, change: c, writtenBy } = now;
    const same =
      was &&
      was.head_sha === c.head.sha &&
      was.draft === c.draft &&
      was.fork === c.fork &&
      was.author_id === c.author.id &&
      was.written_by === writtenBy &&
      was.writer_sha === through &&
      was.opened_at === c.openedAt;
    if (same) return;
    upsert.run(
      repo.owner,
      repo.name,
      c.number,
      c.head.sha,
      c.draft ? 1 : 0,
      c.fork ? 1 : 0,
      c.author.id,
      writtenBy,
      through,
      c.openedAt,
    );
  };

  const replace = db.transaction(
    (repo: RepositoryRef, changes: HostChange[], writers: ReadonlyMap<number, WriterRead>): InboxDelta => {
      const repositoryAdded = upsertRepo.run(repo.owner, repo.name).changes === 1;
      const before = new Map(kept(repo).map((r) => [r.number, r]));
      const delta: InboxDelta = {
        repositoryAdded,
        opened: [],
        ready: [],
        pushed: [],
        closed: [],
        written: [],
      };
      for (const c of changes) {
        const was = before.get(c.number);
        before.delete(c.number);
        const read = writers.get(c.number);
        const writtenBy = read ? read.by : (was?.written_by ?? null);
        const through = read ? read.through : (was?.writer_sha ?? null);
        const now: InboxEntry = { repo, change: c, writtenBy };
        keep(now, through, was);
        said(delta, was, now);
      }
      for (const gone of before.keys()) {
        remove.run(repo.owner, repo.name, gone);
        delta.closed.push(gone);
      }
      return delta;
    },
  );

  return {
    replace: (repo, changes, writers = new Map()) => replace(repo, changes, writers),
    open: (repo) =>
      kept(repo).map((r) => ({
        repo,
        number: r.number,
        head: r.head_sha,
        draft: r.draft,
        fork: r.fork,
        authorId: r.author_id,
        writtenBy: r.written_by,
        writerThrough: r.writer_sha,
      })),
  };
}
