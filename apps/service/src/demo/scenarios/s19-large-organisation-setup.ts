// S19 "A large organisation at setup" (row 46, ADR 0082): S18's world at setup's Repositories step, nothing departed.
// The owner is signed in to the shared App on their own account, fernhill (30 repositories), ledger-dev and
// ledger-labs, 40 repositories in all, every one ticked; the same 25 pull requests are open, none reviewed: nothing asks
// a review by itself until the repositories are chosen (ADR 0079).
import type { Scenario } from "../scenario.ts";
import { MIN } from "./ledger-api.ts";
import { LARGE_ORGANISATION, LARGE_ORGANISATION_CHANGES, OPENED } from "./s18-large-organisation.ts";

export const S19: Scenario = {
  id: "S19",
  title: "A large organisation at setup",
  what: "You're at setup's Repositories step, signed in on four accounts with 40 repositories, every one ticked.",
  steps: [
    "The step lists your 5 repositories, fernhill's 30, ledger-dev's 3 and ledger-labs' 2, every one ticked.",
    "Untick what Lookover should not review, then Continue.",
  ],
  later: "",
  path: "/setup",
  world: {
    ...LARGE_ORGANISATION,
    setup: { done: false, step: "repos", reached: "repos", github: "done", firstReviewChange: null },
  },
  changes: LARGE_ORGANISATION_CHANGES,
  script: OPENED,
  seed: MIN,
};
