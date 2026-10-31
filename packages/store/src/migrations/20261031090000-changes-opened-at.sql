-- A change's age is when the host says it was opened (ADR 0068), not when Lookover first listed it. The column keeps
-- what it held (no backfill, AGENTS.md rule 10): the next listing writes the host's time over each, and says so.
ALTER TABLE changes RENAME COLUMN first_seen_at TO opened_at;
