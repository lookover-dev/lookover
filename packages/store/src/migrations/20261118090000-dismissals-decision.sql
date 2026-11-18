-- The owner's decision on a finding, "This finding is wrong" (ADR 0052) or "Accept as is" (ADR 0100), and how it came,
-- `app` or `agent` (ADR 0101): each dismissal keeps the decision, its way, and the coding agent's settle comment it
-- answers (null for the app's: the poll counts it handled, and its last post is 🚀 on it). A dismissal saved before
-- them was the app's "This finding is wrong". Its posts may end with that 🚀, `react`: SQLite can't change a check in
-- place, so the posts table is made again, its rows kept. A released migration is never edited (ADR 0103).
ALTER TABLE dismissals ADD COLUMN decision TEXT NOT NULL DEFAULT 'wrong' CHECK (decision IN ('wrong', 'accepted'));
ALTER TABLE dismissals ADD COLUMN via TEXT NOT NULL DEFAULT 'app' CHECK (via IN ('app', 'agent'));
ALTER TABLE dismissals ADD COLUMN comment_id TEXT;
-- Each poll asks whether a fresh comment is a settle a dismissal answers: only the agent's carry one.
CREATE INDEX dismissals_comment ON dismissals (comment_id) WHERE comment_id IS NOT NULL;
CREATE TABLE dismissal_posts_next (
  dismissal_id TEXT NOT NULL REFERENCES dismissals (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'status', 'completed', 'minimize', 'react')),
  host_id TEXT,
  tries INTEGER NOT NULL,
  PRIMARY KEY (dismissal_id, seq),
  UNIQUE (dismissal_id, kind)
);
INSERT INTO dismissal_posts_next (dismissal_id, seq, kind, host_id, tries)
  SELECT dismissal_id, seq, kind, host_id, tries FROM dismissal_posts;
DROP TABLE dismissal_posts;
ALTER TABLE dismissal_posts_next RENAME TO dismissal_posts;
-- The coding agent's settle comments Lookover refused (ADR 0101), each owing its 😕 on the host: 0 owed, 1 settled (sent,
-- its comment gone, or never: the sign-in changed, ADR 0090). Kept once settled, so a comment refused again is never
-- answered twice; dropped with a repository that leaves the installation.
CREATE TABLE settle_refusals (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  id TEXT NOT NULL,
  confused INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_owner, repo_name, id)
);
