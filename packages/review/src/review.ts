// One find pass: build the prompt, run it on the engine, read the answer. Every way the engine or its answer
// can fall short is a `failed` run with its reason, never an exception: the service records it as the run's end.
import type {
  CandidateFinding,
  DiffIndex,
  EngineId,
  Engines,
  Prepared,
  ReviewJob,
} from "@lookover/contracts";
import { limitMet } from "@lookover/contracts";
import { indexDiff } from "@lookover/diff";
import { anchor } from "./anchor.ts";
import { type AnswerFinding, readAnswer } from "./answer.ts";
import { fingerprints } from "./fingerprint.ts";
import { buildPrompt } from "./prompt.ts";
import { sessionOf } from "./session.ts";
import type { FindPass, ReviewPolicy, ReviewRun } from "./types.ts";

/**
 * The location as the engine reported it, anchored by its line's text against `index`; an `end_line` equal to
 * `line` is one line, not a range. Found by `engine`, the pass's. Following `rule`; a `repo_rule` finding that
 * cites none is `maintainability` (ADR 0048).
 */
function candidate(found: AnswerFinding, engine: EngineId, index: DiffIndex): CandidateFinding {
  const { rule } = found;
  const reported = {
    path: found.path,
    side: found.side,
    line: found.line,
    endLine: found.end_line === found.line ? null : found.end_line,
  };
  const { location, lineText, anchoring } = anchor(index, reported, found.line_text);
  const category = found.category === "repo_rule" && rule === null ? "maintainability" : found.category;
  return {
    severity: found.severity,
    category,
    title: found.title,
    body: found.body,
    location,
    lineText,
    anchoring,
    foundBy: engine,
    defectKey: found.defect_key,
    suggestion: found.suggestion,
    preExisting: found.pre_existing,
    rule,
    fingerprints: fingerprints(category, location, found.defect_key, lineText),
  };
}

/** What `createReview` takes: the engines, and how many characters of prompt each may be sent. */
interface ReviewOptions {
  engines: Engines;
  /** Each engine's input limit, in characters: a longer prompt has its diff cut (see `prompt.ts`). None: no cut. */
  inputLimits?: Partial<Record<EngineId, number>>;
}

export function createReview({ engines, inputLimits = {} }: ReviewOptions): FindPass {
  return {
    async run(
      job: ReviewJob,
      prepared: Prepared,
      policy: ReviewPolicy,
      signal: AbortSignal,
    ): Promise<ReviewRun> {
      const spec = {
        engine: policy.engine,
        prompt: buildPrompt(job, prepared, policy, inputLimits[policy.engine]),
        cwd: prepared.cwd,
        timeoutMs: policy.timeoutMs,
        artefactsDir: policy.artefactsDir,
        ...(policy.onActivity === undefined ? {} : { onActivity: policy.onActivity }),
      };
      const result = await engines.run(spec, signal);
      const session = sessionOf(policy.pass, policy.engine, result);
      if (result.outcome !== "ok") {
        return {
          kind: "failed",
          reason: result.outcome,
          problems: [],
          text: result.text,
          session,
          ...limitMet(result),
        };
      }
      const read = readAnswer(result, policy.earlier, policy.rules);
      if (!read.ok)
        return { kind: "failed", reason: read.reason, problems: read.problems, text: result.text, session };
      const index = indexDiff(prepared.diff);
      return {
        kind: "reviewed",
        round: {
          sha: job.sha,
          engine: policy.engine,
          notes: read.notes,
          candidates: read.findings.map((found) => candidate(found, policy.engine, index)),
          earlier: read.earlier,
          emptyReason: read.emptyReason,
          problems: read.problems,
          sessions: [session],
        },
      };
    },
  };
}
