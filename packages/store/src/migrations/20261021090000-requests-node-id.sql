-- A review request's global id on the host (GitHub's `node_id`): the round that answers it minimizes it once its
-- check completes (ADR 0052). Null for a comment that was no request. A request recorded before has none, and is
-- never minimized (AGENTS.md rule 10: no backfill).
ALTER TABLE comments ADD COLUMN node_id TEXT;
