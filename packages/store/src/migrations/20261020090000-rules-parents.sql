-- The rules each rule is nested in, by id, outermost first, as a JSON array (ADR 0049): a rule switched off takes the
-- rules nested in it with it.
ALTER TABLE rules ADD COLUMN parent_ids TEXT NOT NULL DEFAULT '[]';
