// First-run setup: its steps, in order, and how far the owner got.
import { enumOf } from "./enum-of.ts";
import type { ChangeId } from "./ids.ts";

/**
 * The steps, in order: your AI, GitHub, the repositories, the first review, your coding agent (ADR 0058), then
 * `background`, where a setup kept from before any step was shown stands (a data folder set up at its first start).
 */
export type SetupStep = "ai" | "github" | "repos" | "first-review" | "agent" | "background";

/**
 * The steps in order, each once: tied to `SetupStep` by `enumOf`, so a step added to the union and not placed here
 * fails to compile.
 */
export const SETUP_ORDER: SetupStep[] = [
  ...enumOf<SetupStep>()(["ai", "github", "repos", "first-review", "agent", "background"]).options,
];

/** The later of two steps in `SETUP_ORDER`: what `reached` becomes, so going back never loses the way forward. */
export const furthestReached = (a: SetupStep, b: SetupStep): SetupStep =>
  SETUP_ORDER.indexOf(a) >= SETUP_ORDER.indexOf(b) ? a : b;

/**
 * Whether the person has chosen the repositories (ADR 0079): setup done, or its furthest step reached past the
 * Repositories step (Continue there sends `setup.chooseRepos`, which moves it to the first review). Until then
 * nothing asks a review by itself (`core.intake`). A step gone back keeps the choice: `reached` is what counts.
 */
export const reposChosen = (setup: Pick<Setup, "done" | "reached">): boolean =>
  setup.done || SETUP_ORDER.indexOf(setup.reached) > SETUP_ORDER.indexOf("repos");

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
