// S6 "New commits after a review" (ADR 0046): the owner's #153 "Add a due date to invoices", written by hand,
// was reviewed before the load: Claude found two, Codex confirmed them, round 1 posted. F2 sits on removed lines,
// the old file's 11 to 13, so the app shows a finding on the old side and on a range (#61). Thirty seconds on, the
// owner pushes two commits at once. A push by the owner asks for nothing (a review after every push is off by
// default), so the review stays done and the change shows two new commits; "Review again" asks for round 2, which
// finds both fixed and settles.
import { commitSha } from "@lookover/contracts";
import type { Scenario, ScenarioChange } from "../scenario.ts";
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
        ],
        usage: { inputTokens: 1_400, outputTokens: 150 },
        tookMs: CONFIRM_MS,
      },
    },
    {
      sha: commitSha("e1f2a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7"),
      message: "Name it dueDateOf",
      pushedWith: ["Count the terms' days in full, refuse negative terms"],
      diff: added("src/invoices/due.ts", DUE(FIXED, "dueDateOf")),
      find: {
        notes: "The date is right now, and negative terms are refused. Nothing new.",
        findings: [],
        earlier: [
          { id: "F1", present: false, why: "The terms' days are added in full." },
          { id: "F2", present: false, why: "terms.ts keeps its check on negative terms now." },
        ],
        emptyReason: "The two commits fix F1 and F2 and rename the function.",
        usage: { inputTokens: 2_200, outputTokens: 140 },
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

export const S6: Scenario = {
  id: "S6",
  title: "New commits after a review",
  what: "You push two commits to a pull request Lookover has reviewed. It waits for you to ask: Review again.",
  steps: [
    "#153 was reviewed: two findings, one on removed lines. Wait, or press Step to the next event: you push two commits.",
    "The row says 2 new commits. Nothing runs by itself.",
    "Press Review again: round 2 finds both fixed and settles.",
  ],
  later: "",
  path: "/",
  world: LEDGER_API,
  changes: [DUE_DATE],
  script: [
    { at: MIN, move: { kind: "open", change: 153 } },
    { at: 6 * MIN + 30_000, move: { kind: "push", change: 153 } },
  ],
  seed: 6 * MIN,
};
