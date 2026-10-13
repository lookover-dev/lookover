// Activity (ADR 0055): what an engine did while it reviewed, read from its output as it came. The engine reports it
// (`EngineRunSpec.onActivity`), the run keeps its newest (`Run.activities`), the UI words it.
import type { EngineId } from "./engine.ts";
import type { RunPass } from "./run.ts";

/**
 * What an engine did during a run (ADR 0055), read from its output as it comes, uncut: a file it read, a pattern it
 * searched the code for, a pattern of files it listed, a command it ran (its shell wrapper removed). Never what the
 * model wrote: the pull request can steer that text (ADR 0048).
 */
export type EngineActivity =
  | { kind: "read"; path: string }
  | { kind: "search"; pattern: string }
  | { kind: "list"; pattern: string }
  | { kind: "command"; text: string };

/** An activity of the run (ADR 0055): what an engine did, in which of the run's passes. */
export interface RunActivity {
  engine: EngineId;
  pass: RunPass;
  activity: EngineActivity;
}

/** The most activities a run keeps (ADR 0055): the newest; the older ones are in the run folder only. */
export const RUN_ACTIVITIES_KEPT = 50;
