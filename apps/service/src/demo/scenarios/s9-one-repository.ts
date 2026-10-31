// S9 "The one repository" (ADR 0046): the repository's list and its page, as the service can show them today.
// One repository, reviewing, with two settings of its own in its file (only blocking findings posted, reviewed again
// after every push; ADR 0049), the rest following the owner's defaults; this morning #168 was reviewed and merged,
// #169 and #170 are open, each reviewed clean. Each value of its own has its way back to the default on the page.
// The page's switch turns reviewing off: the agent's next pull request (#171, the drawer's "Your agent opens a pull
// request") is then skipped. Several repositories come with onboarding (row 7). Every diff is hand-written fixture
// data a review reads; nothing here is a real recording.
import { commitSha } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange } from "../scenario.ts";
import { BY_CLAUDE, MIN, OWNER, SHORT_FIND_MS, unified } from "./ledger-api.ts";
import { SANDBOX } from "./sandbox.ts";

const HEALTH_ROUTE = unified(
  "diff --git a/src/server.ts b/src/server.ts",
  "--- a/src/server.ts",
  "+++ b/src/server.ts",
  "@@ -8,4 +8,5 @@ export function routes(app: App): void {",
  '   app.get("/v1/invoices", listInvoicesRoute);',
  '   app.post("/v1/invoices", createInvoiceRoute);',
  '+  app.get("/health", (_req, res) => res.send("ok"));',
  " }",
);

const PAGE_SIZE = unified(
  "diff --git a/src/invoices/route.ts b/src/invoices/route.ts",
  "--- a/src/invoices/route.ts",
  "+++ b/src/invoices/route.ts",
  "@@ -1,4 +1,4 @@",
  ' import { listInvoices } from "./list.ts";',
  " ",
  "-const PAGE_SIZE = 20;",
  "+const PAGE_SIZE = 50;",
  " ",
);

const LOG_FIELDS = unified(
  "diff --git a/src/logger.ts b/src/logger.ts",
  "--- a/src/logger.ts",
  "+++ b/src/logger.ts",
  "@@ -1,5 +1,5 @@",
  " export function logLine(level: string, message: string): string {",
  '-  return level + " " + message;',
  '+  return new Date().toISOString() + " " + level + " " + message;',
  " }",
  " ",
);

const VAT_ROUNDING = unified(
  "diff --git a/src/invoices/vat.ts b/src/invoices/vat.ts",
  "--- a/src/invoices/vat.ts",
  "+++ b/src/invoices/vat.ts",
  "@@ -1,3 +1,3 @@",
  " export function vatOf(cents: number, rate: number): number {",
  "-  return Math.floor(cents * rate);",
  "+  return Math.round(cents * rate);",
  " }",
);

/** A commit whose find pass finds nothing: what each review of this story answers. */
const clean = (sha: string, message: string, diff: string, why: string) => ({
  sha: commitSha(sha),
  message,
  diff,
  find: { notes: "A small change.", findings: [], emptyReason: why, tookMs: SHORT_FIND_MS },
});

const CHANGES: ScenarioChange[] = [
  {
    number: 168,
    title: "Add a health route",
    branch: "health-route",
    author: OWNER,
    commits: [
      clean(
        "168d4e5f60718293a4b5c6d7e8f9012345678901",
        "Add a health route",
        HEALTH_ROUTE,
        "One route that answers ok; nothing it touches.",
      ),
    ],
  },
  {
    number: 169,
    title: "List fifty invoices a page",
    branch: "page-size",
    author: OWNER,
    commits: [
      clean(
        "169e5f60718293a4b5c6d7e8f901234567890123",
        "List fifty invoices a page",
        PAGE_SIZE,
        "One constant; the pages read it.",
      ),
    ],
  },
  {
    number: 170,
    title: "Stamp each log line with its time",
    branch: "log-time",
    author: OWNER,
    commits: [
      clean(
        "170f60718293a4b5c6d7e8f90123456789012345",
        `Stamp each log line with its time\n\n${BY_CLAUDE}`,
        LOG_FIELDS,
        "The time goes first, in ISO format; the rest of the line is unchanged.",
      ),
    ],
  },
  {
    number: 171,
    title: "Round VAT to the nearest cent",
    branch: "vat-rounding",
    author: OWNER,
    commits: [
      clean(
        "1710718293a4b5c6d7e8f9012345678901234567",
        `Round VAT to the nearest cent\n\n${BY_CLAUDE}`,
        VAT_ROUNDING,
        "Rounding instead of flooring; nothing else changes.",
      ),
    ],
  },
];

/** A pull request of the world's repository, by its number. */
const pr = on(SANDBOX.repo);

export const S9: Scenario = {
  id: "S9",
  title: "The one repository",
  what: "The repository's list and its page: what it holds, its last review, its own settings, and its switch.",
  steps: [
    "Open Repositories: lookover-sandbox, two open, its last review a few minutes ago.",
    "Open it: strictness and “Again after every push” are its own; reset one to your default.",
    "Turn reviewing off, then inject “Your agent opens a pull request”: it is skipped.",
    "Turn reviewing back on.",
  ],
  later: "Several repositories, some following your defaults and some not, come with onboarding (row 7).",
  path: "/repositories",
  world: {
    ...SANDBOX,
    settings: {
      repository: [
        ["strictness", "blocking"],
        ["onPush", true],
      ],
    },
  },
  changes: CHANGES,
  script: [
    { at: 1 * MIN, move: { kind: "open", change: pr(168) } },
    { at: 12 * MIN, move: { kind: "close", change: pr(168) } },
    { at: 15 * MIN, move: { kind: "open", change: pr(169) } },
    { at: 22 * MIN, move: { kind: "open", change: pr(170) } },
  ],
  seed: 30 * MIN,
};
