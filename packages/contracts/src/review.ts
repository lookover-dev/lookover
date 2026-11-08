// The review of one change, in the three levels of ADR 0029: the latest review job (is a review waiting?),
// the run in progress (is one running, and at which step?) and the loop (where the back-and-forth with the
// author stands). The screens derive one display status from the three.
import type { Finding } from "./finding.ts";
import type { ChangeId, CommitSha, FindingId } from "./ids.ts";
import type { AskedBy, Deferral, JobFailure, PushedBy, ReviewJob, Trigger } from "./job.ts";
import type { LoopState } from "./loop.ts";
import type { Round } from "./round.ts";
import type { Run } from "./run.ts";

/**
 * One line of a review's history, as data: what happened, and the facts needed to say it. The words are the
 * UI's (its view model); `apply` only records the entry.
 */
export type TimelineEntry = {
  at: number;
  /** The commit it concerns, when there is one. */
  sha: CommitSha | null;
} /** Opened by `by`: when the host says it was, the first time Lookover lists it; when seen again, reopened. */ & (
  | { kind: "opened"; by: string }
  /** New commits: `agent` when an agent signed every one (ADR 0081), else null, no one named. */
  | { kind: "pushed"; by: PushedBy; commits: number }
  /** A new job, what asked for it, and who wrote the request when a request comment did. */
  | { kind: "queued"; trigger: Trigger; by: AskedBy | null }
  /** A request comment joined the waiting job, which no request had asked for (ADR 0081). */
  | { kind: "asked"; by: AskedBy }
  | { kind: "deferred"; deferral: Deferral }
  /** The job was skipped; why is on the job. */
  | { kind: "skipped" }
  | { kind: "started"; round: number }
  /** A round finished: its number, and the findings still open on the pull request (`Round.open`). */
  | { kind: "posted"; round: number; open: number }
  /** The job ended failed, on its commit (ADR 0081): its failure, as the job has it. */
  | { kind: "failed"; failure: JobFailure | null }
  /** The owner dismissed findings as wrong ("Too noisy?", ADR 0052): which ones. */
  | { kind: "dismissed"; findingIds: FindingId[] }
);

export interface Review {
  changeId: ChangeId;
  /** The latest review job; null until one is asked for. */
  job: ReviewJob | null;
  /** The run in progress; null when none is. */
  run: Run | null;
  /** Null until the first round. */
  loop: LoopState | null;
  rounds: Round[];
  findings: Finding[];
  /** The last run was a preview: nothing was posted. */
  preview: boolean;
  updatedAt: number;
  timeline: TimelineEntry[];
}
