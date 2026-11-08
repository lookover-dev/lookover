// What the review page's tests share: sasensi/ledger-api #7 on the Repositories tests' world, a job and a finding
// to build its review from, and the page rendered to markup on them.
import {
  type ChangeId,
  changeId,
  commitSha,
  emptyReview,
  type Finding,
  findingId,
  jobId,
  type Review,
  type ReviewJob,
  repositoryId,
  type State,
} from "@lookover/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppContext, StateProvider } from "../store.tsx";
import { app, world } from "./repositories.test-support.tsx";
import { Review as ReviewScreen } from "./review.tsx";

export const SHA = commitSha("a1f9c2e");
const ID: ChangeId = changeId("sasensi/ledger-api#7");

export function job(state: ReviewJob["state"], more: Partial<ReviewJob> = {}): ReviewJob {
  return {
    id: jobId("job-1"),
    sha: SHA,
    trigger: "opened",
    state,
    deferral: null,
    stepIn: null,
    askedBy: null,
    skip: null,
    cancel: null,
    failure: null,
    turn: null,
    ...more,
  };
}

export function finding(id: string, status: Finding["status"], more: Partial<Finding> = {}): Finding {
  return {
    id: findingId(id),
    fingerprints: { location: `src/app.ts:1:${id}`, meaning: id },
    severity: "should_fix",
    category: "Correctness",
    title: id,
    file: "src/app.ts",
    side: "head",
    line: 1,
    endLine: null,
    lineText: null,
    anchoring: "reported",
    foundBy: "claude",
    confirmation: { verdict: "not_checked", demoted: false },
    body: "",
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    suggestion: null,
    status,
    posted: true,
    commented: false,
    raisedIn: 1,
    anchoredIn: 1,
    closedIn: status === "open" ? null : 1,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
    ...more,
  };
}

/** The review page of sasensi/ledger-api #7, its review as `review` makes it. */
export function page(review: Partial<Review>): string {
  const base = world();
  const at = base.now - 60_000;
  const round = {
    n: 1,
    sha: SHA,
    base: null,
    reviewer: "claude" as const,
    secondFind: null,
    confirmer: null,
    confirmFallback: null,
    confirmFailure: null,
    ruledOut: [],
    startedAt: at - 60_000,
    endedAt: at,
    raised: 1,
    verifiedFixed: 0,
    open: 0,
    steps: [],
    sessions: [],
  };
  const state: State = {
    ...base,
    changes: {
      [ID]: {
        id: ID,
        repoId: repositoryId("sasensi/ledger-api"),
        number: 7,
        title: "Change 7",
        openedBy: "sasensi",
        author: "agent",
        writtenBy: "claude",
        headSha: SHA,
        openedAt: at - 3_600_000,
        draft: false,
        fork: false,
        newCommits: 0,
      },
    },
    reviews: { [ID]: { ...emptyReview(ID, at), rounds: review.rounds ?? [round], ...review } },
  };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/reviews/sasensi/ledger-api/7"]}>
      <AppContext.Provider
        value={{
          store: app(),
          send: () => undefined,
          embedded: false,
          mode: "program",
          openPalette: () => undefined,
          openShortcuts: () => undefined,
        }}
      >
        <StateProvider value={state}>
          <Routes>
            <Route path="/reviews/:owner/:name/:number" element={<ReviewScreen />} />
          </Routes>
        </StateProvider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
}
