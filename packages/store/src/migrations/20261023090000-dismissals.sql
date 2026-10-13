-- The owner's dismissal of a finding (ADR 0052, "This finding is wrong"): posted outside any round, through an
-- outbox of its own keyed by the dismissal. Each keeps its change and finding, the round it restates (the run whose
-- plan its posts are rendered from), the check it rewrites (null when it leaves it: the head moved), when it was
-- saved and when its posts ended (null while they are owed: a restart resumes it, and the change stays busy for the
-- take); and its posts, in order, each with the host's id once it took it and how many sends of it began.
CREATE TABLE dismissals (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id),
  check_id TEXT,
  at INTEGER NOT NULL,
  ended_at INTEGER
);
-- The take reads the dismissals still owing posts: a year of ended ones is not read through.
CREATE INDEX dismissals_owing ON dismissals (change_id) WHERE ended_at IS NULL;
CREATE TABLE dismissal_posts (
  dismissal_id TEXT NOT NULL REFERENCES dismissals (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'summary', 'completed', 'minimize')),
  host_id TEXT,
  tries INTEGER NOT NULL,
  PRIMARY KEY (dismissal_id, seq),
  UNIQUE (dismissal_id, kind)
);
