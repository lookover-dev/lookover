-- Whether the job was there when the sign-in changed (ADR 0090), finished or not: the switch settled everything it
-- owed the host, so nothing is written for it again, its check never reopened, resent or ended, its block never
-- written, whoever is signed in. Jobs asked after the switch start at 0.
ALTER TABLE jobs ADD COLUMN settled_by_sign_in INTEGER NOT NULL DEFAULT 0 CHECK (settled_by_sign_in IN (0, 1));
