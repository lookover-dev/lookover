-- The person the setup belongs to (ADR 0090): the GitHub id of the first person signed in on it, so another person's
-- sign-in makes the choice of repositories again. Null on a setup kept before this, or before anybody signed in:
-- the first person seen signed in is then recorded, with no reset. Kept beside the setup, never part of it: the
-- setup's writes leave it as it is.
ALTER TABLE setup ADD COLUMN person_id INTEGER;
