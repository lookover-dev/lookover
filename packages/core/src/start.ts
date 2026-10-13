// Whether a review job may start now, or why it waits (ADR 0029, ADR 0040). Answered here, once, so the service
// holds a job the same way whatever asked for the review. A held job is deferred with its
// reason and starts once the reason clears. A review already running finishes: this is about starting.
// Precedence: paused first (the owner's own choice, and nothing runs while it holds), then the engine chosen to
// review (the round plan's finder): missing, signed out, at its limit or failed its self-test, one state at a time.
import { type Deferral, type Engine, engineDeferral, type Trigger } from "@lookover/contracts";

/** An engine as a job's start reads it: its state now, and why a program found can't be used, null if none was. */
type EngineNow = Pick<Engine, "id" | "state" | "unusable">;

/** What decides whether a job may start: the pause, what asked for the review, the chosen engine as it is now. */
export interface StartFacts {
  /** Whether the owner paused reviews. */
  paused: boolean;
  trigger: Trigger;
  /** The engine chosen to review the change, its state now, and why a program found can't be used, if so. */
  engine: EngineNow;
}

/** Start now, or wait as deferred, and why. */
export type MayStart = { kind: "start" } | { kind: "deferred"; deferral: Deferral };

/**
 * Paused means nothing runs (ADR 0040): every trigger waits, the automatic ones, a review request comment (an
 * agent asks the way the owner does), the app's "Review again", setup's first review. A table rather than
 * `true`, so a new trigger is answered here.
 */
const PAUSE_HOLDS: Record<Trigger, boolean> = {
  opened: true,
  push: true,
  comment: true,
  manual: true,
  "first-review": true,
};

/**
 * What the engine's state makes a job wait for, naming the engine (contracts' `engineDeferral`, the one mapping);
 * null when it can review. `mayStart` asks it before a run, the service when a run finds the engine signed out or
 * at its limit. A missing engine whose program was found but can't be used (`unusable`) waits saying why.
 */
export function engineHold(engine: EngineNow): Deferral | null {
  return engine.state === "ready" ? null : engineDeferral(engine.id, engine.state, engine.unusable);
}

/** Whether a review job may start now, or why it must wait. One call decides. */
export function mayStart(facts: StartFacts): MayStart {
  if (facts.paused && PAUSE_HOLDS[facts.trigger]) return { kind: "deferred", deferral: { reason: "paused" } };
  const deferral = engineHold(facts.engine);
  return deferral ? { kind: "deferred", deferral } : { kind: "start" };
}
