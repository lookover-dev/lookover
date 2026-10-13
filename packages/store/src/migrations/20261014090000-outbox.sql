-- The outbox (ADR 0044). A round is saved before it is posted: what its posts are rendered from (the plan, kept as
-- the service gave it), its round number on the change and the ledger once its review lands, one row per run that
-- reached publishing; and the posts it owes, in order, each with the host's id once it took it and how many sends of
-- it began (one begun and never marked sent may be on the host already).
-- A database from before it holds rounds and events whose findings lack ADR 0044's fields (who found each, what the
-- confirm pass said, its line's text). There is no reader of the old format (AGENTS.md rule 10): everything it kept
-- of changes, jobs, runs, rounds, requests and events goes, and Lookover starts as on a fresh data folder (the
-- first listing shows what is open; only comments written after it count as requests). The pause is kept.
DELETE FROM comments;
DELETE FROM comment_places;
DELETE FROM rounds;
DELETE FROM runs;
DELETE FROM jobs;
DELETE FROM changes;
DELETE FROM repositories;
DELETE FROM events;
CREATE TABLE plans (
  run_id TEXT PRIMARY KEY REFERENCES runs (id),
  change_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  plan TEXT NOT NULL,
  ledger TEXT NOT NULL
);
CREATE TABLE posts (
  run_id TEXT NOT NULL REFERENCES runs (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  host_id TEXT,
  tries INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, kind)
);
