-- Why a job held on a missing engine waits though its program was found (contracts' `EngineUnusable` as JSON: a
-- Codex too old for its model), so its check says so; set only with an `engine-missing` deferral.
ALTER TABLE jobs ADD COLUMN deferral_unusable TEXT
  CHECK (deferral_unusable IS NULL OR (deferral_reason = 'engine-missing' AND json_valid(deferral_unusable)));
