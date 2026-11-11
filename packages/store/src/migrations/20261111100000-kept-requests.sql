-- The coding agent's review requests made before the repositories were chosen (ADR 0090): they asked nothing then,
-- and are kept until the choice, which answers (or drops) each, then forgets it. One row per request comment:
-- its change, the comment (its host id, when it was written, its global id) and whether it asked for a full round
-- (ADR 0052). Only the coding agent's are kept, so who wrote it is not.
CREATE TABLE kept_requests (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  full INTEGER NOT NULL CHECK (full IN (0, 1)),
  PRIMARY KEY (repo_owner, repo_name, id)
);
