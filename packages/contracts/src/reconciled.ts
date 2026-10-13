// One round reconciled (ADR 0006, ADR 0029, ADR 0039): what `core.reconcile` decided for the round, read as it
// is by `publish` (which renders and posts it) and by the service (which records it). Every
// loop rule is `core`'s: no reader recomputes a field from the findings.
import type { Finding, FindingStatus, Severity } from "./finding.ts";
import type { RoundConclusion } from "./host-writer.ts";
import type { FindingId } from "./ids.ts";
import type { LoopState } from "./loop.ts";

/**
 * Where the change stands, over the findings that count on the pull request (I-152): `clean`, none counts;
 * `pass`, some count and none is blocking; `blocking`, one counting is blocking. The result's verdict adds
 * `none`, which says there is no done round: a reconciled round is one.
 */
export type Verdict = "clean" | "pass" | "blocking";

/**
 * What the coding agent does next, by the loop: fix what is open, ask the owner, or stop. The result's
 * `next_action` adds `reply` and `wait`, which wait for the phase that reads the threads.
 */
export type NextAction = "fix" | "ask_human" | "stop";

/**
 * Who must act on a finding: the agent on one open on the pull request, the owner (`human`) on one escalated,
 * nobody on any other (settled, or kept off the pull request). The result's `needs_action_by` adds
 * `reviewer`, which no round asks for before the reviewer reads the threads.
 */
export type ActionBy = "agent" | "human" | "none";

/** Over the posted findings only (ADR 0039): the open ones by severity, every other status by itself. */
export type FindingCounts = { open: Record<Severity, number> } & Record<
  Exclude<FindingStatus, "open">,
  number
>;

export interface Reconciled {
  /** The ledger after the round: every finding the change has, with its status. */
  findings: Finding[];
  /** What this round raised, posted or not. */
  raised: Finding[];
  /** What to post this round: the raised findings that go on the pull request. */
  post: Finding[];
  loop: LoopState;
  verdict: Verdict;
  nextAction: NextAction;
  /** Who must act on each finding: one entry per finding of `findings`, in the same order. */
  actionBy: { id: FindingId; by: ActionBy }[];
  /** The check's conclusion (ADR 0006): `success` with no open blocking finding, `neutral` otherwise. */
  conclusion: RoundConclusion;
  /** The check's count: the findings open on the pull request (I-152). */
  open: number;
  /**
   * The findings kept in the app (ADR 0042): unsettled and not on the pull request, by strictness or the
   * later-round rule (Consider). They never hold the loop open, but the pull request says how many there are.
   */
  keptInApp: number;
  counts: FindingCounts;
  /** How many findings this round verified fixed. */
  verifiedFixed: number;
  /** What Lookover says on the findings' threads this round (ADR 0052), in the order of `findings`. */
  replies: ThreadReply[];
}

/**
 * Why Lookover answers on a finding's thread (ADR 0052): it kept the finding against its author's claim, withdrew
 * it, escalated it to the owner, answered a question, or the owner dismissed it. Only a conversation is answered:
 * never a finding verified fixed or acknowledged, which the summary says.
 */
export type ReplyKind = "kept" | "withdrawn" | "escalated" | "answered" | "dismissed";

/** One reply on a finding's thread: its kind, and the reason in the finder's (or the owner's) words. */
export interface ThreadReply {
  findingId: FindingId;
  kind: ReplyKind;
  why: string;
}
