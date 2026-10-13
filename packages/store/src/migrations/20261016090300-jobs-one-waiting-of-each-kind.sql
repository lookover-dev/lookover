-- At most one waiting job of each kind per change (#126 F8): a preview (ADR 0047) and a review that posts. A review
-- request comment is never held by a preview (the agent asked for a posted review, ADR 0043): beside the owner's
-- waiting preview it is a review of its own, which waits its turn behind it (the take starts one job per change).
DROP INDEX jobs_one_waiting;
CREATE UNIQUE INDEX jobs_one_waiting ON jobs (change_id, preview) WHERE state IN ('queued', 'deferred');
