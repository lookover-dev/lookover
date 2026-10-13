// The confirm pass (ADR 0024, ADR 0044): one engine session for a round's new candidates, its answer read into one
// verdict per candidate. Whatever the engine does or says, it never fails: a run that didn't answer, or an answer
// with no block that can be read, gives every candidate `not_checked` with the reason.
import {
  type CandidateFinding,
  type CandidateVerdict,
  type ConfirmFailure,
  type ConfirmVerdict,
  type EngineId,
  type Engines,
  enumOf,
  limitMet,
  type Prepared,
  type ReviewJob,
  type RoundSession,
  type Severity,
} from "@lookover/contracts";
import { indexDiff } from "@lookover/diff";
import { z } from "zod";
import { answerValue, issues } from "./answer.ts";
import { buildConfirmPrompt, claimId } from "./confirm-prompt.ts";
import { sessionOf } from "./session.ts";
import type { ConfirmPass, ConfirmPolicy, ConfirmRun } from "./types.ts";

/** One verdict as the engine writes it. */
const verdict = z.object({
  id: z.string().min(1),
  verdict: enumOf<ConfirmVerdict>()(["confirmed", "refuted", "unsure"]),
  reason: z.string().trim().min(1),
  evidence: z.array(z.string()).default([]),
  severity: enumOf<Severity>()(["blocking", "should_fix", "consider"]),
});

/** The block itself: a list of verdicts, each read on its own. */
const block = z.object({ verdicts: z.array(z.unknown()) });

/** What a candidate gets when no verdict of the session reached it. */
const NO_VERDICT: CandidateVerdict = { verdict: "not_checked" };

/** Every candidate not checked, and why the session gave no verdicts. */
function failed(
  candidates: CandidateFinding[],
  failure: ConfirmFailure,
  problems: string[],
  session: RoundSession,
): ConfirmRun {
  return {
    judged: candidates.map((candidate) => ({ candidate, verdict: NO_VERDICT })),
    failure,
    notes: "",
    problems,
    session,
  };
}

/** The verdicts of a block, one per candidate, by its id; what is wrong with an item goes to `problems`. */
function verdicts(items: unknown[], count: number, by: EngineId, problems: string[]): CandidateVerdict[] {
  const found = new Map<string, CandidateVerdict>();
  items.forEach((item, i) => {
    const parsed = verdict.safeParse(item);
    if (!parsed.success) {
      problems.push(...issues(parsed.error, `verdicts.${i}`));
      return;
    }
    const { id, ...v } = parsed.data;
    const known = Array.from({ length: count }, (_, n) => claimId(n)).includes(id);
    if (!known) problems.push(`verdicts: ${id} was not asked about`);
    else if (found.has(id)) problems.push(`verdicts: ${id} answered twice`);
    else found.set(id, { ...v, by });
  });
  return Array.from({ length: count }, (_, n) => {
    const v = found.get(claimId(n));
    if (v === undefined) problems.push(`verdicts: no verdict on ${claimId(n)}`);
    return v ?? NO_VERDICT;
  });
}

/** What `createConfirm` takes: the engines, and how many characters of prompt each may be sent. */
interface ConfirmOptions {
  engines: Engines;
  /** Each engine's input limit, in characters: a longer prompt leaves claims' code out (`confirm-prompt.ts`). */
  inputLimits?: Partial<Record<EngineId, number>>;
}

export function createConfirm({ engines, inputLimits = {} }: ConfirmOptions): ConfirmPass {
  return {
    async run(
      job: ReviewJob,
      prepared: Prepared,
      candidates: CandidateFinding[],
      policy: ConfirmPolicy,
      signal: AbortSignal,
    ): Promise<ConfirmRun> {
      if (candidates.length === 0)
        return { judged: [], failure: null, notes: "", problems: [], session: null };
      const index = indexDiff(prepared.diff);
      const spec = {
        engine: policy.engine,
        prompt: buildConfirmPrompt(job, index, candidates, policy, inputLimits[policy.engine]),
        cwd: prepared.cwd,
        timeoutMs: policy.timeoutMs,
        artefactsDir: policy.artefactsDir,
        ...(policy.onActivity === undefined ? {} : { onActivity: policy.onActivity }),
      };
      const result = await engines.run(spec, signal);
      const session = sessionOf("confirm", policy.engine, result);
      if (result.outcome !== "ok")
        return { ...failed(candidates, result.outcome, [], session), ...limitMet(result) };
      const value = answerValue(result);
      if (!value.ok) return failed(candidates, "unreadable", [value.reason, ...value.problems], session);
      const parsed = block.safeParse(value.value);
      if (!parsed.success) return failed(candidates, "unreadable", issues(parsed.error, ""), session);
      const problems: string[] = [];
      const found = verdicts(parsed.data.verdicts, candidates.length, policy.engine, problems);
      return {
        judged: candidates.map((candidate, i) => ({ candidate, verdict: found[i] ?? NO_VERDICT })),
        failure: null,
        notes: value.notes,
        problems,
        session,
      };
    },
  };
}
