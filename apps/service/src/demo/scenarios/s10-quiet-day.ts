// S10 "A quiet day" (ADR 0046): one repository, a morning of reviews already done when the app opens, more of
// them than Home lists before it offers to search. First thing, #135, the owner's, reviewed clean; #137, a
// colleague's, skipped; #139, the owner's, one finding Codex confirmed, still to fix. Then, the last hour: #141,
// the owner's own, reviewed clean; #144, dependabot's, skipped; #146, written by Claude, found by Codex and
// confirmed by Claude, its two findings fixed by the agent and verified in round 2: settled. Nothing waits. Two
// more changes the script never opens are there for the drawer's faults: #149, the agent's, and #150, a
// colleague's. main holds a REVIEW.md of three rules: #139's finding follows the first, #146's first finding the
// second, so Settings lists them with their counts. Every diff is hand-written fixture data a review reads; nothing here is a real recording.
import { commitSha } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange } from "../scenario.ts";
import {
  BY_CLAUDE,
  CONFIRM_MS,
  DEPENDABOT,
  FIND_MS,
  MIN,
  MIRA,
  OWNER,
  SHORT_FIND_MS,
  unified,
} from "./ledger-api.ts";
import { SANDBOX } from "./sandbox.ts";

const UNPAID_FILTER = unified(
  "diff --git a/src/invoices/list.ts b/src/invoices/list.ts",
  "--- a/src/invoices/list.ts",
  "+++ b/src/invoices/list.ts",
  "@@ -1,5 +1,8 @@",
  ' import type { Invoice } from "./invoice.ts";',
  " ",
  "-export function listInvoices(all: Invoice[]): Invoice[] {",
  "-  return [...all].sort((a, b) => b.issuedAt - a.issuedAt);",
  '+export type InvoiceFilter = "all" | "unpaid";',
  "+",
  '+export function listInvoices(all: Invoice[], filter: InvoiceFilter = "all"): Invoice[] {',
  '+  const kept = filter === "unpaid" ? all.filter((invoice) => invoice.paidAt === null) : all;',
  "+  return [...kept].sort((a, b) => b.issuedAt - a.issuedAt);",
  " }",
);

const UNPAID_FILTER_TESTED = unified(
  "diff --git a/src/invoices/list.test.ts b/src/invoices/list.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/invoices/list.test.ts",
  "@@ -0,0 +1,8 @@",
  '+import { expect, test } from "bun:test";',
  '+import { listInvoices } from "./list.ts";',
  "+",
  '+test("unpaid keeps the invoices without a payment", () => {',
  '+  const paid = { id: "a", issuedAt: 1, paidAt: 2 };',
  '+  const open = { id: "b", issuedAt: 2, paidAt: null };',
  '+  expect(listInvoices([paid, open], "unpaid")).toEqual([open]);',
  "+});",
  "diff --git a/src/invoices/list.ts b/src/invoices/list.ts",
  "--- a/src/invoices/list.ts",
  "+++ b/src/invoices/list.ts",
  "@@ -1,5 +1,8 @@",
  ' import type { Invoice } from "./invoice.ts";',
  " ",
  "-export function listInvoices(all: Invoice[]): Invoice[] {",
  "-  return [...all].sort((a, b) => b.issuedAt - a.issuedAt);",
  '+export type InvoiceFilter = "all" | "unpaid";',
  "+",
  '+export function listInvoices(all: Invoice[], filter: InvoiceFilter = "all"): Invoice[] {',
  '+  const kept = filter === "unpaid" ? all.filter((invoice) => invoice.paidAt === null) : all;',
  "+  return [...kept].sort((a, b) => b.issuedAt - a.issuedAt);",
  " }",
);

const DEPENDENCY_BUMP = unified(
  "diff --git a/package.json b/package.json",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -12,7 +12,7 @@",
  '   "devDependencies": {',
  '     "@types/bun": "^1.2.0",',
  '     "biome": "^2.0.0",',
  '-    "typescript": "^5.8.3"',
  '+    "typescript": "^5.9.3"',
  "   },",
  '   "dependencies": {',
  '     "zod": "^4.0.0"',
);

const WEBHOOK_RETRIES = unified(
  "diff --git a/src/webhooks/deliver.ts b/src/webhooks/deliver.ts",
  "--- a/src/webhooks/deliver.ts",
  "+++ b/src/webhooks/deliver.ts",
  "@@ -1,5 +1,14 @@",
  ' import { post } from "../http.ts";',
  " ",
  "-export async function deliver(url: string, payload: unknown): Promise<void> {",
  "-  await post(url, payload);",
  "+const MAX_ATTEMPTS = 5;",
  "+",
  "+export async function deliver(url: string, payload: unknown): Promise<void> {",
  "+  let attempt = 0;",
  "+  while (attempt < MAX_ATTEMPTS) {",
  "+    const response = await post(url, payload);",
  "+    if (response.ok) return;",
  "+    attempt += 1;",
  "+    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt));",
  "+  }",
  '+  throw new Error("Webhook " + url + " failed after " + MAX_ATTEMPTS + " attempts");',
  " }",
);

const WEBHOOK_RETRIES_FIXED = unified(
  "diff --git a/src/webhooks/deliver.ts b/src/webhooks/deliver.ts",
  "--- a/src/webhooks/deliver.ts",
  "+++ b/src/webhooks/deliver.ts",
  "@@ -1,5 +1,15 @@",
  ' import { post } from "../http.ts";',
  " ",
  "-export async function deliver(url: string, payload: unknown): Promise<void> {",
  "-  await post(url, payload);",
  "+const MAX_ATTEMPTS = 5;",
  "+",
  "+export async function deliver(url: string, payload: unknown): Promise<void> {",
  "+  let attempt = 0;",
  "+  while (attempt < MAX_ATTEMPTS) {",
  "+    const response = await post(url, payload);",
  "+    if (response.ok) return;",
  '+    if (response.status < 500) throw new Error("Webhook " + url + " refused: " + response.status);',
  "+    attempt += 1;",
  "+    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));",
  "+  }",
  '+  throw new Error("Webhook " + url + " failed after " + MAX_ATTEMPTS + " attempts");',
  " }",
);

const INVOICE_NUMBER = unified(
  "diff --git a/src/webhooks/payload.ts b/src/webhooks/payload.ts",
  "--- a/src/webhooks/payload.ts",
  "+++ b/src/webhooks/payload.ts",
  "@@ -4,6 +4,7 @@ export function payloadOf(invoice: Invoice): WebhookPayload {",
  "   return {",
  "     id: invoice.id,",
  "     total: invoice.total,",
  "+    number: invoice.number.toString(),",
  "     issuedAt: invoice.issuedAt,",
  "     paidAt: invoice.paidAt,",
  "   };",
);

const README_TYPO = unified(
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -3,4 +3,4 @@",
  " The invoicing service.",
  " ",
  "-Run `bun dev` to start it localy.",
  "+Run `bun dev` to start it locally.",
  " ",
);

const MONEY_FORMAT = unified(
  "diff --git a/src/format/money.ts b/src/format/money.ts",
  "--- a/src/format/money.ts",
  "+++ b/src/format/money.ts",
  "@@ -1,3 +1,6 @@",
  "-export function formatCents(cents: number): string {",
  '-  return (cents / 100).toFixed(2) + " EUR";',
  "+export function formatCents(cents: number, locale: string): string {",
  "+  return new Intl.NumberFormat(locale, {",
  '+    style: "currency",',
  '+    currency: "EUR",',
  "+  }).format(cents / 100);",
  " }",
);

const CONTRIBUTING_LINK = unified(
  "diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md",
  "--- a/CONTRIBUTING.md",
  "+++ b/CONTRIBUTING.md",
  "@@ -1,4 +1,4 @@",
  " # Contributing",
  " ",
  "-See the wiki for how to run the tests.",
  "+See [the testing guide](docs/testing.md) for how to run the tests.",
  " ",
);

const RATES_CACHE = unified(
  "diff --git a/src/rates/cache.ts b/src/rates/cache.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/rates/cache.ts",
  "@@ -0,0 +1,12 @@",
  '+import { fetchRates, type Rates } from "./fetch.ts";',
  "+",
  "+/** The rates already fetched, by day. */",
  "+const cached = new Map<string, Rates>();",
  "+",
  "+export async function ratesOf(day: string): Promise<Rates> {",
  "+  const hit = cached.get(day);",
  "+  if (hit) return hit;",
  "+  const rates = await fetchRates(day);",
  "+  cached.set(day, rates);",
  "+  return rates;",
  "+}",
);

/**
 * main's rules (ADR 0048): every review reads them; #139's finding follows the first, #146's first the second. The
 * last has one nested in it, which goes with it when it is switched off (ADR 0049).
 */
const REVIEW_MD = [
  "# Review rules",
  "",
  "- Every cache says when its entries expire.",
  "- A request the server refused (a 4xx answer) is never retried.",
  "- Amounts stay in integer cents until they are shown.",
  "  - A total is rounded once, at the end.",
  "",
].join("\n");

const CHANGES: ScenarioChange[] = [
  {
    number: 135,
    title: "Format amounts in the reader's locale",
    branch: "money-locale",
    author: OWNER,
    commits: [
      {
        sha: commitSha("135a1b2c3d4e5f60718293a4b5c6d7e8f9012345"),
        message: "Format amounts in the reader's locale",
        diff: MONEY_FORMAT,
        find: {
          notes: "The formatter takes the locale; the currency stays euros.",
          findings: [],
          emptyReason: "Intl formats the amount as the old code did, with the locale's separators.",
          usage: { inputTokens: 1_200, outputTokens: 130 },
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
  {
    number: 137,
    title: "Link the testing guide from CONTRIBUTING",
    branch: "contributing-link",
    author: MIRA,
    commits: [
      {
        sha: commitSha("137b2c3d4e5f60718293a4b5c6d7e8f901234567"),
        message: "Link the testing guide from CONTRIBUTING",
        diff: CONTRIBUTING_LINK,
        find: {
          notes: "A link in the docs.",
          findings: [],
          emptyReason: "One line of documentation; no code changes.",
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
  {
    number: 139,
    title: "Cache the exchange rates by day",
    branch: "rates-cache",
    author: OWNER,
    commits: [
      {
        sha: commitSha("139c3d4e5f60718293a4b5c6d7e8f90123456789"),
        message: "Cache the exchange rates by day",
        diff: RATES_CACHE,
        find: {
          notes: "A small cache in front of the fetch. One thing about today's rates.",
          findings: [
            {
              path: "src/rates/cache.ts",
              line: 10,
              lineText: "  cached.set(day, rates);",
              severity: "should_fix",
              category: "correctness",
              title: "Today's rates are kept for the rest of the day",
              body: "When `day` is today, the first rates fetched are kept until the process restarts, because no entry ever expires; rates published later in the day are never seen.",
              defectKey: "todays_rates_never_refresh",
              rule: "R1",
            },
          ],
          usage: { inputTokens: 1_600, outputTokens: 280 },
          tookMs: SHORT_FIND_MS,
        },
        confirm: {
          notes: "Holds: nothing removes an entry.",
          verdicts: [
            {
              id: "C1",
              verdict: "confirmed",
              reason:
                "The map is only ever added to; a day fetched once is answered from it until a restart.",
              evidence: ["src/rates/cache.ts:4", "src/rates/cache.ts:10"],
              severity: "should_fix",
            },
          ],
          usage: { inputTokens: 900, outputTokens: 140 },
          tookMs: CONFIRM_MS,
        },
      },
    ],
  },
  {
    number: 141,
    title: "Add the unpaid filter to the invoice list",
    branch: "unpaid-filter",
    author: OWNER,
    commits: [
      {
        sha: commitSha("b1f2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4"),
        message: "Add the unpaid filter to the invoice list",
        diff: UNPAID_FILTER,
        find: {
          notes: "I read the diff and the sort it keeps. Nothing to raise.",
          findings: [],
          emptyReason: "The filter keeps the sort and the default keeps today's behaviour.",
          usage: { inputTokens: 2_100, outputTokens: 180 },
          tookMs: FIND_MS,
        },
      },
      {
        sha: commitSha("c2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5"),
        message: "Add a test for the unpaid filter",
        diff: UNPAID_FILTER_TESTED,
        find: {
          notes: "A test for the filter; the code is as reviewed.",
          findings: [],
          emptyReason: "The test covers the new filter and changes no behaviour.",
          usage: { inputTokens: 2_400, outputTokens: 160 },
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
  {
    number: 144,
    title: "Bump typescript from 5.8.3 to 5.9.3",
    branch: "dependabot/npm_and_yarn/typescript-5.9.3",
    author: DEPENDABOT,
    commits: [
      {
        sha: commitSha("d3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6"),
        message: "Bump typescript from 5.8.3 to 5.9.3",
        diff: DEPENDENCY_BUMP,
        find: {
          notes: "A dependency bump.",
          findings: [],
          emptyReason: "One version number changes; nothing to review.",
          usage: { inputTokens: 900, outputTokens: 90 },
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
  {
    number: 146,
    title: "Retry failed webhook deliveries",
    branch: "webhook-retries",
    author: OWNER,
    commits: [
      {
        sha: commitSha("e4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7"),
        message: `Retry failed webhook deliveries\n\n${BY_CLAUDE}`,
        diff: WEBHOOK_RETRIES,
        find: {
          notes: "The retry loop reads well, but two things in it will bite in production.",
          findings: [
            {
              path: "src/webhooks/deliver.ts",
              line: 9,
              lineText: "    if (response.ok) return;",
              severity: "blocking",
              category: "correctness",
              title: "A 4xx answer is retried like a 5xx",
              body: "When the endpoint answers 4xx (a bad URL, a revoked secret), the loop retries five times, because only `ok` is checked and a 4xx never becomes ok. Each retry repeats a request the endpoint already refused.",
              defectKey: "retries_client_errors",
              rule: "R2",
              suggestion:
                '    if (response.ok) return;\n    if (response.status < 500) throw new Error("Webhook " + url + " refused: " + response.status);',
            },
            {
              path: "src/webhooks/deliver.ts",
              line: 11,
              lineText: "    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt));",
              severity: "should_fix",
              category: "correctness",
              title: "The backoff waits milliseconds, not seconds",
              body: "When an attempt fails, the loop waits `2 ** attempt` milliseconds (2 to 32 ms), because `setTimeout` takes milliseconds; five attempts go by in under a tenth of a second, which is no backoff.",
              defectKey: "backoff_in_milliseconds",
              suggestion: "    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));",
            },
          ],
          usage: { inputTokens: 3_200, outputTokens: 640 },
          tookMs: FIND_MS,
        },
        confirm: {
          notes: "Both hold: I traced the loop with a 404 and with a 503.",
          verdicts: [
            {
              id: "C1",
              verdict: "confirmed",
              reason:
                "A 404 answer is not ok and is never retried into one; the loop runs all five attempts.",
              evidence: ["src/webhooks/deliver.ts:7", "src/webhooks/deliver.ts:9"],
              severity: "blocking",
            },
            {
              id: "C2",
              verdict: "confirmed",
              reason: "setTimeout's delay is in milliseconds; 2 ** attempt is at most 32.",
              evidence: ["src/webhooks/deliver.ts:11"],
              severity: "should_fix",
            },
          ],
          usage: { inputTokens: 1_800, outputTokens: 260 },
          tookMs: CONFIRM_MS,
        },
      },
      {
        sha: commitSha("f5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8"),
        message: `Stop retrying refused deliveries and back off in seconds\n\n${BY_CLAUDE}`,
        diff: WEBHOOK_RETRIES_FIXED,
        find: {
          notes: "Both earlier findings are addressed; nothing new.",
          findings: [],
          earlier: [
            { id: "F1", present: false, why: "A 4xx now throws at once; only 5xx answers are retried." },
            { id: "F2", present: false, why: "The delay is now 1000 × 2 ** attempt milliseconds." },
          ],
          emptyReason: "The fix is exactly the two changes asked for.",
          usage: { inputTokens: 3_400, outputTokens: 210 },
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
  {
    number: 149,
    title: "Add the invoice number to the webhook payload",
    branch: "payload-number",
    author: OWNER,
    commits: [
      {
        sha: commitSha("a6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809"),
        message: `Add the invoice number to the webhook payload\n\n${BY_CLAUDE}`,
        diff: INVOICE_NUMBER,
        find: {
          notes: "One field added to the payload.",
          findings: [
            {
              path: "src/webhooks/payload.ts",
              line: 7,
              lineText: "    number: invoice.number.toString(),",
              severity: "should_fix",
              category: "api",
              title: "The number is sent as a string",
              body: "When a receiver compares `number` with the invoice's own, a string never equals its number, because every other field of the payload keeps its type.",
              defectKey: "number_sent_as_string",
              suggestion: "    number: invoice.number,",
            },
          ],
          usage: { inputTokens: 1_500, outputTokens: 240 },
          tookMs: FIND_MS,
        },
        confirm: {
          verdicts: [
            {
              id: "C1",
              verdict: "confirmed",
              reason: "The other fields are sent as they are; this one is converted.",
              evidence: ["src/webhooks/payload.ts:7"],
              severity: "should_fix",
            },
          ],
          tookMs: CONFIRM_MS,
        },
      },
    ],
  },
  {
    number: 150,
    title: "Fix a typo in the README",
    branch: "readme-typo",
    author: MIRA,
    commits: [
      {
        sha: commitSha("b7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a"),
        message: "Fix a typo in the README",
        diff: README_TYPO,
        find: {
          notes: "A one-word fix.",
          findings: [],
          emptyReason: "A typo in the README; no code changes.",
          tookMs: SHORT_FIND_MS,
        },
      },
    ],
  },
];

/** A pull request of the world's repository, by its number. */
const pr = on(SANDBOX.repo);

export const S10: Scenario = {
  id: "S10",
  title: "A quiet day",
  what: "Six pull requests seen since early morning: three clean or settled, one with a finding to fix, two skipped. Nothing waits.",
  steps: [
    "Home shows the day: nothing waiting, six pull requests earlier today.",
    "Open #146: two findings, fixed by the agent and verified in round 2.",
    "Open #144: skipped, and why.",
    "Search today's reviews for “rates”, then open “All reviews”.",
  ],
  later: "",
  path: "/",
  world: { ...SANDBOX, rules: [{ path: "REVIEW.md", text: REVIEW_MD }] },
  changes: CHANGES,
  script: [
    { at: 1 * MIN, move: { kind: "open", change: pr(135) } },
    { at: 10 * MIN, move: { kind: "open", change: pr(137) } },
    { at: 19 * MIN, move: { kind: "open", change: pr(139) } },
    { at: 111 * MIN, move: { kind: "open", change: pr(141) } },
    { at: 120 * MIN, move: { kind: "open", change: pr(144) } },
    { at: 129 * MIN, move: { kind: "open", change: pr(146) } },
    { at: 138 * MIN, move: { kind: "push", change: pr(146) } },
    { at: 138 * MIN + 10_000, move: { kind: "ask", change: pr(146) } },
  ],
  seed: 150 * MIN,
};
