-- The job runner's record (ADR 0029, ADR 0039, ADR 0043): each job, its runs step by step, and each round with the
-- ledger it left. `rowid` orders jobs and runs as they were added. A job runs only with its one run not yet ended. A
-- run keeps what is read back: its job, the engine reviewing (the take counts one run per engine), the commit it
-- reviews (its round's), its steps and when it ended.
-- A job keeps why it waits, was skipped, was cancelled or failed; how often a restart put it back in the queue (a
-- restart retries a job it interrupted once); and the check that follows it on the host (ADR 0043): the host's id
-- and the commit it is on (null until the host created one), and whether it is completed (by the job's end, or by
-- its round), after which nothing is sent for it again. A job that ended without a round owes its check's end until
-- then: the end is the job's own (skipped, cancelled or failed, and why), sent again after a refusal or a restart.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  trigger TEXT NOT NULL,
  state TEXT NOT NULL,
  deferral_reason TEXT,
  deferral_engine TEXT,
  skip TEXT,
  cancel TEXT,
  failure_kind TEXT,
  failure_detail TEXT,
  failure_engine TEXT,
  retries INTEGER NOT NULL,
  check_id TEXT,
  check_sha TEXT,
  check_completed INTEGER NOT NULL
);
CREATE INDEX jobs_by_change ON jobs (change_id);
-- The take reads the waiting jobs and the running ones: a year of finished jobs is not read through.
CREATE INDEX jobs_by_state ON jobs (state);
-- At most one waiting job per change (#62, #65): a review asked for while one waits joins it, and a job that would
-- wait again beside its change's follow-up yields to it; SQLite refuses a second one.
CREATE UNIQUE INDEX jobs_one_waiting ON jobs (change_id) WHERE state IN ('queued', 'deferred');
-- The check ends owed are read at every take: a year of completed checks is not read through.
CREATE INDEX jobs_check_owed ON jobs (state) WHERE check_completed = 0;
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  reviewer TEXT NOT NULL,
  sha TEXT NOT NULL,
  step TEXT NOT NULL,
  step_at INTEGER NOT NULL,
  steps TEXT NOT NULL,
  ended_at INTEGER
);
-- What a round left: the commit it reviewed, the ledger after it, and when it was posted (its run's end: the poll
-- is hot for 30 minutes after the last one). The UI's round is in the event log. The index keeps "the last one" a
-- single lookup, however many rounds a year leaves.
CREATE TABLE rounds (
  change_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  sha TEXT NOT NULL,
  findings TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  PRIMARY KEY (change_id, n)
);
CREATE INDEX rounds_by_posted_at ON rounds (posted_at);
