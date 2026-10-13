// A claim (ADR 0030, ADR 0052, glossary): what the change's author says about a finding. A claim never changes the
// finding's status by itself; the reviewer checks it at the next round. "Fixed" alone is never a claim: it is
// `claimed_fixed`, distinct from the reviewer's `verified_fixed`.
import type { FindingId } from "./ids.ts";

export type ClaimKind = "claimed_fixed" | "wont_fix" | "disputed" | "deferred" | "question";

export interface Claim {
  findingId: FindingId;
  kind: ClaimKind;
  /** The author's reply on the finding's thread, as the round read it. */
  text: string;
}

/**
 * The newest claim a round read on a finding's thread, as the finding carries it (ADR 0052): the reply that made
 * it, who wrote it (the owner or the change's author, by login) and when, as the host gave it (ISO 8601).
 */
export interface FindingClaim {
  kind: ClaimKind;
  text: string;
  by: string;
  at: string;
  /** The host's id of the reply: a claim already answered is not read twice. */
  commentId: number;
}
