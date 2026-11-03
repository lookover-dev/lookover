-- The status block in the pull request's description (ADR 0074) replaces the summary comment: a round's or a
-- dismissal's `summary` post, owed or sent, is its `status` post now. SQLite can't change a check in place: the
-- dismissals' posts table is made again, its rows kept.
UPDATE posts SET kind = 'status' WHERE kind = 'summary';
CREATE TABLE dismissal_posts_next (
  dismissal_id TEXT NOT NULL REFERENCES dismissals (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'status', 'completed', 'minimize')),
  host_id TEXT,
  tries INTEGER NOT NULL,
  PRIMARY KEY (dismissal_id, seq),
  UNIQUE (dismissal_id, kind)
);
INSERT INTO dismissal_posts_next (dismissal_id, seq, kind, host_id, tries)
  SELECT dismissal_id, seq, CASE kind WHEN 'summary' THEN 'status' ELSE kind END, host_id, tries
  FROM dismissal_posts;
DROP TABLE dismissal_posts;
ALTER TABLE dismissal_posts_next RENAME TO dismissal_posts;
