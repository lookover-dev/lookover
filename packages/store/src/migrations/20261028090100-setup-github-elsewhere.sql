-- The manifest flow stops short when GitHub made the App on another account than the one chosen (ADR 0059): the
-- setup's refusal `elsewhere`, beside those its check named. SQLite can't change a check in place: the table is made
-- again, its row kept. The checks hold the values `SetupGitHub` and `SetupGitHubRefusal` name.
CREATE TABLE setup_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  step TEXT NOT NULL,
  reached TEXT NOT NULL,
  github TEXT NOT NULL
    CHECK (github IN ('start', 'waiting-for-app', 'waiting-for-install', 'nothing-granted', 'done')),
  github_refused TEXT
    CHECK (github_refused IS NULL OR github_refused IN ('unreachable', 'expired', 'refused', 'elsewhere')),
  first_review_change TEXT
);
INSERT INTO setup_next (id, done, step, reached, github, github_refused, first_review_change)
  SELECT id, done, step, reached, github, github_refused, first_review_change FROM setup;
DROP TABLE setup;
ALTER TABLE setup_next RENAME TO setup;
