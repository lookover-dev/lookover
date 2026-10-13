// An in-memory `Engines`: answers from a script, in order (one per engine, then one shared), and records every
// run's spec. Like the real one, a run takes its time (on the `Timers` given: the real ones unless a test holds
// its clock), ends `timeout` past its limit and `cancelled` when its signal aborts, and leaves its folder's files;
// in memory, never on disk, so a pure module's tests stay pure (`file` reads them).
import type { EngineId, EngineRunResult, EngineRunSpec, Engines } from "@lookover/contracts";
import { EngineDouble, type EngineTimers, REAL_TIMERS, type ScriptedActivity } from "./engine-double.ts";

/**
 * One scripted answer. `tookMs` is how long the run takes, on the engines' timers: the answer comes after it, unless the
 * spec's limit comes first (`timeout`) or the signal aborts (`cancelled`). None: the answer comes at once.
 */
export interface ScriptedRun {
  outcome: EngineRunResult["outcome"];
  text: string;
  /** A structured-output run's value. None: a free-text run, whose `json` is null whatever its text holds. */
  json?: unknown;
  usage?: EngineRunResult["usage"];
  /** A run at the plan's limit: when it resets (ADR 0055). Given as is, whatever the outcome. */
  limitUntil?: number;
  /** A run at the plan's limit with no reset read: what the program said of it. Given as is. */
  limitSaid?: string;
  tookMs?: number;
  /** What the run reports while it takes its time, each at its `afterMs` (ADR 0055); one due after the answer never. */
  activity?: ScriptedActivity[];
}

export class FakeEngines extends EngineDouble implements Engines {
  private readonly script: ScriptedRun[] = [];
  private readonly scripts: Record<EngineId, ScriptedRun[]> = { claude: [], codex: [] };

  /** `timers`: what a run's duration elapses on; the process's own by default. */
  constructor(options: { timers?: EngineTimers } = {}) {
    super(options.timers ?? REAL_TIMERS);
  }

  /**
   * Queues the next answers, for any engine. A run with none left crashes: a silent default would let a test pass
   * by accident.
   */
  answer(...runs: ScriptedRun[]): void {
    this.script.push(...runs);
  }

  /**
   * Queues the next answers of `engine`'s runs, so a test of two engines doesn't depend on the order they run in.
   * An engine's run takes its own answers first, then the shared ones (`answer`).
   */
  answerFor(engine: EngineId, ...runs: ScriptedRun[]): void {
    this.scripts[engine].push(...runs);
  }

  /** How many scripted answers no run has taken yet, shared and per engine. */
  get queued(): number {
    return this.script.length + this.scripts.claude.length + this.scripts.codex.length;
  }

  async run(spec: EngineRunSpec, signal: AbortSignal): Promise<EngineRunResult> {
    this.runs.push(spec);
    // A run cut short says it took no time: the fake keeps no clock of its own.
    const base = { text: "", json: null, usage: null, tookMs: 0, artefactsDir: spec.artefactsDir };
    if (signal.aborted) return this.keep(spec, { ...base, outcome: "cancelled" });
    const next = this.scripts[spec.engine].shift() ?? this.script.shift();
    if (!next) return this.keep(spec, { ...base, outcome: "crashed" });
    const took = next.tookMs ?? 0;
    if (took > 0 && !(await this.playing(spec, next.activity ?? [], Math.min(took, spec.timeoutMs), signal)))
      return this.keep(spec, { ...base, outcome: "cancelled" });
    if (took > spec.timeoutMs)
      return this.keep(spec, { ...base, outcome: "timeout", tookMs: spec.timeoutMs });
    return this.keep(spec, {
      ...base,
      tookMs: took,
      outcome: next.outcome,
      text: next.text,
      json: next.json === undefined ? null : { value: next.json },
      usage: next.usage ?? null,
      ...(next.limitUntil === undefined ? {} : { limitUntil: next.limitUntil }),
      ...(next.limitSaid === undefined ? {} : { limitSaid: next.limitSaid }),
    });
  }
}
