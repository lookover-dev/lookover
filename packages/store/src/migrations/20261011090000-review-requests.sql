-- Review requests (ADR 0043). Where the poll of each repository's conversation comments is: the newest comment time
-- it saw, and the floor, its first place (a repository with no row has never been polled: both start at that first
-- poll's "now"; nothing written before is a request). The comments it handled, so a restart never runs a request
-- twice or reacts twice: a comment that was no request is kept until the poll no longer lists from before its
-- creation; a request is kept with the job it led to (moved to the follow-up its job yielded to), and its eyes and
-- rocket reactions: 0 owed, 1 sent; the rocket 2, never (its job ended without a round).
CREATE TABLE comment_places (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  newest INTEGER NOT NULL,
  floor INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name)
);
CREATE TABLE comments (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  job_id TEXT REFERENCES jobs (id),
  eyes INTEGER NOT NULL DEFAULT 0,
  rocket INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_owner, repo_name, id)
);
CREATE INDEX comments_by_job ON comments (job_id);
-- The reactions still to send are read at every poll: a year of answered requests is not read through.
CREATE INDEX comments_unreacted ON comments (job_id) WHERE job_id IS NOT NULL AND (eyes = 0 OR rocket = 0);
