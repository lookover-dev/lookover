-- A job asked for as a preview (ADR 0047): the first review, "preview here only", whose run posts nothing; kept
-- with the job, as its trigger is, and read by the take, which mints the run from it. And the engine the owner sent
-- a waiting job to (`engine.reroute`): the finder the round plan takes, kept until the job ends; null for none.
ALTER TABLE jobs ADD COLUMN preview INTEGER NOT NULL DEFAULT 0 CHECK (preview IN (0, 1));
ALTER TABLE jobs ADD COLUMN reroute TEXT;
