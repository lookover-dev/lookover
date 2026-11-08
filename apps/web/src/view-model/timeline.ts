// A review's history in words. The snapshot keeps each entry as data (`TimelineEntry`); this is what the
// review page's log and the simulated GitHub page say for it.
import {
  type AskedBy,
  failedTitle,
  pushedText,
  shortSha,
  type TimelineEntry,
  type Trigger,
  upperFirst,
} from "@lookover/contracts";
import { deferralText } from "./deferral.ts";
import { inSentence, logStamp, plural } from "./format.ts";

const TRIGGER_TEXT: Record<Trigger, string> = {
  opened: "Pull request opened",
  push: "New commits pushed",
  comment: "Review asked for on GitHub (/lookover review)",
  manual: "Review asked for in the app",
  "first-review": "First review, picked during setup",
};

/** Who wrote a review request comment (ADR 0081): the agent through `lookover wait`, or you by hand. */
const ASKED_TEXT: Record<AskedBy, string> = {
  agent: "The agent asked for a review",
  person: "You asked on GitHub",
};

/** What asked for a job: who, for a request comment that says; else its trigger (an entry stored before ADR 0081). */
const askedText = (trigger: Trigger, by: AskedBy | null): string =>
  trigger === "comment" && by !== null ? ASKED_TEXT[by] : TRIGGER_TEXT[trigger];

/** Findings by their ids, as a list in a sentence: "F2", "F2 and F3", "F2, F3 and F5". */
const listed = (ids: readonly string[]): string => inSentence(ids, "and");

export function timelineText(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "opened":
      return `Opened by ${entry.by}`;
    case "pushed":
      // An entry stored before ADR 0081 may say "you": no one is named.
      return upperFirst(pushedText(entry.by === "agent" ? "agent" : null, entry.commits));
    case "queued":
      return askedText(entry.trigger, entry.by ?? null);
    case "asked":
      return ASKED_TEXT[entry.by];
    case "deferred":
      return `Waiting: ${deferralText(entry.deferral)}`;
    case "skipped":
      return "Skipped";
    case "started":
      return `Round ${entry.round} started`;
    case "posted":
      return `Round ${entry.round} done: ${entry.open === 0 ? "No open findings" : plural(entry.open, "open finding")}`;
    case "failed":
      // As the check on GitHub says it (ADR 0081).
      return failedTitle(entry.failure);
    case "dismissed":
      return `You marked ${listed(entry.findingIds)} as wrong`;
  }
}

/**
 * One line of the review page's log: when (its day too when not `now`'s, ADR 0081), what happened, then the commit by
 * its first seven characters.
 */
export function logLine(entry: TimelineEntry, now: number, timeZone?: string): string {
  const commit = entry.sha ? `  (${shortSha(entry.sha)})` : "";
  return `${logStamp(now, entry.at, timeZone)}  ${timelineText(entry)}${commit}`;
}

/** What asked for the review: its first job's trigger, and who for a request comment. */
export function startedBy(timeline: TimelineEntry[]): string {
  const first = timeline.find((t) => t.kind === "queued");
  return first?.kind === "queued" ? askedText(first.trigger, first.by ?? null) : TRIGGER_TEXT.opened;
}
