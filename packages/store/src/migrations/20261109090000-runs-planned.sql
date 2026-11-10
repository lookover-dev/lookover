-- The rest of a run's plan (ADR 0044): Deep's second finder, and why the confirmer is the finder (JSON), each null
-- when none. With them the record gives back the run a stopped service left running as the UI was shown it, for a
-- review rebuilt at start (ADR 0085). A run recorded before keeps both null.
ALTER TABLE runs ADD COLUMN second_finder TEXT;
ALTER TABLE runs ADD COLUMN confirm_fallback TEXT;
