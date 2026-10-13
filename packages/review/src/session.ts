// What one engine session used (ADR 0055), kept whatever came of its answer: the round shows it.
import type { EngineId, EngineRunResult, RoundSession, RunPass } from "@lookover/contracts";

/** The session `pass` ran on `engine`: how long its program ran and the tokens it reported, as the run gave them. */
export function sessionOf(pass: RunPass, engine: EngineId, result: EngineRunResult): RoundSession {
  return { pass, engine, ms: result.tookMs, usage: result.usage };
}
