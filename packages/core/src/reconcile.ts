// One round against the ledger (ADR 0006, ADR 0025, ADR 0029, ADR 0032, ADR 0039): what a round outcome does
// to a change's findings, where the loop then stands, what the check concludes and what goes on the pull
// request. The ledger is the change's findings so far; the round outcome is what `review` found.
import {
  type CandidateFinding,
  type ClaimKind,
  type EarlierVerdict,
  type Finding,
  type FindingId,
  findingId,
  isUnsettled,
  NOT_CHECKED,
  type Reconciled,
  type RoundOutcome,
  type Rule,
  type SettingValues,
  type Severity,
  type Strictness,
  type ThreadReply,
} from "@lookover/contracts";
import { distinct, pairUp } from "./identity.ts";
import { standingOf } from "./loop.ts";
import type { ThreadReading } from "./threads.ts";

/**
 * A candidate as the review gives it, with its `confirmation` once the confirm policy gave it one (ADR 0044;
 * `NOT_CHECKED` without). The rule it follows (ADR 0048) is the candidate's: a switched-off rule drops it; a
 * candidate parsed without the field cites none, as with null. What else the app shows (why, the snippet, the fix, the
 * "Too noisy?" numbers) is raised at its default.
 */
export type ReconcileCandidate = CandidateFinding & Partial<Pick<Finding, "confirmation">>;

/** The part of the round outcome `reconcile` reads; the review's whole `RoundOutcome` fits. */
export type RoundOutcomeInput = Pick<RoundOutcome, "sha" | "earlier"> & { candidates: ReconcileCandidate[] };

export interface ReconcileInput {
  /** The round being reconciled, numbered per change from 1. */
  round: number;
  settings: Pick<SettingValues, "strictness">;
  /** The repository's rules: a switched-off one drops the candidates citing it; a finding raised citing one has its text as its why. */
  rules: Pick<Rule, "id" | "enabled" | "text">[];
  /** The claims read on the findings' threads before the round (`readThreads`): the round answers them. */
  threads?: ThreadReading;
  /**
   * The ledger's findings an earlier round raised to post whose review never landed (GitHub refused it until the
   * posts were given up, ADR 0044): each one still open is posted by this round, and counts.
   */
  withheld?: FindingId[];
  /** The owner asked `/lookover review full` (ADR 0052): the round posts as a first round would. */
  full?: boolean;
}

/** Strictness is a posting filter (ADR 0025): it never changes what is found, only what becomes a comment. */
const POSTED: Record<Strictness, Severity[]> = {
  recommended: ["blocking", "should_fix"],
  blocking: ["blocking"],
  everything: ["blocking", "should_fix", "consider"],
};

const NO_THREADS: ThreadReading = { claims: [] };

/** The next `F<n>`: one past the highest the ledger holds, so an id is never reused even if a finding is dropped. */
function nextRank(prior: Finding[]): number {
  return 1 + Math.max(0, ...prior.map((f) => Number(/^F(\d+)$/.exec(f.id)?.[1] ?? 0)));
}

/**
 * The finding a raised candidate becomes: the review's facts, its rule's text (`why`) when it cites one of `rules`,
 * the app's fields at their defaults.
 */
function raise(
  c: ReconcileCandidate,
  id: FindingId,
  posted: boolean,
  round: number,
  rules: ReconcileInput["rules"],
): Finding {
  return {
    id,
    fingerprints: c.fingerprints,
    severity: c.severity,
    category: c.category,
    title: c.title,
    file: c.location.path,
    side: c.location.side,
    line: c.location.line,
    endLine: c.location.endLine,
    lineText: c.lineText,
    anchoring: c.anchoring,
    body: c.body,
    foundBy: c.foundBy,
    confirmation: c.confirmation ?? NOT_CHECKED,
    why: { ruleText: rules.find((r) => r.id === c.rule?.id)?.text ?? null },
    rule: c.rule ?? null,
    snippet: null,
    fix: null,
    status: "open",
    posted,
    commented: false,
    raisedIn: round,
    anchoredIn: round,
    closedIn: null,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
  };
}

/** What the round's check said of an earlier finding: `present` when a candidate reports it again. */
type Said = EarlierVerdict["verdict"];

/** What a round does with a claim (ADR 0052), besides a finding verified fixed; `unread`: not answered yet. */
type Answer = "unread" | "kept" | "withdrawn" | "escalated" | "answered" | "acknowledged";

/** An answer on a blocking finding, and on any other. */
interface BySeverity {
  blocking: Answer;
  other: Answer;
}

/** The same answer whatever the finding's severity. */
const either = (answer: Answer): BySeverity => ({ blocking: answer, other: answer });

/** The author's call on a non-blocking finding, whatever the check said; kept on a blocking one still seen. */
const AUTHORS_CALL: Record<Exclude<Said, "gone">, BySeverity> = {
  present: { blocking: "kept", other: "acknowledged" },
  wrong: { blocking: "unread", other: "acknowledged" },
  unknown: { blocking: "unread", other: "acknowledged" },
};

/**
 * A claim's answer (ADR 0052), by its kind and what the check said, on a blocking finding and on any other. Only a
 * dispute takes `wrong`: on any other claim it says nothing, as `unknown`. A dispute the finder rejects (`present`) is
 * as won't fix. A claim the finder must weigh in on stays unread while it said nothing, so the next round reads it
 * again.
 */
const ANSWERS: Record<ClaimKind, Record<Exclude<Said, "gone">, BySeverity>> = {
  claimed_fixed: { present: either("kept"), wrong: either("unread"), unknown: either("unread") },
  disputed: {
    present: { blocking: "kept", other: "acknowledged" },
    wrong: { blocking: "escalated", other: "withdrawn" },
    unknown: either("unread"),
  },
  wont_fix: AUTHORS_CALL,
  deferred: AUTHORS_CALL,
  question: { present: either("answered"), wrong: either("unread"), unknown: either("unread") },
};

/**
 * What the check said of an earlier finding: `present` when a candidate reports it again, whatever its verdict, but
 * for a dispute the finder answers `wrong`: the verdict answers the dispute, the report only says the line is still
 * there.
 */
function saidOf(verdict: Said | undefined, reportedAgain: boolean, claim: ClaimKind | undefined): Said {
  if (claim === "disputed" && verdict === "wrong") return "wrong";
  if (reportedAgain) return "present";
  return verdict ?? "unknown";
}

/** An earlier finding after the round, and what Lookover says on its thread (null: nothing). */
interface Settled {
  finding: Finding;
  reply: ThreadReply | null;
}

/** A finding reported again with its line's text, `again`, takes that line, range and text (ADR 0044). */
function movedBy(finding: Finding, again: CandidateFinding | undefined, round: number): Finding {
  if (again?.lineText == null) return finding;
  return {
    ...finding,
    file: again.location.path,
    side: again.location.side,
    line: again.location.line,
    endLine: again.location.endLine,
    lineText: again.lineText,
    anchoring: again.anchoring,
    // The location hashes the line's text: it follows the text taken, the meaning stays the finding's.
    fingerprints: { ...finding.fingerprints, location: again.fingerprints.location },
    // Lines of this round's commit now.
    anchoredIn: round,
  };
}

/**
 * An earlier finding after the round. Settled findings never change again. `again`: the candidate that reports it
 * again, so it is present whatever the verdict says; it is never verified fixed while the reviewer still sees it.
 * With its line's text, that candidate says where the finding is now: its line, range and text are taken (ADR 0044).
 * Gone, it is verified fixed, whatever its claim. Otherwise the claim read on its thread is answered (`ANSWERS`):
 * kept counts one more keep, and the second escalates it; withdrawn and escalated take the finder's why, as every reply
 * does (else the body it reported again, else the finding's); acknowledged takes the author's reply as why it settled. An answered claim is stored on the finding (`claim`), the one place its text lives.
 */
function settle(
  finding: Finding,
  again: CandidateFinding | undefined,
  outcome: RoundOutcomeInput,
  threads: ThreadReading,
  round: number,
): Settled {
  if (!isUnsettled(finding)) return { finding, reply: null };
  const verdict = outcome.earlier.find((v) => v.id === finding.id);
  const read = threads.claims.find((c) => c.findingId === finding.id);
  const said = saidOf(verdict?.verdict, again !== undefined, read?.kind);
  // Never an empty reason: the finder's, else what it reported again this round, else the finding's own.
  const why =
    [verdict?.why, again?.body, finding.body].map((t) => t?.trim() ?? "").find((t) => t !== "") ?? "";
  const base = movedBy(finding, again, round);
  const answered: Finding = read
    ? {
        ...base,
        claim: { kind: read.kind, text: read.text, by: read.by, at: read.at, commentId: read.commentId },
      }
    : base;
  if (said === "gone") {
    return {
      finding: { ...answered, status: "verified_fixed", closedIn: round, verifiedSha: outcome.sha },
      reply: null,
    };
  }
  if (!read) return { finding: base, reply: null };
  const reply = (kind: ThreadReply["kind"]): ThreadReply => ({ findingId: finding.id, kind, why });
  switch (ANSWERS[read.kind][said][finding.severity === "blocking" ? "blocking" : "other"]) {
    case "unread":
      return { finding: base, reply: null };
    case "answered":
      return { finding: answered, reply: reply("answered") };
    case "acknowledged":
      return {
        finding: { ...answered, status: "acknowledged", closedIn: round, closedWhy: read.text },
        reply: null,
      };
    case "withdrawn":
      return {
        finding: { ...answered, status: "withdrawn", closedIn: round, closedWhy: why },
        reply: reply("withdrawn"),
      };
    case "escalated":
      return { finding: { ...answered, status: "escalated" }, reply: reply("escalated") };
    case "kept": {
      const kept = finding.kept + 1;
      // The second keep escalates; one already escalated stays so, and is told it is kept.
      const escalates = kept >= 2 && finding.status !== "escalated";
      return {
        finding: { ...answered, kept, ...(kept >= 2 ? { status: "escalated" as const } : {}) },
        reply: reply(escalates ? "escalated" : "kept"),
      };
    }
  }
}

/**
 * A round's candidates as they meet the ledger `prior`: a switched-off rule drops a candidate, which counts for
 * nothing; the rest, each finding once, are paired one to one with the ledger (`identity.ts`).
 * `paired[i]` is the index in `prior` of the finding `candidates[i]` reports again, undefined for a new one.
 * `reconcile` raises the new ones; `toConfirm` sends them to the confirm pass first.
 */
export function meet<C extends ReconcileCandidate>(
  prior: Finding[],
  all: C[],
  input: Pick<ReconcileInput, "rules">,
): { candidates: C[]; paired: (number | undefined)[] } {
  const off = new Set(input.rules.filter((r) => !r.enabled).map((r) => r.id));
  const wanted = (c: C) => {
    const rule = c.rule ?? null;
    return rule === null || !off.has(rule.id);
  };
  const candidates = distinct(all.filter(wanted));
  return { candidates, paired: pairUp(prior, candidates) };
}

/**
 * Round `input.round` against the ledger `prior`. A switched-off rule drops a candidate; the rest are taken
 * each finding once and paired one to one with the ledger (`identity.ts`). A candidate that is one
 * of the ledger's findings is never raised again, settled or not. The others are raised in order and numbered
 * `F<n>` after the ledger's last, never reused. Strictness decides what is posted; from round 2 a new Consider is
 * not, unless `input.full`. A finding an earlier round withheld (`input.withheld`: its review never landed) is
 * posted by this one while it is still open. The round's verdicts and the threads' claims settle what is
 * unsettled (`settle`); `replies` says what Lookover answers on the threads, in the ledger's order. The loop, the
 * check's conclusion and its count read only posted findings (I-152).
 */
export function reconcile(prior: Finding[], outcome: RoundOutcomeInput, input: ReconcileInput): Reconciled {
  const threads = input.threads ?? NO_THREADS;
  // From round 2 a new Consider is never posted (ADR 0042): the loop quiets down instead of finding something
  // new to polish each time, while a real problem found late still reaches the agent.
  const posts = (severity: Severity) =>
    POSTED[input.settings.strictness].includes(severity) &&
    (input.round <= 1 || input.full === true || severity !== "consider");
  const { candidates, paired } = meet(prior, outcome.candidates, input);
  const again = (f: number) => candidates[paired.indexOf(f)];
  const withheld = new Set(input.withheld ?? []);
  // A withheld finding still open goes on the pull request now; one settled before it got there stays off it.
  const owed = (f: Finding) => !f.posted && f.status === "open" && withheld.has(f.id);
  const after = prior.map((f, i) => settle(f, again(i), outcome, threads, input.round));
  const settled = after.map(({ finding: f }) => (owed(f) ? { ...f, posted: true } : f));
  const reposted = settled.filter((f, i) => f.posted && prior[i]?.posted === false);
  const raised = candidates
    .filter((_, i) => paired[i] === undefined)
    .map((c, i) =>
      raise(c, findingId(`F${nextRank(prior) + i}`), posts(c.severity), input.round, input.rules),
    );
  return {
    ...standingOf([...settled, ...raised]),
    raised,
    post: [...reposted, ...raised.filter((f) => f.posted)],
    verifiedFixed: settled.filter((f) => f.status === "verified_fixed" && f.closedIn === input.round).length,
    replies: after.flatMap(({ reply }) => (reply ? [reply] : [])),
  };
}
