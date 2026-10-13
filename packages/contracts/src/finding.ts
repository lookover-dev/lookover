// A finding a review raised, and the reviewer's verdict on it (ADR 0025, ADR 0030); who found it, what the confirm
// pass said of it and the text of its line (ADR 0044); its author's newest claim and how often a round kept it
// against one (ADR 0052).
import type { FindingClaim } from "./claim.ts";
import type { Confirmation } from "./confirm.ts";
import type { Anchoring, DiffSide } from "./diff.ts";
import type { EngineId } from "./engine.ts";
import type { CommitSha, FindingId } from "./ids.ts";
import type { CitedRule } from "./rule.ts";

export type Severity = "blocking" | "should_fix" | "consider";

/**
 * Set by the reviewer, except `dismissed`, which is the owner's. Only `open` and `escalated` are unsettled.
 * `escalated`: the author and the reviewer disagree, and only the owner can settle it.
 */
export type FindingStatus =
  | "open"
  | "escalated"
  | "verified_fixed"
  | "acknowledged"
  | "withdrawn"
  | "dismissed"
  | "obsolete";

/**
 * Both fingerprints of ADR 0032, computed by `review`: where a finding is, and what it says. `core` keeps a
 * finding's identity across rounds through them (`core.sameFinding`, ADR 0044): the location hashes the line's
 * text when the finder copied it, else the line's number, which only the meaning stands in for.
 */
export interface Fingerprints {
  location: string;
  meaning: string;
}

/**
 * A category or a kind key as the fingerprints and `core`'s identity compare it, case and spacing aside:
 * `Data Safety` is `data_safety`. Written once: `review` hashes it, `core` compares two of one round by it.
 */
export function fingerprintWord(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "_");
}

export interface Finding {
  /** `F1`, `F2`…: given by `core` in the order findings are raised on the change, never reused (ADR 0032). */
  id: FindingId;
  fingerprints: Fingerprints;
  severity: Severity;
  category: string;
  title: string;
  /** Where the problem is, as `review` anchored it: the path on `side` (the old path on `base`). */
  file: string;
  /** `head`: a line of the new text; `base`: a removed line of the old one. */
  side: DiffSide;
  /** 1-based, on `side`'s file; the first line of the range when there is one. */
  line: number;
  /** The range's last line, on the same side; null when the finding is on one line. */
  endLine: number | null;
  /**
   * The text of `line` as the finder copied it, and as `review` re-anchored the finding to it (ADR 0044, I-158):
   * the location fingerprint hashes it. Null when the finder gave none (a review before `line_text`).
   */
  lineText: string | null;
  /** How `review` anchored it by `lineText`: `unmatched` goes to the summary. `reported` for a finding without text. */
  anchoring: Anchoring;
  body: string;
  /** The engine whose find pass proposed it (ADR 0044): the round's finder, or either one in a Deep round. */
  foundBy: EngineId;
  /** What the confirm pass said of it, set when it is raised (ADR 0044): `NOT_CHECKED` with no confirm. */
  confirmation: Confirmation;
  /** `ruleText`: the cited rule's text (`rule` says which), as the snapshot shows why it was raised; null when it cites none. */
  why: { ruleText: string | null };
  /** The repository's rule it follows (ADR 0048); null when it cites none. */
  rule: CitedRule | null;
  snippet: { start: number; lines: string[]; mark: number } | null;
  fix: { del: string; add: string } | null;
  status: FindingStatus;
  /**
   * False when strictness or the later-round rule (no new Consider from round 2) kept it off the pull request
   * (ADR 0025, ADR 0042): it stays in the app and in the result, marked as not posted, and is not in the
   * check's count (I-152, ADR 0039).
   */
  posted: boolean;
  /**
   * Whether the review that posted it holds an inline comment on it (#67): false while it is not posted, and when it
   * went into the summary instead (outside the diff, past the review's most comments, or refused by the host). Set
   * when that review lands; a later round lists a finding with no comment in the summary, never as commented.
   */
  commented: boolean;
  raisedIn: number;
  /**
   * The round whose commit `file`, `line`, `endLine` and `lineText` are on: `raisedIn`, until a later round
   * reports the finding again with its line's text and `core` moves it there (ADR 0044).
   */
  anchoredIn: number;
  /** The round that settled it. */
  closedIn: number | null;
  /** The commit on which the reviewer found it gone, once `verified_fixed`. */
  verifiedSha: CommitSha | null;
  /** Why it was settled, in a sentence, for every other settled status. */
  closedWhy: string | null;
  /** The newest claim a round read on its thread (ADR 0052); null when its author never claimed anything. */
  claim: FindingClaim | null;
  /**
   * How many times a round kept it against its author's claim (ADR 0052): apart from `claim`, so the count survives
   * a newer claim and the rounds; the second time escalates it.
   */
  kept: number;
}

/** Open or escalated: a finding the loop has not settled yet. Part of the vocabulary's definition. */
export function isUnsettled(finding: Pick<Finding, "status">): boolean {
  return finding.status === "open" || finding.status === "escalated";
}

/**
 * Unsettled and posted: a finding that counts on the pull request. Only these decide the loop state and the
 * check's count (I-152, ADR 0039); one kept off the pull request never keeps a review from settling.
 */
export function isCounted(finding: Finding): boolean {
  return isUnsettled(finding) && finding.posted;
}

const RANK: Record<Severity, number> = { blocking: 0, should_fix: 1, consider: 2 };

/**
 * The order findings are listed in, wherever they are listed, on the pull request and in the app: blocking, should
 * fix, consider, the given order within a severity (a stable sort). A reader, person or agent, meets what matters
 * most first.
 */
export function bySeverity<T>(items: T[], severity: (item: T) => Severity): T[] {
  return [...items].sort((a, b) => RANK[severity(a)] - RANK[severity(b)]);
}
