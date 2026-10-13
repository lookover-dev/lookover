// What testkit's two in-memory engines share (`FakeEngines`, `ScriptedEngines`): health set by hand (not
// installed until set), a run's duration waited on the `Timers` given (the real ones by default, the demo clock
// in demo mode and in the service's tests), the activities a script plays to the run's listener while it waits
// (ADR 0055), and the run folder the port defines, kept in memory, never on disk, so a pure module's tests stay pure
// (`file` reads it).
import { join } from "node:path";
import type {
  EngineActivity,
  EngineHealth,
  EngineId,
  EngineRunResult,
  EngineRunSpec,
} from "@lookover/contracts";

/** An activity a scripted run reports (ADR 0055): `afterMs` from the run's start, on the engines' timers. */
export interface ScriptedActivity {
  afterMs: number;
  activity: EngineActivity;
}

/** The timers a run's duration elapses on: the service's `Timers`, by shape (testkit knows no service). */
export interface EngineTimers {
  /** Calls `fire` once `ms` have passed; the function returned cancels it. */
  after(ms: number, fire: () => void): () => void;
}

/** The process's own timers. */
export const REAL_TIMERS: EngineTimers = {
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

const NOT_INSTALLED: EngineHealth = { installed: false, version: null, signedIn: false };

/** The part of an in-memory engine that isn't its script: health, waiting, the run folder. */
export abstract class EngineDouble {
  /** Every run asked for, in order. */
  readonly runs: EngineRunSpec[] = [];
  /** The timers a run's duration, and a subclass's own waits, elapse on. */
  protected readonly timers: EngineTimers;
  protected readonly healths: Partial<Record<EngineId, EngineHealth>> = {};
  private readonly files = new Map<string, string>();

  constructor(timers: EngineTimers) {
    this.timers = timers;
  }

  /** What `health(engine)` answers from now on. Not installed until set. */
  setHealth(engine: EngineId, health: EngineHealth): void {
    this.healths[engine] = health;
  }

  /** The health of `engine` now, at once: what `health` answers. */
  healthOf(engine: EngineId): EngineHealth {
    return this.healths[engine] ?? NOT_INSTALLED;
  }

  health(engine: EngineId): Promise<EngineHealth> {
    return Promise.resolve(this.healthOf(engine));
  }

  /** A file a run left, by its path (`join(spec.artefactsDir, "run.json")`); undefined when none did. */
  file(path: string): string | undefined {
    return this.files.get(path);
  }

  /** Resolves once `ms` have passed on the timers, or as soon as `signal` aborts: true when it waited the whole time. */
  protected waited(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (whole: boolean) => {
        cancel();
        signal.removeEventListener("abort", onAbort);
        resolve(whole);
      };
      const onAbort = () => done(false);
      const cancel = this.timers.after(ms, () => done(true));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * `waited`, while each of `activity` due before `ms` is told to the spec's listener at its `afterMs` on the timers;
   * once the wait ends (its time passed, or the signal aborted), nothing more is told.
   */
  protected async playing(
    spec: EngineRunSpec,
    activity: readonly ScriptedActivity[],
    ms: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    let listen = spec.onActivity;
    /** Tells one activity; a listener that throws is dropped, as the port says, and the timers never see it. */
    const tell = (told: EngineActivity) => {
      try {
        listen?.(told);
      } catch {
        // Dropped: called no more, and the clock's advance goes on.
        listen = undefined;
      }
    };
    const cancels =
      listen === undefined
        ? []
        : activity
            .filter((a) => a.afterMs < ms)
            .map((a) => this.timers.after(a.afterMs, () => tell(a.activity)));
    try {
      return await this.waited(ms, signal);
    } finally {
      for (const cancel of cancels) cancel();
    }
  }

  /** The run folder as the port defines it: the prompt, and how the run ended. */
  protected keep(spec: EngineRunSpec, result: EngineRunResult): EngineRunResult {
    this.files.set(join(spec.artefactsDir, "prompt.md"), spec.prompt);
    const run = { engine: spec.engine, outcome: result.outcome };
    this.files.set(join(spec.artefactsDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
    return result;
  }
}
