// What the screens say about a run and its steps: one wording, used by the row, the review page and the
// simulated GitHub check.
import { expect, test } from "bun:test";
import {
  changeId,
  commitSha,
  type EngineId,
  emptyReview,
  type Review,
  type Round,
  type RunStep,
  runId,
} from "@lookover/contracts";
import {
  confirmerOf,
  confirmSkipped,
  postingText,
  runLine,
  runLineParts,
  runSteps,
  stepListText,
  stepNow,
  stepSkippedText,
  stepTime,
} from "./run.ts";

const NOW = Date.UTC(2026, 9, 6, 10, 0, 0);

function running(
  step: RunStep,
  startedAgoMs: number,
  preview = false,
  confirmer: EngineId | null = "claude",
  steps: RunStep[] = [],
): Review {
  return {
    ...emptyReview(changeId("app#1"), NOW),
    preview,
    run: {
      id: runId("run-1"),
      reviewer: "claude",
      secondFinder: null,
      confirmer,
      confirmFallback: null,
      sha: commitSha("a1f9c2e"),
      preview,
      startedAt: NOW - startedAgoMs,
      step,
      stepAt: NOW,
      steps: steps.map((s) => ({ step: s, ms: 1_000 })),
      activities: [],
      posting: null,
    },
  };
}

/** A review whose last round, done, went through `steps`. */
function done(steps: RunStep[]): Review {
  const round: Round = {
    n: 1,
    sha: commitSha("a1f9c2e"),
    reviewer: "claude",
    secondFind: null,
    confirmer: steps.includes("confirming") ? "codex" : null,
    confirmFallback: null,
    confirmFailure: null,
    ruledOut: [],
    startedAt: NOW,
    endedAt: NOW,
    raised: 0,
    verifiedFixed: 0,
    open: 0,
    steps: steps.map((s) => ({ step: s, ms: 1_000 })),
    sessions: [],
  };
  return { ...emptyReview(changeId("app#1"), NOW), rounds: [round] };
}

test("each step is said three ways: as it runs in a line, as it runs in the list, and once done", () => {
  const cases: [RunStep, string, string, string][] = [
    ["preparing", "getting the changes", "Getting the changes", "Got the changes"],
    [
      "finding",
      "reading the code",
      "Codex is reading the code and looking for problems",
      "Codex read the code and looked for problems",
    ],
    [
      "confirming",
      "double-checking findings",
      "Codex is double-checking each new finding",
      "Codex double-checked each new finding",
    ],
    ["publishing", "posting on GitHub", "Posting on GitHub", "Posted on GitHub"],
  ];
  for (const [step, now, doing, did] of cases) {
    expect([step, stepNow(step), stepListText(step, "Codex")]).toEqual([step, now, { doing, did }]);
  }
});

test("a running review's line says its step and how long the run has taken", () => {
  expect(runLine(NOW, running("finding", 72_000))).toBe("reading the code · 1:12");
  expect(runLine(NOW, running("preparing", 0))).toBe("getting the changes · 0:00");
});

test("a running review's line comes in its two parts, so its time can sit in a running time's cell", () => {
  expect(runLineParts(NOW, running("finding", 72_000))).toEqual({ doing: "reading the code", time: "1:12" });
  expect(runLineParts(NOW, running("finding", 3_723_000)).time).toBe("1:02:03");
});

test("a run's time counts past the hour in hours", () => {
  expect(runLine(NOW, running("finding", 599_000))).toBe("reading the code · 9:59");
  expect(runLine(NOW, running("finding", 600_000))).toBe("reading the code · 10:00");
  expect(runLine(NOW, running("finding", 3_723_000))).toBe("reading the code · 1:02:03");
});

test("the running step's time counts from its start; a finished step keeps its recorded time", () => {
  const review = running("finding", 5_000, false, "claude", ["preparing"]);
  expect(stepTime(review, "finding", NOW + 61_000)).toBe("1:01");
  expect(stepTime(review, "preparing", NOW + 61_000)).toBe("0:01");
  expect(stepTime(review, "confirming", NOW + 61_000)).toBe("");
  expect(stepTime(done(["preparing", "finding"]), "finding", NOW + 3_600_000)).toBe("0:01");
});

test("a preview never posts, so it has no posting step", () => {
  expect(runSteps(running("finding", 0))).toEqual(["preparing", "finding", "confirming", "publishing"]);
  expect(runSteps(running("finding", 0, true))).toEqual(["preparing", "finding", "confirming"]);
});

test("the confirm step keeps its row from start to end, so the list never changes length (ADR 0044)", () => {
  const all: RunStep[] = ["preparing", "finding", "confirming", "publishing"];
  expect(runSteps(running("finding", 0, false, null))).toEqual(all);
  expect(runSteps(running("publishing", 0, false, "claude", ["preparing", "finding"]))).toEqual(all);
  expect(runSteps(done(["preparing", "finding", "confirming", "publishing"]))).toEqual(all);
  expect(runSteps(done(["preparing", "finding", "publishing"]))).toEqual(all);
});

test("a confirm step that didn't run says there was nothing new to double-check, running or done", () => {
  expect(confirmSkipped(running("publishing", 0, false, "claude", ["preparing", "finding"]))).toBe(true);
  expect(
    confirmSkipped(running("publishing", 0, false, "claude", ["preparing", "finding", "confirming"])),
  ).toBe(false);
  expect(confirmSkipped(running("finding", 0, false, "claude", ["preparing"]))).toBe(false);
  // No confirmer planned: it never runs.
  expect(confirmSkipped(running("finding", 0, false, null, ["preparing"]))).toBe(true);
  expect(confirmSkipped(done(["preparing", "finding", "publishing"]))).toBe(true);
  expect(confirmSkipped(done(["preparing", "finding", "confirming", "publishing"]))).toBe(false);
  expect(stepSkippedText("confirming")).toBe("Nothing new to double-check");
});

test("the step list names the confirmer at the confirm step, the finder elsewhere", () => {
  expect(confirmerOf(running("finding", 0, false, "codex"))).toBe("codex");
  expect(confirmerOf(done(["preparing", "finding", "confirming", "publishing"]))).toBe("codex");
  expect(confirmerOf(done(["preparing", "finding", "publishing"]))).toBeNull();
});

test("the posting step says how many posts are sent of the round's, and while GitHub makes it wait, until when and why (ADR 0055)", () => {
  // 14:05 in the machine's own zone, as the app shows times.
  const at = new Date(2026, 9, 6, 14, 5).getTime();
  const now = new Date(2026, 9, 6, 14, 0).getTime();
  expect(postingText(null, now)).toBe("Posting on GitHub");
  expect(postingText({ sent: 0, owed: 4, wait: null }, now)).toBe("Posted 0 of 4.");
  expect(postingText({ sent: 2, owed: 4, wait: { until: at, refusal: "rate_limited" } }, now)).toBe(
    "Posted 2 of 4. GitHub asked to wait, trying again at 14:05.",
  );
  expect(postingText({ sent: 1, owed: 5, wait: { until: at, refusal: "unavailable" } }, now)).toBe(
    "Posted 1 of 5. GitHub did not answer, trying again at 14:05.",
  );
  // A wait past midnight says its day, as every time the app shows against the service's clock does.
  const late = new Date(2026, 9, 6, 23, 59).getTime();
  expect(
    postingText({ sent: 1, owed: 5, wait: { until: at + 86_400_000, refusal: "unavailable" } }, late),
  ).toBe("Posted 1 of 5. GitHub did not answer, trying again tomorrow at 14:05.");
});
