// S16 "Signed in on two accounts" (ADR 0066): the owner signed in with GitHub to the shared App, installed on their
// own account and on ledger-dev, an organisation they work in, each with a repository named ledger-api. Lookover
// watches all three repositories at once, posting as the owner. A minute in, the owner opens #151 on their own
// ledger-api (S3's CSV export); twenty seconds later, #151 on ledger-dev's, a change of its own: the same number in a
// repository of the same name, two pull requests. Each is reviewed and posted as the owner, Claude finding one and
// Codex double-checking it. The drawer signs the owner out of GitHub (Sign in again, then its code), or has ledger-dev
// ask for SSO (its account waits; the owner's own goes on), or has mira, an owner of ledger-dev, suspend the App
// there. The owner's `gh` names two organisations without the App (ADR 0067): ledger-labs, theirs to install on, and
// ledger-hq, where they are a member: they ask, it waits for an owner, and the drawer's owner installs it.
import { commitSha } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange } from "../scenario.ts";
import {
  BY_CLAUDE,
  CONFIRM_MS,
  FIND_MS,
  LEDGER_API,
  LEDGER_DEV,
  LEDGER_HQ,
  LEDGER_LABS,
  MIN,
  MIRA,
  OWNER,
  of,
  SHORT_FIND_MS,
  unified,
} from "./ledger-api.ts";
import { CSV_EXPORT } from "./s3-signed-out.ts";

const OWN_API = LEDGER_API.repo;
/** ledger-dev's ledger-api: the owner reaches ledger-dev through the shared App, beside their own account. */
const ORG_API = of(LEDGER_DEV, "ledger-api");

const EUROS =
  '  return new Intl.NumberFormat("en", { style: "currency", currency: "EUR" }).format(cents / 100);';
const ANY_CURRENCY =
  '  return new Intl.NumberFormat("en", { style: "currency", currency: invoice.currency }).format(cents / 100);';
const DEFAULTED =
  '  return new Intl.NumberFormat("en", { style: "currency", currency: invoice.currency ?? "EUR" }).format(cents / 100);';

/** ledger-dev's #151: amounts in the invoice's own currency, which older invoices never had. */
const CURRENCY: ScenarioChange = {
  repo: ORG_API,
  number: 151,
  title: "Show amounts in the invoice's currency",
  branch: "invoice-currency",
  author: OWNER,
  commits: [
    {
      sha: commitSha("b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6"),
      message: "Show amounts in the invoice's currency",
      diff: unified(
        "diff --git a/src/invoices/format.ts b/src/invoices/format.ts",
        "--- a/src/invoices/format.ts",
        "+++ b/src/invoices/format.ts",
        "@@ -3,3 +3,3 @@ export function amount(invoice: Invoice): string {",
        "   const cents = invoice.totalCents;",
        `-${EUROS}`,
        `+${ANY_CURRENCY}`,
        " }",
      ),
      find: {
        notes: "One line changed. One thing to raise.",
        findings: [
          {
            path: "src/invoices/format.ts",
            line: 4,
            lineText: ANY_CURRENCY,
            severity: "should_fix",
            category: "correctness",
            title: "An invoice from before currencies throws",
            body: "Invoices written before the currency column have none, and Intl.NumberFormat throws a TypeError when the style is currency and no currency is given: their pages fail to render.",
            defectKey: "currency_missing_throws",
            suggestion: DEFAULTED,
          },
        ],
        usage: { inputTokens: 2_400, outputTokens: 310 },
        tookMs: FIND_MS,
      },
      confirm: {
        notes: "It holds.",
        verdicts: [
          {
            id: "C1",
            verdict: "confirmed",
            reason: "currency is read as it is, and the invoice type allows it to be missing.",
            evidence: ["src/invoices/format.ts:4"],
            severity: "should_fix",
          },
        ],
        usage: { inputTokens: 1_500, outputTokens: 170 },
        tookMs: CONFIRM_MS,
      },
    },
  ],
};

/**
 * The owner's agent's pull request on their own ledger-api, opened from the drawer ("Your agent opens a pull
 * request"): reviewed while ledger-dev asks for SSO, its account's cause holding only ledger-dev's.
 */
const PAGE_SIZE: ScenarioChange = {
  repo: OWN_API,
  number: 152,
  title: "Name the page size of the invoice list",
  branch: "invoice-page-size",
  author: OWNER,
  commits: [
    {
      sha: commitSha("152a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c"),
      message: `Name the page size of the invoice list\n\n${BY_CLAUDE}`,
      diff: unified(
        "diff --git a/src/invoices/list.ts b/src/invoices/list.ts",
        "--- a/src/invoices/list.ts",
        "+++ b/src/invoices/list.ts",
        "@@ -1,3 +1,4 @@",
        "+const PAGE_SIZE = 50;",
        " export function page(invoices: Invoice[], n: number): Invoice[] {",
        "-  return invoices.slice(n * 50, (n + 1) * 50);",
        "+  return invoices.slice(n * PAGE_SIZE, (n + 1) * PAGE_SIZE);",
        " }",
      ),
      find: {
        notes: "A number named.",
        findings: [],
        emptyReason: "The page size is named; nothing else changes.",
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

const own = on(OWN_API);
const org = on(ORG_API);

export const S16: Scenario = {
  id: "S16",
  title: "Signed in on two accounts",
  what: "You're signed in with GitHub on your account and on ledger-dev, each with a ledger-api: a #151 on each is reviewed and posted as you.",
  steps: [
    "Home lists both reviews: sasensi/ledger-api #151 and ledger-dev/ledger-api #151, each posted as you. You're a member of ledger-dev, not an owner.",
    "Settings › GitHub lists your accounts, the same list as the setup's.",
    "From the drawer, GitHub signs you out: Sign in again, then enter the code from the drawer.",
    "Or ledger-dev asks you to sign in with SSO: only its reviews wait. Your agent opens a pull request on your ledger-api: it is reviewed.",
    'Or an owner suspends the App on ledger-dev ("An owner suspends the App on an organisation"): its account says mira suspended it.',
    "Ask to install on ledger-hq: GitHub's page offers Request, and the account waits for an owner, until \"An owner installs the App where you asked\". ledger-labs is yours: Install on ledger-labs installs it from GitHub's page.",
  ],
  later: "",
  path: "/",
  world: {
    ...LEDGER_API,
    // The shared App's bot: on the shared App it never posts, the owner does.
    bot: { id: 2020, login: "lookover-dev[bot]" },
    gh: "signed-in",
    memberships: [
      { organisation: LEDGER_DEV, role: "member" },
      { organisation: LEDGER_LABS, role: "owner" },
      { organisation: LEDGER_HQ, role: "member" },
    ],
    shared: {
      reaches: [
        {
          organisation: LEDGER_DEV,
          repositories: [ORG_API, { ...ORG_API, name: "ledger-web" }],
          owners: [MIRA],
        },
      ],
      unreached: [
        { organisation: LEDGER_LABS, repositories: [of(LEDGER_LABS, "ledger-cli")] },
        { organisation: LEDGER_HQ, repositories: [of(LEDGER_HQ, "ledger-app")], owners: [MIRA] },
      ],
    },
  },
  changes: [CSV_EXPORT, CURRENCY, PAGE_SIZE],
  script: [
    { at: MIN, move: { kind: "open", change: own(151) } },
    { at: MIN + 20_000, move: { kind: "open", change: org(151) } },
  ],
  seed: 10 * MIN,
};
