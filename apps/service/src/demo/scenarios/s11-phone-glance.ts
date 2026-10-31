// S11 "Phone glance" (ADR 0046): the app opened on a phone, reaching the service from another device (`remote`,
// demo-only until a server mode exists). Each session is view-only until "Unlock": the first action asks for it.
// Something to glance at: #180, the owner's, has a finding Codex confirmed, still to fix; #181 is being reviewed
// right now, Claude finding. Every diff is hand-written fixture data a review reads; nothing here is a real
// recording.
import { commitSha } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange } from "../scenario.ts";
import { CONFIRM_MS, FIND_MS, MIN, OWNER, unified } from "./ledger-api.ts";
import { SANDBOX } from "./sandbox.ts";

const REFUND_TOTAL = unified(
  "diff --git a/src/refunds/total.ts b/src/refunds/total.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/refunds/total.ts",
  "@@ -0,0 +1,7 @@",
  '+import type { Refund } from "./refund.ts";',
  "+",
  "+export function refundedOf(refunds: Refund[]): number {",
  "+  let total = 0;",
  "+  for (const refund of refunds) total += refund.amount;",
  "+  return total / 100;",
  "+}",
);

const EXPORT_CSV = unified(
  "diff --git a/src/invoices/export.ts b/src/invoices/export.ts",
  "--- a/src/invoices/export.ts",
  "+++ b/src/invoices/export.ts",
  "@@ -1,4 +1,5 @@",
  ' import type { Invoice } from "./invoice.ts";',
  " ",
  '-const COLUMNS = ["id", "total"];',
  '+const COLUMNS = ["id", "total", "due"];',
  '+export const SEPARATOR = ";";',
  " ",
);

const CHANGES: ScenarioChange[] = [
  {
    number: 180,
    title: "Show the refunded total on an invoice",
    branch: "refund-total",
    author: OWNER,
    commits: [
      {
        sha: commitSha("180a0b1c2d3e4f5061728394a5b6c7d8e9f00112"),
        message: "Show the refunded total on an invoice",
        diff: REFUND_TOTAL,
        find: {
          notes: "A sum over the refunds. One thing about its unit.",
          findings: [
            {
              path: "src/refunds/total.ts",
              line: 6,
              lineText: "  return total / 100;",
              severity: "should_fix",
              category: "correctness",
              title: "The total is returned in euros, every other amount in cents",
              body: "When the invoice adds this total to its own, the refunds count a hundred times less, because `refundedOf` divides by 100 and every other amount in the code stays in cents.",
              defectKey: "refund_total_in_euros",
              suggestion: "  return total;",
            },
          ],
          usage: { inputTokens: 1_400, outputTokens: 230 },
          tookMs: FIND_MS,
        },
        confirm: {
          verdicts: [
            {
              id: "C1",
              verdict: "confirmed",
              reason: "Invoice totals are cents everywhere else; this one alone is divided.",
              evidence: ["src/refunds/total.ts:6"],
              severity: "should_fix",
            },
          ],
          tookMs: CONFIRM_MS,
        },
      },
    ],
  },
  {
    number: 181,
    title: "Add the due date to the invoice export",
    branch: "export-due",
    author: OWNER,
    commits: [
      {
        sha: commitSha("181b1c2d3e4f5061728394a5b6c7d8e9f0011223"),
        message: "Add the due date to the invoice export",
        diff: EXPORT_CSV,
        find: {
          notes: "One more column.",
          findings: [],
          emptyReason: "A column added to the export; the rows fill it.",
          tookMs: FIND_MS,
        },
      },
    ],
  },
];

/** A pull request of the world's repository, by its number. */
const pr = on(SANDBOX.repo);

export const S11: Scenario = {
  id: "S11",
  title: "Phone glance",
  what: "The app on a phone, reaching the service from another device: you can look, and the first thing you do asks you to unlock.",
  steps: [
    "Open the phone preview.",
    "Look around: #180 has a finding to fix, #181 is being reviewed.",
    "Do anything, such as “Review now”: the app asks you to unlock.",
    "Unlock, then do it.",
  ],
  later: "Demo only: reaching the service from another device comes with a server mode.",
  path: "/",
  world: { ...SANDBOX, remote: true },
  changes: CHANGES,
  script: [
    { at: 2 * MIN, move: { kind: "open", change: pr(180) } },
    { at: 19 * MIN + 30_000, move: { kind: "open", change: pr(181) } },
  ],
  seed: 20 * MIN,
};
