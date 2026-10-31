// S17 "Every account at setup" (ADR 0067): the owner signed in with GitHub to the shared App, at setup's GitHub step,
// their accounts in every state the step shows. Reached: ledger-dev, which they own, and ledger-ops, where they are a
// member, which asks for SAML SSO. Not reached: their own account and ledger-labs, both theirs to install on, and
// ledger-hq, where they are a member and ask an owner. Their `gh` names each organisation with their role in it, and
// GitHub's fake install page offers each its way: Install where they own it, Request where they are a member.
import type { Account, Scenario } from "../scenario.ts";
import { LEDGER_API, LEDGER_DEV, LEDGER_HQ, LEDGER_LABS, MIN, MIRA, of } from "./ledger-api.ts";

/** Reached too, the owner a member, asking for SAML SSO. */
const LEDGER_OPS: Account = { id: 339, login: "ledger-ops" };

export const S17: Scenario = {
  id: "S17",
  title: "Every account at setup",
  what: "You're signed in with GitHub at setup's GitHub step: one account reached, one asking for SSO, two of yours without the App and one where you ask an owner.",
  steps: [
    "The GitHub step lists ledger-dev and ledger-ops reached (ledger-ops needs SSO), then sasensi and ledger-labs to install on, and ledger-hq to ask about.",
    "Ask to install on ledger-hq: GitHub's page offers Request, and the step says you wait for an owner of ledger-hq.",
    'Install on ledger-labs: GitHub\'s page installs it there, and the step lists it reached a few minutes later (or at once with "Reconnect").',
  ],
  later: "",
  path: "/setup",
  world: {
    ...LEDGER_API,
    // The shared App's bot: on the shared App it never posts, the owner does.
    bot: { id: 2020, login: "lookover-dev[bot]" },
    gh: "signed-in",
    memberships: [
      { organisation: LEDGER_DEV, role: "owner" },
      { organisation: LEDGER_OPS, role: "member" },
      { organisation: LEDGER_LABS, role: "owner" },
      { organisation: LEDGER_HQ, role: "member" },
    ],
    shared: {
      ownAccountInstalled: false,
      reaches: [
        { organisation: LEDGER_DEV, repositories: [of(LEDGER_DEV, "ledger-api")] },
        { organisation: LEDGER_OPS, repositories: [of(LEDGER_OPS, "deploy")], sso: true, owners: [MIRA] },
      ],
      unreached: [
        { organisation: LEDGER_LABS, repositories: [of(LEDGER_LABS, "ledger-cli")] },
        { organisation: LEDGER_HQ, repositories: [of(LEDGER_HQ, "ledger-app")], owners: [MIRA] },
      ],
    },
    setup: {
      done: false,
      step: "github",
      reached: "repos",
      github: "done",
      githubRefused: null,
      firstReviewChange: null,
    },
  },
  changes: [],
  script: [],
  seed: MIN,
};
