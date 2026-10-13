-- A run holds its confirmer too (ADR 0044): the engine planned to confirm the round's new candidates, held busy with
-- the finder until the round is saved, so one engine is never in two runs at once. Null when the run confirms
-- nothing.
ALTER TABLE runs ADD COLUMN confirmer TEXT;
