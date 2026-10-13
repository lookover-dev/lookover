// What a restart does with a job the stopped service left running (ADR 0043, #62, ADR 0044). A run that had reached
// publishing resumes its posts: its round was saved, with the posts it owes, as the run reached that step, so
// nothing is found again and the outbox sends only what is still owed. Any other run's job runs again, as a new run
// of the same job, once; not when a restart already retried it: a job that stops the service each time it runs would
// otherwise run forever, and it fails.
import type { RunStep } from "@lookover/contracts";

/** What a restart knows of a job it found running: the step its run reached, and how often a restart retried it. */
export interface Interrupted {
  step: RunStep;
  retries: number;
}

/** What the restart does with it: resume its round's posts, run it again, or fail it (the service stopped). */
export type AfterRestart = "resumes" | "runs-again" | "fails";

/** How often a restart puts one job back in the queue. */
const RETRIES = 1;

/** What the restart does with a job it found running. */
export function afterRestart({ step, retries }: Interrupted): AfterRestart {
  if (step === "publishing") return "resumes";
  return retries < RETRIES ? "runs-again" : "fails";
}
