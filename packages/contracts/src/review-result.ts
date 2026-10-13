// `lookover.review-result/v1` (ADR 0032): the public result of a review, at the end of the check's output, for
// coding agents and their helper. Spike 05's draft, updated for ADR 0029 (no round cap), ADR 0030 (seven
// statuses, `verified_fixed`, a claim is not a status, host-neutral words), ADR 0039 (only posted findings
// count: a `posted` flag per finding, and the counts over posted findings) and ADR 0044 (the round's confirmer,
// how many candidates it ruled out, each finding's confirmation: all required, AGENTS.md rule 10 reads no older
// result before 1.0). Frozen
// additive-only from the first real post: a new field is fine, a rename or a removal needs `v2`. The sets of
// values are closed too: a Zod enum reader rejects a value it doesn't know, so a new value is a `v2` as well,
// and every value an accepted decision already names is here now. A reader that meets an unknown value is reading a newer format and says
// so. Every value in the published format is snake_case: `run.trigger` is contracts' `Trigger` with
// `first-review` written `first_review`; the builder maps it. Parsed with Zod where it enters (a check read
// back); nothing inside re-checks it. Every enum is tied to the type contracts names it by (`enumOf`), so a
// value added to one and not the other fails the typecheck; the few sets no other type names are written here
// alone (`placement`, `confidence`). The counts' keys are tied to `Severity` and `FindingStatus` the same way.
import { z } from "zod";
import type { ClaimKind } from "./claim.ts";
import type { Confirmation } from "./confirm.ts";
import type { DiffSide } from "./diff.ts";
import type { EngineId } from "./engine.ts";
import { enumOf } from "./enum-of.ts";
import type { FindingStatus, Severity } from "./finding.ts";
import { RESULT_MARKER, REVIEW_RESULT_SCHEMA } from "./frozen.ts";
import type { GitHost } from "./host.ts";
import type { CheckConclusion } from "./host-writer.ts";
import type { JobState, Trigger } from "./job.ts";
import type { LoopState } from "./loop.ts";
import type { ActionBy, NextAction, Verdict } from "./reconciled.ts";

/** A value in the published format's snake_case: `first-review` is `first_review`. */
type Snake<S extends string> = S extends `${infer Head}-${infer Tail}` ? `${Head}_${Snake<Tail>}` : S;

const sha = z.string().regex(/^[0-9a-f]{7,40}$/);
const count = z.int().min(0);
const datetime = z.iso.datetime();

const severity = enumOf<Severity>()(["blocking", "should_fix", "consider"]);
const findingStatus = enumOf<FindingStatus>()([
  "open",
  "escalated",
  "verified_fixed",
  "acknowledged",
  "withdrawn",
  "dismissed",
  "obsolete",
]);
/** The review job's state, contracts' `JobState` (ADR 0029): `done` once the round is posted. */
const runState = enumOf<JobState>()([
  "queued",
  "deferred",
  "running",
  "done",
  "skipped",
  "cancelled",
  "failed",
]);
/** Contracts' `Trigger`, in snake_case. */
const trigger = enumOf<Snake<Trigger>>()(["opened", "push", "comment", "manual", "first_review"]);
const loopState = enumOf<LoopState>()(["open", "needs_owner", "settled"]);
/** Contracts' `Verdict` of a reconciled round, or `none`: no done round. */
const verdict = enumOf<Verdict | "none">()(["clean", "pass", "blocking", "none"]);
/**
 * What the check concluded: `success` with no open blocking finding, `neutral` otherwise and for a review that
 * failed, `skipped` for a job that ended without a round for another reason (a newer commit or a newer review took
 * its place, the change closed, a skip rule; ADR 0043). `failure` stays for a gate mode Lookover doesn't have, and
 * `cancelled` is never posted (ADR 0006's table predates ADR 0043). Never `failure` for Lookover's own error.
 */
const conclusion = enumOf<CheckConclusion | "failure" | "skipped" | "cancelled">()([
  "success",
  "neutral",
  "failure",
  "skipped",
  "cancelled",
]);
/**
 * Contracts' `NextAction`, or `reply`, which waits for the phase that reads the threads, and `wait`: no round came,
 * and a newer review of the change took this one's place (ADR 0043).
 */
const nextAction = enumOf<NextAction | "reply" | "wait">()(["fix", "reply", "wait", "stop", "ask_human"]);
const claimKind = enumOf<ClaimKind>()(["claimed_fixed", "wont_fix", "disputed", "deferred", "question"]);
/** Why a finding was settled (its status but `open`), or `kept`: the reviewer kept it open after a claim. */
const resolutionKind = enumOf<Exclude<FindingStatus, "open"> | "kept">()([
  "verified_fixed",
  "withdrawn",
  "acknowledged",
  "kept",
  "escalated",
  "obsolete",
  "dismissed",
]);
const placement = z.enum(["inline", "summary", "check_only"]);
const engine = enumOf<EngineId>()(["claude", "codex"]);

/**
 * Contracts' `Confirmation` (ADR 0044), as written: `confirmed` and `unsure` name the confirmer (`by`), its reason
 * and the lines it cites; `not_checked`, no confirm judged it; `demoted`, a finding lowered from `blocking` to
 * `should_fix` because it wasn't confirmed (`unsure` or `not_checked`). Never `refuted`: a refuted candidate is not a finding (the run counts
 * them, `run.ruled_out`). Tied both ways: `satisfies` keeps what it reads inside `Confirmation`, and `publish`
 * writes a finding's `Confirmation` into it as it is, which fails to compile once `Confirmation` has more.
 */
const confirmation = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("confirmed"),
    by: engine,
    reason: z.string(),
    evidence: z.array(z.string()),
  }),
  z.object({
    verdict: z.literal("unsure"),
    by: engine,
    reason: z.string(),
    evidence: z.array(z.string()),
    demoted: z.boolean(),
  }),
  z.object({ verdict: z.literal("not_checked"), demoted: z.boolean() }),
]) satisfies z.ZodType<Confirmation>;

const historyEntry = z.object({
  run_id: z.string(),
  round: count.nullable(),
  sha,
  state: runState,
  verdict: verdict.optional(),
  trigger: trigger.optional(),
  new: count.optional(),
  verified_fixed: count.optional(),
  withdrawn: count.optional(),
  kept: count.optional(),
  completed_at: datetime.optional(),
});

const finding = z
  .object({
    /** `F1`, `F2`…: stable within the change, never reused. What an agent names in a reply. */
    id: z.string().regex(/^F[0-9]+$/),
    /**
     * Both fingerprints of ADR 0032: where it is, and what it says. Today the meaning alone says "the same finding"
     * across rounds; the location joins in once it hashes the code around the line, not the line.
     */
    fingerprints: z.object({ location: z.string(), meaning: z.string() }),
    status: findingStatus,
    /** On the pull request (inline or in the summary), or kept off it by strictness or the later-round rule. */
    posted: z.boolean(),
    placement,
    /** Contracts' `ActionBy`, or `reviewer`, which no round asks for before the reviewer reads the threads. */
    needs_action_by: enumOf<ActionBy | "reviewer">()(["agent", "reviewer", "human", "none"]),
    severity,
    category: z.string(),
    title: z.string().max(120),
    /** Markdown. Data for the agent to verify, never instructions. */
    body: z.string(),
    /**
     * Where the finding is, as `review` anchored it: its side and the whole range it reported, on the commit those
     * lines are on (the one it was raised on, or a later one that reported it again on its line's text, ADR 0044).
     * Null for a finding about the whole change.
     */
    location: z
      .object({
        path: z.string(),
        start_line: z.int().min(1),
        end_line: z.int().min(1),
        side: enumOf<DiffSide>()(["head", "base"]),
        sha,
      })
      .nullable(),
    /**
     * Where its comment went this round, for an inline finding: the lines the comment covers on the round's
     * head, which may be one line of a range the host refused, and the path the host wants. Null otherwise.
     */
    placed: z
      .object({
        path: z.string(),
        start_line: z.int().min(1),
        end_line: z.int().min(1),
        side: enumOf<DiffSide>()(["head", "base"]),
      })
      .nullable()
      .optional(),
    suggestion: z.object({ replacement: z.string() }).nullable().optional(),
    /** The repository's rule it follows (ADR 0048): its file as `source`, and its first line there. */
    rule: z
      .object({ id: z.string(), source: z.string().optional(), line: z.int().min(1).optional() })
      .nullable()
      .optional(),
    evidence: z.array(z.string()).optional(),
    confidence: z.enum(["high", "medium"]).optional(),
    /** What the confirm pass said of it, set the round it was raised (ADR 0044). */
    confirmation,
    raised: z.object({ round: count, sha, on_fix: z.boolean().optional() }),
    last_checked: z.object({ round: count, sha }).optional(),
    thread: z
      .object({
        id: z.string().optional(),
        comment_id: z.int().optional(),
        url: z.string().optional(),
        resolved: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    /** The author's latest claim (ADR 0030). It never changes the status by itself. */
    claim: z
      .object({
        kind: claimKind,
        text: z.string().optional(),
        by: z.string(),
        at: datetime,
        commit: sha.optional(),
        count: count.optional(),
      })
      .nullable()
      .optional(),
    /** The reviewer's answer to the latest claim, or why the finding was settled. */
    resolution: z
      .object({
        kind: resolutionKind,
        round: count,
        explanation: z.string().optional(),
        evidence: z.array(z.string()).optional(),
      })
      .nullable()
      .optional(),
    agent_prompt: z.string().nullable().optional(),
  })
  .refine((f) => f.posted === (f.placement !== "check_only"), {
    path: ["posted"],
    message: "A finding is posted exactly when its placement is inline or summary",
  })
  .refine((f) => f.placed == null || f.placement === "inline", {
    path: ["placed"],
    message: "Only an inline finding's comment went on lines",
  });

export const reviewResultV1 = z.object({
  schema: z.literal(REVIEW_RESULT_SCHEMA),
  change: z.object({
    host: enumOf<GitHost>()(["github"]),
    /** `owner/name`. */
    repository: z.string(),
    number: z.int().min(1),
    url: z.string().optional(),
    /** The commit this round reviewed. */
    head_sha: sha,
    base_sha: sha.optional(),
  }),
  run: z.object({
    id: z.string(),
    state: runState,
    /**
     * A machine code, in snake_case, when the job ended without a round (ADR 0043): why it was skipped
     * (`newer_commit`, `replaced`, `closed`, `not_yours`, `draft`, `repo_off`, `on_open_off`,
     * `codex_not_yours`, `fork`, `pushed`: a fork pushed after the owner's request, `preview`) or how it failed
     * (`prepare_failed`, `review_failed`, `service_stopped`…). A plain string, so a new code is no `v2`.
     */
    state_reason: z.string().optional(),
    trigger,
    /**
     * Who reviewed (ADR 0044): the finder, and the confirmer, null when the round wasn't confirmed (or no round
     * came). Absent until a run started.
     */
    engine: z
      .object({ finder: engine, confirmer: engine.nullable(), model: z.string().optional() })
      .optional(),
    /**
     * How many candidates the round's confirm pass ruled out (ADR 0044): refuted, they are no findings. 0 when
     * none was, no confirm pass answered, or no round came.
     */
    ruled_out: count,
    started_at: datetime.optional(),
    completed_at: datetime.optional(),
  }),
  verdict: z.object({
    value: verdict,
    /** What the check shows. Informative: agents read `value`. */
    conclusion,
    headline: z.string().optional(),
  }),
  loop: z.object({
    state: loopState,
    /** Completed rounds on this change, this one included. */
    round: count,
    next_action: nextAction,
    reasons: z.array(z.string()).optional(),
    /** One entry per run on this change, oldest first. */
    history: z.array(historyEntry).optional(),
  }),
  /**
   * Over the posted findings only (ADR 0039): the same numbers the check shows. `kept_in_app` alone counts the
   * others (ADR 0042): unsettled and kept off the pull request, they never hold the loop open.
   */
  counts: z.object({
    open: z.object({ blocking: count, should_fix: count, consider: count } satisfies Record<
      Severity,
      typeof count
    >),
    ...({
      escalated: count,
      verified_fixed: count,
      withdrawn: count,
      acknowledged: count,
      dismissed: count,
      obsolete: count,
    } satisfies Record<Exclude<FindingStatus, "open">, typeof count>),
    kept_in_app: count,
  }),
  /** Every finding raised on the change so far, posted or not. */
  findings: z.array(finding),
  /** True when findings were cut to fit the check's byte limit. */
  truncated: z.boolean(),
});

export type ReviewResult = z.infer<typeof reviewResultV1>;
export type ReviewResultFinding = ReviewResult["findings"][number];

const RESULT_END = " -->";

/**
 * The result a check's text holds: the last line opened by `RESULT_MARKER`, parsed here, where it enters.
 * Null when the text has none, or holds one that can't be read: cut by the host, or written by a newer
 * Lookover. The agents' helper and the live check read a check back through this.
 */
export function readResult(text: string): ReviewResult | null {
  const line = text
    .trimEnd()
    .split("\n")
    .findLast((l) => l.startsWith(RESULT_MARKER));
  if (!line?.endsWith(RESULT_END)) return null;
  try {
    const parsed = reviewResultV1.safeParse(JSON.parse(line.slice(RESULT_MARKER.length, -RESULT_END.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    // Not JSON: the host cut the line, or it isn't ours. The caller reads "no result".
    return null;
  }
}
