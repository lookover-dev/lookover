-- Each repository's rules as last read from its default branch's rules files (ADR 0048), in the order read: replaced
-- at each read. An id is hashed from the repository, the file and the rule's text, so an edited rule is a new rule.
-- How often each was cited and acted on is counted from the rounds' ledgers, never kept here.
CREATE TABLE rules (
  repo_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  file TEXT NOT NULL CHECK (file IN ('REVIEW.md', 'AGENTS.md', 'CLAUDE.md')),
  line INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (repo_id, id)
);
