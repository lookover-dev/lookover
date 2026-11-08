/// S1 "First run" (ADR 0046, 0047, 0066, 0073): the owner opens Lookover for the first time. Claude is ready, Codex
// signed out; nobody is signed in to the shared App yet, so GitHub lists nothing. The owner signs Codex in (the
// scripted engine is signed in a few seconds on), signs in with GitHub (the code entered on GitHub's fake device page
// or by the drawer, the App on GitHub standing for the shared App's installation on their three repositories), keeps
// ledger-api on and asks for a first review of #148, opened by their agent before Lookover watched it, with "Preview
// here only": the round runs as any other (Codex finds, Claude double-checks) and nothing reaches GitHub. #148 is S2's.
// Beside it, #131, open on GitHub for 19 days, which First review says so of (ADR 0068), and #152, the agent's, which
// the drawer opens while setup shows its lists: opened on Repositories, it is asked nothing until the repositories
// are chosen (ADR 0079), and First review can ask it; opened on First review, it is reviewed by itself.
import { commitSha } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange } from "../scenario.ts";
import { added, BY_CLAUDE, LEDGER_API, MIN, OWNER, SHORT_FIND_MS } from "./ledger-api.ts";
import { RATE_LIMITING } from "./s2-happy-loop.ts";

/** A pull request of the world's repository, by its number. */
const pr = on(LEDGER_API.repo);

const DAY = 24 * 60 * MIN;

/**
 * #131, the owner's own, open on GitHub for 19 days before Lookover first lists it: First review gives its age as
 * GitHub's (ADR 0068). Reviewed, nothing is found.
 */
const WEBHOOK_RETRIES: ScenarioChange = {
  number: 131,
  title: "Retry failed webhook deliveries",
  branch: "webhook-retries",
  author: OWNER,
  openedAgo: 19 * DAY,
  commits: [
    {
      sha: commitSha("131c0ffee5d1e2a3b4c5d6e7f8091a2b3c4d5e6f"),
      message: "Retry failed webhook deliveries",
      diff: added("src/webhooks/retry.ts", [
        "/** How long to wait before the attempt numbered `attempt` (from 1): doubling, at most an hour. */",
        "export function retryDelayMs(attempt: number): number {",
        "  return Math.min(60 * 60_000, 30_000 * 2 ** (attempt - 1));",
        "}",
      ]),
      find: {
        notes: "One pure function for the delay between attempts.",
        findings: [],
        emptyReason: "The delay doubles from 30 s and stops at an hour, as its comment says.",
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

/**
 * #152, written by the owner's agent and not opened yet: the drawer's "Your agent opens a pull request" opens it
 * while setup shows Repositories or First review, and both lists show it with no reload (ADR 0068). Reviewed, nothing
 * is found.
 */
const EXCHANGE_RATES: ScenarioChange = {
  number: 152,
  title: "Cache exchange rates for an hour",
  branch: "claude/cache-exchange-rates",
  author: OWNER,
  commits: [
    {
      sha: commitSha("152ca5e0f1e2d3c4b5a69788a9b0c1d2e3f40516"),
      message: `Cache exchange rates for an hour\n\n${BY_CLAUDE}`,
      diff: added("src/rates/cache.ts", [
        "/** How long a fetched exchange rate is reused before it is fetched again. */",
        "export const RATE_TTL_MS = 60 * 60_000;",
        "",
        "/** Whether a rate fetched at `fetchedAt` is still fresh at `now`. */",
        "export const fresh = (fetchedAt: number, now: number): boolean => now - fetchedAt < RATE_TTL_MS;",
      ]),
      find: {
        notes: "A constant and one pure check of a rate's age.",
        findings: [],
        emptyReason: "A rate is reused for less than an hour and fetched again after, as the comment says.",
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

export const S1: Scenario = {
  id: "S1",
  title: "First run",
  what: "Lookover's first start: sign Codex in, sign in with GitHub, pick the repositories, preview a first review.",
  steps: [
    "Sign in to Codex: it is ready a few seconds later.",
    `Go on to GitHub and sign in with GitHub: copy the code and open GitHub's page, then enter it there with Authorize (or "You enter the sign-in code on GitHub" in the drawer); a few seconds later you are signed in, your three repositories reached. Cancel on GitHub's page (or "You cancel the sign-in on GitHub"), or wait 15 minutes, and the step says why.`,
    `On Repositories, "Your agent opens a pull request" in the drawer opens #152: it shows at once and is asked nothing; First review can ask it. Keep ledger-api on and go on.`,
    "Pick #148 for the first review, with Preview here only, and watch it run. Nothing is posted on GitHub.",
  ],
  later: "",
  path: "/setup",
  world: {
    ...LEDGER_API,
    repositories: [
      { owner: "sasensi", name: "ledger-web" },
      { owner: "sasensi", name: "invoice-pdf" },
    ],
    engines: {
      ...LEDGER_API.engines,
      codex: { installed: true, version: "0.162.1", signedIn: false },
    },
    setup: {
      done: false,
      step: "ai",
      reached: "ai",
      github: "start",
      firstReviewChange: null,
    },
  },
  changes: [RATE_LIMITING, WEBHOOK_RETRIES, EXCHANGE_RATES],
  script: [
    { at: MIN, move: { kind: "open", change: pr(148) } },
    { at: MIN + 1_000, move: { kind: "open", change: pr(131) } },
  ],
  seed: 2 * MIN,
};
