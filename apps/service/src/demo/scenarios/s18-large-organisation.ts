// S18 "A large organisation" (row 46, ADR 0082): the owner signed in with GitHub to the shared App on 40 repositories
// in four accounts: five of their own, 30 of fernhill, the company they work at, where they are a member, three of
// ledger-dev and two of ledger-labs, which they own. In the seed's first minute fernhill's owner narrows the App to
// 20 of fernhill's repositories, so ten leave an account still reached, and ledger-labs uninstalls it, so the account
// is gone with its two; then one Reconnect lists the installations again, and the twelve depart. Others have 22 pull
// requests open (Everyone lists them; nobody asked, so nothing reviews them); the owner's three, one per account still
// reached, are reviewed clean. S19 plays this world at setup's Repositories step, nothing departed
// (`s19-large-organisation-setup.ts`). Every pull request's diff is generated (one new file), its sha the SHA-1 of its
// name, so 25 changes stay a table: only the owner's commits, and mira's #412 that a step invites asking about, have
// a `find` scripted.
import type { ChangeRef, RepositoryRef } from "@lookover/contracts";
import type { Account, Scenario, ScenarioChange, TimedMove, World } from "../scenario.ts";
import { change, clean, DAY } from "./generated.ts";
import { DEPENDABOT, LEDGER_API, LEDGER_DEV, LEDGER_LABS, MIN, MIRA, OWNER, of } from "./ledger-api.ts";

/** The company the owner works at: 30 repositories, the owner a member, mira an owner. */
const FERNHILL: Account = { id: 342, login: "fernhill" };
const THEO: Account = { id: 11, login: "theo-r" };
const ANA: Account = { id: 12, login: "ana-lima" };
const KWAME: Account = { id: 13, login: "kwame-o" };
const JUN: Account = { id: 14, login: "jun-park" };

const OWN_API = LEDGER_API.repo;
const OWN = ["ledger-api", "invoice-pdf", "dotfiles", "notes", "site"].map((name) => of(OWNER, name));
/** fernhill's repositories in GitHub's order: the first 20 stay; the last ten leave the App's installation. */
const FERNHILL_REPOS = [
  "api",
  "web",
  "mobile",
  "billing",
  "auth",
  "search",
  "notifications",
  "analytics",
  "admin",
  "docs",
  "design-system",
  "infra",
  "payments",
  "editor",
  "scheduler",
  "gateway",
  "worker",
  "cli",
  "sdk-js",
  "integrations",
  "legacy-portal",
  "ml-models",
  "data-pipeline",
  "status-page",
  "sdk-python",
  "terraform",
  "importer",
  "exporter",
  "emails",
  "onboarding",
].map((name) => of(FERNHILL, name));
/** The ten fernhill takes off the App's installation in the seed: its others stay. */
const LEFT = FERNHILL_REPOS.slice(20);
const LEDGER_DEV_REPOS = ["ledger-api", "ledger-web", "ledger-docs"].map((name) => of(LEDGER_DEV, name));
const LEDGER_LABS_REPOS = ["ledger-cli", "ledger-sdk"].map((name) => of(LEDGER_LABS, name));

/**
 * The world at the start: 40 repositories in four accounts, the owner a member of fernhill and of ledger-dev, four of
 * fernhill's that hold others' pull requests switched off (ADR 0084).
 */
export const LARGE_ORGANISATION: World = {
  ...LEDGER_API,
  off: ["web", "mobile", "analytics", "gateway"].map((name) => of(FERNHILL, name)),
  repositories: OWN.filter((r) => r.name !== OWN_API.name),
  gh: "signed-in",
  memberships: [
    { organisation: FERNHILL, role: "member" },
    { organisation: LEDGER_DEV, role: "member" },
    { organisation: LEDGER_LABS, role: "owner" },
  ],
  shared: {
    reaches: [
      { organisation: FERNHILL, repositories: FERNHILL_REPOS, owners: [MIRA] },
      { organisation: LEDGER_DEV, repositories: LEDGER_DEV_REPOS, owners: [MIRA] },
      { organisation: LEDGER_LABS, repositories: LEDGER_LABS_REPOS },
    ],
  },
};

const fern = (name: string): RepositoryRef => of(FERNHILL, name);

/** mira's #412 on fernhill/api: the one a step invites asking about with Review now, which finds nothing. */
const ASKED: ScenarioChange = change(
  fern("api"),
  412,
  "Rate-limit the export endpoint",
  MIRA,
  "src/export/limit.ts",
  { openedAgo: 2 * DAY, find: clean("A limit added in one place; nothing else changes.") },
);

/** The 22 pull requests by others, across fernhill's repositories that stay, ledger-dev's and the owner's own. */
const OTHERS: ScenarioChange[] = [
  ASKED,
  change(fern("api"), 415, "Paginate the audit log", THEO, "src/audit/page.ts", { openedAgo: 3 * DAY }),
  change(fern("web"), 233, "Move the settings page to the new layout", ANA, "src/settings/layout.tsx", {
    openedAgo: 5 * DAY,
  }),
  change(fern("web"), 236, "Bump vite from 6.1.0 to 6.2.1", DEPENDABOT, "package.json.d/vite.txt", {
    openedAgo: DAY,
  }),
  change(fern("mobile"), 98, "Cache the avatar images", KWAME, "src/avatars/cache.ts", {
    openedAgo: 9 * DAY,
  }),
  change(fern("billing"), 177, "Prorate a plan changed mid-month", MIRA, "src/plans/prorate.ts", {
    openedAgo: 4 * DAY,
  }),
  change(fern("auth"), 64, "Expire a reset link after an hour", JUN, "src/reset/expiry.ts", {
    openedAgo: 2 * DAY,
  }),
  change(fern("search"), 51, "Rank exact title matches first", THEO, "src/rank/exact.ts", {
    openedAgo: 12 * DAY,
  }),
  change(fern("notifications"), 140, "Batch the daily digest", ANA, "src/digest/batch.ts", {
    openedAgo: 6 * DAY,
  }),
  change(fern("analytics"), 29, "Drop the unused funnel table", KWAME, "migrations/drop-funnel.sql", {
    openedAgo: 20 * DAY,
  }),
  change(fern("admin"), 72, "Show the plan on the account page", JUN, "src/accounts/plan.tsx", {
    openedAgo: DAY,
  }),
  change(fern("docs"), 310, "Document the webhooks' retries", MIRA, "docs/webhooks/retries.md", {
    openedAgo: 7 * DAY,
  }),
  change(fern("design-system"), 88, "Add the compact table density", ANA, "src/table/compact.css", {
    openedAgo: 3 * DAY,
  }),
  change(fern("infra"), 205, "Raise the worker pool to six", THEO, "pools/worker.tf", { openedAgo: 2 * DAY }),
  change(fern("payments"), 119, "Retry a declined card once", KWAME, "src/cards/retry.ts", {
    openedAgo: 8 * DAY,
  }),
  change(fern("editor"), 402, "Keep the cursor on undo", JUN, "src/history/cursor.ts", {
    openedAgo: 4 * DAY,
  }),
  change(fern("scheduler"), 37, "Skip a run while the last one runs", MIRA, "src/runs/overlap.ts", {
    openedAgo: 15 * DAY,
  }),
  change(fern("gateway"), 93, "Bump undici from 7.3.0 to 7.4.0", DEPENDABOT, "package.json.d/undici.txt", {
    openedAgo: 2 * DAY,
  }),
  change(fern("worker"), 160, "Log a job's queue time", THEO, "src/jobs/queue-time.ts", {
    openedAgo: 5 * DAY,
  }),
  change(fern("sdk-js"), 44, "Type the list responses", ANA, "src/types/list.ts", { openedAgo: 11 * DAY }),
  change(of(LEDGER_DEV, "ledger-web"), 58, "Translate the invoice page to German", MIRA, "src/i18n/de.json", {
    openedAgo: 3 * DAY,
  }),
  change(OWN_API, 163, "Bump zod from 3.24.1 to 3.24.2", DEPENDABOT, "package.json.d/zod.txt", {
    openedAgo: DAY,
  }),
];

/** The owner's three, one per account still reached, each written by Claude and reviewed clean. */
const MINE: ScenarioChange[] = [
  change(OWN_API, 164, "Name the invoice statuses", OWNER, "src/invoices/status.ts", {
    byClaude: true,
    find: clean("The statuses are named; nothing else changes."),
  }),
  change(fern("cli"), 21, "Print the version with --version", OWNER, "src/version.ts", {
    byClaude: true,
    find: clean("One flag added; nothing else changes."),
  }),
  change(
    of(LEDGER_DEV, "ledger-docs"),
    12,
    "Link the API reference from the README",
    OWNER,
    "docs/links.md",
    {
      byClaude: true,
      find: clean("A link added; nothing else changes."),
    },
  ),
];

/** Every pull request of the world: the others', then the owner's. */
export const LARGE_ORGANISATION_CHANGES: ScenarioChange[] = [...OTHERS, ...MINE];

/** A change as a move names it. */
const refOf = (c: ScenarioChange): ChangeRef => ({ repo: c.repo ?? OWN_API, number: c.number });

/** The others' pull requests opened two seconds in, the owner's at 40 s, each set with one listing. */
export const OPENED: TimedMove[] = [
  { at: 2_000, move: { kind: "open-several", changes: OTHERS.map(refOf) } },
  { at: 40_000, move: { kind: "open-several", changes: MINE.map(refOf) } },
];

export const S18: Scenario = {
  id: "S18",
  title: "A large organisation",
  what: "You're signed in on four accounts, 40 repositories in all: twelve have left, ten of fernhill's and all of ledger-labs', four of fernhill's are off, and others have 22 pull requests open.",
  steps: [
    "Repositories lists 28 repositories: yours, fernhill's 20 and ledger-dev's 3. fernhill's owner took ten off the App, and ledger-labs uninstalled it.",
    "fernhill's web, mobile, analytics and gateway are off: Repositories says they are not reviewed, and their five pull requests stay out of Reviews.",
    "Home and All reviews list your three pull requests, reviewed clean. Everyone lists 17 more, by others: none from the four that are off.",
    "Under Everyone, Review now on mira's fernhill/api #412: it is reviewed, nothing to raise.",
  ],
  later: "",
  path: "/repositories",
  world: LARGE_ORGANISATION,
  changes: LARGE_ORGANISATION_CHANGES,
  script: [
    ...OPENED,
    { at: 20_000, move: { kind: "leave", repos: LEFT } },
    { at: 25_000, move: { kind: "uninstall", organisation: LEDGER_LABS } },
    { at: 30_000, move: { kind: "reconnect" } },
  ],
  seed: 3 * MIN,
};
