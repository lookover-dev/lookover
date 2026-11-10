// S21 "Real-looking names at setup" (row 52, ADR 0086): S20's world at setup's GitHub step, signed in. The person's
// own account and meridian-health-analytics reached, northwind-platform-infrastructure-group (39 characters) asking for
// SAML SSO; Continue goes on to the Repositories step with the same names.
import type { Scenario } from "../scenario.ts";
import { MIN } from "./ledger-api.ts";
import { REAL_NAMES, REAL_NAMES_CHANGES, REAL_NAMES_SCRIPT } from "./s20-real-names.ts";

export const S21: Scenario = {
  id: "S21",
  title: "Real-looking names at setup",
  what: "You're at setup's GitHub step, signed in on your account and two organisations with long names, one asking for SSO.",
  steps: [
    "The GitHub step lists sasensi, northwind-platform-infrastructure-group (it asks for SSO) and meridian-health-analytics.",
    "Continue: the Repositories step lists their repositories under the same names.",
  ],
  later: "",
  path: "/setup",
  world: {
    ...REAL_NAMES,
    setup: { done: false, step: "github", reached: "repos", github: "done", firstReviewChange: null },
  },
  changes: REAL_NAMES_CHANGES,
  script: REAL_NAMES_SCRIPT,
  seed: MIN,
};
