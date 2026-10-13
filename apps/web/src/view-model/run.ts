// A run in words (ADR 0029): its steps and how far it is. The row, the review page, the step list and the
// simulated GitHub check all say a step with these words. The confirm step (ADR 0044) is always listed, and says
// the confirmer's name, or that there was nothing new to double-check. The posting step says its outbox while it runs.
import {
  asSentence,
  type EngineId,
  postWaitText,
  type Review,
  type RunPosting,
  type RunStep,
} from "@lookover/contracts";
import { elapsed, startsAt } from "./format.ts";

const RUN_STEPS: RunStep[] = ["preparing", "finding", "confirming", "publishing"];

/** Each step in a line (`now`), and in the step list while it runs (`doing`) and once done (`did`). */
const STEP_TEXT: Record<
  RunStep,
  { now: string; doing: (ai: string) => string; did: (ai: string) => string }
> = {
  preparing: { now: "getting the changes", doing: () => "Getting the changes", did: () => "Got the changes" },
  finding: {
    now: "reading the code",
    doing: (ai) => `${ai} is reading the code and looking for problems`,
    did: (ai) => `${ai} read the code and looked for problems`,
  },
  confirming: {
    now: "double-checking findings",
    doing: (ai) => `${ai} is double-checking each new finding`,
    did: (ai) => `${ai} double-checked each new finding`,
  },
  publishing: { now: "posting on GitHub", doing: () => "Posting on GitHub", did: () => "Posted on GitHub" },
};

/** "reading the code": the step a run is at, in a line. */
export function stepNow(step: RunStep): string {
  return STEP_TEXT[step].now;
}

/**
 * A step in the step list, while it runs and once done. `ai` is the name of the AI at that step: the finder's, the
 * confirmer's at the confirm step.
 */
export function stepListText(step: RunStep, ai: string): { doing: string; did: string } {
  const text = STEP_TEXT[step];
  return { doing: text.doing(ai), did: text.did(ai) };
}

/**
 * The posting step while it runs (ADR 0055): how many of the round's posts are sent, and while GitHub makes it wait,
 * why and until when, against the service's clock `now`: "Posted 2 of 4. GitHub asked to wait, trying again at
 * 14:05." Before its first post is counted, the step's own words.
 */
export function postingText(posting: RunPosting | null, now: number): string {
  if (posting === null) return STEP_TEXT.publishing.doing("");
  const sent = `Posted ${posting.sent} of ${posting.owed}.`;
  const { wait } = posting;
  return wait === null
    ? sent
    : `${sent} ${asSentence(postWaitText(wait.refusal, startsAt(now, wait.until)))}`;
}

/** What the list says of a step the run passed by without running it. */
export function stepSkippedText(step: Extract<RunStep, "confirming">): string {
  switch (step) {
    case "confirming":
      return "Nothing new to double-check";
  }
}

/**
 * The steps a review's run goes through, the confirm step included from start to end whether it runs or not, so
 * the list never changes length (`confirmSkipped` words the row of one that doesn't); a preview never posts.
 */
export function runSteps(review: Review): RunStep[] {
  return review.preview ? RUN_STEPS.filter((step) => step !== "publishing") : RUN_STEPS;
}

/**
 * The confirm step didn't run, or won't (ADR 0044): the running run plans no confirmer, or passed the step without
 * running it; the last round, done, went without it. Its row then says there was nothing new to double-check.
 */
export function confirmSkipped(review: Review): boolean {
  const { run } = review;
  const ran = (steps: { step: RunStep }[]) => steps.some((s) => s.step === "confirming");
  if (!run) return !ran(review.rounds.at(-1)?.steps ?? []);
  if (run.step === "confirming" || ran(run.steps)) return false;
  return run.confirmer === null || RUN_STEPS.indexOf(run.step) > RUN_STEPS.indexOf("confirming");
}

/** The AI planned to double-check the running round, or the one that double-checked the last round. */
export function confirmerOf(review: Review): EngineId | null {
  return review.run ? review.run.confirmer : (review.rounds.at(-1)?.confirmer ?? null);
}

/**
 * A step's time in the step list: the running step's since it began, against the ticking `now` (ADR 0058); a
 * finished step's as recorded, whatever the time is; none for a step not reached.
 */
export function stepTime(review: Review, step: RunStep, now: number): string {
  const { run } = review;
  const done = (run ? run.steps : review.rounds.at(-1)?.steps)?.find((s) => s.step === step);
  if (done) return elapsed(done.ms);
  return run?.step === step ? elapsed(now - run.stepAt) : "";
}

/** A run line's two parts: the running step, and how long the run has taken (a running time, design system). */
export interface RunLineParts {
  doing: string;
  time: string;
}

export function runLineParts(now: number, review: Review): RunLineParts {
  return {
    doing: stepNow(review.run?.step ?? "preparing"),
    time: elapsed(now - (review.run?.startedAt ?? now)),
  };
}

/** "reading the code · 1:12": the running step, and how long the run has taken. */
export function runLine(now: number, review: Review): string {
  const { doing, time } = runLineParts(now, review);
  return `${doing} · ${time}`;
}
