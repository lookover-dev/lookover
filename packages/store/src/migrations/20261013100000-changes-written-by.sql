-- Who wrote an open change (ADR 0044): the engine whose coding agent wrote it, read by the service from its commits'
-- trailers and its branch, kept so a push whose commits say nothing keeps it; null when unknown. `writer_sha` is the
-- head commit it was read through: null until a read succeeds, so a change whose read failed is read again.
ALTER TABLE changes ADD COLUMN written_by TEXT;
ALTER TABLE changes ADD COLUMN writer_sha TEXT;
