-- The setup (ADR 0047): how far the owner got, as the snapshot's base reads it and the setup commands write it.
-- One row at most, written whole; none until the first write, which is the first step. The furthest step reached
-- is kept beside the step the owner is on: going back never loses the way forward.
CREATE TABLE setup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  step TEXT NOT NULL,
  reached TEXT NOT NULL,
  bot_created INTEGER NOT NULL CHECK (bot_created IN (0, 1)),
  waiting_for_install INTEGER NOT NULL CHECK (waiting_for_install IN (0, 1)),
  first_review_change TEXT
);
