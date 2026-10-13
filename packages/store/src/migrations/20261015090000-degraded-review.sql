-- A review GitHub refused for a comment it can't place is sent once more with every finding of the round in the
-- summary (ADR 0044). The round keeps that, so its summary and a restart say the same.
ALTER TABLE plans ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0;
