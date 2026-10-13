-- A repository's switch (ADR 0047): on unless the owner turned it off. Set from the setup's "choose repositories"
-- or the repository's page, before or after the inbox first lists the repository; so a row may hold a switch and no
-- listing yet, and whether the inbox has listed it is kept apart (the first listing says "new", once).
ALTER TABLE repositories ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
ALTER TABLE repositories ADD COLUMN listed INTEGER NOT NULL DEFAULT 1 CHECK (listed IN (0, 1));
