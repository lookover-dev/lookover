// S8 "Pause and resume" (ADR 0046): one review done this morning, then reviews paused for an hour, as from the
// pill, as the room is handed over. Two pull requests arrive while paused: the agent opens #161 (written by
// Claude, so Codex finds) two minutes on, and the owner opens #162 (so Claude finds) a minute later. Both wait;
// resumed, they run one after the other, since each review holds both AIs (one finds, the other is there to
// double-check), and come back clean. "Run all checks" then reads everything again. Every diff is hand-written
// fixture data a review reads; nothing here is a real recording.
import { commitSha } from "@lookover/contracts";
import type { Scenario, ScenarioChange } from "../scenario.ts";
import { BY_CLAUDE, MIN, OWNER, SHORT_FIND_MS, unified } from "./ledger-api.ts";
import { SANDBOX } from "./sandbox.ts";

const DUE_DATE = unified(
  "diff --git a/src/invoices/row.ts b/src/invoices/row.ts",
  "--- a/src/invoices/row.ts",
  "+++ b/src/invoices/row.ts",
  "@@ -3,6 +3,7 @@ export function rowOf(invoice: Invoice): Row {",
  "   return {",
  "     id: invoice.id,",
  "     total: formatCents(invoice.total),",
  "+    due: formatDate(invoice.dueAt),",
  "     issued: formatDate(invoice.issuedAt),",
  "   };",
  " }",
);

const RATES_RETRY = unified(
  "diff --git a/src/rates/fetch.ts b/src/rates/fetch.ts",
  "--- a/src/rates/fetch.ts",
  "+++ b/src/rates/fetch.ts",
  "@@ -1,6 +1,11 @@",
  ' import { get } from "../http.ts";',
  " ",
  " export async function fetchRates(day: string): Promise<Rates> {",
  '-  return (await get("/rates/" + day)).json();',
  '+  const first = await get("/rates/" + day);',
  "+  if (first.ok) return first.json();",
  '+  const second = await get("/rates/" + day);',
  '+  if (!second.ok) throw new Error("No rates for " + day + ": " + second.status);',
  "+  return second.json();",
  " }",
);

const TOTALS_RENAME = unified(
  "diff --git a/src/invoices/sum.ts b/src/invoices/totals.ts",
  "similarity index 100%",
  "rename from src/invoices/sum.ts",
  "rename to src/invoices/totals.ts",
  "diff --git a/src/invoices/list.ts b/src/invoices/list.ts",
  "--- a/src/invoices/list.ts",
  "+++ b/src/invoices/list.ts",
  "@@ -1,3 +1,3 @@",
  ' import type { Invoice } from "./invoice.ts";',
  '-import { sumOf } from "./sum.ts";',
  '+import { sumOf } from "./totals.ts";',
  " ",
);

const CHANGES: ScenarioChange[] = [
  {
    number: 160,
    title: "Show the due date on each invoice row",
    branch: "due-date",
    author: OWNER,
    commits: [
      {
        sha: commitSha("0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293"),
        message: "Show the due date on each invoice row",
        diff: DUE_DATE,
        find: {
          notes: "One field added to the row, formatted like the others.",
          findings: [],
          emptyReason: "The due date is formatted as the issue date is.",
          usage: { inputTokens: 1_100, outputTokens: 120 },
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
  {
    number: 161,
    title: "Try the exchange rates once more before failing",
    branch: "rates-retry",
    author: OWNER,
    commits: [
      {
        sha: commitSha("1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6071829304"),
        message: `Try the exchange rates once more before failing\n\n${BY_CLAUDE}`,
        diff: RATES_RETRY,
        find: {
          notes: "One retry, and the error names the day and the status.",
          findings: [],
          emptyReason: "The second attempt is the only change, and its failure is said.",
          usage: { inputTokens: 1_300, outputTokens: 150 },
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
  {
    number: 162,
    title: "Rename the sum module to totals",
    branch: "totals-rename",
    author: OWNER,
    commits: [
      {
        sha: commitSha("2e3f4a5b6c7d8e9f0a1b2c3d4e5f607182930415"),
        message: "Rename the sum module to totals",
        diff: TOTALS_RENAME,
        find: {
          notes: "A rename and its one import.",
          findings: [],
          emptyReason: "The file moves unchanged and its only importer follows.",
          usage: { inputTokens: 900, outputTokens: 100 },
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
];

export const S8: Scenario = {
  id: "S8",
  title: "Pause and resume",
  what: "Reviews are paused. New pull requests wait, then run when you resume. “Run all checks” shows each result in the pill.",
  steps: [
    "Reviews are paused for an hour: the status pill says so.",
    "Two pull requests arrive in the next three minutes and wait.",
    "Resume from the pill: they run one after the other, each on both AIs, one finding and the other double-checking.",
    "Open the pill again and run all checks.",
  ],
  later: "",
  path: "/",
  world: SANDBOX,
  changes: CHANGES,
  script: [
    { at: 1 * MIN, move: { kind: "open", change: 160 } },
    { at: 5 * MIN, move: { kind: "command", command: { type: "service.pause", for: "hour" } } },
    { at: 7 * MIN, move: { kind: "open", change: 161 } },
    { at: 8 * MIN, move: { kind: "open", change: 162 } },
  ],
  seed: 5 * MIN,
};
