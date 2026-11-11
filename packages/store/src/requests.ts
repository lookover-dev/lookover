// Review requests (ADR 0043), in the poll's verbs: "where is the poll in this repository's comments", "which of
// these comments were handled", "the poll looked at these, and is now here", "which reactions are still to send",
// "this one was sent". A request itself is recorded with the job it led to, in that job's transaction (`jobs.asked`,
// `jobs.skipped`), so a request is never recorded without its job nor its job without it; a job that yields to the
// change's follow-up (`jobs.runEnded`) hands its requests to the follow-up in the same transaction.
// The place is the newest comment time seen, which only moves forward, and the floor, the first place, which never
// moves: how far back the poll lists is the caller's to say. A comment that was no request is forgotten once the
// caller says it no longer lists from before its creation; a request is kept. 👀 is owed once a request is recorded,
// whatever its job does (never a preview: `jobs.asked` never lets one hold a request); 🚀 once its job's round is
// posted, as the run's end says, in its own transaction: done, or failed after the round was posted when its end as a
// round could not be recorded. A job that ends without a round (skipped, cancelled, failed before posting) settles its
// requests' 🚀 as never, so it is not read again; the sign-in changed (ADR 0090) settles every reaction still owed or
// to come, the 👀 as if sent, the 🚀 as never. A request is kept with its global id on the host, which the round
// that answers it minimizes once its check completes (ADR 0052): `of(job)` gives those of a job's requests.
import type { Database } from "bun:sqlite";
import {
  type AskedBy,
  type ChangeId,
  changeId,
  type Reaction,
  type RepositoryRef,
} from "@lookover/contracts";
import { z } from "zod";

/** A comment as the poll handles it: the host's id for it, and when it was written. */
export interface SeenComment {
  id: string;
  createdAt: number;
}

/**
 * A review request comment, recorded with the job it led to, its global id, which minimizing takes, and who wrote it
 * (ADR 0081), which the job keeps.
 */
export interface RequestComment {
  repo: RepositoryRef;
  comment: SeenComment;
  nodeId: string;
  askedBy: AskedBy;
}

/** A reaction owed to a request: 👀 once recorded, 🚀 once its job's round is posted. */
export interface Unreacted {
  repo: RepositoryRef;
  commentId: string;
  reaction: Reaction;
}

/** Where the poll of a repository's comments is: the newest comment time it saw, and its first place. */
export interface CommentPlace {
  newest: number;
  floor: number;
}

export interface Requests {
  /** Where the poll of `repo`'s comments is; null before its first poll. */
  place(repo: RepositoryRef): CommentPlace | null;
  /** Which of `ids` were handled already: requests recorded, or comments the poll looked at. */
  handled(repo: RepositoryRef, ids: readonly string[]): Set<string>;
  /**
   * The poll looked at `comments` (handled from now on); the newest comment time it saw is `newest`, unless it
   * already is further (the first call sets the floor to it). The comments that were no request and were written
   * before `keepFrom` (where the next poll lists from) are forgotten.
   */
  seen(repo: RepositoryRef, comments: readonly SeenComment[], at: { newest: number; keepFrom: number }): void;
  /** The reactions owed and not yet sent, oldest request first; a request's 👀 before its 🚀. */
  unreacted(): Unreacted[];
  /** Whether `reaction` on `repo`'s comment `commentId` is still owed: one of `unreacted`, read alone. */
  owes(repo: RepositoryRef, commentId: string, reaction: Reaction): boolean;
  /** The reaction was put on the request's comment. */
  reacted(repo: RepositoryRef, commentId: string, reaction: Reaction): void;
  /**
   * The global ids of the requests job `jobId` answers (those a job it yielded to handed it included), oldest first:
   * what its round minimizes once its check completes (ADR 0052).
   */
  of(jobId: string): string[];
  /**
   * The coding agent's request on change `changeId`, made before the repositories were chosen (ADR 0090), kept until
   * the choice, across a restart; `full`: it asked for a full round (ADR 0052). Its comment is the poll's to mark seen.
   * Kept again, a request already kept is left as it was. Only the agent's are kept, so who wrote it is not: `kept`
   * gives it back as the agent's.
   */
  keep(changeId: ChangeId, request: Omit<RequestComment, "askedBy">, full: boolean): void;
  /**
   * The kept requests, oldest first: the repositories are chosen, and the caller answers each or drops it, then
   * `unkeep`s it, so one left unanswered (a stop or a throw on the way) is kept for the next choice or start. A request
   * recorded with a job (`jobs.asked`, `jobs.skipped`) is kept no more in that job's transaction. Dropped too when the
   * sign-in changes (`repos.signInChanged`) and with a repository that leaves (`repos.removed`).
   */
  kept(): KeptRequest[];
  /** The kept request answered or dropped: kept no more. One not kept is left as it is. */
  unkeep(request: RequestComment): void;
}

/** A request kept until the repositories are chosen (ADR 0090): its change, the request, whether it asked a full round. */
export interface KeptRequest {
  changeId: ChangeId;
  request: RequestComment;
  full: boolean;
}

/**
 * Records a request with the job it led to; for `jobs`' transaction. A comment the poll only saw (a kept request,
 * answered once the repositories are chosen, ADR 0090) takes the job, and is kept no more; one recorded with a job
 * already is a programming error.
 */
export function requestWriter(db: Database): (request: RequestComment, jobId: string) => void {
  const insert = db.query(`
    INSERT INTO comments (repo_owner, repo_name, id, created_at, job_id, node_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo_owner, repo_name, id) DO UPDATE SET job_id = excluded.job_id, node_id = excluded.node_id
    WHERE comments.job_id IS NULL
  `);
  const unkeep = keptAnswered(db);
  return (request, jobId) => {
    const { repo, comment, nodeId } = request;
    const { changes } = insert.run(repo.owner, repo.name, comment.id, comment.createdAt, jobId, nodeId);
    if (changes === 0) throw new Error(`the request ${comment.id} is recorded with a job already`);
    unkeep(request);
  };
}

/** The kept request answered or dropped (ADR 0090): kept no more. */
function keptAnswered(db: Database): (request: RequestComment) => void {
  const remove = db.query("DELETE FROM kept_requests WHERE repo_owner = ? AND repo_name = ? AND id = ?");
  return ({ repo, comment }) => {
    remove.run(repo.owner, repo.name, comment.id);
  };
}

/**
 * The kept requests dropped (ADR 0090), every one, or `repo`'s only; for `repos`' transaction: the sign-in changed, or
 * the repository left the installation.
 */
export function keptDropped(db: Database): (repo?: RepositoryRef) => void {
  const all = db.query("DELETE FROM kept_requests");
  const ofRepo = db.query("DELETE FROM kept_requests WHERE repo_owner = ? AND repo_name = ?");
  return (repo) => {
    if (repo === undefined) all.run();
    else ofRepo.run(repo.owner, repo.name);
  };
}

/** Hands a job's requests to the job that answers them now; for `jobs`' transaction. */
export function requestMover(db: Database): (from: string, to: string) => void {
  const move = db.query("UPDATE comments SET job_id = ? WHERE job_id = ?");
  return (from, to) => {
    move.run(to, from);
  };
}

// The rocket column: the request's 🚀 waits for its job's round, is owed, sent, or never owed.
const ROCKET = { waits: 0, sent: 1, never: 2, owed: 3 } as const;

/** The job's round was posted: its requests' 🚀 is owed; for `jobs`' transaction. */
export function requestsAnswered(db: Database): (jobId: string) => void {
  const owed = db.query(`
    UPDATE comments SET rocket = ${ROCKET.owed}
    WHERE job_id = ? AND rocket = ${ROCKET.waits}
  `);
  return (jobId) => {
    owed.run(jobId);
  };
}

/** Whether the job holds a request; for `jobs`' transaction. */
export function requestsHeld(db: Database): (jobId: string) => boolean {
  const held = db.query("SELECT 1 FROM comments WHERE job_id = ? LIMIT 1");
  return (jobId) => held.get(jobId) !== null;
}

/** The job ended without a round: its requests' 🚀 is never owed; for `jobs`' transaction. */
export function requestsUnanswered(db: Database): (jobId: string) => void {
  const never = db.query(
    `UPDATE comments SET rocket = ${ROCKET.never} WHERE job_id = ? AND rocket = ${ROCKET.waits}`,
  );
  return (jobId) => {
    never.run(jobId);
  };
}

/**
 * Every reaction owed or still to come is owed no more (ADR 0090): the 👀 counted as settled, the 🚀 never owed; for
 * `repos`' transaction.
 */
export function requestsSettled(db: Database): () => void {
  const eyes = db.query("UPDATE comments SET eyes = 1 WHERE job_id IS NOT NULL AND eyes = 0");
  const rocket = db.query(`
    UPDATE comments SET rocket = ${ROCKET.never}
    WHERE job_id IS NOT NULL AND rocket IN (${ROCKET.waits}, ${ROCKET.owed})
  `);
  return () => {
    eyes.run();
    rocket.run();
  };
}

const keptRows = z.array(
  z.object({
    repo_owner: z.string(),
    repo_name: z.string(),
    id: z.string(),
    change_id: z.string().transform(changeId),
    created_at: z.int(),
    node_id: z.string(),
    full: z.union([z.literal(0), z.literal(1)]),
  }),
);
const placeRow = z.object({ newest: z.int(), floor: z.int() });
const nodeRows = z.array(z.object({ node_id: z.string() }));
const flag = z.union([z.literal(0), z.literal(1)]);
const unreactedRows = z.array(
  z.object({
    repo_owner: z.string(),
    repo_name: z.string(),
    id: z.string(),
    eyes: flag,
    rocket: z.union([
      z.literal(ROCKET.waits),
      z.literal(ROCKET.sent),
      z.literal(ROCKET.never),
      z.literal(ROCKET.owed),
    ]),
  }),
);

export function requests(db: Database): Requests {
  const selectPlace = db.query(
    "SELECT newest, floor FROM comment_places WHERE repo_owner = ? AND repo_name = ?",
  );
  const upsertPlace = db.query(`
    INSERT INTO comment_places (repo_owner, repo_name, newest, floor) VALUES (?, ?, ?, ?)
    ON CONFLICT (repo_owner, repo_name) DO UPDATE SET newest = MAX(newest, excluded.newest)
  `);
  const selectHandled = db.query("SELECT 1 FROM comments WHERE repo_owner = ? AND repo_name = ? AND id = ?");
  const insertSeen = db.query(
    "INSERT OR IGNORE INTO comments (repo_owner, repo_name, id, created_at) VALUES (?, ?, ?, ?)",
  );
  const forget = db.query(
    "DELETE FROM comments WHERE repo_owner = ? AND repo_name = ? AND job_id IS NULL AND created_at < ?",
  );
  const selectUnreacted = db.query(`
    SELECT repo_owner, repo_name, id, eyes, rocket FROM comments
    WHERE job_id IS NOT NULL AND (eyes = 0 OR rocket = ${ROCKET.owed})
    ORDER BY rowid
  `);
  const owesEyes = db.query(
    "SELECT 1 FROM comments WHERE repo_owner = ? AND repo_name = ? AND id = ? AND job_id IS NOT NULL AND eyes = 0",
  );
  const owesRocket = db.query(`
    SELECT 1 FROM comments WHERE repo_owner = ? AND repo_name = ? AND id = ? AND job_id IS NOT NULL
      AND rocket = ${ROCKET.owed}
  `);
  const markEyes = db.query("UPDATE comments SET eyes = 1 WHERE repo_owner = ? AND repo_name = ? AND id = ?");
  const markRocket = db.query(
    `UPDATE comments SET rocket = ${ROCKET.sent} WHERE repo_owner = ? AND repo_name = ? AND id = ?`,
  );

  const selectNodes = db.query(
    "SELECT node_id FROM comments WHERE job_id = ? AND node_id IS NOT NULL ORDER BY created_at, rowid",
  );

  const seen = db.transaction(
    (repo: RepositoryRef, comments: readonly SeenComment[], at: { newest: number; keepFrom: number }) => {
      for (const c of comments) insertSeen.run(repo.owner, repo.name, c.id, c.createdAt);
      upsertPlace.run(repo.owner, repo.name, at.newest, at.newest);
      forget.run(repo.owner, repo.name, at.keepFrom);
    },
  );

  const insertKept = db.query(`
    INSERT OR IGNORE INTO kept_requests (repo_owner, repo_name, id, change_id, created_at, node_id, full)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectKept = db.query(`
    SELECT repo_owner, repo_name, id, change_id, created_at, node_id, full FROM kept_requests
    ORDER BY created_at, rowid
  `);
  const unkeep = keptAnswered(db);

  return {
    place: (repo) => {
      const row = selectPlace.get(repo.owner, repo.name);
      return row === null ? null : placeRow.parse(row);
    },
    handled: (repo, ids) =>
      new Set(ids.filter((id) => selectHandled.get(repo.owner, repo.name, id) !== null)),
    seen: (repo, comments, at) => seen(repo, comments, at),
    unreacted: () =>
      unreactedRows.parse(selectUnreacted.all()).flatMap((r): Unreacted[] => {
        const repo = { owner: r.repo_owner, name: r.repo_name };
        const owed: Unreacted[] = [];
        if (r.eyes === 0) owed.push({ repo, commentId: r.id, reaction: "eyes" });
        if (r.rocket === ROCKET.owed) owed.push({ repo, commentId: r.id, reaction: "rocket" });
        return owed;
      }),
    owes: (repo, commentId, reaction) =>
      (reaction === "eyes" ? owesEyes : owesRocket).get(repo.owner, repo.name, commentId) !== null,
    reacted: (repo, commentId, reaction) => {
      (reaction === "eyes" ? markEyes : markRocket).run(repo.owner, repo.name, commentId);
    },
    of: (jobId) => nodeRows.parse(selectNodes.all(jobId)).map((r) => r.node_id),
    keep: (id, { repo, comment, nodeId }, full) => {
      insertKept.run(repo.owner, repo.name, comment.id, id, comment.createdAt, nodeId, full ? 1 : 0);
    },
    kept: () =>
      keptRows.parse(selectKept.all()).map(
        (r): KeptRequest => ({
          changeId: r.change_id,
          request: {
            repo: { owner: r.repo_owner, name: r.repo_name },
            comment: { id: r.id, createdAt: r.created_at },
            nodeId: r.node_id,
            askedBy: "agent",
          },
          full: r.full === 1,
        }),
      ),
    unkeep,
  };
}
