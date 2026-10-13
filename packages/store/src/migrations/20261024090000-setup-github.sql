-- The setup's GitHub step (ADR 0053): where it is (start, waiting for the App, waiting for the install, nothing
-- granted, done) and why the manifest flow stopped short, in place of "bot created" and "waiting for install". No
-- migration path before 1.0 (AGENTS.md rule 10): the setup kept is dropped, and a data folder starts it again.
-- The checks hold the values `SetupGitHub` and `SetupGitHubRefusal` name.
DROP TABLE setup;
CREATE TABLE setup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  step TEXT NOT NULL,
  reached TEXT NOT NULL,
  github TEXT NOT NULL
    CHECK (github IN ('start', 'waiting-for-app', 'waiting-for-install', 'nothing-granted', 'done')),
  github_refused TEXT CHECK (github_refused IS NULL OR github_refused IN ('unreachable', 'expired', 'refused')),
  first_review_change TEXT
);
