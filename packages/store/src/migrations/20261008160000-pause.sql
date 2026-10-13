-- The pause (ADR 0040): at most one row, there while reviews are paused. Since when, and until when (null: until
-- the owner resumes).
CREATE TABLE pause (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  since INTEGER NOT NULL,
  until INTEGER
);
