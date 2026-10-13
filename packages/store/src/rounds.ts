// The rounds of each change and the ledger they leave (ADR 0029, ADR 0032): "the ledger to reconcile the next
// round against", "the rounds so far, with the commit each reviewed", "when was a round last posted" (the poll's
// hot window, ADR 0043). A round is written by its run as it reaches publishing (`posts.saved`, ADR 0044), before
// anything is posted, with that time as its posting time; its ledger is held (the findings its review posts not
// posted yet) until the review lands, when `posts.sent` writes it as reconciled. The ledger is the findings as the
// last round left them, every one the change ever had. "Too noisy?"'s counts (ADR 0049) are read from the ledgers
// too, never kept: a repository's 30 most recently reviewed changes, each by its last round, as `rules` counts.
import type { Database } from "bun:sqlite";
import {
  type ChangeId,
  type CommitSha,
  commitSha,
  type Finding,
  type NoiseCounts,
  type RepositoryId,
  type Round,
} from "@lookover/contracts";
import { z } from "zod";
import { pastPrefix } from "./prefix.ts";

export interface Rounds {
  /** The change's findings as the last round left them; empty before the first round. */
  ledger(changeId: ChangeId): Finding[];
  /** The rounds so far, in order: their number and the commit each reviewed. */
  of(changeId: ChangeId): Pick<Round, "n" | "sha">[];
  /**
   * When the last round of a change whose id starts with `changes` was posted (the service names a repository's
   * changes `<name>#<n>`): one repository's hot window (ADR 0043); null before its first.
   */
  lastPostedAt(changes: string): number | null;
  /**
   * "Too noisy?"'s counts (ADR 0049) over the 30 most recently reviewed changes whose ids start with `changes` (the
   * service names a repository's changes `<name>#<n>`), each by its last round: the findings below blocking posted,
   * and the findings citing each rule or any of `repoId`'s rules nested in it.
   */
  noise(repoId: RepositoryId, changes: string): NoiseCounts;
}

const roundRows = z.array(z.object({ n: z.int(), sha: z.string().transform(commitSha) }));
const ledgerRow = z.object({ findings: z.string() });
const postedRow = z.object({ at: z.int().nullable() });
const noiseRows = z.array(z.object({ rule: z.string().nullable(), below: z.int(), raised: z.int() }));

const reviewsRow = z.object({ reviews: z.int() });
const ruleRows = z.array(
  z.object({
    id: z.string(),
    parent_ids: z.string().transform((s) => z.array(z.string()).parse(JSON.parse(s))),
  }),
);

/**
 * Each rule's findings with those of every rule nested in it (ADR 0049: turning a rule off turns those off too), from
 * each cited rule's own count. A rule no longer in the files keeps its own count; one that raised nothing is left out.
 */
function subtrees(
  own: Map<string, number>,
  rules: { id: string; parent_ids: string[] }[],
): [string, number][] {
  const total = new Map(own);
  for (const rule of rules) {
    const raised = own.get(rule.id) ?? 0;
    if (raised === 0) continue;
    for (const parent of rule.parent_ids) total.set(parent, (total.get(parent) ?? 0) + raised);
  }
  return [...total];
}

/** How many changes "the last 30 reviews" are (ADR 0049). */
const LAST_REVIEWS = 30;

/** Records round `n` of a change, on `sha`, the ledger it left, and when it was saved; for `posts`' transaction. */
export function roundWriter(
  db: Database,
): (changeId: ChangeId, n: number, sha: CommitSha, ledger: Finding[], at: number) => void {
  const insert = db.query(
    "INSERT INTO rounds (change_id, n, sha, findings, posted_at) VALUES (?, ?, ?, ?, ?)",
  );
  return (changeId, n, sha, ledger, at) => {
    insert.run(changeId, n, sha, JSON.stringify(ledger), at);
  };
}

export function rounds(db: Database): Rounds {
  const selectAll = db.query("SELECT n, sha FROM rounds WHERE change_id = ? ORDER BY n");
  const selectLast = db.query("SELECT findings FROM rounds WHERE change_id = ? ORDER BY n DESC LIMIT 1");
  const selectPosted = db.query(
    "SELECT MAX(posted_at) AS at FROM rounds WHERE change_id >= ?1 AND change_id < ?2",
  );
  // The repository's changes by their last round, the most recently reviewed first. Its ids are the range from the
  // prefix (?1) to just past it (?2), so the primary key finds them without reading the other repositories' rounds.
  const last = `
    WITH last AS (
      SELECT r.findings FROM rounds AS r
      WHERE r.change_id >= ?1 AND r.change_id < ?2
        AND r.n = (SELECT MAX(l.n) FROM rounds AS l WHERE l.change_id = r.change_id)
      ORDER BY r.posted_at DESC, r.change_id DESC
      LIMIT ${LAST_REVIEWS}
    )`;
  const selectReviews = db.query(`${last} SELECT COUNT(*) AS reviews FROM last`);
  // Their findings grouped by the rule each cites (none: null).
  const selectNoise = db.query(`${last}
    SELECT json_extract(f.value, '$.rule.id') AS rule,
           SUM(json_extract(f.value, '$.posted') = 1
               AND json_extract(f.value, '$.severity') <> 'blocking') AS below,
           COUNT(*) AS raised
    FROM last, json_each(last.findings) AS f
    GROUP BY 1
  `);
  // The repository's rules as last read, each with the rules it sits in.
  const selectRules = db.query("SELECT id, parent_ids FROM rules WHERE repo_id = ?");
  return {
    lastPostedAt: (changes) => postedRow.parse(selectPosted.get(changes, pastPrefix(changes))).at,
    // `findings` is written above from typed values: reading it back is reading our own JSON.
    ledger: (changeId) => {
      const row = selectLast.get(changeId);
      return row === null ? [] : JSON.parse(ledgerRow.parse(row).findings);
    },
    of: (changeId) => roundRows.parse(selectAll.all(changeId)),
    noise: (repoId, changes) => {
      const range = [changes, pastPrefix(changes)];
      const rows = noiseRows.parse(selectNoise.all(...range));
      const own = new Map(rows.flatMap((r) => (r.rule === null ? [] : [[r.rule, r.raised] as const])));
      return {
        reviews: reviewsRow.parse(selectReviews.get(...range)).reviews,
        postedBelowBlocking: rows.reduce((sum, r) => sum + r.below, 0),
        raisedByRule: Object.fromEntries(subtrees(own, ruleRows.parse(selectRules.all(repoId)))),
      };
    },
  };
}
