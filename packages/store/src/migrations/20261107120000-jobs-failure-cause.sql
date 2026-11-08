-- What a failed job's failure came from, finer than its kind (ADR 0081), and the time limit that ran out, in ms, as it
-- was configured; both null when not known, or when the job didn't fail.
ALTER TABLE jobs ADD COLUMN failure_cause TEXT CHECK (failure_cause IS NULL OR failure_cause IN (
  'git_silent', 'git_time_limit', 'engine_time_limit', 'base_not_found', 'path_too_long', 'git_missing', 'network',
  'engine_answer'
));
ALTER TABLE jobs ADD COLUMN failure_limit_ms INTEGER;
