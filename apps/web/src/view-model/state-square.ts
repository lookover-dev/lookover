// The state square at the start of a setup row (design-system.md "State square"): which mark it draws, for an AI's
// row in the setup's first step and for a sub-step's.
import type { Engine } from "@lookover/contracts";

/**
 * What is not done yet, as the square draws it before: a thing to install, a sign-in, a wait (a limit, a check), a thing
 * there to fix (an AI installed whose version failed the check).
 */
export type TodoMark = "install" | "sign-in" | "wait" | "fix";

/** A state square's state: what is not done yet, the eyes while waiting, done, stale, refused. */
export type SquareState = TodoMark | "busy" | "done" | "stale" | "refused";

/** A sub-step's state (`SubStep`). */
export type SubStepState = "done" | "busy" | "current" | "later";

/**
 * What an AI not ready yet still needs: its program, a fix to the one there (its version failed the check), a
 * sign-in, a wait.
 */
const ENGINE_TODO: Record<Exclude<Engine["state"], "ready">, TodoMark> = {
  missing: "install",
  "failed-self-test": "fix",
  "signed-out": "sign-in",
  limit: "wait",
  "self-test-unfinished": "wait",
};

/** An AI's square in the setup's first step: done once ready, the eyes while it signs in, else what it still needs. */
export const engineMark = (engine: Engine): SquareState =>
  engine.state === "ready" ? "done" : engine.signingIn ? "busy" : ENGINE_TODO[engine.state];

/** A sub-step's square: its state's, `todo` before it is done. */
export const subStepMark = (state: SubStepState, todo: TodoMark): SquareState =>
  state === "done" ? "done" : state === "busy" ? "busy" : todo;
