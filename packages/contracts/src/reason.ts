// The owner's reason for a decision on a finding (ADR 0100, ADR 0101), as the service keeps it and `lookover settle`
// checks it before posting: one line, runs of white space (a pasted newline too) one space, none at the ends, empty
// taken for none, and at most `REASON_MAX` characters once so. Written once, so the two never disagree.

/** The longest reason the owner's decision keeps, in characters, once on one line (ADR 0100). */
export const REASON_MAX = 200;

/** A reason on one line (none: null), or too long, with its length on one line. */
export type OneLineReason = { reason: string | null } | { tooLong: number };

/** `typed` as the reason Lookover keeps: on one line, none when empty, too long past `REASON_MAX`. */
export function oneLineReason(typed: string | null): OneLineReason {
  const said = (typed ?? "").replace(/\s+/g, " ").trim();
  if (said.length > REASON_MAX) return { tooLong: said.length };
  return { reason: said === "" ? null : said };
}
