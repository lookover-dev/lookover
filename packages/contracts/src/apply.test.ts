// `apply` and the three levels of a review (ADR 0029): each event carries the job, run, findings or loop it
// results in, and `apply` records it on the snapshot.
import { expect, test } from "bun:test";
import {
  apply,
  type Change,
  type Connection,
  changeId,
  commitSha,
  connectionId,
  emptyReview,
  type Finding,
  findingId,
  GITHUB_WEB,
  jobId,
  type Repository,
  type ResolvedSettings,
  type Review,
  type ReviewJob,
  type Round,
  type Rule,
  type Run,
  repositoryId,
  runId,
  type State,
  type Turn,
} from "./index.ts";

const NOW = Date.UTC(2026, 9, 6, 10, 0, 0);
const ID = changeId("sam/app#1");
const SHA = commitSha("a1f9c2e");

/** Every key at Lookover's default. */
const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};
const REPO: Repository = {
  id: repositoryId("sam/app"),
  owner: "sam",
  name: "app",
  enabled: true,
  settings: DEFAULTS,
};

const CONNECTED: Connection = {
  id: null,
  state: "connected",
  cause: null,
  bot: "sam-reviewer[bot]",
  app: {
    id: 4242,
    slug: "sam-reviewer",
    account: { id: 7, login: "sam", type: "User" },
    person: { id: 7, login: "sam" },
  },
  accounts: [
    { account: { id: 7, login: "sam", type: "User" }, installationId: 77, cause: null, owner: null },
  ],
  unreached: [],
  way: "own",
  signIn: null,
  person: null,
  web: GITHUB_WEB,
  since: NOW,
  limitUntil: null,
  gh: null,
};

/** The own App's one account, sam's, as `CONNECTED` holds it. */
const SAM = {
  account: { id: 7, login: "sam", type: "User" },
  installationId: 77,
  cause: null,
  owner: null,
} as const;
/** The shared App on sam's account and on the organisation acme's. */
const ON_SAM = { ...SAM, installationId: 91 };
const ON_ACME = {
  account: { id: 80, login: "acme", type: "Organization" },
  installationId: 92,
  cause: null,
  owner: null,
} as const;

function snapshot(review: Partial<Review> = {}, change: Partial<Change> = {}): State {
  return {
    seq: 0,
    now: NOW,
    setup: {
      done: true,
      step: "background",
      reached: "background",
      github: "done",
      githubRefused: null,
      firstReviewChange: null,
    },
    engines: {
      claude: {
        id: "claude",
        name: "Claude",
        cli: "claude",
        version: "1.0.0",
        state: "ready",
        detail: "Max plan",
        unusable: null,
        since: NOW,
        limitUntil: null,
        signingIn: false,
      },
      codex: {
        id: "codex",
        name: "Codex",
        cli: "codex",
        version: "1.0.0",
        state: "ready",
        detail: "ChatGPT Plus plan",
        unusable: null,
        since: NOW,
        limitUntil: null,
        signingIn: false,
      },
    },
    connection: CONNECTED,
    service: {
      state: "running",
      since: NOW,
      version: "0.1.0",
      command: "lookover",
      agent: {
        path: { reach: "no", folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin" },
        offer: "binary",
        skills: [{ agent: "claude", state: "none", folder: "~/.claude/skills/lookover-review-loop" }],
      },
      startAtLogin: true,
      startsAtLogin: true,
      loginItem: "os",
      paused: null,
      remote: false,
      unlocked: false,
      checks: null,
    },
    settings: DEFAULTS,
    repos: [REPO, { ...REPO, id: repositoryId("sam/other"), name: "other" }],
    departed: [],
    rules: [],
    changes: {
      [ID]: {
        id: ID,
        repoId: repositoryId("sam/app"),
        number: 1,
        title: "Change 1",
        openedBy: "sam",
        author: "agent",
        writtenBy: "claude",
        headSha: SHA,
        openedAt: NOW - 60_000,
        draft: false,
        fork: false,
        newCommits: 0,
        ...change,
      },
    },
    reviews: { [ID]: { ...emptyReview(ID, NOW - 60_000), ...review } },
  };
}

function job(state: ReviewJob["state"], extra: Partial<ReviewJob> = {}): ReviewJob {
  return {
    id: jobId("job-1"),
    sha: SHA,
    trigger: "comment",
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
  confirmer: null,
  confirmFallback: null,
  sha: SHA,
  preview: false,
  startedAt: NOW - 30_000,
  step: "finding",
  stepAt: NOW - 20_000,
  steps: [{ step: "preparing", ms: 10_000 }],
  activities: [],
  posting: null,
};

function finding(id: string, status: Finding["status"]): Finding {
  return {
    id: findingId(id),
    fingerprints: { location: `src/app.ts:1:${id}`, meaning: id },
    severity: "blocking",
    category: "Security",
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
    status,
    posted: true,
    commented: false,
    raisedIn: 1,
    anchoredIn: 1,
    closedIn: null,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
  };
}

function reviewOf(state: State): Review {
  const review = state.reviews[ID];
  if (!review) throw new Error("No review");
  return review;
}

test("a new job is recorded, and the timeline keeps what asked for it", () => {
  const after = apply(snapshot(), { type: "job.changed", at: NOW, seq: 1, changeId: ID, job: job("queued") });
  expect(reviewOf(after).job).toEqual(job("queued"));
  expect(reviewOf(after).timeline).toEqual([{ at: NOW, sha: null, kind: "queued", trigger: "comment" }]);
});

test("a job deferred while it ran loses its run, and the timeline says why once", () => {
  const deferred = job("deferred", { deferral: { reason: "engine-signed-out", engine: "codex" } });
  let after = apply(snapshot({ job: job("running"), run: RUN }), {
    type: "job.changed",
    at: NOW,
    seq: 1,
    changeId: ID,
    job: deferred,
  });
  after = apply(after, { type: "job.changed", at: NOW + 1_000, seq: 2, changeId: ID, job: deferred });
  expect(reviewOf(after)).toMatchObject({ job: deferred, run: null });
  expect(reviewOf(after).timeline).toEqual([
    {
      at: NOW,
      sha: null,
      kind: "deferred",
      deferral: { reason: "engine-signed-out", engine: "codex" },
    },
  ]);
});

test("a skipped job and why are kept in the timeline", () => {
  const skipped = job("skipped", { skip: "not-yours" });
  const after = apply(snapshot(), { type: "job.changed", at: NOW, seq: 1, changeId: ID, job: skipped });
  expect(reviewOf(after).job).toEqual(skipped);
  expect(reviewOf(after).timeline).toEqual([{ at: NOW, sha: null, kind: "skipped" }]);
});

test("a run that starts records its run and the job the event carries", () => {
  const running = job("running", { id: jobId("job-2") });
  const after = apply(snapshot({ job: job("deferred", { deferral: { reason: "paused" } }) }), {
    type: "run.started",
    at: NOW,
    seq: 1,
    changeId: ID,
    job: running,
    run: { ...RUN, step: "preparing", stepAt: NOW, startedAt: NOW, steps: [], preview: true },
  });
  expect(reviewOf(after).job).toEqual(running);
  expect(reviewOf(after).run).toMatchObject({ reviewer: "codex", step: "preparing", startedAt: NOW });
  expect(reviewOf(after).preview).toBe(true);
  expect(reviewOf(after).timeline).toEqual([{ at: NOW, sha: SHA, kind: "started", round: 1 }]);
});

test("a run moves step by step and keeps how long each step took", () => {
  const after = apply(snapshot({ job: job("running"), run: RUN }), {
    type: "run.step",
    at: NOW,
    seq: 1,
    changeId: ID,
    step: "confirming",
  });
  expect(reviewOf(after).run).toMatchObject({
    step: "confirming",
    stepAt: NOW,
    steps: [
      { step: "preparing", ms: 10_000 },
      { step: "finding", ms: 20_000 },
    ],
  });
});

test("a run's activities are appended as they come, its last 50 kept; with no run going they change nothing (ADR 0055)", () => {
  const read = (n: number) => ({
    engine: "claude" as const,
    pass: "find" as const,
    activity: { kind: "read" as const, path: `src/file-${n}.ts` },
  });
  const first = [read(1), read(2)];
  let after = apply(snapshot({ job: job("running"), run: RUN }), {
    type: "run.activity",
    at: NOW,
    seq: 1,
    changeId: ID,
    activities: first,
  });
  expect(reviewOf(after).run?.activities).toEqual(first);
  const command = {
    engine: "codex" as const,
    pass: "confirm" as const,
    activity: { kind: "command" as const, text: "rg --files" },
  };
  after = apply(after, {
    type: "run.activity",
    at: NOW + 1_000,
    seq: 2,
    changeId: ID,
    activities: [command],
  });
  expect(reviewOf(after).run?.activities).toEqual([...first, command]);

  // Past 50, the oldest go: 3 kept plus 49 new is 52, so read 1 and read 2 leave.
  const many = Array.from({ length: 49 }, (_, i) => read(100 + i));
  after = apply(after, { type: "run.activity", at: NOW + 2_000, seq: 3, changeId: ID, activities: many });
  expect(reviewOf(after).run?.activities).toEqual([command, ...many]);

  const idle = snapshot({ job: job("done") });
  const ignored = apply(idle, { type: "run.activity", at: NOW, seq: 1, changeId: ID, activities: first });
  expect(reviewOf(ignored)).toEqual(reviewOf(idle));
});

test("a run's activities and outbox leave the review's updatedAt alone, so Home's order holds still (ADR 0055)", () => {
  const before = snapshot({ job: job("running"), run: { ...RUN, step: "publishing" } });
  const activity = {
    engine: "claude" as const,
    pass: "find" as const,
    activity: { kind: "read" as const, path: "src/a.ts" },
  };
  let after = apply(before, {
    type: "run.activity",
    at: NOW + 5_000,
    seq: 1,
    changeId: ID,
    activities: [activity],
  });
  after = apply(after, {
    type: "run.posting",
    at: NOW + 6_000,
    seq: 2,
    changeId: ID,
    posting: { sent: 1, owed: 2, wait: null },
  });
  expect(reviewOf(after).run?.activities).toEqual([activity]);
  expect(reviewOf(after).updatedAt).toBe(reviewOf(before).updatedAt);
});

test("a run's activities go with the run: its round finished, or its job no longer running", () => {
  const run: Run = {
    ...RUN,
    activities: [{ engine: "claude", pass: "find", activity: { kind: "search", pattern: "apiKey" } }],
  };
  const deferred = job("deferred", { deferral: { reason: "paused" } });
  const after = apply(snapshot({ job: job("running"), run }), {
    type: "job.changed",
    at: NOW,
    seq: 1,
    changeId: ID,
    job: deferred,
  });
  expect(reviewOf(after).run).toBeNull();
  const finished = apply(snapshot({ job: job("running"), run }), {
    type: "round.finished",
    at: NOW,
    seq: 1,
    changeId: ID,
    round: ROUND_1,
    job: job("done"),
    newCommits: 0,
    findings: [],
    loop: "open",
    preview: false,
  });
  expect(reviewOf(finished).run).toBeNull();
});

test("a posting run shows its outbox as the last event says; with no run going it changes nothing (ADR 0055)", () => {
  const sending = { sent: 1, owed: 4, wait: null };
  let after = apply(snapshot({ job: job("running"), run: { ...RUN, step: "publishing" } }), {
    type: "run.posting",
    at: NOW,
    seq: 1,
    changeId: ID,
    posting: sending,
  });
  expect(reviewOf(after).run?.posting).toEqual(sending);
  const waiting = { sent: 2, owed: 4, wait: { until: NOW + 300_000, refusal: "rate_limited" as const } };
  after = apply(after, { type: "run.posting", at: NOW + 1_000, seq: 2, changeId: ID, posting: waiting });
  expect(reviewOf(after).run?.posting).toEqual(waiting);

  const idle = snapshot({ job: job("done") });
  const ignored = apply(idle, { type: "run.posting", at: NOW, seq: 1, changeId: ID, posting: sending });
  expect(reviewOf(ignored)).toEqual(reviewOf(idle));
});

test("a queued job's turn travels with it (ADR 0055)", () => {
  const turn: Turn = {
    behind: "engines",
    engines: ["claude"],
    changes: [changeId("sam/app#2")],
    testing: false,
  };
  const queued = job("queued", { turn });
  let after = apply(snapshot(), { type: "job.changed", at: NOW, seq: 1, changeId: ID, job: queued });
  expect(reviewOf(after).job?.turn).toEqual(turn);
  after = apply(after, {
    type: "job.changed",
    at: NOW + 1_000,
    seq: 2,
    changeId: ID,
    job: job("queued", { turn: { behind: "change" } }),
  });
  expect(reviewOf(after).job?.turn).toEqual({ behind: "change" });
});

test("a finished round, its job and the change's new commits are recorded as the event says; the run is gone", () => {
  const round: Round = {
    n: 1,
    sha: SHA,
    reviewer: "codex",
    secondFind: null,
    confirmer: null,
    confirmFallback: null,
    confirmFailure: null,
    ruledOut: [],
    startedAt: NOW - 30_000,
    endedAt: NOW,
    raised: 2,
    verifiedFixed: 0,
    open: 1,
    steps: [],
    sessions: [],
  };
  const findings = [finding("a", "escalated"), finding("b", "withdrawn")];
  const finished = {
    type: "round.finished",
    at: NOW,
    seq: 1,
    changeId: ID,
    round,
    job: job("done"),
    newCommits: 1,
    findings,
    loop: "needs_owner",
    preview: false,
  } as const;
  const after = apply(snapshot({ job: job("running"), run: RUN }, { newCommits: 2 }), finished);
  const review = reviewOf(after);
  expect(review).toMatchObject({
    run: null,
    loop: "needs_owner",
    rounds: [round],
    findings,
    job: job("done"),
  });
  expect(after.changes[ID]?.newCommits).toBe(1);
  expect(review.timeline).toEqual([{ at: NOW, sha: SHA, kind: "posted", round: 1, open: 1 }]);
  // No counts sent, none kept; sent, the repository they name has them, and no other (ADR 0049).
  expect(after.repos.map((r) => r.noise)).toEqual([undefined, undefined]);
  const counts = { reviews: 1, postedBelowBlocking: 0, raisedByRule: {} };
  const noise = { repoId: repositoryId("sam/app"), counts };
  const counted = apply(after, { ...finished, seq: 2, noise });
  expect(counted.repos.map((r) => r.noise)).toEqual([counts, undefined]);
  // A round that finishes once its change is closed still moves its repository's counts (Lookover #156 F3).
  const closed = apply(after, { type: "change.closed", at: NOW, seq: 2, changeId: ID });
  expect(closed.changes[ID]).toBeUndefined();
  const late = apply(closed, { ...finished, seq: 3, noise });
  expect(late.repos.map((r) => r.noise)).toEqual([counts, undefined]);
});

test("the second look goes through as the events say: the run's confirmer, the round's, each finding's (ADR 0044)", () => {
  const fallback = { reason: "not-ready", engine: "claude", state: "limit" } as const;
  const run: Run = { ...RUN, confirmer: "codex", confirmFallback: fallback };
  let after = apply(snapshot({ job: job("queued") }), {
    type: "run.started",
    at: NOW,
    seq: 1,
    changeId: ID,
    job: job("running"),
    run,
  });
  expect(reviewOf(after).run).toMatchObject({
    reviewer: "codex",
    confirmer: "codex",
    confirmFallback: fallback,
  });

  const kept = finding("a", "open");
  const candidate = {
    severity: kept.severity,
    category: kept.category,
    title: "b",
    body: "",
    location: { path: "src/app.ts", side: "head", line: 3, endLine: null },
    lineText: "  return total;",
    anchoring: "reported",
    foundBy: "codex",
    defectKey: "b",
    suggestion: null,
    preExisting: false,
    rule: null,
    fingerprints: { location: "loc-b", meaning: "b" },
  } as const;
  const round: Round = {
    ...ROUND_1,
    reviewer: "codex",
    confirmer: "codex",
    confirmFallback: fallback,
    confirmFailure: null,
    ruledOut: [{ candidate, by: "codex", reason: "The caller checks first.", evidence: ["src/app.ts:2"] }],
  };
  const findings: Finding[] = [
    {
      ...kept,
      foundBy: "codex",
      lineText: "  log(req.headers);",
      anchoring: "reported",
      confirmation: {
        verdict: "unsure",
        by: "codex",
        reason: "Can't see the logger's filter.",
        evidence: [],
        demoted: true,
      },
    },
  ];
  after = apply(after, {
    type: "round.finished",
    at: NOW + 1_000,
    seq: 2,
    changeId: ID,
    round,
    job: job("done"),
    newCommits: 0,
    findings,
    loop: "open",
    preview: false,
  });
  expect(reviewOf(after).rounds).toEqual([round]);
  expect(reviewOf(after).findings).toEqual(findings);
});

test("dismissed findings and the loop are recorded as the event says", () => {
  const findings = [finding("a", "dismissed")];
  const after = apply(
    snapshot({ job: job("done"), loop: "needs_owner", findings: [finding("a", "escalated")] }),
    {
      type: "finding.dismissed",
      at: NOW,
      seq: 1,
      changeId: ID,
      findingIds: [findingId("a")],
      findings,
      loop: "settled",
    },
  );
  expect(reviewOf(after)).toMatchObject({ findings, loop: "settled" });
  expect(reviewOf(after).timeline).toEqual([
    { at: NOW, sha: null, kind: "dismissed", findingIds: [findingId("a")] },
  ]);
});

test("a settings change records what now applies, for the owner and for each repository it names", () => {
  const owner: ResolvedSettings = {
    ...DEFAULTS,
    onPush: { value: true, origin: "owner-default", overrode: { value: false, origin: "lookover-default" } },
  };
  const app: ResolvedSettings = {
    ...owner,
    strictness: {
      value: "blocking",
      origin: "owner-repository",
      overrode: { value: "recommended", origin: "lookover-default" },
    },
  };
  const after = apply(snapshot(), {
    type: "settings.changed",
    at: NOW,
    seq: 1,
    settings: owner,
    repos: { [REPO.id]: app },
  });
  expect(after.settings).toEqual(owner);
  expect(after.repos.map((r) => [r.name, r.settings.onPush.value, r.settings.strictness.origin])).toEqual([
    ["app", true, "owner-repository"],
    ["other", false, "lookover-default"],
  ]);
});

test("an opened change and the commits pushed to it are kept in its timeline, with who did it", () => {
  const other = changeId("sam/app#2");
  const base = snapshot().changes[ID];
  if (!base) throw new Error("No change");
  const pushed = commitSha("b2c3d4e");
  let after = apply(snapshot(), { type: "change.opened", at: NOW, seq: 1, change: { ...base, id: other } });
  after = apply(after, {
    type: "change.pushed",
    at: NOW + 1_000,
    seq: 2,
    changeId: other,
    sha: pushed,
    commits: 2,
    by: "agent",
  });
  expect(after.reviews[other]?.timeline).toEqual([
    { at: NOW, sha: SHA, kind: "opened", by: "sam" },
    { at: NOW + 1_000, sha: pushed, kind: "pushed", by: "agent", commits: 2 },
  ]);
});

test("a draft opened again, marked ready, is a draft no more and keeps its review", () => {
  const review: Partial<Review> = {
    job: job("done"),
    timeline: [{ at: NOW - 60_000, sha: SHA, kind: "opened", by: "sam" }],
  };
  const before = snapshot(review, { draft: true, newCommits: 1 });
  const base = before.changes[ID];
  if (!base) throw new Error("No change");
  const after = apply(before, {
    type: "change.opened",
    at: NOW,
    seq: 1,
    change: { ...base, draft: false, newCommits: 0, openedAt: NOW },
  });
  expect(after.changes[ID]).toEqual({ ...base, draft: false });
  expect(reviewOf(after)).toEqual(reviewOf(before));
});

/** A round with nothing in it, for the tests of a closed change. */
const ROUND_1: Round = {
  n: 1,
  sha: SHA,
  reviewer: "claude",
  secondFind: null,
  confirmer: null,
  confirmFallback: null,
  confirmFailure: null,
  ruledOut: [],
  startedAt: NOW - 30_000,
  endedAt: NOW,
  raised: 0,
  verifiedFixed: 0,
  open: 0,
  steps: [],
  sessions: [],
};

test("a closed change leaves the list; its review is kept, and the round its run posts after the close is recorded", () => {
  const other = changeId("sam/app#2");
  const base = snapshot().changes[ID];
  if (!base) throw new Error("No change");
  let after = apply(snapshot({ job: job("running"), run: RUN }), {
    type: "change.opened",
    at: NOW,
    seq: 1,
    change: { ...base, id: other },
  });
  after = apply(after, { type: "change.closed", at: NOW + 1_000, seq: 2, changeId: ID });
  expect(Object.keys(after.changes)).toEqual([other]);
  // Closed again, or never known: nothing changes but the number.
  const again = apply(after, { type: "change.closed", at: NOW + 2_000, seq: 3, changeId: ID });
  expect(again).toEqual({ ...after, seq: 3, now: NOW + 2_000 });
  // A running review is never cut by a close: its round is kept with the review, as the store keeps it.
  const round: Round = { ...ROUND_1, sha: SHA };
  after = apply(again, {
    type: "round.finished",
    at: NOW + 3_000,
    seq: 4,
    changeId: ID,
    round,
    job: job("done"),
    newCommits: 0,
    findings: [],
    loop: "settled",
    preview: false,
  });
  expect(reviewOf(after)).toMatchObject({ rounds: [round], job: job("done"), run: null });
  expect(after.changes[ID]).toBeUndefined();
});

test("a preview's round leaves the review a preview: nothing was posted (ADR 0047)", () => {
  const round: Round = { ...ROUND_1, sha: SHA };
  const after = apply(snapshot({ job: job("running"), run: { ...RUN, preview: true } }), {
    type: "round.finished",
    at: NOW,
    seq: 1,
    changeId: ID,
    round,
    job: job("done"),
    newCommits: 0,
    findings: [],
    loop: "settled",
    preview: true,
  });
  expect(reviewOf(after)).toMatchObject({ preview: true, rounds: [round], run: null });
});

test("a change reopened comes back with the review it had: its next round follows the last one", () => {
  const round: Round = { ...ROUND_1, sha: SHA };
  const before = snapshot({
    job: job("done"),
    rounds: [round],
    loop: "settled",
    timeline: [{ at: NOW - 60_000, sha: SHA, kind: "opened", by: "sam" }],
  });
  const base = before.changes[ID];
  if (!base) throw new Error("No change");
  const closed = apply(before, { type: "change.closed", at: NOW, seq: 1, changeId: ID });
  const reopened = apply(closed, {
    type: "change.opened",
    at: NOW + 1_000,
    seq: 2,
    change: { ...base, openedAt: NOW + 1_000 },
  });
  expect(reopened.changes[ID]).toEqual({ ...base, openedAt: NOW + 1_000 });
  expect(reviewOf(reopened)).toMatchObject({ rounds: [round], job: job("done"), loop: "settled" });
  expect(reviewOf(reopened).timeline).toEqual([
    { at: NOW - 60_000, sha: SHA, kind: "opened", by: "sam" },
    { at: NOW + 1_000, sha: SHA, kind: "opened", by: "sam" },
  ]);
  const started = apply(reopened, {
    type: "run.started",
    at: NOW + 2_000,
    seq: 3,
    changeId: ID,
    job: job("running"),
    run: RUN,
  });
  expect(reviewOf(started).timeline.at(-1)).toMatchObject({ kind: "started", round: 2 });
});

// ---- rules (ADR 0048) ----

function rule(id: string, repo: string | null, raised = 0): Rule {
  return {
    id,
    text: `Rule ${id}.`,
    source: repo === null ? "yours" : "REVIEW.md",
    line: repo === null ? null : 3,
    repoId: repo === null ? null : repositoryId(repo),
    raised,
    acted: 0,
    enabled: true,
    parentOff: false,
    nested: 0,
  };
}

test("a repository's rules read again replace its rules, and no other repository's or the owner's", () => {
  const before = {
    ...snapshot(),
    rules: [rule("old", "sam/app"), rule("other", "sam/site"), rule("mine", null), rule("gone", "sam/app")],
  };
  const after = apply(before, {
    type: "rules.changed",
    at: NOW + 1_000,
    seq: 1,
    repoId: repositoryId("sam/app"),
    rules: [rule("old", "sam/app", 2), rule("new", "sam/app")],
  });
  expect(after.rules).toEqual([
    rule("other", "sam/site"),
    rule("mine", null),
    rule("old", "sam/app", 2),
    rule("new", "sam/app"),
  ]);
});

test("a repository whose rules files are gone has no rules left", () => {
  const before = { ...snapshot(), rules: [rule("old", "sam/app"), rule("mine", null)] };
  const after = apply(before, {
    type: "rules.changed",
    at: NOW + 1_000,
    seq: 1,
    repoId: repositoryId("sam/app"),
    rules: [],
  });
  expect(after.rules).toEqual([rule("mine", null)]);
});

// ---- onboarding (ADR 0053) ----

test("a repository gone from the installation leaves the copy with its changes and its rules; their reviews are kept", () => {
  const other = changeId("sam/other#2");
  const before = snapshot();
  const withOther: State = {
    ...before,
    changes: {
      ...before.changes,
      [other]: { ...before.changes[ID], id: other, repoId: repositoryId("sam/other") },
    },
    reviews: { ...before.reviews, [other]: emptyReview(other, NOW) },
    rules: [rule("old", "sam/app"), rule("kept", "sam/other"), rule("mine", null)],
  };
  const after = apply(withOther, {
    type: "repo.removed",
    at: NOW + 1_000,
    seq: 1,
    repoId: repositoryId("sam/app"),
  });
  expect(after.repos.map((r) => r.id)).toEqual([repositoryId("sam/other")]);
  expect(Object.keys(after.changes)).toEqual([other]);
  expect(after.rules).toEqual([rule("kept", "sam/other"), rule("mine", null)]);
  expect(Object.keys(after.reviews).sort()).toEqual([ID, other].sort());
});

test("a repository removed takes the setup's first review with it when that change was its own, and only then", () => {
  const other = changeId("sam/other#2");
  const before = snapshot();
  const withOther: State = {
    ...before,
    changes: {
      ...before.changes,
      [other]: { ...before.changes[ID], id: other, repoId: repositoryId("sam/other") },
    },
    setup: { ...before.setup, firstReviewChange: ID },
  };
  const removeOther = apply(withOther, {
    type: "repo.removed",
    at: NOW + 1_000,
    seq: 1,
    repoId: repositoryId("sam/other"),
  });
  expect(removeOther.setup.firstReviewChange).toBe(ID);
  const removeApp = apply(withOther, {
    type: "repo.removed",
    at: NOW + 1_000,
    seq: 1,
    repoId: repositoryId("sam/app"),
  });
  expect(removeApp.setup).toEqual({ ...withOther.setup, firstReviewChange: null });
});

test("a repository the copy doesn't hold, removed, changes nothing but the number", () => {
  const before = snapshot();
  const after = apply(before, { type: "repo.removed", at: NOW, seq: 1, repoId: repositoryId("sam/gone") });
  expect({ ...after, seq: 0 }).toEqual(before);
});

test("a repository gone from the installation is said departed (ADR 0059), with when it left; once, however often it left", () => {
  const removed = apply(snapshot(), {
    type: "repo.removed",
    at: NOW + 1_000,
    seq: 1,
    repoId: repositoryId("sam/app"),
  });
  expect(removed.departed).toEqual([
    { id: repositoryId("sam/app"), owner: "sam", name: "app", at: NOW + 1_000 },
  ]);
  const back = apply(removed, { type: "repo.added", at: NOW + 2_000, seq: 2, repo: REPO });
  const again = apply(back, {
    type: "repo.removed",
    at: NOW + 3_000,
    seq: 3,
    repoId: repositoryId("sam/app"),
  });
  expect(again.departed).toEqual([
    { id: repositoryId("sam/app"), owner: "sam", name: "app", at: NOW + 3_000 },
  ]);
});

test("a departed repository back in the installation is no longer said departed; the others still are", () => {
  const one = apply(snapshot(), {
    type: "repo.removed",
    at: NOW + 1_000,
    seq: 1,
    repoId: repositoryId("sam/app"),
  });
  const two = apply(one, {
    type: "repo.removed",
    at: NOW + 2_000,
    seq: 2,
    repoId: repositoryId("sam/other"),
  });
  const back = apply(two, { type: "repo.added", at: NOW + 3_000, seq: 3, repo: REPO });
  expect(back.departed).toEqual([
    { id: repositoryId("sam/other"), owner: "sam", name: "other", at: NOW + 2_000 },
  ]);
});

test("a departed repository dismissed is no longer said; the others still are", () => {
  const one = apply(snapshot(), {
    type: "repo.removed",
    at: NOW + 1_000,
    seq: 1,
    repoId: repositoryId("sam/app"),
  });
  const two = apply(one, {
    type: "repo.removed",
    at: NOW + 2_000,
    seq: 2,
    repoId: repositoryId("sam/other"),
  });
  const dismissed = apply(two, {
    type: "repo.dismissed",
    at: NOW + 3_000,
    seq: 3,
    repoId: repositoryId("sam/other"),
  });
  expect(dismissed.departed).toEqual([
    { id: repositoryId("sam/app"), owner: "sam", name: "app", at: NOW + 1_000 },
  ]);
});

test("a connection lost records its cause and keeps the App it knows; connected again, the cause is gone", () => {
  const lost = apply(snapshot(), {
    type: "connection.changed",
    at: NOW + 1_000,
    seq: 1,
    patch: { state: "disconnected", cause: { kind: "key-refused", why: "clock" }, since: NOW + 1_000 },
  });
  expect(lost.connection).toEqual({
    ...CONNECTED,
    state: "disconnected",
    cause: { kind: "key-refused", why: "clock" },
    since: NOW + 1_000,
  });
  const suspended = apply(lost, {
    type: "connection.changed",
    at: NOW + 2_000,
    seq: 2,
    patch: { cause: { kind: "uninstalled", suspended: true } },
  });
  expect(suspended.connection.cause).toEqual({ kind: "uninstalled", suspended: true });
  const back = apply(suspended, {
    type: "connection.changed",
    at: NOW + 3_000,
    seq: 3,
    patch: {
      state: "connected",
      cause: null,
      accounts: [{ ...SAM, installationId: 78 }],
      since: NOW + 3_000,
    },
  });
  expect(back.connection).toEqual({
    ...CONNECTED,
    accounts: [{ ...SAM, installationId: 78 }],
    since: NOW + 3_000,
  });
});

test("a sign-in to the shared App shows its code until it ends, then the connection is the person's, with no bot (ADR 0066)", () => {
  const none = apply(snapshot(), {
    type: "connection.changed",
    at: NOW,
    seq: 1,
    patch: { id: null, state: "not-connected", way: null, bot: null, app: null, accounts: [] },
  });
  const code = {
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresAt: NOW + 900_000,
  };
  const waiting = apply(none, {
    type: "connection.changed",
    at: NOW + 1_000,
    seq: 2,
    patch: { signIn: code },
  });
  expect(waiting.connection.signIn).toEqual(code);
  expect(waiting.connection.way).toBeNull();
  const signedIn = apply(waiting, {
    type: "connection.changed",
    at: NOW + 6_000,
    seq: 3,
    patch: { signIn: null, way: "shared" },
  });
  const installed = apply(signedIn, {
    type: "connection.changed",
    at: NOW + 7_000,
    seq: 4,
    patch: {
      id: connectionId("github:sam"),
      state: "connected",
      accounts: [ON_SAM, ON_ACME],
      since: NOW + 7_000,
    },
  });
  expect(installed.connection).toEqual({
    ...CONNECTED,
    id: connectionId("github:sam"),
    way: "shared",
    signIn: null,
    bot: null,
    app: null,
    accounts: [ON_SAM, ON_ACME],
    since: NOW + 7_000,
  });
  // One account's cause is that account's: the connection stays connected, its other account used.
  const sso = { kind: "sso", organisation: "acme", url: null } as const;
  const refused = apply(installed, {
    type: "connection.changed",
    at: NOW + 8_000,
    seq: 5,
    patch: { accounts: [ON_SAM, { ...ON_ACME, cause: sso }] },
  });
  expect(refused.connection.state).toBe("connected");
  expect(refused.connection.cause).toBeNull();
  expect(refused.connection.accounts).toEqual([ON_SAM, { ...ON_ACME, cause: sso }]);
});

test("the accounts the shared App doesn't reach follow the service: named, asked, then reached and gone from the list", () => {
  const ledger = { id: 338, login: "ledger-dev" };
  const shared = { ...snapshot(), connection: { ...CONNECTED, way: "shared" as const, accounts: [ON_SAM] } };
  const named = apply(shared, {
    type: "connection.changed",
    at: NOW,
    seq: 1,
    patch: { unreached: [{ account: ledger, kind: "organisation", owner: false, askedAt: null }] },
  });
  expect(named.connection.unreached).toEqual([
    { account: ledger, kind: "organisation", owner: false, askedAt: null },
  ]);
  const asked = apply(named, {
    type: "connection.changed",
    at: NOW + 1_000,
    seq: 2,
    patch: { unreached: [{ account: ledger, kind: "organisation", owner: false, askedAt: NOW + 1_000 }] },
  });
  expect(asked.connection.unreached[0]?.askedAt).toBe(NOW + 1_000);
  const ledgerAccount = {
    account: { ...ledger, type: "Organization" as const },
    installationId: 93,
    cause: null,
  };
  const reached = apply(asked, {
    type: "connection.changed",
    at: NOW + 2_000,
    seq: 3,
    patch: { accounts: [ON_SAM, { ...ledgerAccount, owner: false }], unreached: [] },
  });
  expect(reached.connection.accounts).toEqual([ON_SAM, { ...ledgerAccount, owner: false }]);
  expect(reached.connection.unreached).toEqual([]);
});

test("your coding agent follows the service: the PATH reached and Lookover's command with it, then a skill installed", () => {
  const before = snapshot();
  expect(before.service.agent.path.reach).toBe("no");
  const onPath = apply(before, {
    type: "service.changed",
    at: NOW,
    seq: 1,
    patch: {
      command: "lookover",
      agent: {
        ...before.service.agent,
        path: { reach: "yes", folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin" },
      },
    },
  });
  expect(onPath.service.command).toBe("lookover");
  expect(onPath.service.agent.path).toEqual({
    reach: "yes",
    folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin",
  });
  const installed = apply(onPath, {
    type: "service.changed",
    at: NOW,
    seq: 2,
    patch: {
      agent: {
        ...onPath.service.agent,
        skills: [{ agent: "claude", state: "ours", folder: "~/.claude/skills/lookover-review-loop" }],
      },
    },
  });
  expect(installed.service.agent).toEqual({
    path: { reach: "yes", folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin" },
    offer: "binary",
    skills: [{ agent: "claude", state: "ours", folder: "~/.claude/skills/lookover-review-loop" }],
  });
  expect(installed.seq).toBe(2);
});

test("the setup's GitHub step moves as the service says, and keeps the flow's refusal until it is cleared", () => {
  const start = {
    ...snapshot(),
    setup: { ...snapshot().setup, done: false, step: "github" as const, github: "start" as const },
  };
  const refused = apply(start, {
    type: "setup.changed",
    at: NOW,
    seq: 1,
    setup: { github: "waiting-for-app", githubRefused: "unreachable" },
  });
  expect(refused.setup).toMatchObject({
    github: "waiting-for-app",
    githubRefused: "unreachable",
    step: "github",
  });
  const granted = apply(refused, {
    type: "setup.changed",
    at: NOW + 1_000,
    seq: 2,
    setup: { github: "nothing-granted", githubRefused: null },
  });
  expect(granted.setup).toMatchObject({ github: "nothing-granted", githubRefused: null });
});

// ---- sequence numbers (ADR 0038) ----

test("the snapshot is current up to the last event applied", () => {
  let after = apply({ ...snapshot(), seq: 7 }, { type: "clock", at: NOW + 1_000, seq: 8 });
  after = apply(after, { type: "rule.changed", at: NOW + 2_000, seq: 9, ruleId: "r", enabled: false });
  expect(after.seq).toBe(9);
});

test("an event the snapshot already includes changes nothing", () => {
  const before = { ...snapshot(), seq: 9 };
  const again = apply(before, { type: "rule.changed", at: NOW + 2_000, seq: 9, ruleId: "r", enabled: true });
  const older = apply(before, { type: "clock", at: NOW + 5_000, seq: 4 });
  expect(again).toBe(before);
  expect(older).toBe(before);
});

test("a replaced snapshot is current up to the event that replaced it", () => {
  const replacement = { ...snapshot(), seq: 40, now: NOW - 60_000 };
  const after = apply(
    { ...snapshot(), seq: 12 },
    {
      type: "state.replaced",
      at: NOW,
      seq: 13,
      state: replacement,
    },
  );
  expect(after.seq).toBe(13);
  expect(after.now).toBe(NOW - 60_000);
});

test("a replaced snapshot is taken whatever its number: a reload after a data reset, or past the end, starts lower", () => {
  const replacement = { ...snapshot(), seq: 5, now: NOW - 60_000 };
  const after = apply(
    { ...snapshot(), seq: 40 },
    { type: "state.replaced", at: NOW - 60_000, seq: 5, state: replacement },
  );
  expect(after.seq).toBe(5);
  expect(after.now).toBe(NOW - 60_000);
  // The numbers then go on from the replacement's.
  expect(apply(after, { type: "clock", at: NOW, seq: 6 }).seq).toBe(6);
});

test("a clock event at the snapshot's own number is the keepalive's: it moves now and nothing else; one that is behind changes nothing", () => {
  // The service's now between events (ADR 0046): the tab applies it and never stores it, so it carries the last
  // number seen.
  const before = { ...snapshot(), seq: 9, now: NOW };
  const ticked = apply(before, { type: "clock", at: NOW + 15_000, seq: 9 });
  expect(ticked).toMatchObject({ seq: 9, now: NOW + 15_000 });
  expect({ ...ticked, now: NOW }).toEqual(before);
  // A clock standing still, or a keepalive older than the last event: the copy is left as it is.
  expect(apply(ticked, { type: "clock", at: NOW + 15_000, seq: 9 })).toBe(ticked);
  expect(apply(ticked, { type: "clock", at: NOW + 1_000, seq: 9 })).toBe(ticked);
});
