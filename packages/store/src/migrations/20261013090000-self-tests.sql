-- The engines' self-tests (ADR 0044): one row per engine, program and version tested, whether it passed. A
-- version that passed isn't tested again, a restart included; one tested again keeps its last result.
CREATE TABLE self_tests (
  engine TEXT NOT NULL,
  program TEXT NOT NULL,
  version TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  PRIMARY KEY (engine, program, version)
);
