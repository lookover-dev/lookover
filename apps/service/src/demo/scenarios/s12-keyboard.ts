// S12 "Everything through the keyboard" (ADR 0046): the richest Home the service shows, to walk with `?`, Ctrl K
// and J/K. #190, the owner's, was reviewed this morning with a finding Codex confirmed, and the owner pushed a
// commit since: "Review again". Claude then signed out: #191, the owner's, waits on it, and Codex may step in
// (the status pill's "Send the waiting review to Codex", the reroute). #192, written by Claude, is being
// reviewed by Codex right now. The App is on all seven of the owner's repositories, the other six quiet. Every diff is hand-written fixture data a review reads; nothing here is a real
// recording.
import { commitSha } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange } from "../scenario.ts";
import { BY_CLAUDE, CONFIRM_MS, FIND_MS, MIN, OWNER, SHORT_FIND_MS, unified } from "./ledger-api.ts";
import { SANDBOX } from "./sandbox.ts";

const DISCOUNT = unified(
  "diff --git a/src/invoices/discount.ts b/src/invoices/discount.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/invoices/discount.ts",
  "@@ -0,0 +1,4 @@",
  "+/** The total after a discount of `percent`, in cents. */",
  "+export function discounted(cents: number, percent: number): number {",
  "+  return cents - cents * percent;",
  "+}",
);

const DISCOUNT_TESTED = unified(
  "diff --git a/src/invoices/discount.test.ts b/src/invoices/discount.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/invoices/discount.test.ts",
  "@@ -0,0 +1,6 @@",
  '+import { expect, test } from "bun:test";',
  '+import { discounted } from "./discount.ts";',
  "+",
  '+test("no discount keeps the total", () => {',
  "+  expect(discounted(1000, 0)).toBe(1000);",
  "+});",
  "diff --git a/src/invoices/discount.ts b/src/invoices/discount.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/invoices/discount.ts",
  "@@ -0,0 +1,4 @@",
  "+/** The total after a discount of `percent`, in cents. */",
  "+export function discounted(cents: number, percent: number): number {",
  "+  return cents - cents * percent;",
  "+}",
);

const CURRENCY_CODE = unified(
  "diff --git a/src/invoices/invoice.ts b/src/invoices/invoice.ts",
  "--- a/src/invoices/invoice.ts",
  "+++ b/src/invoices/invoice.ts",
  "@@ -2,4 +2,5 @@ export interface Invoice {",
  "   id: string;",
  "   total: number;",
  "+  currency: string;",
  "   issuedAt: number;",
  "   paidAt: number | null;",
);

const REMINDER_COPY = unified(
  "diff --git a/src/reminders/text.ts b/src/reminders/text.ts",
  "--- a/src/reminders/text.ts",
  "+++ b/src/reminders/text.ts",
  "@@ -1,3 +1,3 @@",
  " export function reminderOf(number: string): string {",
  '-  return "Invoice " + number + " is late.";',
  '+  return "Invoice " + number + " is due. Pay it from your account page.";',
  " }",
);

const CHANGES: ScenarioChange[] = [
  {
    number: 190,
    title: "Apply a discount to an invoice",
    branch: "discount",
    author: OWNER,
    commits: [
      {
        sha: commitSha("190c2d3e4f5061728394a5b6c7d8e9f001122334"),
        message: "Apply a discount to an invoice",
        diff: DISCOUNT,
        find: {
          notes: "A one-line helper. Its unit is off.",
          findings: [
            {
              path: "src/invoices/discount.ts",
              line: 3,
              lineText: "  return cents - cents * percent;",
              severity: "should_fix",
              category: "correctness",
              title: "A percent is used as a fraction",
              body: "When a 10 % discount is passed as 10, the total goes ten times below zero, because `percent` is multiplied as if it were 0.10.",
              defectKey: "percent_as_fraction",
              suggestion: "  return cents - (cents * percent) / 100;",
            },
          ],
          usage: { inputTokens: 900, outputTokens: 200 },
          tookMs: FIND_MS,
        },
        confirm: {
          verdicts: [
            {
              id: "C1",
              verdict: "confirmed",
              reason: "Named percent and documented as one; 10 gives a negative total.",
              evidence: ["src/invoices/discount.ts:1", "src/invoices/discount.ts:3"],
              severity: "should_fix",
            },
          ],
          tookMs: CONFIRM_MS,
        },
      },
      {
        sha: commitSha("190d3e4f5061728394a5b6c7d8e9f00112233445"),
        message: "Test the discount without one",
        diff: DISCOUNT_TESTED,
        find: {
          notes: "A test of the zero case; the helper is as reviewed.",
          findings: [],
          earlier: [{ id: "F1", present: true, why: "The helper still multiplies by the percent itself." }],
          emptyReason: "Nothing new; the earlier finding stands.",
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
  {
    number: 191,
    title: "Say which currency an invoice is in",
    branch: "invoice-currency",
    author: OWNER,
    commits: [
      {
        sha: commitSha("191e4f5061728394a5b6c7d8e9f0011223344556"),
        message: "Say which currency an invoice is in",
        diff: CURRENCY_CODE,
        find: {
          notes: "One field on the invoice.",
          findings: [],
          emptyReason: "A field added to the type; nothing reads it yet.",
          tookMs: FIND_MS,
        },
      },
    ],
  },
  {
    number: 192,
    title: "Kinder words in the payment reminder",
    branch: "reminder-copy",
    author: OWNER,
    commits: [
      {
        sha: commitSha("192f5061728394a5b6c7d8e9f001122334455667"),
        message: `Kinder words in the payment reminder\n\n${BY_CLAUDE}`,
        diff: REMINDER_COPY,
        find: {
          notes: "A sentence changes.",
          findings: [],
          emptyReason: "Only the reminder's words change.",
          tookMs: FIND_MS,
        },
      },
    ],
  },
];

/** A pull request of the world's repository, by its number. */
const pr = on(SANDBOX.repo);

export const S12: Scenario = {
  id: "S12",
  title: "Everything through the keyboard",
  what: "The fullest Home: a review waiting on Claude, one running, new commits on a reviewed pull request. Walk it with the keyboard.",
  steps: [
    "Press ? for the shortcuts.",
    "J and K move between rows; Enter opens one.",
    "Ctrl K opens the palette, to go anywhere or review a pull request.",
    "In the status pill, “Send the waiting review to Codex” moves #191.",
    "On #190, R reviews the new commit again.",
  ],
  later: "",
  path: "/",
  world: {
    ...SANDBOX,
    repositories: ["ledger-api", "ledger-web", "invoice-pdf", "mobile-app", "infra", "dotfiles"].map(
      (name) => ({
        owner: "sasensi",
        name,
      }),
    ),
  },
  changes: CHANGES,
  script: [
    { at: 1 * MIN, move: { kind: "open", change: pr(190) } },
    { at: 10 * MIN, move: { kind: "push", change: pr(190) } },
    { at: 12 * MIN, move: { kind: "sign-out", engine: "claude" } },
    { at: 20 * MIN, move: { kind: "open", change: pr(191) } },
    { at: 29 * MIN + 30_000, move: { kind: "open", change: pr(192) } },
  ],
  seed: 30 * MIN,
};
