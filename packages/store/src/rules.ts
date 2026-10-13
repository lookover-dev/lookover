// Each repository's rules (ADR 0048): "these are the rules just read from its default branch" (replacing the ones
// kept, so a rule edited or removed there is gone here) and "its rules, with how often each was cited and acted on".
// The counts are read from the rounds, never kept: every change's last round's ledger, its findings citing the rule
// (`raised`) and, of those, the ones verified fixed (`acted`). A rule's id is hashed from the repository, the file and
// its text (`core`'s), so an edited rule is a new rule, its counts at zero.
import type { Database } from "bun:sqlite";
import type { CitedRule, RepositoryId, Rule } from "@lookover/contracts";
import { RULES_FILES } from "@lookover/contracts";
import { z } from "zod";

/**
 * A rule as read from a rules file: which rule, where, its text, and the ids of the rules it is nested in, outermost
 * first (ADR 0049: a rule switched off takes them with it).
 */
export type ReadRule = CitedRule & { text: string; parentIds: string[] };

/**
 * A repository's rule as kept, with its counts and the rules it is nested in; whether it is on is the settings', not
 * the store's.
 */
export type KeptRule = Omit<Rule, "enabled" | "parentOff" | "nested"> & { parentIds: string[] };

export interface Rules {
  /**
   * The repository's rules just read, in the files' order: they replace the ones kept; none leaves it none. A rule
   * read twice is kept once, at its first place.
   */
  read(repoId: RepositoryId, rules: ReadRule[]): void;
  /** The repository's rules as last read, in that order, each counted from every change's last round. */
  of(repoId: RepositoryId): KeptRule[];
}

const keptRows = z.array(
  z.object({
    id: z.string(),
    file: z.enum(RULES_FILES),
    line: z.int(),
    text: z.string(),
    parent_ids: z.string(),
    raised: z.int(),
    acted: z.int(),
  }),
);

const parentIds = z.array(z.string());

export function rules(db: Database): Rules {
  const remove = db.query("DELETE FROM rules WHERE repo_id = ?");
  // A rule read twice (one id) is kept once, where it was first read, as `core` keeps a rule repeated in a file.
  const insert = db.query(
    "INSERT OR IGNORE INTO rules (repo_id, seq, id, file, line, text, parent_ids) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // Every change's last round, its findings citing one of the repository's rules.
  const select = db.query(`
    WITH cited AS (
      SELECT json_extract(f.value, '$.rule.id') AS id,
             COUNT(*) AS raised,
             SUM(json_extract(f.value, '$.status') = 'verified_fixed') AS acted
      FROM rounds AS r, json_each(r.findings) AS f
      WHERE r.n = (SELECT MAX(l.n) FROM rounds AS l WHERE l.change_id = r.change_id)
        AND json_extract(f.value, '$.rule.id') IN (SELECT id FROM rules WHERE repo_id = ?1)
      GROUP BY 1
    )
    SELECT rules.id, rules.file, rules.line, rules.text, rules.parent_ids,
           COALESCE(cited.raised, 0) AS raised, COALESCE(cited.acted, 0) AS acted
    FROM rules LEFT JOIN cited ON cited.id = rules.id
    WHERE rules.repo_id = ?1
    ORDER BY rules.seq
  `);
  const replace = db.transaction((repoId: RepositoryId, read: ReadRule[]) => {
    remove.run(repoId);
    read.forEach((r, seq) => {
      insert.run(repoId, seq, r.id, r.file, r.line, r.text, JSON.stringify(r.parentIds));
    });
  });
  return {
    read: (repoId, read) => {
      replace(repoId, read);
    },
    of: (repoId) =>
      keptRows.parse(select.all(repoId)).map(({ file, parent_ids, ...r }) => ({
        ...r,
        repoId,
        source: file,
        parentIds: parentIds.parse(JSON.parse(parent_ids)),
      })),
  };
}
