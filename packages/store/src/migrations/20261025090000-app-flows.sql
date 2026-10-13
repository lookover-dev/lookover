-- The manifest flows (ADR 0053): each "Create it on GitHub" page opened, kept by the hash of its state (never the
-- state itself) and when it was opened, so GitHub's redirect back is accepted within the hour, after a restart too.
-- A flow is used up (deleted) only by a conversion that succeeded.
CREATE TABLE app_flows (
  state_hash TEXT PRIMARY KEY,
  opened_at INTEGER NOT NULL
);
