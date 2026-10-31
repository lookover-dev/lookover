-- A change is named by its repository's owner and name, `<owner>/<name>#<n>` (ADR 0066), so two repositories of one
-- name on two accounts are two. A data folder from before named it `<name>#<n>`, and its repositories had one name
-- each: the owner of every id is the one `repositories` keeps for its name, prefixed to the jobs', rounds', plans' and
-- dismissals' ids and to the setup's first review, so its history stays its own and an open pull request reviewed
-- already isn't reviewed again. An id holding a slash is already of the new shape; one whose name the store keeps no
-- repository of stays as it was. A waiting job's turn names the changes it waits behind: it is said again by the
-- next take, in the new ids. The events are history, kept as written.
--
-- Each subquery finds one row: before ADR 0066 the room refused a second repository of a name it watched already, so
-- a name is unique in `repositories`. `LIMIT 1` keeps the subquery to one value all the same.
UPDATE jobs SET change_id = (
  SELECT r.owner || '/' || jobs.change_id FROM repositories r
  WHERE substr(jobs.change_id, 1, length(r.name) + 1) = r.name || '#' LIMIT 1
)
WHERE instr(change_id, '/') = 0 AND EXISTS (
  SELECT 1 FROM repositories r WHERE substr(jobs.change_id, 1, length(r.name) + 1) = r.name || '#'
);
UPDATE jobs SET turn = NULL WHERE turn IS NOT NULL;
UPDATE rounds SET change_id = (
  SELECT r.owner || '/' || rounds.change_id FROM repositories r
  WHERE substr(rounds.change_id, 1, length(r.name) + 1) = r.name || '#' LIMIT 1
)
WHERE instr(change_id, '/') = 0 AND EXISTS (
  SELECT 1 FROM repositories r WHERE substr(rounds.change_id, 1, length(r.name) + 1) = r.name || '#'
);
UPDATE plans SET change_id = (
  SELECT r.owner || '/' || plans.change_id FROM repositories r
  WHERE substr(plans.change_id, 1, length(r.name) + 1) = r.name || '#' LIMIT 1
)
WHERE instr(change_id, '/') = 0 AND EXISTS (
  SELECT 1 FROM repositories r WHERE substr(plans.change_id, 1, length(r.name) + 1) = r.name || '#'
);
UPDATE dismissals SET change_id = (
  SELECT r.owner || '/' || dismissals.change_id FROM repositories r
  WHERE substr(dismissals.change_id, 1, length(r.name) + 1) = r.name || '#' LIMIT 1
)
WHERE instr(change_id, '/') = 0 AND EXISTS (
  SELECT 1 FROM repositories r WHERE substr(dismissals.change_id, 1, length(r.name) + 1) = r.name || '#'
);
UPDATE setup SET first_review_change = (
  SELECT r.owner || '/' || setup.first_review_change FROM repositories r
  WHERE substr(setup.first_review_change, 1, length(r.name) + 1) = r.name || '#' LIMIT 1
)
WHERE instr(first_review_change, '/') = 0 AND EXISTS (
  SELECT 1 FROM repositories r WHERE substr(setup.first_review_change, 1, length(r.name) + 1) = r.name || '#'
);
