// What the runner and the setups both read a case's sessions with (ADR 0050): the job the prompts name, the rules
// as both passes are given them and the switches `core` reads, and an engine that gives back a stored answer. One
// copy, so the live run's reading of a find and the replay's can't drift apart. Private to the package.
import {
  type CommitSha,
  type EngineRunResult,
  type Engines,
  jobId,
  type PromptRulesFile,
  type ReviewJob,
  repositoryId,
} from "@lookover/contracts";
import { parseRules, promptRules } from "@lookover/core";
import type { CaseInputs, SessionRecord } from "./types.ts";

/** The one repository every case's rules are parsed under: a rule's id hashes it, and nothing compares ids across. */
const REPOSITORY = repositoryId("evals");

/** The job a session's prompt names: the passes read only its commit. */
export function jobOn(sha: CommitSha): ReviewJob {
  return {
    id: jobId("eval"),
    sha,
    trigger: "manual",
    state: "running",
    deferral: null,
    stepIn: null,
    skip: null,
    cancel: null,
    failure: null,
    turn: null,
  };
}

/** A rule as `core`'s `toConfirm` and `reconcile` read its switch. */
export interface RuleSwitch {
  id: string;
  text: string;
  enabled: boolean;
}

/**
 * A case's rules as both passes are given them (`promptRules`) and as `core` reads their switches: every rule on,
 * since a case's repository has no settings file.
 */
export function caseRules(inputs: CaseInputs): { rules: PromptRulesFile[]; switches: RuleSwitch[] } {
  return {
    rules: promptRules(REPOSITORY, inputs.rules),
    switches: inputs.rules
      .flatMap((file) => parseRules(REPOSITORY, file))
      .map(({ id, text }) => ({ id, text, enabled: true })),
  };
}

/** An engine that gives back one stored answer: `review` reads it as it read the live one. */
export function answering(record: Extract<SessionRecord, { text: string }>): Engines {
  return {
    run: (spec): Promise<EngineRunResult> =>
      Promise.resolve({
        outcome: record.outcome,
        text: record.text,
        json: record.json,
        usage: record.usage,
        tookMs: record.wallMs,
        artefactsDir: spec.artefactsDir,
      }),
    health: () => Promise.resolve({ installed: true, version: null, signedIn: true }),
  };
}
