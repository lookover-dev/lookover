// The tray's words (ADR 0105 §9): what the icon, its tooltip and its menu's line say for a given snapshot, worst first.
// Snapshots are built by hand: the tray reads state only.
import { expect, test } from "bun:test";
import {
  changeId,
  commitSha,
  type Engine,
  type EngineId,
  emptyReview,
  type Finding,
  findingId,
  GITHUB_WEB,
  jobId,
  type ResolvedSettings,
  type Review,
  type ReviewJob,
  repositoryId,
  runId,
  type State,
} from "@lookover/contracts";
import { trayView } from "./tray.ts";

const NOW = new Date(2026, 9, 3, 9, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const SHA = commitSha("a1f9c2e");

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

function engine(id: EngineId, name: string): Engine {
  return {
    id,
    name,
    cli: id,
    version: "1.0.0",
    state: "ready",
    detail: "Max plan",
    unusable: null,
    since: NOW - 3 * HOUR,
    limitUntil: null,
    signingIn: false,
  };
}

/** Set up, everything connected and running, one repository `owner/name`, no pull requests. */
function calm(owner = "sam", name = "app"): State {
  return {
    seq: 0,
    now: NOW,
    setup: { done: true, step: "background", reached: "background", github: "done", firstReviewChange: null },
    engines: { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") },
    connection: {
      id: null,
      state: "connected",
      cause: null,
      accounts: [],
      listed: true,
      listingCause: null,
      look: null,
      unreached: [],
      signIn: null,
      person: { id: 7, login: "sam" },
      web: GITHUB_WEB,
      since: NOW - 3 * HOUR,
      limitUntil: null,
    },
    service: {
      state: "running",
      since: NOW - 3 * HOUR,
      version: "0.1.0",
      command: "lookover",
      agent: { path: { reach: "no", folder: "~/.local/bin" }, offer: "binary", skills: [] },
      startAtLogin: true,
      atLogin: "this",
      loginItem: "os",
      tray: { on: true, shown: "shown", reason: null },
      os: "linux",
      paused: null,
      remote: false,
      unlocked: false,
      checks: null,
    },
    settings: DEFAULTS,
    repos: [{ id: repositoryId(`${owner}/${name}`), owner, name, enabled: true, settings: DEFAULTS }],
    departed: [],
    rules: [],
    changes: {},
    reviews: {},
  };
}

function job(state: ReviewJob["state"]): ReviewJob {
  return {
    id: jobId(`job-${state}`),
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
  };
}

/** An open blocking finding of round 1. */
const blocking: Finding = {
  id: findingId("f1"),
  fingerprints: { location: "src/app.ts:1:f1", meaning: "f1" },
  severity: "blocking",
  category: "Correctness",
  title: "f1",
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
  status: "open",
  posted: false,
  commented: false,
  raisedIn: 1,
  anchoredIn: 1,
  closedIn: null,
  verifiedSha: null,
  closedWhy: null,
  decidedVia: null,
  claim: null,
  kept: 0,
};

type Kind = "running" | "needs-you" | "preview";

/** A review running now, one whose round left a question for the person, or a preview that found something. */
function levels(kind: Kind): Partial<Review> {
  if (kind === "running") {
    return {
      job: job("running"),
      run: {
        id: runId("run-1"),
        reviewer: "claude",
        secondFinder: null,
        confirmer: null,
        confirmFallback: null,
        sha: SHA,
        preview: false,
        startedAt: NOW - 3 * MIN,
        step: "finding",
        stepAt: NOW - MIN,
        steps: [],
        activities: [],
        posting: null,
      },
    };
  }
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
    startedAt: NOW - 13 * MIN,
    endedAt: NOW - 10 * MIN,
    raised: 0,
    verifiedFixed: 0,
    open: 0,
    steps: [],
    sessions: [],
  };
  if (kind === "preview")
    return { job: job("done"), loop: "open", rounds: [round], preview: true, findings: [blocking] };
  return { job: job("done"), loop: "needs_owner", rounds: [round] };
}

/** Adds pull request `n` of the state's one repository, its review at `kind`, opened by `by`. */
function withChange(state: State, n: number, kind: Kind, by = "sam"): State {
  const [repo] = state.repos;
  if (!repo) throw new Error("No repository");
  const id = changeId(`${repo.id}#${n}`);
  const review: Review = { ...emptyReview(id, NOW - 10 * MIN), ...levels(kind) };
  return {
    ...state,
    changes: {
      ...state.changes,
      [id]: {
        id,
        repoId: repo.id,
        number: n,
        title: `Change ${n}`,
        openedBy: by,
        author: by === "sam" ? "agent" : "other",
        writtenBy: by === "sam" ? "claude" : null,
        headSha: SHA,
        openedAt: NOW - HOUR,
        draft: false,
        newCommits: 0,
      },
    },
    reviews: { ...state.reviews, [id]: review },
  };
}

const pausedUntil = (state: State, until: number | null): State => ({
  ...state,
  service: { ...state.service, paused: { since: NOW - HOUR, until } },
});

const signedOut = (state: State, id: EngineId): State => ({
  ...state,
  engines: { ...state.engines, [id]: { ...state.engines[id], state: "signed-out" } },
});

const notSetUp = (state: State): State => ({ ...state, setup: { ...state.setup, done: false } });

test("nothing to say: idle, all good", () => {
  expect(trayView(calm())).toEqual({
    state: "idle",
    tooltip: "Lookover: All good",
    line: "All good",
    paused: false,
  });
});

test("one review running names its pull request as the app does; more are counted", () => {
  expect(trayView(withChange(calm(), 12, "running"))).toMatchObject({
    state: "reviewing",
    line: "Reviewing sam/app #12",
  });
  const two = withChange(withChange(calm(), 12, "running"), 13, "running");
  expect(trayView(two)).toMatchObject({ state: "reviewing", line: "Reviewing 2 pull requests" });
  // Another author's, opened and reviewed without the person asking: not theirs, still what the service is doing.
  expect(trayView(withChange(calm(), 7, "running", "ana"))).toMatchObject({
    state: "reviewing",
    line: "Reviewing sam/app #7",
  });
});

test("a pull request that needs the person, counted as Home's sentence counts: the person's own", () => {
  expect(trayView(withChange(calm(), 4, "needs-you"))).toMatchObject({
    state: "needs-you",
    line: "1 pull request needs you",
    tooltip: "Lookover: 1 pull request needs you",
  });
  const three = withChange(withChange(withChange(calm(), 4, "needs-you"), 5, "needs-you"), 6, "needs-you");
  expect(trayView(three)).toMatchObject({ state: "needs-you", line: "3 pull requests need you" });
});

test("paused says until when, in the app's words, and offers Resume", () => {
  const until = new Date(2026, 9, 3, 9, 52).getTime();
  expect(trayView(pausedUntil(calm(), until))).toEqual({
    state: "paused",
    tooltip: "Lookover: Paused until 09:52",
    line: "Paused until 09:52",
    paused: true,
  });
  expect(trayView(pausedUntil(calm(), null))).toMatchObject({
    state: "paused",
    line: "Paused until you resume",
  });
});

test("a problem says the pill's own words", () => {
  expect(trayView(signedOut(calm(), "claude"))).toEqual({
    state: "problem",
    tooltip: "Lookover: Claude needs attention",
    line: "Claude needs attention",
    paused: false,
  });
  expect(trayView(signedOut(signedOut(calm(), "claude"), "codex"))).toMatchObject({
    state: "problem",
    line: "2 things need attention",
  });
});

test("worst first: a problem hides a pause, a pause hides what needs you, what needs you hides a review running", () => {
  const busy = withChange(withChange(calm(), 4, "needs-you"), 12, "running");
  expect(trayView(busy)).toMatchObject({ state: "needs-you", line: "1 pull request needs you" });
  const pausedBusy = pausedUntil(busy, null);
  expect(trayView(pausedBusy)).toMatchObject({
    state: "paused",
    line: "Paused until you resume",
    paused: true,
  });
  // A problem while paused still offers Resume: the menu says what the service does, the line the worst.
  expect(trayView(signedOut(pausedBusy, "claude"))).toEqual({
    state: "problem",
    tooltip: "Lookover: Claude needs attention",
    line: "Claude needs attention",
    paused: true,
  });
});

test("before setup is done, the way back: finish setting up, whatever else stands", () => {
  expect(trayView(notSetUp(calm()))).toEqual({
    state: "needs-you",
    tooltip: "Lookover: Finish setting up",
    line: "Finish setting up",
    paused: false,
  });
  expect(trayView(notSetUp(signedOut(withChange(calm(), 12, "running"), "claude")))).toMatchObject({
    state: "needs-you",
    line: "Finish setting up",
  });
});

test("previews alone that need the person are said in Home's words, without its full stop", () => {
  expect(trayView(withChange(calm(), 4, "preview"))).toMatchObject({
    state: "needs-you",
    line: "1 preview to read",
    tooltip: "Lookover: 1 preview to read",
  });
  expect(trayView(withChange(withChange(calm(), 4, "preview"), 5, "preview"))).toMatchObject({
    line: "2 previews to read",
  });
  // A preview among other pull requests that need the person: all are counted as pull requests, as Home counts them.
  expect(trayView(withChange(withChange(calm(), 4, "preview"), 5, "needs-you"))).toMatchObject({
    line: "2 pull requests need you",
  });
});

test("a tooltip past Windows' 127 characters is cut to 126 and an ellipsis; the line stays whole", () => {
  const owner = "o".repeat(60);
  const name = "n".repeat(60);
  const view = trayView(withChange(calm(owner, name), 12, "running"));
  expect(view.line).toBe(`Reviewing ${owner}/${name} #12`);
  // "Lookover: Reviewing " is 20 characters, the owner 60 and its slash 1: 45 of the name's reach 126.
  expect(view.tooltip).toBe(`Lookover: Reviewing ${"o".repeat(60)}/${"n".repeat(45)}…`);
});

test("the cut never splits a character in two: one that would cross 126 goes whole", () => {
  // 20 + 60 + 1 + 44 is 125: the face takes two UTF-16 units, the 126th and 127th, past the 126 the cut keeps.
  const view = trayView(withChange(calm("o".repeat(60), `${"n".repeat(44)}😀😀😀`), 12, "running"));
  expect(view.tooltip).toBe(`Lookover: Reviewing ${"o".repeat(60)}/${"n".repeat(44)}…`);
});
