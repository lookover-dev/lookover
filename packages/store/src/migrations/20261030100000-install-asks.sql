-- The accounts the person signed in to the shared App asked to install it on (ADR 0067: "Ask to install on <org>"),
-- and when: GitHub never says whether an owner saw the request, so Lookover keeps it to say "Waiting for an owner".
-- One row per account, by GitHub's id for it (a login can be renamed), with its login as last asked so it is shown when
-- nothing else names it, the person who asked beside it: forgotten once the account is reached, or once another person
-- signs in.
CREATE TABLE install_asks (
  account_id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  person_id INTEGER NOT NULL,
  asked_at INTEGER NOT NULL
);
