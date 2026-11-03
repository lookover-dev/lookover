// S6 "New commits after a review" (ADR 0046): the owner's #153 "Add a due date to invoices", written by hand,
// was reviewed before the load: Claude found three, Codex confirmed them, round 1 posted. F2 sits on removed lines,
// the old file's 11 to 13, so the app shows a finding on the old side and on a range (#61); F3 on a file the pull
// request leaves as it was, so it has no line comment and the description lists it with its lines (ADR 0074). Thirty seconds on, the
// owner pushes two commits at once. A push by the owner asks for nothing (a review after every push is off by
// default), so the review stays done and the change shows two new commits; "Review again" asks for round 2, which
// finds the three fixed and settles.
import { commitSha } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange } from "../scenario.ts";
import { added, CONFIRM_MS, FIND_MS, LEDGER_API, MIN, OWNER, SHORT_FIND_MS, unified } from "./ledger-api.ts";

const OFF_BY_ONE = "  due.setDate(due.getDate() + terms.days - 1);";
const FIXED = "  due.setDate(due.getDate() + terms.days);";

/** `src/invoices/due.ts`: `line` sets the date; `named` is the export's name. */
const DUE = (line: string, named: string) => [
  'import type { Invoice, PaymentTerms } from "./invoice.ts";',
  "",
  "/** The day an invoice is due: its issue date plus the days its terms give. */",
  `export function ${named}(invoice: Invoice, terms: PaymentTerms): Date {`,
  "  const due = new Date(invoice.issuedAt);",
  line,
  "  return due;",
  "}",
];

const NEGATIVE_CHECK = "  if (account.termsDays < 0) {";

/** `src/invoices/reminders.ts`'s line 9, which this pull request leaves as it was: reminders count 30 days. */
const THIRTY_DAYS = "  const dueAt = addDays(invoice.issuedAt, 30);";

/** The fix the owner pushes: reminders count from the invoice's own due date. */
const REMINDERS_FIXED = unified(
  "diff --git a/src/invoices/reminders.ts b/src/invoices/reminders.ts",
  "--- a/src/invoices/reminders.ts",
  "+++ b/src/invoices/reminders.ts",
  "@@ -7,5 +7,5 @@ export function reminderDays(invoice: Invoice, terms: PaymentTerms): Date[] {",
  " ",
  " /** The days a reminder is sent: a week before the due date, then on it. */",
  `-${THIRTY_DAYS}`,
  "+  const dueAt = dueDateOf(invoice, terms);",
  "   return [addDays(dueAt, -7), dueAt];",
  " }",
);

/** `src/invoices/terms.ts` with its check on negative terms removed: the old file's lines 11 to 13. */
const UNCHECKED_TERMS = unified(
  "diff --git a/src/invoices/terms.ts b/src/invoices/terms.ts",
  "--- a/src/invoices/terms.ts",
  "+++ b/src/invoices/terms.ts",
  "@@ -8,8 +8,5 @@ export interface PaymentTerms {",
  " ",
  " /** The terms an account pays on. */",
  " export function termsOf(account: Account): PaymentTerms {",
  `-${NEGATIVE_CHECK}`,
  '-    throw new RangeError("Payment terms can\'t be negative.");',
  "-  }",
  "   return { days: account.termsDays };",
  " }",
);

const DUE_DATE: ScenarioChange = {
  number: 153,
  title: "Add a due date to invoices",
  branch: "invoice-due-date",
  author: OWNER,
  commits: [
    {
      sha: commitSha("d0e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6"),
      message: "Add a due date to invoices",
      diff: added("src/invoices/due.ts", DUE(OFF_BY_ONE, "dueDate")) + UNCHECKED_TERMS,
      find: {
        notes: "Small and clear. Two things.",
        findings: [
          {
            path: "src/invoices/due.ts",
            line: 6,
            lineText: OFF_BY_ONE,
            severity: "should_fix",
            category: "correctness",
            title: "Invoices fall due a day early",
            body: "When the terms say 30 days, an invoice issued on 1 March is due on 30 March instead of 31 March, because one day is taken off the terms.",
            defectKey: "due_date_off_by_one",
            suggestion: FIXED,
          },
          {
            path: "src/invoices/terms.ts",
            side: "base",
            line: 11,
            endLine: 13,
            lineText: NEGATIVE_CHECK,
            severity: "should_fix",
            category: "correctness",
            title: "Negative payment terms are accepted again",
            body: "When an account's terms are set to -30 days, its invoices now fall due a month before they are issued, because the check that refused negative terms was removed.",
            defectKey: "negative_terms_unchecked",
          },
          {
            path: "src/invoices/reminders.ts",
            line: 9,
            lineText: THIRTY_DAYS,
            severity: "should_fix",
            category: "correctness",
            title: "Reminders still count 30 days",
            body: "When an account pays at 14 days, its reminders are still sent 30 days after the invoice is issued, two weeks after it fell due, because reminders.ts counts its own 30 days instead of reading the due date.",
            defectKey: "reminders_ignore_terms",
          },
        ],
        usage: { inputTokens: 2_100, outputTokens: 300 },
        tookMs: FIND_MS,
      },
      confirm: {
        notes: "Both hold.",
        verdicts: [
          {
            id: "C1",
            verdict: "confirmed",
            reason: "Net 30 from 1 March gives 30 March with the minus one.",
            evidence: ["src/invoices/due.ts:6"],
            severity: "should_fix",
          },
          {
            id: "C2",
            verdict: "confirmed",
            reason: "Nothing else reads termsDays before dueDate adds it to the issue date.",
            evidence: ["src/invoices/terms.ts:11"],
            severity: "should_fix",
          },
          {
            id: "C3",
            verdict: "confirmed",
            reason: "reminderDays never reads the terms.",
            evidence: ["src/invoices/reminders.ts:9"],
            severity: "should_fix",
          },
        ],
        usage: { inputTokens: 1_400, outputTokens: 150 },
        tookMs: CONFIRM_MS,
      },
    },
    {
      sha: commitSha("e1f2a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7"),
      message: "Name it dueDateOf",
      pushedWith: ["Count the terms' days in full, refuse negative terms, send reminders on the due date"],
      diff: added("src/invoices/due.ts", DUE(FIXED, "dueDateOf")) + REMINDERS_FIXED,
      find: {
        notes: "The date is right now, and negative terms are refused. Nothing new.",
        findings: [],
        earlier: [
          { id: "F1", present: false, why: "The terms' days are added in full." },
          { id: "F2", present: false, why: "terms.ts keeps its check on negative terms now." },
          { id: "F3", present: false, why: "Reminders count from the invoice's due date now." },
        ],
        emptyReason: "The two commits fix F1, F2 and F3 and rename the function.",
        usage: { inputTokens: 2_200, outputTokens: 140 },
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

/** A pull request of the world's repository, by its number. */
const pr = on(LEDGER_API.repo);

export const S6: Scenario = {
  id: "S6",
  title: "New commits after a review",
  what: "You push two commits to a pull request Lookover has reviewed. It waits for you to ask: Review again.",
  steps: [
    "#153 was reviewed: three findings, one on removed lines, one on a file it leaves as it was. Wait, or press Step to the next event: you push two commits.",
    "The row says 2 new commits. Nothing runs by itself.",
    "Press Review again: round 2 finds the three fixed and settles.",
  ],
  later: "",
  path: "/",
  world: LEDGER_API,
  changes: [DUE_DATE],
  script: [
    { at: MIN, move: { kind: "open", change: pr(153) } },
    { at: 6 * MIN + 30_000, move: { kind: "push", change: pr(153) } },
  ],
  seed: 6 * MIN,
};
