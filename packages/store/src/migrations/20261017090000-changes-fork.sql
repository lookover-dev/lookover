-- Whether an open change is a fork's (ADR 0048): its head repository isn't its base's, or is gone, as the host's
-- adapter decides it. Kept with each listing; what intake and the round plan read of it.
ALTER TABLE changes ADD COLUMN fork INTEGER NOT NULL DEFAULT 0 CHECK (fork IN (0, 1));
