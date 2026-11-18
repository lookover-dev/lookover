-- Lookover in the tray (ADR 0105 §11): the owner's choice, the machine's and no review setting, kept beside the setup
-- as start at login is. One row at most; none until the owner first chooses, which is on.
CREATE TABLE tray (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);
