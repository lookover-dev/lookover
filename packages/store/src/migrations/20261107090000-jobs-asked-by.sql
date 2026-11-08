-- Who wrote the review request comment that asked for a job, or the first that joined it (ADR 0081): `agent`, one
-- with the marker `lookover wait` writes; `person`, the command by hand; null when no request did.
ALTER TABLE jobs ADD COLUMN asked_by TEXT CHECK (asked_by IS NULL OR asked_by IN ('agent', 'person'));
