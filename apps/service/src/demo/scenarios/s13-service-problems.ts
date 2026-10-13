// S13 "Service problems" (ADR 0046): each problem said plainly, with its one fix. Forty seconds after the room is
// handed over, GitHub stops answering for two and a half minutes: the connection shows disconnected, "Reconnect
// GitHub" is refused while it is down and finds it once it is back. #200 was reviewed forty minutes before, so the
// repository is quiet and polled once a minute: "Reconnect GitHub" comes back sooner than the next poll. Six
// minutes in, both AIs' programs are gone; two minutes later they are installed again, which the service sees only
// when the owner presses "Check again". The service stopping is not a problem shown here: a stopped service can't
// be reached from its UI. Every diff is hand-written fixture data a review reads; nothing here is a real recording.
import { commitSha } from "@lookover/contracts";
import type { Scenario, ScenarioChange } from "../scenario.ts";
import { MIN, OWNER, SHORT_FIND_MS, unified } from "./ledger-api.ts";
import { SANDBOX } from "./sandbox.ts";

const TIMEOUT = unified(
  "diff --git a/src/http.ts b/src/http.ts",
  "--- a/src/http.ts",
  "+++ b/src/http.ts",
  "@@ -1,3 +1,3 @@",
  " export function post(url: string, body: unknown): Promise<Response> {",
  '-  return fetch(url, { method: "POST", body: JSON.stringify(body) });',
  '+  return fetch(url, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });',
  " }",
);

const CHANGES: ScenarioChange[] = [
  {
    number: 200,
    title: "Give up on a webhook call after ten seconds",
    branch: "post-timeout",
    author: OWNER,
    commits: [
      {
        sha: commitSha("200a1b2c3d4e5f60718293a4b5c6d7e8f9001122"),
        message: "Give up on a webhook call after ten seconds",
        diff: TIMEOUT,
        find: {
          notes: "A timeout on the one call.",
          findings: [],
          emptyReason: "The call now ends after ten seconds; its callers already handle a failure.",
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
];

export const S13: Scenario = {
  id: "S13",
  title: "Service problems",
  what: "GitHub out of reach, then both AIs missing: each problem said plainly, with its one fix.",
  steps: [
    "In 40 seconds GitHub stops answering: the status pill says so.",
    "“Reconnect GitHub” fails while it is down; two and a half minutes later it works.",
    "At 6 minutes both AIs are missing; they are installed again two minutes later.",
    "“Check again” finds them.",
  ],
  later: "",
  path: "/",
  world: SANDBOX,
  changes: CHANGES,
  script: [
    { at: 1 * MIN, move: { kind: "open", change: 200 } },
    { at: 40 * MIN + 40_000, move: { kind: "refuse", failure: "unavailable", forMs: 150_000 } },
    { at: 46 * MIN, move: { kind: "missing", engine: "claude" } },
    { at: 46 * MIN, move: { kind: "missing", engine: "codex" } },
    { at: 48 * MIN, move: { kind: "installed", engine: "claude", version: "2.4.1" } },
    { at: 48 * MIN, move: { kind: "installed", engine: "codex", version: "0.162.1" } },
  ],
  seed: 40 * MIN,
};
