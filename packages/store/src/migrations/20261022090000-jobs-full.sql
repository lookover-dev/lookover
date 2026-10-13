-- A job asked for in full (ADR 0052): the owner's `/lookover review full`, whose round posts as a first round would,
-- new `consider` findings included. Kept with the job, as a preview is, sticking to the job it joins, and read by the
-- take, which gives it to the run it starts.
ALTER TABLE jobs ADD COLUMN full INTEGER NOT NULL DEFAULT 0 CHECK (full IN (0, 1));
