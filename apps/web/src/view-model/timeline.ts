// A review's history in words. The snapshot keeps each entry as data (`TimelineEntry`); this is what the
// review page's log and the simulated GitHub page say for it.
import { type Change, shortSha, type TimelineEntry, type Trigger } from "@lookover/contracts";
import { deferralText } from "./deferral.ts";
import { clock, plural } from "./format.ts";

const TRIGGER_TEXT: Record<Trigger, string> = {
  opened: "Pull request opened",
  push: "New commits pushed",
  comment: "Review asked for on GitHub (/lookover review)",
  manual: "Review asked for in the app",
  "first-review": "First review, picked during setup",
};

/** Findings by their ids, as a list in a sentence: "F2", "F2 and F3", "F2, F3 and F5". */
function listed(ids: readonly string[]): string {
  const last = ids.at(-1) ?? "";
  return ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${last}` : last;
}

export function timelineText(change: Pick<Change, "openedBy">, entry: TimelineEntry): string {
  switch (entry.kind) {
    case "opened":
      return `Opened by ${entry.by}`;
    case "pushed": {
      // The service's host says only that the head moved (`commits: 0`), not how many commits.
      const what = entry.commits > 0 ? plural(entry.commits, "commit") : "new commits";
      return `${entry.by === "agent" ? "The agent" : change.openedBy} pushed ${what}`;
    }
    case "queued":
      return TRIGGER_TEXT[entry.trigger];
    case "deferred":
      return `Waiting: ${deferralText(entry.deferral)}`;
    case "skipped":
      return "Skipped";
    case "started":
      return `Round ${entry.round} started`;
    case "posted":
      return `Round ${entry.round} done: ${entry.open === 0 ? "No open findings" : plural(entry.open, "open finding")}`;
    case "dismissed":
      return `You marked ${listed(entry.findingIds)} as wrong`;
  }
}

/** One line of the review page's log: the time, what happened, then the commit by its first seven characters. */
export function logLine(change: Pick<Change, "openedBy">, entry: TimelineEntry): string {
  const commit = entry.sha ? `  (${shortSha(entry.sha)})` : "";
  return `${clock(entry.at)}  ${timelineText(change, entry)}${commit}`;
}

/** What asked for the review: its first job's trigger. */
export function startedBy(timeline: TimelineEntry[]): string {
  const first = timeline.find((t) => t.kind === "queued");
  return TRIGGER_TEXT[first?.kind === "queued" ? first.trigger : "opened"];
}
