// S3 "An AI signs out mid-run" (ADR 0046, 0047): the owner's #151, written by hand, is being reviewed when the
// load ends, Claude forty seconds into finding. Twenty seconds on, Claude's session signs out: the run answers
// `auth_required` at its end and the job waits for Claude, the band and the pill saying so. "Sign in" opens the
// login (scripted: signed in five seconds on), the watch sees Claude ready and the review starts again, this time
// to its end: Claude finds one, Codex double-checks it, round 1 is posted. What Claude does as it reads (ADR 0055) is
// written by hand: the files and searches of a small exporter's review.
import { commitSha } from "@lookover/contracts";
import type { Scenario, ScenarioChange } from "../scenario.ts";
import { CONFIRM_MS, FIND_MS, LEDGER_API, MIN, OWNER, unified } from "./ledger-api.ts";

const ESCAPED = "  const cell = (value: string) => '\"' + value.replaceAll('\"', '\"\"') + '\"';";
const PLAIN = "  const cell = (value: string) => value;";

const CSV_EXPORT: ScenarioChange = {
  number: 151,
  title: "Export invoices as CSV",
  branch: "invoices-csv",
  author: OWNER,
  commits: [
    {
      sha: commitSha("f6a7b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2"),
      message: "Export invoices as CSV",
      diff: unified(
        "diff --git a/src/invoices/csv.ts b/src/invoices/csv.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/invoices/csv.ts",
        "@@ -0,0 +1,10 @@",
        '+import type { Invoice } from "./invoice.ts";',
        "+",
        "+/** The invoices as CSV: one header line, then one line per invoice. */",
        "+export function toCsv(invoices: Invoice[]): string {",
        `+${PLAIN}`,
        '+  const lines = invoices.map((i) => [i.number, cell(i.customer), String(i.totalCents)].join(","));',
        '+  return ["number,customer,total_cents", ...lines].join("\\n");',
        "+}",
        "+",
        '+export const CSV_TYPE = "text/csv; charset=utf-8";',
      ),
      find: {
        notes: "A small exporter. One thing to raise.",
        findings: [
          {
            path: "src/invoices/csv.ts",
            line: 5,
            lineText: PLAIN,
            severity: "should_fix",
            category: "correctness",
            title: "A customer name with a comma breaks the line",
            body: 'When a customer is called "Acme, Inc.", its line gets one column too many, because the cell is written as it is, with no quotes around it.',
            defectKey: "csv_cell_unquoted",
            suggestion: ESCAPED,
          },
        ],
        usage: { inputTokens: 2_900, outputTokens: 360 },
        tookMs: FIND_MS,
        // What Claude does as it reads (ADR 0055), written by hand: seven lines by the load, forty seconds in.
        activity: [
          { afterMs: 2_000, activity: { kind: "read", path: "src/invoices/csv.ts" } },
          { afterMs: 5_000, activity: { kind: "read", path: "src/invoices/invoice.ts" } },
          { afterMs: 9_000, activity: { kind: "search", pattern: "toCsv" } },
          { afterMs: 14_000, activity: { kind: "read", path: "src/invoices/routes.ts" } },
          { afterMs: 20_000, activity: { kind: "list", pattern: "src/**/*.test.ts" } },
          { afterMs: 27_000, activity: { kind: "read", path: "test/invoices.test.ts" } },
          { afterMs: 34_000, activity: { kind: "search", pattern: "customer" } },
          { afterMs: 48_000, activity: { kind: "search", pattern: "replaceAll" } },
        ],
      },
      confirm: {
        notes: "It holds.",
        verdicts: [
          {
            id: "C1",
            verdict: "confirmed",
            reason: "cell returns the value untouched and the line is joined with commas.",
            evidence: ["src/invoices/csv.ts:5", "src/invoices/csv.ts:6"],
            severity: "should_fix",
          },
        ],
        usage: { inputTokens: 1_700, outputTokens: 190 },
        tookMs: CONFIRM_MS,
      },
    },
  ],
};

export const S3: Scenario = {
  id: "S3",
  title: "An AI signs out mid-run",
  what: "Claude's session signs out while it reviews #151. The review waits for it; sign in and it starts again.",
  steps: [
    "#151 is being reviewed. Wait, or press Step to the next event: Claude signs out.",
    "The review waits for Claude. The band at the top and the status pill say so.",
    "Press Sign in. Claude is ready within a minute and the review starts again.",
  ],
  later: "",
  path: "/",
  world: LEDGER_API,
  changes: [CSV_EXPORT],
  script: [
    { at: MIN, move: { kind: "open", change: 151 } },
    { at: 2 * MIN, move: { kind: "sign-out", engine: "claude" } },
  ],
  seed: MIN + 40_000,
};
