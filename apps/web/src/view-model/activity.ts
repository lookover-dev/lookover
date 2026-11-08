// What the engine does while a round runs, in words (ADR 0055): Details › Log's live log, one line per activity, newest
// last, each with the AI that did it. Plain text only: a path, a pattern or a command is said as it came (the service
// filtered and cut it), never read as a link or markdown.
import { type EngineActivity, engineName, type Run } from "@lookover/contracts";
import { plural } from "./format.ts";

/** "Read src/invoices.ts": one activity in a line. */
export function activityText(activity: EngineActivity): string {
  switch (activity.kind) {
    case "read":
      return `Read ${activity.path}`;
    case "search":
      return `Searched for ${activity.pattern}`;
    case "list":
      return `Listed ${activity.pattern}`;
    case "command":
      return `Ran ${activity.text}`;
  }
}

/** One line of the live log: the AI's name and what it did. */
export interface LiveLogLine {
  who: string;
  text: string;
}

/**
 * The live log of a review: the running run's activities, oldest first; with none, the one line the block holds
 * instead (`empty`), so it is there, its height kept, before the engine did anything and once no round runs.
 */
export function liveLog(run: Pick<Run, "reviewer" | "activities"> | null): {
  lines: LiveLogLine[];
  empty: string | null;
} {
  if (run === null)
    return {
      lines: [],
      empty: "While a round runs, what the AI reads, searches and runs shows here.",
    };
  const lines = run.activities.map((a) => ({ who: engineName(a.engine), text: activityText(a.activity) }));
  return {
    lines,
    empty: lines.length > 0 ? null : `${engineName(run.reviewer)} hasn't opened anything yet.`,
  };
}

/**
 * Details › Log's summary, what its row says closed and open: the lines it shows, its history's `history` and, while
 * the live block has any, the run's ("3 lines, 7 live"), then that secrets were taken out.
 */
export function logSummary(history: number, run: Pick<Run, "activities"> | null): string {
  const live = run?.activities.length ?? 0;
  return `${plural(history, "line")}${live > 0 ? `, ${live} live` : ""} · secrets removed`;
}
