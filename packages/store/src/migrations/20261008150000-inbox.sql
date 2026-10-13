-- The inbox: the repositories Lookover watches and their open changes, as the host last listed them. What a
-- listing is compared against (which changes, the head commit each was at, when each was first seen) and what the
-- service's decisions read of an open change: its head, whether it is a draft, its author's host id.
CREATE TABLE repositories (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (owner, name)
);
CREATE TABLE changes (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  draft INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, number),
  FOREIGN KEY (repo_owner, repo_name) REFERENCES repositories (owner, name)
);
