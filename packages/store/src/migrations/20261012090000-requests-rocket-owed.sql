-- A request's rocket reaction is owed once its job's round is posted, recorded as such with the run's end (ADR
-- 0043), not read from the job's state: a round posted whose end could only be recorded as a failure still earns
-- it. The rocket column: 0 waits for the round, 1 sent, 2 never (its job ended without a round), 3 owed.
DROP INDEX comments_unreacted;
-- The reactions still to send are read at every poll: a year of answered requests is not read through.
CREATE INDEX comments_unreacted ON comments (job_id) WHERE job_id IS NOT NULL AND (eyes = 0 OR rocket = 3);
