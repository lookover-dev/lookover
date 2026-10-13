// The five eval setups (ADR 0050), built from a case's stored sessions as the service builds round 1
// (`apps/service/src/run.ts`): the finds merged by `core` (Claude then Codex), the candidates new to an empty ledger
// asked of the confirm, the policy on its verdicts (none at Quick: not checked), reconciled at Lookover's default
// strictness. Each answer is read by `review`'s own passes, on an engine that gives back the stored answer: no second
// parser, and the same reading the service would have made of it.
import type { EngineId, Engines, Prepared, RoundOutcome } from "@lookover/contracts";
import {
  type ConfirmApplied,
  confirmPolicy,
  type Judged,
  mergeFinds,
  reconcile,
  toConfirm,
  unconfirmed,
} from "@lookover/core";
import { createConfirm, createReview } from "@lookover/review";
import { resolve, settingValues } from "@lookover/settings";
import { answering, caseRules, jobOn } from "./reading.ts";
import {
  type CaseInputs,
  SESSIONS,
  SETUPS,
  type SessionName,
  type SessionRecord,
  type SetupName,
  type SetupResult,
} from "./types.ts";

/** Lookover's default strictness, as `settings` gives it with no layer of the owner's. */
const STRICTNESS = settingValues(resolve([])).strictness;

type Missing = Extract<SetupResult, { kind: "missing" }>;
type Reading<T> = { ok: true; value: T } | { ok: false; missing: Missing };

/** A session's stored answer, when it was answered and read; else why the setups that need it are missing. */
function answered(
  sessions: Partial<Record<SessionName, SessionRecord>>,
  session: SessionName,
): Reading<Engines> {
  const record = sessions[session];
  if (record === undefined || record.outcome === "no_candidates")
    return { ok: false, missing: { kind: "missing", session, reason: "not_run" } };
  if (record.failure !== null)
    return { ok: false, missing: { kind: "missing", session, reason: record.failure } };
  return { ok: true, value: answering(record) };
}

/**
 * Every setup of one case from its sessions (`sessions`: as stored; one absent was never run), with what it keeps
 * at the default strictness and every finding it raised, or missing when a session it needs failed or never ran. A
 * confirm asked nothing (no new candidate) is no session: the setup is complete without it. Pure: no disk, no
 * engine, no clock; the answers are read by `review` through an engine that gives them back.
 */
export async function buildSetups(
  inputs: CaseInputs,
  sessions: Partial<Record<SessionName, SessionRecord>>,
): Promise<Record<SetupName, SetupResult>> {
  const signal = new AbortController().signal;
  const job = jobOn(inputs.head);
  const prepared: Prepared = { cwd: ".", diff: inputs.diff };
  const { rules, switches } = caseRules(inputs);
  const round = 1;

  async function find(session: "claude-find" | "codex-find"): Promise<Reading<RoundOutcome>> {
    const engines = answered(sessions, session);
    if (!engines.ok) return engines;
    const policy = {
      engine: SESSIONS[session].engine,
      pass: "find" as const,
      round,
      earlier: [],
      timeoutMs: 0,
      artefactsDir: "",
      rules,
    };
    const run = await createReview({ engines: engines.value }).run(job, prepared, policy, signal);
    if (run.kind === "failed")
      return { ok: false, missing: { kind: "missing", session, reason: run.reason } };
    return { ok: true, value: run.round };
  }

  const finds = { "claude-find": await find("claude-find"), "codex-find": await find("codex-find") };

  /** The confirm session's verdicts on `asked`, through `review`'s confirm pass. */
  async function confirmed(
    session: SessionName,
    asked: RoundOutcome["candidates"],
  ): Promise<Reading<Judged[]>> {
    const engines = answered(sessions, session);
    if (!engines.ok) return engines;
    const engine: EngineId = SESSIONS[session].engine;
    const policy = { engine, round, timeoutMs: 0, artefactsDir: "", rules };
    const run = await createConfirm({ engines: engines.value }).run(job, prepared, asked, policy, signal);
    if (run.failure !== null)
      return { ok: false, missing: { kind: "missing", session, reason: run.failure } };
    return { ok: true, value: run.judged };
  }

  /** The round a setup's finds make: one pass as it is, two merged in the setup's order (Deep, `run.ts` `find`). */
  function mergedFinds(
    names: readonly SessionName[],
    passes: Reading<RoundOutcome>[],
  ): Reading<RoundOutcome> {
    const rounds: RoundOutcome[] = [];
    for (const pass of passes) {
      if (!pass.ok) return pass;
      rounds.push(pass.value);
    }
    const [first, ...rest] = rounds;
    if (first === undefined) throw new Error(`a setup of ${names.join(", ")} merges no find`);
    return { ok: true, value: rest.length === 0 ? first : mergeFinds([first, ...rest]) };
  }

  async function setup(name: SetupName): Promise<SetupResult> {
    const { finds: names, confirm } = SETUPS[name];
    const found = mergedFinds(
      names,
      names.map((session) => finds[session]),
    );
    if (!found.ok) return found.missing;
    const { candidates } = found.value;
    const spent: SessionName[] = [...names];
    // The candidates new to the ledger, which is empty at round 1 (`run.ts` `confirm`).
    const asked = toConfirm([], candidates, { round, rules: switches });
    let applied: ConfirmApplied;
    let judged: Judged[] = [];
    let confirmer: EngineId | null = null;
    if (confirm === null) {
      // Quick: what the confirm would have checked is not checked, a blocking one demoted.
      applied = unconfirmed(candidates, asked);
    } else if (asked.length === 0) {
      // Nothing new to judge: no session, the candidates go on as found.
      applied = { candidates, ruledOut: [] };
    } else {
      const verdicts = await confirmed(confirm, asked);
      if (!verdicts.ok) return verdicts.missing;
      judged = verdicts.value;
      confirmer = SESSIONS[confirm].engine;
      spent.push(confirm);
      applied = confirmPolicy(candidates, judged);
    }
    const reconciled = reconcile(
      [],
      { ...found.value, candidates: applied.candidates },
      { round, settings: { strictness: STRICTNESS }, rules: switches },
    );
    return {
      kind: "complete",
      kept: reconciled.findings.filter((finding) => finding.posted),
      all: reconciled.findings,
      judged,
      ruledOut: applied.ruledOut,
      confirmer,
      sessions: spent,
    };
  }

  return {
    quick: await setup("quick"),
    "quick-codex": await setup("quick-codex"),
    "standard-one": await setup("standard-one"),
    "standard-cross": await setup("standard-cross"),
    deep: await setup("deep"),
  };
}
