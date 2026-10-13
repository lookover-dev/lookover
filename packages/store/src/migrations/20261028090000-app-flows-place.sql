-- Where "Create it on GitHub" makes the App (ADR 0059): your own account, or an organisation the person's `gh` listed
-- as theirs to admin, with that person. The place chosen last is kept on its own (one row at most: none is your own
-- account); each flow keeps the place its page was opened for, so GitHub's redirect back keeps the App there with
-- that person. No migration path before 1.0 (AGENTS.md rule 10): the flows kept are dropped, and a page opened before
-- is opened again.
DROP TABLE app_flows;
CREATE TABLE app_flows (
  state_hash TEXT PRIMARY KEY,
  opened_at INTEGER NOT NULL,
  organisation_id INTEGER,
  organisation_login TEXT,
  person_id INTEGER,
  person_login TEXT,
  CHECK (
    (organisation_id IS NULL AND organisation_login IS NULL AND person_id IS NULL AND person_login IS NULL)
    OR (organisation_id IS NOT NULL AND organisation_login IS NOT NULL AND person_id IS NOT NULL
      AND person_login IS NOT NULL)
  )
);
-- A row with no organisation is nowhere: the last choice wasn't taken (refused, or its `gh` read never finished), and
-- no flow opens until another is made.
CREATE TABLE app_place (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  organisation_id INTEGER,
  organisation_login TEXT,
  person_id INTEGER,
  person_login TEXT,
  CHECK (
    (organisation_id IS NULL AND organisation_login IS NULL AND person_id IS NULL AND person_login IS NULL)
    OR (organisation_id IS NOT NULL AND organisation_login IS NOT NULL AND person_id IS NOT NULL
      AND person_login IS NOT NULL)
  )
);
