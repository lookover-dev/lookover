-- The event log (ADR 0038): what the service sent the UI, numbered by the table, so numbers go on after a restart.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL
);
