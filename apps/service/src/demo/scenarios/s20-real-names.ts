// S20 "Real-looking names" (row 52, ADR 0086): the demo's names are short, so a screen judged on them never shows what
// a long login does to it. Here the person keeps their short login and is signed in to the shared App on two
// organisations with names as real ones are: northwind-platform-infrastructure-group, as long as a GitHub login can be
// (39 characters), and meridian-health-analytics, long-named. Each is reached with a few repositories; others have pull
// requests open, and the person's own, on their account and on meridian's, are reviewed clean. Then northwind asks for
// SAML SSO the sign-in hasn't: its head and its account hold the cause, meridian's none. `proof`'s layout pass judges
// Repositories, Reviews and Settings › GitHub on it; S21 plays this world at setup's GitHub step
// (`s21-real-names-setup.ts`). Diffs are generated as S18's are.
import type { ChangeRef } from "@lookover/contracts";
import type { Account, Scenario, ScenarioChange, TimedMove, World } from "../scenario.ts";
import { change, clean, DAY } from "./generated.ts";
import { LEDGER_API, MIN, MIRA, OWNER, of } from "./ledger-api.ts";

/** As long as a GitHub login can be; the person a member. It asks for SAML SSO 50 s in. */
const NORTHWIND: Account = { id: 401, login: "northwind-platform-infrastructure-group" };
/** Long-named, reached, with no problem; the person a member. */
const MERIDIAN: Account = { id: 402, login: "meridian-health-analytics" };
const PRIYA: Account = { id: 21, login: "priya-natarajan" };
const TOMAS: Account = { id: 22, login: "tomas-lindqvist" };

const OWN_API = LEDGER_API.repo;
const north = (name: string) => of(NORTHWIND, name);
const merid = (name: string) => of(MERIDIAN, name);

/** The world: the person's two repositories and the two organisations' three each. */
export const REAL_NAMES: World = {
  ...LEDGER_API,
  repositories: [of(OWNER, "dotfiles")],
  gh: "signed-in",
  memberships: [
    { organisation: NORTHWIND, role: "member" },
    { organisation: MERIDIAN, role: "member" },
  ],
  shared: {
    reaches: [
      {
        organisation: NORTHWIND,
        repositories: ["api-gateway", "terraform-modules", "observability-dashboards"].map(north),
        owners: [MIRA],
      },
      {
        organisation: MERIDIAN,
        repositories: ["patient-portal", "claims-service", "reporting-warehouse"].map(merid),
        owners: [MIRA],
      },
    ],
  },
};

/** Others' pull requests: one on the person's own ledger-api, two on northwind's, three on meridian's. */
const OTHERS: ScenarioChange[] = [
  change(OWN_API, 170, "Round the totals to the currency's minor unit", MIRA, "src/invoices/round.ts", {
    openedAgo: 2 * DAY,
  }),
  change(north("api-gateway"), 1287, "Retry an upstream timeout once", TOMAS, "src/upstream/retry.ts", {
    openedAgo: 4 * DAY,
  }),
  change(north("terraform-modules"), 342, "Pin the AWS provider to 5.x", PRIYA, "providers.tf", {
    openedAgo: DAY,
  }),
  change(
    merid("patient-portal"),
    214,
    "Show the next appointment on the dashboard",
    PRIYA,
    "src/home/next.tsx",
    {
      openedAgo: DAY,
    },
  ),
  change(
    merid("claims-service"),
    87,
    "Reject a claim filed after its deadline",
    TOMAS,
    "src/claims/deadline.ts",
    {
      openedAgo: 3 * DAY,
    },
  ),
  change(
    merid("reporting-warehouse"),
    43,
    "Partition the visits table by month",
    PRIYA,
    "models/visits.sql",
    {
      openedAgo: 5 * DAY,
    },
  ),
];

/** A title as meridian's team writes them, in Chinese: no space for a line to break at, as real titles can be. */
const CLAIMS_TITLE = "记录每笔被拒绝理赔的原因，并在月度报表中按原因汇总";

/** The person's own, written by Claude, each reviewed clean. */
const MINE: ScenarioChange[] = [
  change(OWN_API, 171, "Name the late-payment fee", OWNER, "src/invoices/fees.ts", {
    byClaude: true,
    find: clean("The fee is named; nothing else changes."),
  }),
  {
    ...change(merid("claims-service"), 88, CLAIMS_TITLE, OWNER, "src/claims/log.ts", {
      byClaude: true,
      find: clean("One log line added; nothing else changes."),
    }),
    // A branch's name is ASCII, as the title's isn't.
    branch: "log-rejected-claim-reason",
  },
];

export const REAL_NAMES_CHANGES: ScenarioChange[] = [...OTHERS, ...MINE];

const refOf = (c: ScenarioChange): ChangeRef => ({ repo: c.repo ?? OWN_API, number: c.number });

/** Others' pull requests opened two seconds in, the person's at 40 s; northwind asks for SSO at 50 s. */
export const REAL_NAMES_SCRIPT: TimedMove[] = [
  { at: 2_000, move: { kind: "open-several", changes: OTHERS.map(refOf) } },
  { at: 40_000, move: { kind: "open-several", changes: MINE.map(refOf) } },
  { at: 50_000, move: { kind: "sso", organisation: NORTHWIND } },
];

export const S20: Scenario = {
  id: "S20",
  title: "Real-looking names",
  what: "You're signed in on your account and two organisations with long names: northwind-platform-infrastructure-group asks for SSO, meridian-health-analytics is fine.",
  steps: [
    "Repositories lists your 2 repositories, northwind-platform-infrastructure-group's 3 and meridian-health-analytics' 3. northwind's head asks you to sign in with SSO; the others' hold no problem.",
    "Home and All reviews list your two pull requests, reviewed clean. Everyone lists 6 more, by others.",
    "Settings › GitHub lists the three accounts.",
  ],
  later: "",
  path: "/repositories",
  world: REAL_NAMES,
  changes: REAL_NAMES_CHANGES,
  script: REAL_NAMES_SCRIPT,
  seed: 3 * MIN,
};
