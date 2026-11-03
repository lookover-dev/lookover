// First-run setup: its steps, in order, and how far the owner got.
import type { ChangeId } from "./ids.ts";

/**
 * The steps, in order: your AI, GitHub, the repositories, the first review, your coding agent (ADR 0058), then
 * `background`, where a setup kept from before any step was shown stands (a data folder set up at its first start).
 */
export type SetupStep = "ai" | "github" | "repos" | "first-review" | "agent" | "background";

export const SETUP_ORDER: SetupStep[] = ["ai", "github", "repos", "first-review", "agent", "background"];

/** The later of two steps in `SETUP_ORDER`: what `reached` becomes, so going back never loses the way forward. */
export const furthestReached = (a: SetupStep, b: SetupStep): SetupStep =>
  SETUP_ORDER.indexOf(a) >= SETUP_ORDER.indexOf(b) ? a : b;

/**
 * Where the setup's GitHub step is (ADR 0053, ADR 0073): `start`, nobody signed in yet; `waiting-for-install`, the
 * person is signed in and the service checks every few seconds for the shared App's installation; `nothing-granted`, installed with no repository, or the install page left ("Open
 * GitHub again"); `done`, installed with repositories: the step shows it and waits for Continue (`setup.goto`: no
 * step moves on by itself, ADR 0058).
 */
export type SetupGitHub = "start" | "waiting-for-install" | "nothing-granted" | "done";

export interface Setup {
  done: boolean;
  step: SetupStep;
  /** The furthest step reached: going back never loses the way forward. */
  reached: SetupStep;
  github: SetupGitHub;
  firstReviewChange: ChangeId | null;
}
