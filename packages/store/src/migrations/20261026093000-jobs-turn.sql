-- What a queued job waits behind (ADR 0055): contracts' `Turn` as JSON, set only while the job is queued, written only
-- when it changes, so that a move is one `job.changed` and the same turn none.
ALTER TABLE jobs ADD COLUMN turn TEXT CHECK (turn IS NULL OR (state = 'queued' AND json_valid(turn)));
