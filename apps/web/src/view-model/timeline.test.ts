// What a review's history and its waits say. The snapshot keeps them as data; these are the only words for them.
import { expect, test } from "bun:test";
import { commitSha, type Deferral, findingId, type Service, type TimelineEntry } from "@lookover/contracts";
import { deferralText, waitingNotice } from "./deferral.ts";
import { clock } from "./format.ts";
import { logLine, startedBy, timelineText } from "./timeline.ts";

const NOW = Date.UTC(2026, 9, 6, 10, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const SHA = commitSha("a1f9c2e");

const CHANGE = { openedBy: "sam" };

/** What a deferred review's notice reads beside its deferral: the service's clock, the pause, each AI's limit. */
function around(paused: Service["paused"], codexUntil: number | null = null) {
  return { now: NOW, paused, engines: { claude: { limitUntil: null }, codex: { limitUntil: codexUntil } } };
}

const DEFERRALS: [Deferral, string, string][] = [
  [{ reason: "paused" }, "reviews are paused", "Reviews are paused. This one starts when you resume."],
  [
    { reason: "connection" },
    "GitHub is disconnected",
    "GitHub is disconnected. This review starts when it is back.",
  ],
  [
    { reason: "engine-signed-out", engine: "claude" },
    "Claude is signed out",
    "Claude is signed out. This review starts by itself once you sign in.",
  ],
  [
    { reason: "engine-missing", engine: "codex", unusable: null },
    "Codex is not installed",
    "Codex is not installed. This review starts by itself once it is.",
  ],
  [
    {
      reason: "engine-missing",
      engine: "codex",
      unusable: { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" },
    },
    "Codex 0.161.0 is too old for gpt-6.1-sol",
    "Codex 0.161.0 is too old for gpt-6.1-sol. This review starts by itself once it is updated.",
  ],
  [
    {
      reason: "engine-missing",
      engine: "codex",
      unusable: { kind: "signed-in-otherwise", how: "an API key" },
    },
    "Codex is signed in with an API key, not ChatGPT",
    "Codex is signed in with an API key, not ChatGPT. This review starts by itself once you sign in with ChatGPT.",
  ],
  [
    { reason: "engine-missing", engine: "claude", unusable: { kind: "npm-launcher" } },
    "only npm's claude launcher was found",
    "Only npm's claude launcher was found. This review starts by itself once the native program is installed.",
  ],
  [
    { reason: "engine-limit", engine: "codex" },
    "Codex reached its limit",
    "Codex reached its limit. This review starts when the limit resets.",
  ],
  [
    { reason: "engine-failed-self-test", engine: "claude" },
    "Claude didn't pass Lookover's safety check",
    "Claude didn't pass Lookover's safety check. This review starts by itself once a version passes it.",
  ],
];

test("a deferral is said one way: what the review waits for, then when it starts", () => {
  for (const [deferral, text, notice] of DEFERRALS) {
    expect([deferral, deferralText(deferral), waitingNotice(deferral, around(null))]).toEqual([
      deferral,
      text,
      notice,
    ]);
  }
});

test("a review waiting on a timed pause says until when (ADR 0040)", () => {
  const paused = { since: NOW - MIN, until: NOW + HOUR };
  expect(waitingNotice({ reason: "paused" }, around(paused))).toMatch(
    /^Reviews are paused until \d\d:\d\d\. This one starts then\.$/,
  );
  // A pause until resumed, or any other wait, says nothing about the clock.
  expect(waitingNotice({ reason: "paused" }, around({ since: NOW - MIN, until: null }))).toBe(
    "Reviews are paused. This one starts when you resume.",
  );
  expect(waitingNotice({ reason: "connection" }, around(paused))).toBe(
    "GitHub is disconnected. This review starts when it is back.",
  );
});

test("a review waiting on an AI's limit says when it starts, with the day when it isn't today (ADR 0055)", () => {
  const limit: Deferral = { reason: "engine-limit", engine: "codex" };
  const notice = (until: number | null) => waitingNotice(limit, around(null, until));
  // bun test runs in UTC: the service's clock reads 10:00 on Tuesday 6 October.
  expect([
    notice(Date.UTC(2026, 9, 6, 14, 5)),
    notice(Date.UTC(2026, 9, 7, 9, 0)),
    notice(Date.UTC(2026, 9, 8, 10, 11)),
    notice(null),
  ]).toEqual([
    "Codex reached its limit. This review starts at 14:05.",
    "Codex reached its limit. This review starts tomorrow at 09:00.",
    "Codex reached its limit. This review starts on Thu 8 Oct at 10:11.",
    "Codex reached its limit. This review starts when the limit resets.",
  ]);
});

test("each timeline entry reads as one line of the review's history", () => {
  const cases: [TimelineEntry, string][] = [
    [{ at: NOW, sha: SHA, kind: "opened", by: "sam" }, "Opened by sam"],
    [{ at: NOW, sha: SHA, kind: "pushed", by: "you", commits: 1 }, "sam pushed 1 commit"],
    [{ at: NOW, sha: SHA, kind: "pushed", by: "agent", commits: 2 }, "The agent pushed 2 commits"],
    // The service's host says only that the head moved, not how many commits (`commits: 0`).
    [{ at: NOW, sha: SHA, kind: "pushed", by: "you", commits: 0 }, "sam pushed new commits"],
    [{ at: NOW, sha: null, kind: "queued", trigger: "opened" }, "Pull request opened"],
    [{ at: NOW, sha: null, kind: "queued", trigger: "push" }, "New commits pushed"],
    [
      { at: NOW, sha: null, kind: "queued", trigger: "comment" },
      "Review asked for on GitHub (/lookover review)",
    ],
    [{ at: NOW, sha: null, kind: "queued", trigger: "manual" }, "Review asked for in the app"],
    [{ at: NOW, sha: null, kind: "queued", trigger: "first-review" }, "First review, picked during setup"],
    [
      { at: NOW, sha: null, kind: "deferred", deferral: { reason: "engine-signed-out", engine: "codex" } },
      "Waiting: Codex is signed out",
    ],
    [{ at: NOW, sha: null, kind: "deferred", deferral: { reason: "paused" } }, "Waiting: reviews are paused"],
    [{ at: NOW, sha: null, kind: "skipped" }, "Skipped"],
    [{ at: NOW, sha: SHA, kind: "started", round: 2 }, "Round 2 started"],
    [{ at: NOW, sha: SHA, kind: "posted", round: 1, open: 0 }, "Round 1 done: No open findings"],
    [{ at: NOW, sha: SHA, kind: "posted", round: 2, open: 1 }, "Round 2 done: 1 open finding"],
    [{ at: NOW, sha: SHA, kind: "posted", round: 3, open: 4 }, "Round 3 done: 4 open findings"],
    [{ at: NOW, sha: null, kind: "dismissed", findingIds: [findingId("F2")] }, "You marked F2 as wrong"],
    [
      { at: NOW, sha: null, kind: "dismissed", findingIds: [findingId("F2"), findingId("F3")] },
      "You marked F2 and F3 as wrong",
    ],
    [
      {
        at: NOW,
        sha: null,
        kind: "dismissed",
        findingIds: [findingId("F2"), findingId("F3"), findingId("F5")],
      },
      "You marked F2, F3 and F5 as wrong",
    ],
  ];
  for (const [entry, text] of cases) {
    expect([entry, timelineText(CHANGE, entry)]).toEqual([entry, text]);
  }
});

test("a review was started by what asked for its first job; before any, by the pull request opening", () => {
  expect(startedBy([])).toBe("Pull request opened");
  expect(
    startedBy([
      { at: NOW, sha: SHA, kind: "opened", by: "sam" },
      { at: NOW, sha: null, kind: "queued", trigger: "manual" },
      { at: NOW, sha: null, kind: "queued", trigger: "comment" },
    ]),
  ).toBe("Review asked for in the app");
});

test("a log line names its commit by the first seven characters, as the rounds do", () => {
  const whole = commitSha("a1f9c2e0b4d6f8a1c3e5b7d9f1a3c5e7b9d1f3a5");
  const line = logLine(CHANGE, { at: NOW, sha: whole, kind: "started", round: 1 });
  expect(line).toBe(`${clock(NOW)}  Round 1 started  (a1f9c2e)`);
  expect(logLine(CHANGE, { at: NOW, sha: null, kind: "skipped" })).toBe(`${clock(NOW)}  Skipped`);
});
