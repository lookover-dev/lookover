-- Start at login (ADR 0049): the owner's choice, the machine's and no review setting, kept beside the setup. One
-- row at most; none until the owner first chooses, which is on (ADR 0054). Apart from the setup's row, so choosing
-- it never makes a data folder's setup kept.
CREATE TABLE start_at_login (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);
