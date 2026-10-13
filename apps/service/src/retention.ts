// How long the service keeps what it writes on disk (ADR 0056, exploration 09 SR-13): its log files and its run
// folders, both pruned once a day.

/** Files older than this many days are removed: log files, and run folders. */
export const KEPT_DAYS = 30;
/** A day, in milliseconds. */
export const DAY_MS = 86_400_000;
