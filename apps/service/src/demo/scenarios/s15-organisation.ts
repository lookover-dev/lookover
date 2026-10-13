// S15 "An organisation's App" (ADR 0059): the owner's code lives in an organisation, ledger-dev, where they are an
// admin, and their `gh` is signed in. Setup starts on its GitHub step: "Create your App" lists ledger-dev beside their
// own account, as their `gh` says it; the App is made on the organisation's pages of GitHub's fake and installed on
// its two repositories. The owner's agent opened #148 before Lookover watched (S1's, reviewed first if they pick it);
// later two teammates open theirs on ledger-api, from branches of the organisation's repository, not forks: each is
// skipped as not the owner's, as any other author's is (ADR 0016). An App an admin made before, lookover-ledger-dev
// (id 1, installed on both), is on GitHub's fake too, for "Use an existing App".
import { commitSha } from "@lookover/contracts";
import type { Account, Scenario, ScenarioChange } from "../scenario.ts";
import { LEDGER_API, MIN, MIRA, unified } from "./ledger-api.ts";
import { RATE_LIMITING } from "./s2-happy-loop.ts";

/** The organisation the App lives on: a team's, named as the owner's own is. */
const LEDGER_DEV: Account = { id: 338, login: "ledger-dev" };
const TOMAS: Account = { id: 9, login: "tomas" };

const CURRENCY: ScenarioChange = {
  number: 151,
  title: "Show amounts in the invoice's currency",
  branch: "mira/invoice-currency",
  author: MIRA,
  commits: [
    {
      sha: commitSha("f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0"),
      message: "Show amounts in the invoice's currency",
      diff: unified(
        "diff --git a/src/invoices/format.ts b/src/invoices/format.ts",
        "--- a/src/invoices/format.ts",
        "+++ b/src/invoices/format.ts",
        "@@ -3,3 +3,3 @@ export function amount(invoice: Invoice): string {",
        "   const cents = invoice.totalCents;",
        '-  return new Intl.NumberFormat("en", { style: "currency", currency: "EUR" }).format(cents / 100);',
        '+  return new Intl.NumberFormat("en", { style: "currency", currency: invoice.currency }).format(cents / 100);',
        " }",
      ),
    },
  ],
};

const TIMEOUTS: ScenarioChange = {
  number: 153,
  title: "Time out slow PDF renders",
  branch: "tomas/pdf-timeout",
  author: TOMAS,
  commits: [
    {
      sha: commitSha("a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1"),
      message: "Time out slow PDF renders",
      diff: unified(
        "diff --git a/src/pdf/render.ts b/src/pdf/render.ts",
        "--- a/src/pdf/render.ts",
        "+++ b/src/pdf/render.ts",
        "@@ -8,3 +8,3 @@ export async function render(invoice: Invoice): Promise<Buffer> {",
        "   const page = await browser.newPage();",
        "-  await page.setContent(html(invoice));",
        '+  await page.setContent(html(invoice), { timeout: 15_000, waitUntil: "load" });',
        "   return page.pdf();",
      ),
    },
  ],
};

export const S15: Scenario = {
  id: "S15",
  title: "An organisation's App",
  what: "Your code lives in ledger-dev, where you're an admin: create the App there, then teammates' pull requests are skipped.",
  steps: [
    "Under “Create your App”, pick ledger-dev, then Create it on GitHub: the organisation's page opens in a new tab and makes it. Install it there; both repositories appear a few seconds later.",
    "Keep ledger-api on and go on; pick #148 for the first review.",
    "Ten minutes in, Mira opens #151 and Tomas #153 on ledger-api: both are skipped as not yours.",
  ],
  later: "",
  path: "/setup",
  world: {
    ...LEDGER_API,
    repo: { owner: LEDGER_DEV.login, name: "ledger-api" },
    repositories: [{ owner: LEDGER_DEV.login, name: "ledger-web" }],
    bot: { id: 2, login: "lookover-ledger-dev[bot]" },
    organisation: { account: LEDGER_DEV, admin: true },
    gh: "signed-in",
    setup: {
      done: false,
      step: "github",
      reached: "github",
      github: "start",
      githubRefused: null,
      firstReviewChange: null,
    },
  },
  changes: [RATE_LIMITING, CURRENCY, TIMEOUTS],
  script: [
    { at: MIN, move: { kind: "open", change: 148 } },
    { at: 10 * MIN, move: { kind: "open", change: 151 } },
    { at: 12 * MIN, move: { kind: "open", change: 153 } },
  ],
  seed: 2 * MIN,
};
