// First-run setup: its steps, in order, and how far the owner got.
import type { SetupGitHubRefusal } from "./github-app.ts";
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
 * Where the setup's GitHub step is (ADR 0053): `start`, nothing asked of GitHub yet; `waiting-for-app`, GitHub's page
 * to create the App is open; `waiting-for-install`, the App is made (or given) and the service checks every few
 * seconds for its installation; `nothing-granted`, installed with no repository, or the install page left ("Open
 * GitHub again"); `done`, installed with repositories: the step shows it and waits for Continue (`setup.goto`: no
 * step moves on by itself, ADR 0058).
 */
export type SetupGitHub = "start" | "waiting-for-app" | "waiting-for-install" | "nothing-granted" | "done";

export interface Setup {
  done: boolean;
  step: SetupStep;
  /** The furthest step reached: going back never loses the way forward. */
  reached: SetupStep;
  github: SetupGitHub;
  /** Why the manifest flow stopped short, until the owner tries again; null when nothing went wrong. */
  githubRefused: SetupGitHubRefusal | null;
  firstReviewChange: ChangeId | null;
}
