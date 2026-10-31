// The log file's line for each event (ADR 0055, "The log file says what the service did"): written by hand, one row
// per event kind and case, given the state before it. Times are made in the machine's own zone, as the file is read.
import { expect, test } from "bun:test";
import {
  type Change,
  changeId,
  commitSha,
  type EventBody,
  emptyReview,
  findingId,
  GITHUB_WEB,
  jobId,
  type ResolvedSettings,
  type Review,
  type ReviewJob,
  type Round,
  type Run,
  type RunPosting,
  repositoryId,
  runId,
  type State,
} from "@lookover/contracts";
import { flowLines, logLineOf } from "./index.ts";

/** Sunday 11 October 2026, 10:00 in the machine's own zone. */
const AT = new Date(2026, 9, 11, 10, 0).getTime();
const ID = changeId("sasensi/ledger-api#151");
const SHA = commitSha("a1f9c2e7d3b4");
const PUSHED = commitSha("b2e8d1f0c9a7");

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

const CHANGE: Change = {
  id: ID,
  repoId: repositoryId("sasensi/ledger-api"),
  number: 151,
  title: "Retry the ledger sync",
  openedBy: "sasensi",
  author: "you",
  writtenBy: null,
  headSha: SHA,
  openedAt: AT - 60_000,
  draft: false,
  fork: false,
  newCommits: 0,
};

function job(state: ReviewJob["state"], extra: Partial<ReviewJob> = {}): ReviewJob {
  return {
    id: jobId("job-1"),
    sha: SHA,
    trigger: "opened",
    state,
    deferral: null,
    stepIn: null,
    skip: null,
    cancel: null,
    failure: null,
    turn: null,
    ...extra,
  };
}

const RUN: Run = {
  id: runId("run-1"),
  reviewer: "codex",
  secondFinder: null,
  confirmer: "claude",
  confirmFallback: null,
  sha: SHA,
  preview: false,
  startedAt: AT,
  step: "preparing",
  stepAt: AT,
  steps: [],
  activities: [],
  posting: null,
};

function round(n: number, extra: Partial<Round> = {}): Round {
  return {
    n,
    sha: SHA,
    reviewer: "codex",
    secondFind: null,
    confirmer: "claude",
    confirmFallback: null,
    confirmFailure: null,
    ruledOut: [],
    startedAt: AT - 60_000,
    endedAt: AT,
    raised: 2,
    verifiedFixed: 0,
    open: 2,
    steps: [],
    sessions: [],
    ...extra,
  };
}

/** The state before the event: the change shown, its review as given, the engines ready, nothing paused. */
function before(
  o: { review?: Partial<Review>; change?: Partial<Change> | null; paused?: State["service"]["paused"] } = {},
): State {
  const engine = (id: "claude" | "codex") => ({
    id,
    name: id === "claude" ? "Claude" : "Codex",
    cli: id,
    version: "1.0.0",
    state: "ready" as const,
    detail: "",
    unusable: null,
    since: AT - 60_000,
    limitUntil: null,
    gh: null,
    signingIn: false,
  });
  return {
    seq: 0,
    now: AT,
    setup: {
      done: true,
      step: "background",
      reached: "background",
      github: "done",
      githubRefused: null,
      firstReviewChange: null,
    },
    engines: { claude: engine("claude"), codex: engine("codex") },
    connection: {
      id: null,
      state: "connected",
      cause: null,
      bot: null,
      app: null,
      accounts: [],
      unreached: [],
      way: null,
      signIn: null,
      person: null,
      web: GITHUB_WEB,
      since: AT,
      limitUntil: null,
      gh: null,
    },
    service: {
      state: "running",
      since: AT,
      version: "0.1.0",
      command: "lookover",
      agent: { path: { reach: "no", folder: "~/.local/bin" }, offer: "binary", skills: [] },
      startAtLogin: true,
      startsAtLogin: true,
      loginItem: "memory",
      paused: o.paused ?? null,
      remote: false,
      unlocked: false,
      checks: null,
    },
    settings: DEFAULTS,
    repos: [],
    departed: [],
    rules: [],
    changes: o.change === null ? {} : { [ID]: { ...CHANGE, ...o.change } },
    reviews: { [ID]: { ...emptyReview(ID, AT - 60_000), ...o.review } },
  };
}

const jobChanged = (j: ReviewJob): EventBody => ({ type: "job.changed", at: AT, changeId: ID, job: j });

test("a change opened, marked ready, pushed and closed each say so, its title included", () => {
  const opened: EventBody = { type: "change.opened", at: AT, change: CHANGE };
  expect(logLineOf(opened, before({ change: null }))).toBe(
    "sasensi/ledger-api#151 opened by sasensi: Retry the ledger sync",
  );
  expect(logLineOf({ ...opened, change: { ...CHANGE, draft: true } }, before({ change: null }))).toBe(
    "sasensi/ledger-api#151 opened as a draft by sasensi: Retry the ledger sync",
  );
  expect(logLineOf(opened, before({ change: { draft: true } }))).toBe(
    "sasensi/ledger-api#151 marked ready for review",
  );
  // Seen again at a start, as it was: nothing happened.
  expect(logLineOf(opened, before())).toBeNull();
  const pushed: EventBody = {
    type: "change.pushed",
    at: AT,
    changeId: ID,
    sha: PUSHED,
    commits: 0,
    by: "agent",
  };
  expect(logLineOf(pushed, before())).toBe("sasensi/ledger-api#151 pushed b2e8d1f by the agent");
  expect(logLineOf({ ...pushed, by: "you" }, before())).toBe("sasensi/ledger-api#151 pushed b2e8d1f by you");
  expect(logLineOf({ type: "change.closed", at: AT, changeId: ID }, before())).toBe(
    "sasensi/ledger-api#151 closed",
  );
});

test("a job queued says what asked for it and the commit; waiting, back in the queue or moved, why", () => {
  const triggers: [ReviewJob["trigger"], string][] = [
    ["opened", "on opening"],
    ["push", "after a push"],
    ["comment", "asked on GitHub"],
    ["manual", "asked in the app"],
    ["first-review", "the setup's first review"],
  ];
  for (const [trigger, words] of triggers)
    expect(logLineOf(jobChanged(job("queued", { trigger })), before())).toBe(
      `sasensi/ledger-api#151 review queued (${words}) for a1f9c2e`,
    );
  const paused = job("deferred", { deferral: { reason: "paused" } });
  expect(logLineOf(jobChanged(paused), before())).toBe(
    "sasensi/ledger-api#151 review waits: reviews are paused",
  );
  expect(logLineOf(jobChanged(paused), before({ review: { job: paused } }))).toBeNull();
  const signedOut = job("deferred", { deferral: { reason: "engine-signed-out", engine: "claude" } });
  expect(logLineOf(jobChanged(signedOut), before({ review: { job: paused } }))).toBe(
    "sasensi/ledger-api#151 review waits: Claude is signed out",
  );
  expect(logLineOf(jobChanged(job("queued")), before({ review: { job: paused } }))).toBe(
    "sasensi/ledger-api#151 review back in the queue",
  );
  expect(
    logLineOf(jobChanged(job("queued", { sha: PUSHED })), before({ review: { job: job("queued") } })),
  ).toBe("sasensi/ledger-api#151 review moved to b2e8d1f");
  expect(logLineOf(jobChanged(job("queued")), before({ review: { job: job("queued") } }))).toBeNull();
});

test("a job left running at the last stop says it runs again, or failed, once", () => {
  const running = before({ review: { job: job("running"), run: RUN } });
  expect(logLineOf(jobChanged(job("queued")), running)).toBe(
    "sasensi/ledger-api#151 review runs again: the service stopped while it ran",
  );
  expect(
    logLineOf(
      jobChanged(job("failed", { failure: { kind: "service_stopped", detail: "", engine: null } })),
      running,
    ),
  ).toBe("sasensi/ledger-api#151 review failed: the service stopped before the review finished");
});

test("a job skipped, cancelled or failed says why, a failure with what the module said", () => {
  expect(logLineOf(jobChanged(job("skipped", { skip: "draft" })), before())).toBe(
    "sasensi/ledger-api#151 review skipped: still a draft",
  );
  expect(logLineOf(jobChanged(job("cancelled", { cancel: "closed" })), before())).toBe(
    "sasensi/ledger-api#151 review cancelled: the pull request was closed",
  );
  expect(
    logLineOf(
      jobChanged(job("failed", { failure: { kind: "review_failed", detail: "crashed", engine: "codex" } })),
      before(),
    ),
  ).toBe("sasensi/ledger-api#151 review failed: Codex gave no review (crashed)");
  expect(
    logLineOf(
      jobChanged(job("failed", { failure: { kind: "host_failed", detail: "", engine: null } })),
      before(),
    ),
  ).toBe("sasensi/ledger-api#151 review failed: GitHub did not answer");
  // Running and done are the run's and the round's lines.
  expect(logLineOf(jobChanged(job("running")), before())).toBeNull();
  expect(logLineOf(jobChanged(job("done")), before())).toBeNull();
});

test("a run started names its round, commit, depth, finder and confirmer", () => {
  const started = (run: Run): EventBody => ({
    type: "run.started",
    at: AT,
    changeId: ID,
    job: job("running"),
    run,
  });
  expect(logLineOf(started(RUN), before())).toBe(
    "sasensi/ledger-api#151 round 1 started on a1f9c2e, standard: Codex finds, Claude double-checks",
  );
  expect(logLineOf(started({ ...RUN, confirmer: null }), before({ review: { rounds: [round(1)] } }))).toBe(
    "sasensi/ledger-api#151 round 2 started on a1f9c2e, quick: Codex finds, nobody double-checks",
  );
  expect(logLineOf(started({ ...RUN, secondFinder: "claude" }), before())).toBe(
    "sasensi/ledger-api#151 round 1 started on a1f9c2e, deep: Codex and Claude find, Claude double-checks",
  );
  expect(logLineOf(started({ ...RUN, preview: true }), before())).toBe(
    "sasensi/ledger-api#151 round 1 started on a1f9c2e, standard, a preview: Codex finds, Claude double-checks",
  );
  expect(logLineOf({ type: "run.step", at: AT, changeId: ID, step: "finding" }, before())).toBeNull();
});

test("a round finished says posted with its open findings and what failed, kept as a preview, or given up", () => {
  const finished = (r: Round, j: ReviewJob, preview = false): EventBody => ({
    type: "round.finished",
    at: AT,
    changeId: ID,
    round: r,
    job: j,
    newCommits: 0,
    findings: [],
    loop: "open",
    preview,
  });
  expect(logLineOf(finished(round(1), job("done")), before())).toBe(
    "sasensi/ledger-api#151 round 1 posted: 2 open findings",
  );
  expect(logLineOf(finished(round(2, { open: 1 }), job("done")), before())).toBe(
    "sasensi/ledger-api#151 round 2 posted: 1 open finding",
  );
  expect(logLineOf(finished(round(1, { open: 0 }), job("done"), true), before())).toBe(
    "sasensi/ledger-api#151 round 1 kept as a preview: no open findings",
  );
  expect(
    logLineOf(
      finished(
        round(1, { confirmFailure: "timeout", secondFind: { engine: "claude", failure: "crashed" } }),
        job("done"),
      ),
      before(),
    ),
  ).toBe(
    "sasensi/ledger-api#151 round 1 posted: 2 open findings; second find failed: Claude stopped before it answered; not double-checked: Claude ran out of time",
  );
  expect(
    logLineOf(
      finished(
        round(1),
        job("failed", {
          failure: { kind: "publish_failed", detail: "GitHub answered 422", engine: "codex" },
        }),
      ),
      before(),
    ),
  ).toBe(
    "sasensi/ledger-api#151 round 1 kept, its posts given up: GitHub refused the review (GitHub answered 422)",
  );
});

test("a post that meets a refusal and waits says until when and why, once per wait; a post sent says nothing", () => {
  const posting = (sent: number, wait: RunPosting["wait"]): EventBody => ({
    type: "run.posting",
    at: AT,
    changeId: ID,
    posting: { sent, owed: 4, wait },
  });
  const limited = { until: new Date(2026, 9, 11, 10, 5).getTime(), refusal: "rate_limited" as const };
  const posting1 = (p: RunPosting | null) =>
    before({ review: { rounds: [round(1)], run: { ...RUN, posting: p } } });
  expect(logLineOf(posting(2, limited), posting1({ sent: 2, owed: 4, wait: null }))).toBe(
    "sasensi/ledger-api#151 round 2 posts wait: GitHub asked to wait, trying again at 10:05 (2 of 4 sent)",
  );
  const down = { until: new Date(2026, 9, 12, 0, 1).getTime(), refusal: "unavailable" as const };
  expect(logLineOf(posting(0, down), posting1(null))).toBe(
    "sasensi/ledger-api#151 round 2 posts wait: GitHub did not answer, trying again at 2026-10-12 00:01 (0 of 4 sent)",
  );
  // The same wait said again, a post sent, a wait over: no line.
  expect(logLineOf(posting(2, limited), posting1({ sent: 2, owed: 4, wait: limited }))).toBeNull();
  expect(logLineOf(posting(3, null), posting1({ sent: 2, owed: 4, wait: null }))).toBeNull();
  expect(logLineOf(posting(3, null), posting1({ sent: 3, owed: 4, wait: limited }))).toBeNull();
});

test("findings dismissed say which", () => {
  const dismissed: EventBody = {
    type: "finding.dismissed",
    at: AT,
    changeId: ID,
    findingIds: [findingId("F2"), findingId("F3")],
    findings: [],
    loop: "open",
  };
  expect(logLineOf(dismissed, before())).toBe("sasensi/ledger-api#151 F2, F3 marked wrong by you");
});

test("the service paused until when, or until resumed, and resumed", () => {
  const paused = (until: number | null): EventBody => ({
    type: "service.changed",
    at: AT,
    patch: { paused: { since: AT, until } },
  });
  expect(logLineOf(paused(new Date(2026, 9, 11, 11, 0).getTime()), before())).toBe(
    "reviews paused until 11:00",
  );
  expect(logLineOf(paused(new Date(2026, 9, 12, 9, 0).getTime()), before())).toBe(
    "reviews paused until 2026-10-12 09:00",
  );
  expect(logLineOf(paused(null), before())).toBe("reviews paused until resumed");
  const resumed: EventBody = { type: "service.changed", at: AT, patch: { paused: null } };
  expect(logLineOf(resumed, before({ paused: { since: AT - 1, until: null } }))).toBe("reviews resumed");
  expect(logLineOf(resumed, before())).toBeNull();
  expect(logLineOf({ type: "service.changed", at: AT, patch: { unlocked: true } }, before())).toBeNull();
});

test("an engine's state says what it is, until when for a limit, and nothing when it didn't move", () => {
  const engine = (patch: object): EventBody => ({ type: "engine.changed", at: AT, id: "codex", patch });
  const until = new Date(2026, 9, 14, 9, 5).getTime();
  expect(logLineOf(engine({ state: "limit", limitUntil: until }), before())).toBe(
    "Codex reached its limit until 2026-10-14 09:05",
  );
  expect(logLineOf(engine({ state: "limit", limitUntil: null }), before())).toBe(
    "Codex reached its limit until it resets",
  );
  expect(logLineOf(engine({ state: "signed-out" }), before())).toBe("Codex is signed out");
  expect(logLineOf(engine({ state: "missing" }), before())).toBe("Codex is not installed");
  expect(logLineOf(engine({ state: "failed-self-test" }), before())).toBe(
    "Codex didn't pass Lookover's safety check",
  );
  expect(logLineOf(engine({ state: "ready" }), before())).toBeNull();
  const limited = before();
  limited.engines.codex = { ...limited.engines.codex, state: "limit" };
  expect(logLineOf(engine({ state: "ready" }), limited)).toBe("Codex is ready");
  expect(logLineOf(engine({ signingIn: true }), before())).toBeNull();
});

test("what changes no review writes no line", () => {
  expect(logLineOf({ type: "clock", at: AT }, before())).toBeNull();
  expect(
    logLineOf({ type: "connection.changed", at: AT, patch: { state: "connected" } }, before()),
  ).toBeNull();
  expect(logLineOf({ type: "rule.changed", at: AT, ruleId: "r", enabled: false }, before())).toBeNull();
});

test("the manifest flow says why it stopped short and where an App made elsewhere is", () => {
  expect(flowLines.ghUnanswered("offline", "error connecting to api.github.com")).toBe(
    "gh couldn't answer for the organisation (offline): error connecting to api.github.com",
  );
  expect(flowLines.notMade("not_found")).toBe("GitHub didn't make the App: not_found");
  expect(flowLines.elsewhere("lookover-sam", "sam", "acme")).toBe(
    "lookover-sam was made on sam, not on acme: it isn't kept",
  );
  expect(flowLines.elsewhere("lookover-acme", "acme", null)).toBe(
    "lookover-acme was made on acme, not on your GitHub account: it isn't kept",
  );
  expect(flowLines.notKept("lookover-sam", "the keychain is locked")).toBe(
    "lookover-sam was made on GitHub but not kept: the keychain is locked",
  );
});
