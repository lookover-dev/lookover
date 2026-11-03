-- One way in (ADR 0073): Lookover is on GitHub through the shared App alone, so the manifest flows, the place chosen
-- for an App and the flow's refusal go. The setup's GitHub step no longer waits for an App: a row left waiting for one
-- goes back to the step's start. SQLite can't change a check in place: the table is made again, its row kept. The
-- check holds the values `SetupGitHub` names.
DROP TABLE app_flows;
DROP TABLE app_place;
CREATE TABLE setup_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  step TEXT NOT NULL,
  reached TEXT NOT NULL,
  github TEXT NOT NULL CHECK (github IN ('start', 'waiting-for-install', 'nothing-granted', 'done')),
  first_review_change TEXT
);
INSERT INTO setup_next (id, done, step, reached, github, first_review_change)
  SELECT id, done, step, reached, CASE github WHEN 'waiting-for-app' THEN 'start' ELSE github END,
    first_review_change
  FROM setup;
DROP TABLE setup;
ALTER TABLE setup_next RENAME TO setup;
