// What the log file says of each event (ADR 0055, "The log file says what the service did"): one pure function words an
// event, given the state before it, as one line or none. A line starts with what it is about: the change
// (`sasensi/ledger-api#151`), the engine (`Codex`) or the reviews (`reviews paused`). The events that change no review, and
// those that change nothing a reader of the file looks for (a step, a clock, a check), write none. The phrases the app
// and GitHub say too come from `contracts`' copy; the file's own words are here. Times are the machine's local time,
// as the file's stamps are: "11:00" on the event's own day, else with the date. The installation's and the sign-in's
// lines, which no event carries the words of, are here too (`installationLines`, `signInLines`).
import {
  type AskedBy,
  type Change,
  cancelPhrase,
  confirmFailureText,
  deferralText,
  type EngineId,
  type EventBody,
  engineDeferral,
  engineName,
  failureWords,
  type JobFailure,
  postWaitText,
  pushedText,
  type Review,
  type ReviewJob,
  type Round,
  type Run,
  type RunPosting,
  type Service,
  SHARED_APP,
  type State,
  sameDeferral,
  shortSha,
  skipText,
  type Trigger,
  twoDigits,
} from "@lookover/contracts";
import { localDay } from "./local-day.ts";

const TRIGGER: Record<Trigger, string> = {
  opened: "on opening",
  push: "after a push",
  comment: "asked on GitHub",
  manual: "asked in the app",
  "first-review": "the setup's first review",
};

/** Who asked on GitHub (ADR 0081): the agent, through `lookover wait`, or the owner by hand. */
const ASKED: Record<AskedBy, string> = {
  agent: "asked by the agent on GitHub",
  person: "asked on GitHub",
};

/** Who joined a job with a request (ADR 0081): "review asked for by the agent on GitHub". */
const ASKED_FOR: Record<AskedBy, string> = {
  agent: "asked for by the agent on GitHub",
  person: "asked for on GitHub",
};

/** What asked for a new job: its trigger, and for a request comment, who wrote it (none named on an old job). */
function askedText(job: ReviewJob): string {
  const by = job.askedBy ?? null;
  return job.trigger === "comment" && by !== null ? ASKED[by] : TRIGGER[job.trigger];
}

/** `until` in local time: "11:00" on the day of `at`, "2026-10-12 09:00" on another. */
function timeOf(until: number, at: number): string {
  const date = new Date(until);
  const time = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  const day = localDay(until);
  return day === localDay(at) ? time : `${day} ${time}`;
}

const plural = (n: number, one: string) => (n === 0 ? `no ${one}s` : n === 1 ? `1 ${one}` : `${n} ${one}s`);

/** Why a job failed, with what the module that failed said, for the record. */
function failedText(failure: JobFailure | null): string {
  const why = failureWords(failure).phrase;
  return failure === null || failure.detail === "" ? why : `${why} (${failure.detail})`;
}

/**
 * A job now queued, given the same job as it was: new, back from a wait, run again after a restart (only a restart puts
 * a running job back in the queue), moved to a newer commit, or nothing new. The first request that asked for a job
 * (ADR 0081) says who asked, before what else it did: "review asked for on GitHub, moved to b2e8d1f".
 */
function queuedLine(job: ReviewJob, same: ReviewJob | null): string | null {
  if (same === null) return `review queued (${askedText(job)}) for ${shortSha(job.sha)}`;
  const moved = queuedMove(job, same);
  if (job.askedBy && !same.askedBy) {
    const asked = `review ${ASKED_FOR[job.askedBy]}`;
    return moved === null ? asked : `${asked}, ${moved}`;
  }
  return moved === null ? null : `review ${moved}`;
}

/** What brought the same job back to the queue or moved it: null when nothing did. */
function queuedMove(job: ReviewJob, same: ReviewJob): string | null {
  // Running to queued is only the restart's `interrupted` end (`queue.recover`): a new way back to the queue from a
  // running job needs its own line here.
  if (same.state === "running") return "runs again: the service stopped while it ran";
  if (same.state === "deferred") return "back in the queue";
  return same.sha === job.sha ? null : `moved to ${shortSha(job.sha)}`;
}

/** The change's line for its job's new state, given the job it had: null when nothing a reader looks for moved. */
function jobLine(job: ReviewJob, was: ReviewJob | null): string | null {
  const same = was !== null && was.id === job.id ? was : null;
  switch (job.state) {
    case "queued":
      return queuedLine(job, same);
    case "deferred":
      if (job.deferral === null) return null;
      if (same?.state === "deferred" && sameDeferral(same.deferral, job.deferral)) return null;
      return `review waits: ${deferralText(job.deferral)}`;
    case "skipped":
      return job.skip === null ? "review skipped" : `review skipped: ${skipText(job.skip)}`;
    case "cancelled":
      return job.cancel === null ? "review cancelled" : `review cancelled: ${cancelPhrase(job.cancel)}`;
    case "failed":
      return `review failed: ${failedText(job.failure)}`;
    case "running":
    case "done":
      return null;
  }
}

/** Who finds and who double-checks a run, with its depth: "standard: Codex finds, Claude double-checks". */
function crewOf(run: Run): string {
  const depth = run.secondFinder !== null ? "deep" : run.confirmer === null ? "quick" : "standard";
  const finders =
    run.secondFinder === null
      ? `${engineName(run.reviewer)} finds`
      : `${engineName(run.reviewer)} and ${engineName(run.secondFinder)} find`;
  const confirms =
    run.confirmer === null ? "nobody double-checks" : `${engineName(run.confirmer)} double-checks`;
  return `${depth}${run.preview ? ", a preview" : ""}: ${finders}, ${confirms}`;
}

/** What failed in a round that still landed: Deep's second find, the confirm pass. */
function roundFailures(round: Round): string {
  const failed: string[] = [];
  if (round.secondFind?.failure != null)
    failed.push(
      `second find failed: ${confirmFailureText(round.secondFind.failure, round.secondFind.engine)}`,
    );
  if (round.confirmFailure !== null && round.confirmer !== null)
    failed.push(`not double-checked: ${confirmFailureText(round.confirmFailure, round.confirmer)}`);
  return failed.map((f) => `; ${f}`).join("");
}

/** A change listed open, given the one shown before: new, a draft marked ready, or seen again as it was. */
function openedLine(change: Change, was: Change | undefined): string | null {
  if (was === undefined)
    return `${change.id} opened ${change.draft ? "as a draft " : ""}by ${change.openedBy}: ${change.title}`;
  return was.draft && !change.draft ? `${change.id} marked ready for review` : null;
}

/** A round through posting: posted, kept as a preview, or kept with its posts given up. */
function roundLine(round: Round, job: ReviewJob, preview: boolean): string {
  const open = plural(round.open, "open finding");
  if (job.state === "failed") return `kept, its posts given up: ${failedText(job.failure)}`;
  if (preview) return `kept as a preview: ${open}`;
  return `posted: ${open}${roundFailures(round)}`;
}

/**
 * A round's outbox as it now is, given the running review as it was: a new wait (a post the host refused for a moment,
 * until when and why) is said; a post sent, the same wait again or a wait over say nothing (the round's line follows).
 */
function postingLine(posting: RunPosting, was: Review | undefined, at: number): string | null {
  const { wait } = posting;
  const before = was?.run?.posting?.wait ?? null;
  if (wait === null || (before !== null && before.until === wait.until && before.refusal === wait.refusal))
    return null;
  const n = (was?.rounds.length ?? 0) + 1;
  return `round ${n} posts wait: ${postWaitText(wait.refusal, `at ${timeOf(wait.until, at)}`)} (${posting.sent} of ${posting.owed} sent)`;
}

/** The service's pause as it now is, given the one before: paused until when, resumed, or nothing moved. */
function pauseLine(paused: Service["paused"] | undefined, was: Service["paused"], at: number): string | null {
  if (paused === undefined) return null;
  if (paused === null) return was === null ? null : "reviews resumed";
  return `reviews paused until ${paused.until === null ? "resumed" : timeOf(paused.until, at)}`;
}

function engineLine(
  id: EngineId,
  patch: { state?: State["engines"][EngineId]["state"]; limitUntil?: number | null },
  was: State["engines"][EngineId],
  at: number,
): string | null {
  const state = patch.state ?? was.state;
  const until = patch.limitUntil === undefined ? was.limitUntil : patch.limitUntil;
  const moved = state !== was.state || (state === "limit" && until !== was.limitUntil);
  if (!moved) return null;
  if (state === "ready") return `${engineName(id)} is ready`;
  const words = deferralText(engineDeferral(id, state));
  if (state !== "limit") return words;
  return `${words} until ${until === null ? "it resets" : timeOf(until, at)}`;
}

/** The installation's lines (ADR 0053): what GitHub's refusal of the shared App's installations says. */
export const installationLines = {
  /** The shared App reaches no account of `person`'s sign-in (ADR 0066). */
  notReached: (person: string) =>
    `${SHARED_APP.slug} is installed on none of the accounts ${person} reaches: install it on GitHub`,
} as const;

/** The sign-in to the shared App's lines (ADR 0066): how a device code ended; never the code or a token. */
export const signInLines = {
  /** The code was entered: `person` is signed in. */
  signedIn: (person: string) => `signed in to GitHub as ${person}`,
  /** The code ran out before it was entered. */
  expired: "the GitHub sign-in code expired before it was entered",
  /** The person refused on GitHub's page. */
  denied: "the GitHub sign-in was refused on GitHub",
  /** The sign-in was given up from the app. */
  cancelled: "the GitHub sign-in was cancelled",
  /** GitHub refused a poll for good, saying `why`. */
  refused: (why: string) => `the GitHub sign-in stopped: ${why}`,
  /** A poll GitHub couldn't answer for now, saying `why`: polled again. */
  unanswered: (why: string) => `GitHub didn't answer the sign-in's poll, trying again: ${why}`,
  /** The sign-in was made and not kept, saying `why`. */
  notKept: (why: string) => `the GitHub sign-in was not kept: ${why}`,
} as const;

/**
 * The log file's line for `event`, given the state before it (ADR 0055): what happened to a change, its review, the
 * service's pause or an engine, in one line that starts with what it is about; null for an event that changes none of
 * these, or changes nothing the file says (the same wait again, a change seen again as it was).
 */
export function logLineOf(event: EventBody, before: State): string | null {
  switch (event.type) {
    case "change.opened":
      return openedLine(event.change, before.changes[event.change.id]);
    case "change.pushed":
      return `${event.changeId} ${pushedText(event.by, event.commits)}, now at ${shortSha(event.sha)}`;
    case "change.closed":
      return `${event.changeId} closed`;
    case "job.changed": {
      const line = jobLine(event.job, before.reviews[event.changeId]?.job ?? null);
      return line === null ? null : `${event.changeId} ${line}`;
    }
    case "run.started": {
      const n = (before.reviews[event.changeId]?.rounds.length ?? 0) + 1;
      return `${event.changeId} round ${n} started on ${shortSha(event.run.sha)}, ${crewOf(event.run)}`;
    }
    case "round.finished":
      return `${event.changeId} round ${event.round.n} ${roundLine(event.round, event.job, event.preview)}`;
    case "finding.dismissed":
      return `${event.changeId} ${event.findingIds.join(", ")} marked wrong by you`;
    case "service.changed":
      return pauseLine(event.patch.paused, before.service.paused, event.at);
    case "engine.changed":
      return engineLine(event.id, event.patch, before.engines[event.id], event.at);
    case "run.posting": {
      const line = postingLine(event.posting, before.reviews[event.changeId], event.at);
      return line === null ? null : `${event.changeId} ${line}`;
    }
    case "clock":
    case "state.replaced":
    case "setup.changed":
    case "connection.changed":
    case "settings.changed":
    case "repo.changed":
    case "repo.added":
    case "repo.removed":
    case "repo.dismissed":
    case "rule.changed":
    case "rules.changed":
    case "run.step":
    case "run.activity":
      return null;
  }
}
