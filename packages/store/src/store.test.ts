import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChangeId,
  changeId,
  commitSha,
  type EventBody,
  type Finding,
  findingId,
  type HostChange,
  type JobId,
  jobId,
  type ReviewJob,
  type Run,
  type RunId,
  repositoryId,
  runId,
  type Setup,
  type Turn,
} from "@lookover/contracts";
import { z } from "zod";
import { type Asked, openStore, type ReadRule, type RunEnd, type Store, type WaitingJob } from "./index.ts";

/** The database's file in a data folder, as the header names it. */
const DATABASE = "lookover.sqlite";
/** The migration that brings the outbox (ADR 0044). */
const OUTBOX_MIGRATION = "20261014090000-outbox.sql";

const homes: string[] = [];
const stores: Store[] = [];

/** A fresh data folder, removed after the test. The long form of the temp path: Bun fails under 8.3 names. */
function home(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-store-"));
  homes.push(dir);
  return dir;
}

/** The store on `dir`, for data thrown away: no commit waits for the disk. */
function open(dir: string): Store {
  const store = openStore({ home: dir, durable: false });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const REPO = { owner: "sasensi", name: "lookover-sandbox" };
const pr1: HostChange = {
  host: "github",
  number: 1,
  title: "Add unpaid filter and rewrite total",
  url: "https://github.com/sasensi/lookover-sandbox/pull/1",
  author: { login: "sasensi", id: 1234 },
  draft: false,
  fork: false,
  head: { ref: "planted-bugs", sha: commitSha("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678") },
  base: { ref: "main", sha: commitSha("0123456789abcdef0123456789abcdef01234567") },
};
const pr2: HostChange = {
  host: "github",
  number: 2,
  title: "Fix the unpaid filter",
  url: "https://github.com/sasensi/lookover-sandbox/pull/2",
  author: { login: "sasensi", id: 1234 },
  draft: true,
  fork: false,
  head: { ref: "fix-filter", sha: commitSha("b2c3d4e5f60718293a4b5c6d7e8f9012345678a1") },
  base: { ref: "main", sha: commitSha("0123456789abcdef0123456789abcdef01234567") },
};
const T1 = Date.UTC(2026, 9, 6, 9, 0);
const T2 = Date.UTC(2026, 9, 6, 9, 30);

test("the inbox says what a listing added, opened or pushed, and keeps when a change was first seen", () => {
  const dir = home();
  const store = open(dir);
  expect(store.inbox.replace(REPO, [pr1], T1)).toEqual({
    repositoryAdded: true,
    opened: [{ repo: REPO, change: pr1, writtenBy: null, firstSeenAt: T1 }],
    ready: [],
    pushed: [],
    closed: [],
    written: [],
  });
  const moved = {
    ...pr1,
    head: { ref: "planted-bugs", sha: commitSha("c3d4e5f60718293a4b5c6d7e8f9012345678a1b2") },
  };
  expect(store.inbox.replace(REPO, [moved, pr2], T2)).toEqual({
    repositoryAdded: false,
    opened: [{ repo: REPO, change: pr2, writtenBy: null, firstSeenAt: T2 }],
    ready: [],
    pushed: [{ repo: REPO, change: moved, writtenBy: null, firstSeenAt: T1, from: pr1.head.sha }],
    closed: [],
    written: [],
  });
  store.close();
  // What was listed is kept: the same listing again, after a restart, says nothing new.
  const again = open(dir);
  expect(again.inbox.replace(REPO, [moved, pr2], T2 + 1)).toEqual({
    repositoryAdded: false,
    opened: [],
    ready: [],
    pushed: [],
    closed: [],
    written: [],
  });
});

test("a draft listed ready for review is said once; listed a draft again, nothing is said", () => {
  const store = open(home());
  store.inbox.replace(REPO, [pr1, pr2], T1);
  const ready = { ...pr2, draft: false };
  const pushedReady = {
    ...ready,
    head: { ref: "fix-filter", sha: commitSha("e5f60718293a4b5c6d7e8f9012345678a1b2c3d4") },
  };
  expect(store.inbox.replace(REPO, [pr1, pushedReady], T2)).toMatchObject({
    ready: [{ repo: REPO, change: pushedReady, firstSeenAt: T1 }],
    pushed: [{ repo: REPO, change: pushedReady, firstSeenAt: T1, from: pr2.head.sha }],
  });
  expect(store.inbox.replace(REPO, [pr1, pushedReady], T2 + 1).ready).toEqual([]);
  expect(store.inbox.replace(REPO, [pr1, { ...pushedReady, draft: true }], T2 + 2).ready).toEqual([]);
  expect(store.inbox.open(REPO).map((c) => c.draft)).toEqual([false, true]);
});

test("a change the host no longer lists leaves the inbox, said once, and is new again if it comes back", () => {
  const store = open(home());
  store.inbox.replace(REPO, [pr1, pr2], T1);
  expect(store.inbox.replace(REPO, [pr2], T2).closed).toEqual([1]);
  expect(store.inbox.replace(REPO, [pr2], T2).closed).toEqual([]);
  expect(store.inbox.replace(REPO, [pr1, pr2], T2 + 1).opened).toEqual([
    { repo: REPO, change: pr1, writtenBy: null, firstSeenAt: T2 + 1 },
  ]);
});

test("the inbox gives a repository's open changes as last listed: head, draft, author, first seen", () => {
  const dir = home();
  const store = open(dir);
  expect(store.inbox.open(REPO)).toEqual([]);
  store.inbox.replace(REPO, [pr1, pr2], T1);
  const ready = {
    ...pr2,
    draft: false,
    head: { ref: "fix-filter", sha: commitSha("d4e5f60718293a4b5c6d7e8f9012345678a1b2c3") },
  };
  store.inbox.replace(REPO, [ready], T2);
  store.close();
  // Kept across a restart; a change the host no longer lists is not open.
  expect(open(dir).inbox.open(REPO)).toEqual([
    {
      repo: REPO,
      number: 2,
      head: commitSha("d4e5f60718293a4b5c6d7e8f9012345678a1b2c3"),
      draft: false,
      fork: false,
      authorId: 1234,
      writtenBy: null,
      writerThrough: null,
      firstSeenAt: T1,
    },
  ]);
  expect(open(dir).inbox.open({ owner: "sasensi", name: "elsewhere" })).toEqual([]);
});

test("the inbox keeps whether each change is a fork's, across a restart, as the last listing says", () => {
  const dir = home();
  const store = open(dir);
  const fromFork = { ...pr2, fork: true };
  store.inbox.replace(REPO, [pr1, fromFork], T1);
  store.close();
  const forks = (s: ReturnType<typeof open>) => s.inbox.open(REPO).map((c) => [c.number, c.fork]);
  const again = open(dir);
  expect(forks(again)).toEqual([
    [1, false],
    [2, true],
  ]);
  // Nothing else moved: the listing that says otherwise is kept all the same, and tells nothing new.
  expect(again.inbox.replace(REPO, [{ ...pr1, fork: true }, fromFork], T2)).toEqual({
    repositoryAdded: false,
    opened: [],
    ready: [],
    pushed: [],
    closed: [],
    written: [],
  });
  expect(forks(again)).toEqual([
    [1, true],
    [2, true],
  ]);
});

test("the inbox keeps who wrote each change and the commit it was read through; a new writer is said once", () => {
  const dir = home();
  const store = open(dir);
  const claude = { by: "claude", through: pr1.head.sha } as const;
  // Read for #1; #2 not read yet: unknown, through no commit.
  expect(store.inbox.replace(REPO, [pr1, pr2], T1, new Map([[1, claude]]))).toMatchObject({
    opened: [
      { change: pr1, writtenBy: "claude" },
      { change: pr2, writtenBy: null },
    ],
    written: [],
  });
  const read = () => store.inbox.open(REPO).map((c) => [c.number, c.writtenBy, c.writerThrough]);
  expect(read()).toEqual([
    [1, "claude", pr1.head.sha],
    [2, null, null],
  ]);
  const moved = {
    ...pr1,
    head: { ref: "planted-bugs", sha: commitSha("c3d4e5f60718293a4b5c6d7e8f9012345678a1b2") },
  };
  // A listing that says nothing of a change keeps who wrote it, and the commit it was read through.
  expect(store.inbox.replace(REPO, [moved, pr2], T2)).toMatchObject({
    pushed: [{ writtenBy: "claude" }],
    written: [],
  });
  expect(read()[0]).toEqual([1, "claude", pr1.head.sha]);
  // Read again: the same writer moves only the commit; another one is said, as the change now is.
  const writers = new Map([
    [1, { by: "claude", through: moved.head.sha }],
    [2, { by: "codex", through: pr2.head.sha }],
  ] as const);
  expect(store.inbox.replace(REPO, [moved, pr2], T2 + 1, writers)).toEqual({
    repositoryAdded: false,
    opened: [],
    ready: [],
    pushed: [],
    closed: [],
    written: [{ repo: REPO, change: pr2, writtenBy: "codex", firstSeenAt: T1 }],
  });
  store.close();
  expect(
    open(dir)
      .inbox.open(REPO)
      .map((c) => [c.number, c.writtenBy, c.writerThrough]),
  ).toEqual([
    [1, "claude", moved.head.sha],
    [2, "codex", pr2.head.sha],
  ]);
});

test("a repository's switch is on until the owner turns it off, kept across a restart, set before or after its first listing (ADR 0047)", () => {
  const dir = home();
  const store = open(dir);
  const other = { owner: "lookover-dev", name: "lookover-private" };
  // Never listed, never switched: on.
  expect(store.repos.enabled(REPO)).toBe(true);
  store.repos.setEnabled(REPO, false);
  expect(store.repos.enabled(REPO)).toBe(false);
  expect(store.repos.enabled(other)).toBe(true);
  // Switched off before its first listing: the listing still says the repository is new, and the switch holds.
  expect(store.inbox.replace(REPO, [], T1).repositoryAdded).toBe(true);
  expect(store.inbox.replace(REPO, [], T2).repositoryAdded).toBe(false);
  expect(store.repos.enabled(REPO)).toBe(false);
  // Listed first, then switched off: the same.
  expect(store.inbox.replace(other, [pr1], T1).repositoryAdded).toBe(true);
  store.repos.setEnabled(other, false);
  expect(store.inbox.replace(other, [pr1], T2).repositoryAdded).toBe(false);
  expect(store.repos.enabled(other)).toBe(false);
  store.close();
  const again = open(dir);
  expect(again.repos.enabled(REPO)).toBe(false);
  again.repos.setEnabled(REPO, true);
  expect(again.repos.enabled(REPO)).toBe(true);
  expect(again.repos.enabled(other)).toBe(false);
});

test("events are numbered one more than the last, kept in order, and numbered on after a restart", () => {
  const dir = home();
  const store = open(dir);
  expect(store.events.last()).toBe(0);
  const first: EventBody = { type: "clock", at: T1 };
  const second: EventBody = { type: "service.changed", at: T2, patch: { paused: null } };
  expect(store.events.append(first)).toEqual({ type: "clock", at: T1, seq: 1 });
  expect(store.events.append(second).seq).toBe(2);
  store.close();
  const again = open(dir);
  expect(again.events.last()).toBe(2);
  expect(again.events.append({ type: "clock", at: T2 + 1 }).seq).toBe(3);
  expect(again.events.all()).toEqual([
    { type: "clock", at: T1, seq: 1 },
    { type: "service.changed", at: T2, patch: { paused: null }, seq: 2 },
    { type: "clock", at: T2 + 1, seq: 3 },
  ]);
});

test("a store for data thrown away and a durable one on the same folder read each other's writes", () => {
  const dir = home();
  const quick = openStore({ home: dir, durable: false });
  stores.push(quick);
  quick.events.append({ type: "clock", at: T1 });
  const durable = openStore({ home: dir });
  stores.push(durable);
  expect(durable.events.append({ type: "clock", at: T2 }).seq).toBe(2);
  expect(quick.events.all()).toEqual([
    { type: "clock", at: T1, seq: 1 },
    { type: "clock", at: T2, seq: 2 },
  ]);
  quick.close();
  durable.close();
  const reopened = openStore({ home: dir, durable: false });
  stores.push(reopened);
  expect(reopened.events.last()).toBe(2);
});

test("a new store opened from a given number numbers its events after it, across a restart (ADR 0038)", () => {
  const dir = home();
  // A fresh room's store after one that reached 41: nothing is kept, but the numbers never go back.
  const store = openStore({ home: dir, durable: false, eventsFrom: 41 });
  stores.push(store);
  expect(store.events.last()).toBe(41);
  expect(store.events.all()).toEqual([]);
  expect(store.events.append({ type: "clock", at: T1 })).toEqual({ type: "clock", at: T1, seq: 42 });
  store.close();
  // Opened again from a lower number, the store keeps counting from where it is.
  const again = openStore({ home: dir, durable: false, eventsFrom: 7 });
  stores.push(again);
  expect(again.events.last()).toBe(42);
  expect(again.events.append({ type: "clock", at: T2 }).seq).toBe(43);
});

test("the setup says whether it was ever written: not before the first write, then across a restart (ADR 0047)", () => {
  const dir = home();
  const store = open(dir);
  expect(store.setup.kept()).toBe(false);
  store.close();
  // Reopened with its tables made and nothing written: still not kept.
  const reopened = open(dir);
  expect(reopened.migrated).toEqual([]);
  expect(reopened.setup.kept()).toBe(false);
  reopened.setup.write({ step: "github" });
  expect(reopened.setup.kept()).toBe(true);
  reopened.close();
  expect(open(dir).setup.kept()).toBe(true);
});

test("the setup starts at its first step, keeps each write across a restart, and never loses the furthest step reached (ADR 0047)", () => {
  const dir = home();
  const store = open(dir);
  const start: Setup = {
    done: false,
    step: "ai",
    reached: "ai",
    github: "start",
    githubRefused: null,
    firstReviewChange: null,
  };
  expect(store.setup.read()).toEqual(start);
  // Each write gives the setup as it now is; a step gone on to is the furthest reached.
  expect(store.setup.write({ step: "github" })).toEqual({ ...start, step: "github", reached: "github" });
  expect(store.setup.write({ github: "waiting-for-app", githubRefused: "unreachable" })).toEqual({
    ...start,
    step: "github",
    reached: "github",
    github: "waiting-for-app",
    githubRefused: "unreachable",
  });
  // Going back never loses the way forward.
  expect(store.setup.write({ step: "ai", githubRefused: null })).toEqual({
    ...start,
    step: "ai",
    reached: "github",
    github: "waiting-for-app",
  });
  store.close();
  const again = open(dir);
  expect(again.setup.read()).toEqual({ ...start, step: "ai", reached: "github", github: "waiting-for-app" });
  expect(again.setup.write({ github: "nothing-granted" }).github).toBe("nothing-granted");
  expect(
    again.setup.write({
      step: "first-review",
      github: "done",
      firstReviewChange: changeId("sasensi/lookover-sandbox#1"),
    }),
  ).toEqual({
    done: false,
    step: "first-review",
    reached: "first-review",
    github: "done",
    githubRefused: null,
    firstReviewChange: changeId("sasensi/lookover-sandbox#1"),
  });
  // Set up at once, as live mode writes it at the first start of a data folder.
  expect(again.setup.write({ done: true, step: "background" })).toEqual({
    done: true,
    step: "background",
    reached: "background",
    github: "done",
    githubRefused: null,
    firstReviewChange: changeId("sasensi/lookover-sandbox#1"),
  });
});

test("the setup's table refuses a GitHub step or a refusal the contracts don't name (ADR 0053)", () => {
  const dir = home();
  open(dir).setup.write({ step: "github" });
  const db = new Database(join(dir, DATABASE), { strict: true });
  expect(() => db.run("UPDATE setup SET github = 'bot-created'")).toThrow("CHECK");
  expect(() => db.run("UPDATE setup SET github_refused = 'timeout'")).toThrow("CHECK");
  for (const github of ["start", "waiting-for-app", "waiting-for-install", "nothing-granted", "done"])
    db.run("UPDATE setup SET github = ?", [github]);
  for (const refused of ["unreachable", "expired", "refused", "elsewhere", null])
    db.run("UPDATE setup SET github_refused = ?", [refused]);
  db.close();
});

test("start at login is on until the owner turns it off, kept across a restart, and never makes the setup kept (ADR 0054)", () => {
  const dir = home();
  const store = open(dir);
  expect(store.setup.startAtLogin()).toBe(true);
  store.setup.keepStartAtLogin(false);
  expect(store.setup.startAtLogin()).toBe(false);
  store.setup.keepStartAtLogin(true);
  expect(store.setup.startAtLogin()).toBe(true);
  // The machine's choice, beside the setup: a data folder whose setup nobody wrote is still at its first step.
  expect(store.setup.kept()).toBe(false);
  store.close();
  const again = open(dir);
  expect(again.setup.startAtLogin()).toBe(true);
  again.setup.keepStartAtLogin(false);
  again.close();
  expect(open(dir).setup.startAtLogin()).toBe(false);
});

test("the pause is kept across a restart, a later pause replaces it, and a resume clears it (ADR 0040)", () => {
  const dir = home();
  const store = open(dir);
  expect(store.pause.current()).toBeNull();
  store.pause.paused({ since: T1, until: null });
  store.pause.paused({ since: T2, until: T2 + 3_600_000 });
  store.close();
  const again = open(dir);
  expect(again.pause.current()).toEqual({ since: T2, until: T2 + 3_600_000 });
  again.pause.resumed();
  expect(again.pause.current()).toBeNull();
  again.pause.resumed();
  expect(again.pause.current()).toBeNull();
});

test("a self-test's result is kept per engine, program and version, across a restart, the last one winning (ADR 0044)", () => {
  const dir = home();
  const store = open(dir);
  const claude = { engine: "claude", program: "C:\\bin\\claude.exe", version: "2.1.283" } as const;
  expect(store.selfTests.result(claude)).toBeNull();
  store.selfTests.ran(claude, false);
  store.selfTests.ran(claude, true);
  store.selfTests.ran({ ...claude, version: "2.1.284" }, false);
  store.close();
  const again = open(dir);
  expect(again.selfTests.result(claude)).toEqual({ passed: true });
  expect(again.selfTests.result({ ...claude, version: "2.1.284" })).toEqual({ passed: false });
  expect(again.selfTests.result({ ...claude, program: "C:\\other\\claude.exe" })).toBeNull();
  expect(again.selfTests.result({ ...claude, engine: "codex" })).toBeNull();
});

const CHANGE = changeId("sasensi/lookover-sandbox#1");
const job: ReviewJob = {
  id: jobId("j1"),
  sha: pr1.head.sha,
  trigger: "manual",
  state: "queued",
  deferral: null,
  stepIn: null,
  skip: null,
  cancel: null,
  failure: null,
  turn: null,
};
const run: Run = {
  id: runId("r1"),
  reviewer: "claude",
  secondFinder: null,
  confirmer: null,
  confirmFallback: null,
  sha: pr1.head.sha,
  preview: false,
  startedAt: T1,
  step: "preparing",
  stepAt: T1,
  steps: [],
  activities: [],
  posting: null,
};

const OTHER = changeId("sasensi/lookover-sandbox#2");
const THIRD = changeId("sasensi/lookover-sandbox#3");
const SIGNED_OUT = { reason: "engine-signed-out", engine: "claude" } as const;
/** Behind Claude reviewing the other change. */
const BEHIND: Turn = { behind: "engines", engines: ["claude"], changes: [OTHER], testing: false };

/** A review of `j.sha` asked for `changeId`, by what asked for `j`; a new job takes `j`'s id. */
function asked(store: Store, changeId: ChangeId, j: ReviewJob): Asked {
  return store.jobs.asked(changeId, { sha: j.sha, trigger: j.trigger, id: () => j.id });
}

/**
 * Run `r` ends as round `n`, leaving `ledger`: saved as it reached publishing, owing no post, then ended as posted,
 * or as a preview that posted nothing.
 */
function roundEnded(
  store: Store,
  r: RunId,
  n: number,
  ledger: Finding[],
  at: number,
  end: "round" | "preview" = "round",
): ReviewJob {
  store.posts.saved(r, { n, held: ledger, ledger, plan: {}, posts: [] }, at);
  return store.jobs.runEnded(r, { kind: end }, at);
}

/** The job as the take is offered it: an ordinary review, not a full round, sent nowhere by the owner. */
function waits(changeId: ChangeId, j: ReviewJob): WaitingJob {
  return { changeId, job: j, preview: false, full: false, reroute: null };
}

/** Starts job `id` through the take, as the queue does, leaving every other waiting job as it is. */
function started(store: Store, id: JobId, r: Run): ReviewJob | undefined {
  return store.jobs.take((s) => (s.job.id === id ? { kind: "start", run: r } : null)).started?.job;
}

test("the take offers the waiting jobs oldest first, records each change it decides and the first start, and stops there", () => {
  const dir = home();
  const store = open(dir);
  expect(store.jobs.latest(CHANGE)).toBeNull();
  const second: ReviewJob = { ...job, id: jobId("j2"), sha: pr2.head.sha };
  const third: ReviewJob = { ...job, id: jobId("j3") };
  asked(store, CHANGE, job);
  asked(store, OTHER, second);
  asked(store, THIRD, third);
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job });
  expect(store.jobs.waiting()).toEqual({
    jobs: [waits(CHANGE, job), waits(OTHER, second), waits(THIRD, third)],
    reviewing: new Set(),
  });

  // Claude is signed out for the first; the second starts on Codex; the third is not offered.
  const offered: [JobId, string[]][] = [];
  const codexRun: Run = { ...run, id: runId("r2"), reviewer: "codex", sha: second.sha };
  const took = store.jobs.take((s, reviewing) => {
    offered.push([s.job.id, [...reviewing.keys()]]);
    return s.job.id === job.id ? { kind: "defer", deferral: SIGNED_OUT } : { kind: "start", run: codexRun };
  });
  expect(offered).toEqual([
    [job.id, []],
    [second.id, []],
  ]);
  const deferred: ReviewJob = { ...job, state: "deferred", deferral: SIGNED_OUT };
  const running: ReviewJob = { ...second, state: "running" };
  expect(took).toEqual({
    changed: [{ changeId: CHANGE, job: deferred }],
    started: { changeId: OTHER, job: running, run: codexRun, full: false },
  });
  store.close();

  // Kept: Codex is reviewing, and the running job is no longer offered.
  const again = open(dir);
  expect(again.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: deferred });
  expect(again.jobs.latest(OTHER)).toEqual({ changeId: OTHER, job: running });
  expect(again.jobs.waiting()).toEqual({
    jobs: [waits(CHANGE, deferred), waits(THIRD, third)],
    reviewing: new Set(["codex"]),
  });
  offered.length = 0;
  const claudeRun: Run = { ...run, id: runId("r3") };
  expect(
    again.jobs.take((s, reviewing) => {
      offered.push([s.job.id, [...reviewing.keys()]]);
      return { kind: "start", run: { ...claudeRun, id: runId(`r-${s.job.id}`) } };
    }).started,
  ).toEqual({
    changeId: CHANGE,
    job: { ...job, state: "running" },
    run: { ...claudeRun, id: runId("r-j1") },
    full: false,
  });
  expect(offered).toEqual([[job.id, ["codex"]]]);
  expect(again.jobs.waiting().reviewing).toEqual(new Set(["codex", "claude"]));

  // A run that ends frees its engine.
  roundEnded(again, codexRun.id, 1, [], T2);
  expect(again.jobs.waiting()).toEqual({
    jobs: [waits(THIRD, third)],
    reviewing: new Set(["claude"]),
  });
});

test("a review asked for as a preview is offered to the take as one, joined or restarted, and the join keeps the first ask's", () => {
  const dir = home();
  const store = open(dir);
  const first: ReviewJob = { ...job, trigger: "first-review" };
  store.jobs.asked(CHANGE, { sha: first.sha, trigger: first.trigger, id: () => first.id, preview: true });
  expect(store.jobs.waiting().jobs).toEqual([{ ...waits(CHANGE, first), preview: true }]);
  // Joined by an ordinary ask: still the preview the owner asked for, as the trigger is the first's.
  asked(store, CHANGE, { ...job, sha: pr2.head.sha });
  const joined: ReviewJob = { ...first, sha: pr2.head.sha };
  expect(store.jobs.waiting().jobs).toEqual([{ ...waits(CHANGE, joined), preview: true }]);
  store.close();
  const again = open(dir);
  const offered: WaitingJob[] = [];
  again.jobs.take((s) => {
    offered.push(s);
    return { kind: "defer", deferral: SIGNED_OUT };
  });
  expect(offered).toEqual([{ ...waits(CHANGE, joined), preview: true }]);
  // One asked without saying is no preview.
  asked(again, OTHER, { ...job, id: jobId("j2") });
  expect(again.jobs.waiting().jobs.map((w) => w.preview)).toEqual([true, false]);
  expect([again.jobs.previewOf(first.id), again.jobs.previewOf(jobId("j2"))]).toEqual([true, false]);
});

test("a job an ordinary ask made and a preview joined is a preview, its trigger kept", () => {
  const store = open(home());
  asked(store, CHANGE, job);
  expect(store.jobs.previewOf(job.id)).toBe(false);
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "first-review", id: () => jobId("j9"), preview: true });
  expect(store.jobs.latest(CHANGE)?.job).toMatchObject({ id: job.id, trigger: job.trigger });
  expect(store.jobs.previewOf(job.id)).toBe(true);
});

test("a review asked for in full is offered and started so, joined or restarted, and a full ask makes the job it joins full", () => {
  const dir = home();
  const store = open(dir);
  // Asked without saying: no full round.
  asked(store, CHANGE, job);
  expect(store.jobs.waiting().jobs).toEqual([waits(CHANGE, job)]);
  // Joined by the owner's `/lookover review full`: full from then on, whatever joins it later.
  store.jobs.asked(CHANGE, { sha: pr2.head.sha, trigger: "comment", id: () => jobId("j9"), full: true });
  asked(store, CHANGE, { ...job, sha: pr2.head.sha });
  const joined: ReviewJob = { ...job, sha: pr2.head.sha };
  expect(store.jobs.waiting().jobs).toEqual([{ ...waits(CHANGE, joined), full: true }]);
  // A new job asked in full is one; another asked without saying is none.
  store.jobs.asked(OTHER, { sha: pr2.head.sha, trigger: "comment", id: () => jobId("j2"), full: true });
  asked(store, THIRD, { ...job, id: jobId("j3") });
  store.close();
  const again = open(dir);
  expect(again.jobs.waiting().jobs.map((w) => w.full)).toEqual([true, true, false]);
  const took = again.jobs.take((s) => ({ kind: "start", run: { ...run, sha: s.job.sha } }));
  expect(took.started).toEqual({
    changeId: CHANGE,
    job: { ...joined, state: "running" },
    run: { ...run, sha: joined.sha },
    full: true,
  });
});

test("an ordinary waiting job joined by a preview ask is a preview from then on: the owner was told nothing is posted", () => {
  const store = open(home());
  // Opened after the first listing: its job is queued when the owner picks it at the first-review step.
  const opened: ReviewJob = { ...job, trigger: "opened" };
  asked(store, CHANGE, opened);
  store.jobs.asked(CHANGE, {
    sha: opened.sha,
    trigger: "first-review",
    id: () => jobId("j2"),
    preview: true,
  });
  const offered: WaitingJob[] = [];
  store.jobs.take((s) => {
    offered.push(s);
    return null;
  });
  expect(offered).toEqual([{ ...waits(CHANGE, opened), preview: true }]);
});

test("a preview has no check: completed from the start, joined as one too, unless the host already shows one", () => {
  const store = open(home());
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "first-review", id: () => job.id, preview: true });
  expect(store.jobs.checkOf(job.id)).toEqual({ ref: null, completed: true });
  // An ordinary job, its check not created yet, joined by a preview ask.
  const other: ReviewJob = { ...job, id: jobId("j2"), trigger: "opened" };
  asked(store, OTHER, other);
  store.jobs.asked(OTHER, { sha: other.sha, trigger: "first-review", id: () => jobId("j3"), preview: true });
  expect(store.jobs.checkOf(other.id)).toEqual({ ref: null, completed: true });
  // One whose check the host already shows keeps following it.
  const third = changeId("sasensi/lookover-sandbox#3");
  const shown: ReviewJob = { ...job, id: jobId("j4"), trigger: "opened" };
  asked(store, third, shown);
  store.jobs.checked(shown.id, { id: "c1", sha: shown.sha });
  store.jobs.asked(third, { sha: shown.sha, trigger: "first-review", id: () => jobId("j5"), preview: true });
  expect(store.jobs.checkOf(shown.id)).toEqual({ ref: { id: "c1", sha: shown.sha }, completed: false });
});

test("a check the host made after a preview joined its job is followed: the preview owes its end once done", () => {
  const store = open(home());
  // An ordinary job whose check is being created when a preview joins it: no check kept yet, so none owed.
  asked(store, CHANGE, job);
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "first-review", id: () => jobId("j2"), preview: true });
  expect(store.jobs.checkOf(job.id)).toEqual({ ref: null, completed: true });
  // The host answers: the check exists, and must not stay queued there.
  store.jobs.checked(job.id, { id: "c1", sha: job.sha });
  expect(store.jobs.checkOf(job.id)).toEqual({ ref: { id: "c1", sha: job.sha }, completed: false });
  started(store, job.id, run);
  const done = roundEnded(store, run.id, 1, [], T2);
  expect(store.jobs.previewsEnding()).toEqual([{ changeId: CHANGE, job: done }]);
  // A check let go (its job moved to a newer commit) is no check to end.
  store.jobs.checkCompleted(job.id);
  store.jobs.checked(job.id, null);
  expect(store.jobs.checkOf(job.id)).toEqual({ ref: null, completed: true });
});

test("a preview's job moved to a newer commit lets its check go and makes none: nothing more is owed", () => {
  const store = open(home());
  asked(store, CHANGE, job);
  store.jobs.checked(job.id, { id: "c1", sha: job.sha });
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "first-review", id: () => jobId("j2"), preview: true });
  // The old commit's check ended there; a preview has none on the new one.
  store.jobs.checked(job.id, null);
  expect(store.jobs.checkOf(job.id)).toEqual({ ref: null, completed: true });
  // An ordinary job let go of its check creates one on its new commit.
  asked(store, OTHER, { ...job, id: jobId("j3") });
  store.jobs.checked(jobId("j3"), { id: "c2", sha: job.sha });
  store.jobs.checked(jobId("j3"), null);
  expect(store.jobs.checkOf(jobId("j3"))).toEqual({ ref: null, completed: false });
});

test("a preview done whose check the host shows owes that check's end until it is completed, after a restart too", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  store.jobs.checked(job.id, { id: "c1", sha: job.sha });
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "first-review", id: () => jobId("j2"), preview: true });
  // Still running, it owes nothing yet; a preview with no check owes nothing ever.
  started(store, job.id, run);
  expect(store.jobs.previewsEnding()).toEqual([]);
  const other: ReviewJob = { ...job, id: jobId("j3"), trigger: "first-review" };
  store.jobs.asked(OTHER, { sha: other.sha, trigger: other.trigger, id: () => other.id, preview: true });
  started(store, other.id, { ...run, id: runId("r3") });
  roundEnded(store, runId("r3"), 1, [], T2);
  const done = roundEnded(store, run.id, 1, [], T2);
  store.close();
  const again = open(dir);
  expect(again.jobs.previewsEnding()).toEqual([{ changeId: CHANGE, job: done }]);
  again.jobs.checkCompleted(job.id);
  expect(again.jobs.previewsEnding()).toEqual([]);
});

test("a waiting job sent to the other engine keeps it until the job ends: offered with it, through a run that defers, not past its end (ADR 0047)", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  store.jobs.take(() => ({ kind: "defer", deferral: SIGNED_OUT }));
  const deferred: ReviewJob = { ...job, state: "deferred", deferral: SIGNED_OUT };
  store.jobs.reroute(job.id, "codex");
  expect(store.jobs.waiting().jobs).toEqual([{ ...waits(CHANGE, deferred), reroute: "codex" }]);
  store.close();
  // The take is offered it, after a restart too, and the run it starts is the caller's: its engine as planned.
  const again = open(dir);
  const offered: WaitingJob[] = [];
  const codexRun: Run = { ...run, reviewer: "codex" };
  again.jobs.take((s) => {
    offered.push(s);
    return { kind: "start", run: codexRun };
  });
  expect(offered).toEqual([{ ...waits(CHANGE, deferred), reroute: "codex" }]);
  // Deferred again by its run: the job waits on, sent where it was.
  const limit = { reason: "engine-limit", engine: "codex" } as const;
  again.jobs.runEnded(codexRun.id, { kind: "deferred", deferral: limit }, T1 + 1_000);
  expect(again.jobs.waiting().jobs).toEqual([
    { ...waits(CHANGE, { ...job, state: "deferred", deferral: limit }), reroute: "codex" },
  ]);
  // Ended as a round: the next job of the change plans as usual.
  started(again, job.id, { ...codexRun, id: runId("r2") });
  roundEnded(again, runId("r2"), 1, [], T2);
  const next: ReviewJob = { ...job, id: jobId("j2") };
  asked(again, CHANGE, next);
  expect(again.jobs.waiting().jobs).toEqual([waits(CHANGE, next)]);
  // A job that no longer waits can't be sent anywhere; nor one the record doesn't hold.
  started(again, next.id, { ...run, id: runId("r3") });
  expect(() => again.jobs.reroute(next.id, "codex")).toThrow("reroute: job j2 is not waiting");
  expect(() => again.jobs.reroute(jobId("j9"), "codex")).toThrow("reroute: job j9 is not waiting");
});

test("a job's reroute is cleared when the job ends, by the take's skip, cancel and fail or by its run's end", () => {
  const dir = home();
  const store = open(dir);
  const second: ReviewJob = { ...job, id: jobId("j2") };
  const third: ReviewJob = { ...job, id: jobId("j3") };
  const fourth: ReviewJob = { ...job, id: jobId("j4") };
  asked(store, CHANGE, job);
  asked(store, OTHER, second);
  asked(store, THIRD, third);
  asked(store, changeId("sasensi/lookover-sandbox#4"), fourth);
  for (const j of [job, second, third, fourth]) store.jobs.reroute(j.id, "codex");
  expect(store.jobs.waiting().jobs.map((w) => w.reroute)).toEqual(["codex", "codex", "codex", "codex"]);
  const failure = { kind: "host_failed", detail: "not_found" } as const;
  store.jobs.take((s) => {
    switch (s.job.id) {
      case job.id:
        return { kind: "skip", reason: "not-yours" };
      case second.id:
        return { kind: "cancel", reason: "closed" };
      case third.id:
        return { kind: "fail", failure };
      default:
        return { kind: "start", run: { ...run, id: runId("r4") } };
    }
  });
  store.jobs.runEnded(runId("r4"), { kind: "failed", failure }, T2);
  store.close();
  // Nothing offers an ended job again, so no verb at the entry can show its reroute: the row is read directly to see
  // it cleared, as ADR 0047 says.
  const db = new Database(join(dir, DATABASE), { strict: true });
  expect(db.query("SELECT id, state, reroute FROM jobs ORDER BY rowid").all()).toEqual([
    { id: "j1", state: "skipped", reroute: null },
    { id: "j2", state: "cancelled", reroute: null },
    { id: "j3", state: "failed", reroute: null },
    { id: "j4", state: "failed", reroute: null },
  ]);
  db.close();
});

test("a job held on an engine found but not usable keeps why, and a new why is a change", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  const tooOld = { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  const held = { reason: "engine-missing", engine: "codex", unusable: tooOld } as const;
  store.jobs.take(() => ({ kind: "defer", deferral: held }));
  store.close();
  const again = open(dir);
  expect(again.jobs.latest(CHANGE)?.job.deferral).toEqual(held);
  // Updated to a version still too old: the same reason, a new why.
  const still = { ...held, unusable: { ...tooOld, version: "0.161.5" } };
  expect(again.jobs.take(() => ({ kind: "defer", deferral: still })).changed).toHaveLength(1);
  expect(again.jobs.take(() => ({ kind: "defer", deferral: still })).changed).toEqual([]);
  // Gone from the machine: missing without a why.
  const gone = { reason: "engine-missing", engine: "codex", unusable: null } as const;
  expect(again.jobs.take(() => ({ kind: "defer", deferral: gone })).changed).toHaveLength(1);
  expect(again.jobs.latest(CHANGE)?.job.deferral).toEqual(gone);
  again.close();
});

test("the take writes only what changes: an unchanged deferral or a queued job left queued is no write", () => {
  const store = open(home());
  const second: ReviewJob = { ...job, id: jobId("j2"), sha: pr2.head.sha };
  asked(store, CHANGE, job);
  asked(store, OTHER, second);
  const deferred: ReviewJob = { ...job, state: "deferred", deferral: SIGNED_OUT };
  expect(store.jobs.take(() => ({ kind: "defer", deferral: SIGNED_OUT })).changed).toEqual([
    { changeId: CHANGE, job: deferred },
    { changeId: OTHER, job: { ...second, state: "deferred", deferral: SIGNED_OUT } },
  ]);

  // The same reason again, or the job left as it is: nothing changed, nothing to tell.
  expect(store.jobs.take(() => ({ kind: "defer", deferral: SIGNED_OUT }))).toEqual({
    changed: [],
    started: null,
  });
  expect(store.jobs.take(() => null)).toEqual({ changed: [], started: null });

  // Another reason is a change; back in the queue is one, and a second time is none.
  const limit = { reason: "engine-limit", engine: "claude" } as const;
  expect(store.jobs.take((s) => (s.job.id === job.id ? { kind: "defer", deferral: limit } : null))).toEqual({
    changed: [{ changeId: CHANGE, job: { ...deferred, deferral: limit } }],
    started: null,
  });
  const queued = (turn: Turn) =>
    store.jobs.take((s) => (s.job.id === job.id ? { kind: "queue", holds: [], turn } : null));
  expect(queued(BEHIND).changed).toEqual([{ changeId: CHANGE, job: { ...job, turn: BEHIND } }]);
  expect(queued(BEHIND).changed).toEqual([]);
  // What it waits behind moving is a change too (ADR 0055); the same again is none.
  const testing: Turn = { behind: "engines", engines: ["codex"], changes: [], testing: true };
  expect(queued(testing).changed).toEqual([{ changeId: CHANGE, job: { ...job, turn: testing } }]);
  expect(queued({ ...testing }).changed).toEqual([]);
  expect(queued({ behind: "change" }).changed).toEqual([
    { changeId: CHANGE, job: { ...job, turn: { behind: "change" } } },
  ]);
  expect(store.jobs.latest(CHANGE)).toEqual({
    changeId: CHANGE,
    job: { ...job, turn: { behind: "change" } },
  });

  // Cancelled (its change is gone) and failed (whether it may start couldn't be asked): neither waits any more.
  const failure = { kind: "unexpected", detail: "health check broke" } as const;
  expect(
    store.jobs.take((s) =>
      s.job.id === job.id ? { kind: "cancel", reason: "closed" } : { kind: "fail", failure },
    ).changed,
  ).toEqual([
    { changeId: CHANGE, job: { ...job, state: "cancelled", cancel: "closed" } },
    // No run of it started: no engine was reviewing.
    {
      changeId: OTHER,
      job: { ...second, state: "failed", deferral: null, failure: { ...failure, engine: null } },
    },
  ]);
  expect(store.jobs.waiting().jobs).toEqual([]);
  expect(store.jobs.take(() => ({ kind: "queue", holds: [], turn: BEHIND }))).toEqual({
    changed: [],
    started: null,
  });
});

test("a queued job's turn is kept across a restart and goes when it leaves the queue: deferred, joined from deferred, started (ADR 0055)", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  store.jobs.take(() => ({ kind: "queue", holds: [], turn: BEHIND }));
  store.close();
  const again = open(dir);
  expect(again.jobs.latest(CHANGE)?.job.turn).toEqual(BEHIND);
  // A push or a join leaves a queued job queued: it waits behind the same.
  expect(asked(again, CHANGE, { ...job, sha: pr2.head.sha }).job.turn).toEqual(BEHIND);
  expect(again.jobs.take(() => ({ kind: "defer", deferral: SIGNED_OUT })).changed).toEqual([
    { changeId: CHANGE, job: { ...job, sha: pr2.head.sha, state: "deferred", deferral: SIGNED_OUT } },
  ]);
  expect(again.jobs.latest(CHANGE)?.job.turn).toBeNull();
  again.jobs.take(() => ({ kind: "queue", holds: [], turn: BEHIND }));
  expect(started(again, job.id, { ...run, sha: pr2.head.sha })?.turn).toBeNull();
  expect(again.jobs.latest(CHANGE)?.job.turn).toBeNull();
});

test("the take skips a waiting job with its reason: it waits no more, its check's end is owed, its request gets no 🚀", () => {
  const store = open(home());
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c1") });
  store.jobs.take(() => ({ kind: "defer", deferral: SIGNED_OUT }));
  const skipped: ReviewJob = { ...job, trigger: "comment", state: "skipped", skip: "codex-not-yours" };
  expect(store.jobs.take(() => ({ kind: "skip", reason: "codex-not-yours" }))).toEqual({
    changed: [{ changeId: CHANGE, job: skipped }],
    started: null,
  });
  expect(store.jobs.waiting().jobs).toEqual([]);
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: skipped });
  expect(store.jobs.checksEnding()).toEqual([
    { changeId: CHANGE, job: skipped, check: { ref: null, completed: false } },
  ]);
  store.requests.reacted(REPO, "c1", "eyes");
  expect(store.requests.unreacted()).toEqual([]);
});

test("a push moves the change's waiting job to the new head as the same job, as it waits, and makes none (ADR 0040)", () => {
  const store = open(home());
  const newest = commitSha("c3d4e5f60718293a4b5c6d7e8f9012345678a1b2");
  // No waiting job: nothing to move, and no job is made.
  expect(store.jobs.pushed(CHANGE, newest)).toEqual([]);
  expect(store.jobs.latest(CHANGE)).toBeNull();

  // A deferred job moves, still deferred with its reason: a push is not a request.
  asked(store, CHANGE, job);
  store.jobs.take(() => ({ kind: "defer", deferral: SIGNED_OUT }));
  const deferred: ReviewJob = { ...job, state: "deferred", deferral: SIGNED_OUT, sha: newest };
  expect(store.jobs.pushed(CHANGE, newest)).toEqual([{ job: deferred, followUp: false }]);
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: deferred });
  // The same head again: nothing changes.
  expect(store.jobs.pushed(CHANGE, newest)).toEqual([]);

  // A running job stays on its commit; the follow-up behind it moves.
  store.jobs.take(() => ({ kind: "start", run }));
  expect(store.jobs.pushed(CHANGE, pr1.head.sha)).toEqual([]);
  const followUp: ReviewJob = { ...job, id: jobId("j2"), sha: newest };
  asked(store, CHANGE, followUp);
  expect(store.jobs.pushed(CHANGE, pr1.head.sha)).toEqual([
    { job: { ...followUp, sha: pr1.head.sha }, followUp: true },
  ]);
  expect(store.jobs.latest(OTHER)).toBeNull();
});

test("a fork pushed ends its waiting job cancelled `pushed` on the commit it was asked for: nobody asked for the new head (ADR 0048)", () => {
  const store = open(home());
  const newest = commitSha("c3d4e5f60718293a4b5c6d7e8f9012345678a1b2");
  expect(store.jobs.forkPushed(CHANGE, newest)).toEqual([]);

  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c1") });
  store.jobs.take(() => ({ kind: "defer", deferral: SIGNED_OUT }));
  // The same head: nothing changes.
  expect(store.jobs.forkPushed(CHANGE, job.sha)).toEqual([]);
  const cancelled: ReviewJob = { ...job, trigger: "comment", state: "cancelled", cancel: "pushed" };
  expect(store.jobs.forkPushed(CHANGE, newest)).toEqual([cancelled]);
  expect(store.jobs.waiting().jobs).toEqual([]);
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: cancelled });
  expect(store.jobs.checksEnding()).toEqual([
    { changeId: CHANGE, job: cancelled, check: { ref: null, completed: false } },
  ]);
  // Its request gets no 🚀: the review it asked for never ran.
  store.requests.reacted(REPO, "c1", "eyes");
  expect(store.requests.unreacted()).toEqual([]);

  // A running job stays as it is: it reviews the commit asked for.
  asked(store, CHANGE, { ...job, id: jobId("j2") });
  store.jobs.take(() => ({ kind: "start", run }));
  expect(store.jobs.forkPushed(CHANGE, newest)).toEqual([]);
});

const NEWEST = commitSha("c3d4e5f60718293a4b5c6d7e8f9012345678a1b2");

test("a review asked for a change whose job waits joins it: the same job, on the commit asked for, back in the queue", () => {
  const store = open(home());
  expect(asked(store, CHANGE, job)).toEqual({ job, changed: true, followUp: false });
  // Asked again, as it is: nothing changes.
  expect(asked(store, CHANGE, { ...job, id: jobId("j2") })).toEqual({
    job,
    changed: false,
    followUp: false,
  });
  // Deferred, then asked for the newest commit: the same job, moved there and queued without its reason (ADR 0042).
  store.jobs.take(() => ({ kind: "defer", deferral: SIGNED_OUT }));
  const joined: ReviewJob = { ...job, sha: NEWEST };
  expect(asked(store, CHANGE, { ...job, id: jobId("j3"), sha: NEWEST })).toEqual({
    job: joined,
    changed: true,
    followUp: false,
  });
  expect(store.jobs.waiting().jobs).toEqual([waits(CHANGE, joined)]);
});

test("the database itself refuses a second waiting job for a change, queued or deferred; other jobs are let in", () => {
  const dir = home();
  asked(open(dir), CHANGE, job);
  const db = new Database(join(dir, DATABASE), { strict: true });
  const insert = (id: string, change: ChangeId, state: string) =>
    db.run(
      "INSERT INTO jobs (id, change_id, sha, trigger, state, retries, check_completed) VALUES (?, ?, ?, 'manual', ?, 0, 0)",
      [id, change, job.sha, state],
    );
  try {
    expect(() => insert("j2", CHANGE, "queued")).toThrow("UNIQUE");
    expect(() => insert("j3", CHANGE, "deferred")).toThrow("UNIQUE");
    // A finished or running job of the change, and another change's waiting job, are not waiting beside it.
    insert("j4", CHANGE, "done");
    insert("j5", CHANGE, "running");
    insert("j6", OTHER, "queued");
  } finally {
    db.close();
  }
});

test("a review asked for while the change's job runs is a follow-up for the commit asked for, and later asks join it", () => {
  const store = open(home());
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const followUp: ReviewJob = { ...job, id: jobId("j2"), sha: NEWEST };
  expect(asked(store, CHANGE, followUp)).toEqual({ job: followUp, changed: true, followUp: true });
  expect(asked(store, CHANGE, { ...followUp, id: jobId("j3") })).toEqual({
    job: followUp,
    changed: false,
    followUp: true,
  });
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: followUp });
  expect(store.jobs.waiting().jobs).toEqual([waits(CHANGE, followUp)]);
  // The run ends: the follow-up waits on, no longer behind a run.
  roundEnded(store, run.id, 1, [], T2);
  expect(asked(store, CHANGE, { ...followUp, id: jobId("j4") })).toEqual({
    job: followUp,
    changed: false,
    followUp: false,
  });
});

/** The poll's place moved to `newest`, listing next from `keepFrom`. */
const at = (newest: number, keepFrom = newest) => ({ newest, keepFrom });

test("the poll's place in a repository's comments: none at first, its first kept as the floor, the newest only forward, across a restart (ADR 0043)", () => {
  const dir = home();
  const store = open(dir);
  expect(store.requests.place(REPO)).toBeNull();
  store.requests.seen(REPO, [], at(T1));
  store.requests.seen(REPO, [], at(T2));
  // An answer that saw nothing newer never moves it back.
  store.requests.seen(REPO, [], at(T1));
  store.close();
  const again = open(dir);
  expect(again.requests.place(REPO)).toEqual({ newest: T2, floor: T1 });
  expect(again.requests.place({ owner: "sasensi", name: "other" })).toBeNull();
});

test("a comment the poll handled is never handled again, after a restart too; forgotten once the poll lists only after it", () => {
  const dir = home();
  const store = open(dir);
  store.requests.seen(REPO, [{ id: "c1", createdAt: T1 }], at(T1));
  expect(store.requests.handled(REPO, ["c1", "c2"])).toEqual(new Set(["c1"]));
  store.close();
  const again = open(dir);
  expect(again.requests.handled(REPO, ["c1", "c2"])).toEqual(new Set(["c1"]));
  // Another repository's comment of the same id is not this one.
  expect(again.requests.handled({ owner: "sasensi", name: "other" }, ["c1"])).toEqual(new Set());
  // The next poll still lists from before it: kept, so a late listing of it isn't new.
  again.requests.seen(REPO, [{ id: "c2", createdAt: T2 }], at(T2, T1));
  expect(again.requests.handled(REPO, ["c1", "c2"])).toEqual(new Set(["c1", "c2"]));
  // It lists only after it: it can never be listed as new again, and isn't kept.
  again.requests.seen(REPO, [], at(T2));
  expect(again.requests.handled(REPO, ["c1", "c2"])).toEqual(new Set(["c2"]));
});

/** A review request comment on the sandbox, written at `at`. */
const request = (id: string, at = T1) => ({
  repo: REPO,
  comment: { id, createdAt: at },
  nodeId: `IC_${id}`,
});

test("the requests a job answers are given by their global ids, for its round to minimize (ADR 0052)", () => {
  const dir = home();
  const store = open(dir);
  expect(store.requests.of(job.id)).toEqual([]);
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c1") });
  store.jobs.asked(CHANGE, {
    sha: job.sha,
    trigger: "comment",
    id: () => jobId("j2"),
    request: request("c2"),
  });
  // A comment that was no request is never one a round answers.
  store.requests.seen(REPO, [{ id: "c3", createdAt: T1 }], at(T1));
  store.close();
  expect(open(dir).requests.of(job.id)).toEqual(["IC_c1", "IC_c2"]);
});

test("a request is handled with the job it led to: 👀 waits once recorded, 🚀 once its job's round is posted", () => {
  const dir = home();
  const store = open(dir);
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c1") });
  // A second request while the job waits joins it: the same job answers both.
  store.jobs.asked(CHANGE, {
    sha: job.sha,
    trigger: "comment",
    id: () => jobId("j2"),
    request: request("c2"),
  });
  expect(store.requests.handled(REPO, ["c1", "c2"])).toEqual(new Set(["c1", "c2"]));
  expect(store.requests.unreacted()).toEqual([
    { repo: REPO, commentId: "c1", reaction: "eyes" },
    { repo: REPO, commentId: "c2", reaction: "eyes" },
  ]);
  store.requests.reacted(REPO, "c1", "eyes");
  store.requests.reacted(REPO, "c2", "eyes");
  expect(store.requests.unreacted()).toEqual([]);

  started(store, job.id, run);
  expect(store.requests.unreacted()).toEqual([]);
  roundEnded(store, run.id, 1, [], T2);
  store.close();
  const again = open(dir);
  expect(again.requests.unreacted()).toEqual([
    { repo: REPO, commentId: "c1", reaction: "rocket" },
    { repo: REPO, commentId: "c2", reaction: "rocket" },
  ]);
  again.requests.reacted(REPO, "c1", "rocket");
  again.requests.reacted(REPO, "c2", "rocket");
  expect(again.requests.unreacted()).toEqual([]);
  // A request is kept once handled, whatever the place: it is never run again.
  again.requests.seen(REPO, [], at(T2 + 60_000));
  expect(again.requests.handled(REPO, ["c1", "c2"])).toEqual(new Set(["c1", "c2"]));
});

test("a request skipped is handled and waits for 👀, never 🚀; a failed or cancelled job's never gets 🚀", () => {
  const dir = home();
  const store = open(dir);
  store.jobs.skipped(OTHER, {
    sha: pr2.head.sha,
    trigger: "comment",
    skip: "repo-off",
    id: () => jobId("j0"),
    request: request("c1"),
  });
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c2") });
  store.jobs.take(() => ({ kind: "cancel", reason: "closed" }));
  const failing: ReviewJob = { ...job, id: jobId("j3") };
  store.jobs.asked(CHANGE, {
    sha: job.sha,
    trigger: "comment",
    id: () => failing.id,
    request: request("c3"),
  });
  started(store, failing.id, run);
  const failure = { kind: "review_failed", detail: "invalid_output" } as const;
  expect(store.jobs.runEnded(run.id, { kind: "failed", failure }, T2).state).toBe("failed");
  expect(store.requests.unreacted()).toEqual(
    ["c1", "c2", "c3"].map((commentId) => ({ repo: REPO, commentId, reaction: "eyes" })),
  );
  for (const id of ["c1", "c2", "c3"]) store.requests.reacted(REPO, id, "eyes");
  expect(store.requests.handled(REPO, ["c1", "c2", "c3"])).toEqual(new Set(["c1", "c2", "c3"]));
  expect(store.requests.unreacted()).toEqual([]);
  // Settled as never, in the job's own write: no longer among the reactions read at every poll.
  const db = new Database(join(dir, DATABASE), { strict: true });
  try {
    expect(db.query("SELECT id FROM comments WHERE eyes = 0 OR rocket = 0").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("a request whose round was posted gets its 🚀 when the run's end is recorded only as a failure", () => {
  const dir = home();
  const store = open(dir);
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c1") });
  store.requests.reacted(REPO, "c1", "eyes");
  started(store, job.id, run);
  const failure = { kind: "unexpected", detail: "disk I/O error" } as const;
  const ended = store.jobs.runEnded(run.id, { kind: "failed", failure, posted: true }, T2);
  expect(ended).toMatchObject({ state: "failed", failure });
  store.close();
  const again = open(dir);
  expect(again.requests.unreacted()).toEqual([{ repo: REPO, commentId: "c1", reaction: "rocket" }]);
  again.requests.reacted(REPO, "c1", "rocket");
  expect(again.requests.unreacted()).toEqual([]);
});

test("a request whose job yields to the follow-up behind it is answered by the follow-up's round (ADR 0043)", () => {
  const store = open(home());
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c1") });
  started(store, job.id, run);
  const followUp: ReviewJob = { ...job, id: jobId("j2"), sha: NEWEST };
  store.jobs.asked(CHANGE, {
    sha: NEWEST,
    trigger: "comment",
    id: () => followUp.id,
    request: request("c2"),
  });
  for (const id of ["c1", "c2"]) store.requests.reacted(REPO, id, "eyes");
  // A restart interrupted the run: the job yields to the follow-up, which now answers both requests.
  expect(store.jobs.runEnded(run.id, { kind: "interrupted" }, T2).state).toBe("cancelled");
  const next: Run = { ...run, id: runId("r2"), sha: NEWEST };
  started(store, followUp.id, next);
  roundEnded(store, next.id, 1, [], T2 + 60_000);
  expect(store.requests.unreacted()).toEqual([
    { repo: REPO, commentId: "c1", reaction: "rocket" },
    { repo: REPO, commentId: "c2", reaction: "rocket" },
  ]);
});

test("a request beside a waiting preview is held by a review of its own, behind it: 👀 at once, 🚀 when its round posts", () => {
  const dir = home();
  const store = open(dir);
  // The owner's preview waits; an agent's request comes.
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "first-review", id: () => job.id, preview: true });
  const own = store.jobs.asked(CHANGE, {
    sha: job.sha,
    trigger: "comment",
    id: () => jobId("j2"),
    request: request("c1"),
  });
  expect(own).toMatchObject({
    job: { id: jobId("j2"), trigger: "comment", state: "queued" },
    changed: true,
    followUp: false,
  });
  const kinds = (s: Store) => s.jobs.waiting().jobs.map((w) => [w.job.id, w.preview]);
  expect(kinds(store)).toEqual([
    [job.id, true],
    [jobId("j2"), false],
  ]);
  // Its own review posts: its 👀 is owed at once.
  expect(store.requests.unreacted()).toEqual([{ repo: REPO, commentId: "c1", reaction: "eyes" }]);
  store.requests.reacted(REPO, "c1", "eyes");
  // Another request joins that review, never the preview; after a restart too.
  store.close();
  const again = open(dir);
  const joined = again.jobs.asked(CHANGE, {
    sha: job.sha,
    trigger: "comment",
    id: () => jobId("j3"),
    request: request("c2"),
  });
  expect(joined.job.id).toBe(jobId("j2"));
  again.requests.reacted(REPO, "c2", "eyes");

  // The preview, oldest, starts; the request's review waits for its change to be free.
  started(again, job.id, { ...run, preview: true });
  const offered: [JobId, boolean][] = [];
  again.jobs.take((s, _reviewing, busy) => {
    offered.push([s.job.id, busy]);
    return null;
  });
  expect(offered).toEqual([[jobId("j2"), true]]);
  roundEnded(again, run.id, 1, [], T2, "preview");
  expect(again.requests.unreacted()).toEqual([]);
  started(again, jobId("j2"), { ...run, id: runId("r2") });
  roundEnded(again, runId("r2"), 2, [], T2 + 60_000);
  expect(again.requests.unreacted()).toEqual([
    { repo: REPO, commentId: "c1", reaction: "rocket" },
    { repo: REPO, commentId: "c2", reaction: "rocket" },
  ]);
});

test("a waiting review that holds a request is no preview: the owner's preview is a job of its own, and a push moves both", () => {
  const store = open(home());
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c1") });
  const preview = store.jobs.asked(CHANGE, {
    sha: job.sha,
    trigger: "first-review",
    id: () => jobId("j2"),
    preview: true,
  });
  expect(preview.job).toMatchObject({ id: jobId("j2"), trigger: "first-review" });
  expect(store.jobs.waiting().jobs.map((w) => [w.job.id, w.preview])).toEqual([
    [job.id, false],
    [jobId("j2"), true],
  ]);
  expect(store.requests.unreacted()).toEqual([{ repo: REPO, commentId: "c1", reaction: "eyes" }]);
  // "Review now" joins the review that posts; a push moves both to the new head.
  expect(asked(store, CHANGE, { ...job, id: jobId("j3") }).job.id).toBe(job.id);
  expect(store.jobs.pushed(CHANGE, NEWEST).map((p) => [p.job.id, p.job.sha])).toEqual([
    [job.id, NEWEST],
    [jobId("j2"), NEWEST],
  ]);
});

test("a preview's run ends as a preview, done like a round once its round is saved: it owes no reaction", () => {
  const store = open(home());
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "first-review", id: () => job.id, preview: true });
  started(store, job.id, { ...run, preview: true });
  expect(() => store.jobs.runEnded(run.id, { kind: "preview" }, T2)).toThrow(
    "runEnded: no round saved for run r1",
  );
  expect(roundEnded(store, run.id, 1, [], T2, "preview")).toEqual({
    ...job,
    trigger: "first-review",
    state: "done",
  });
  expect(store.requests.unreacted()).toEqual([]);
});

test("two takes on one database, from two connections, never start the same job", () => {
  const dir = home();
  const first = open(dir);
  const second = open(dir);
  asked(first, CHANGE, job);
  asked(first, OTHER, { ...job, id: jobId("j2") });
  const start = (tag: string) => () => ({ kind: "start", run: { ...run, id: runId(tag) } }) as const;
  expect(first.jobs.take(start("a"))?.started?.job.id).toBe(jobId("j1"));
  expect(second.jobs.take(start("b"))?.started?.job.id).toBe(jobId("j2"));
  expect(first.jobs.take(start("c"))).toEqual({ changed: [], started: null });
  expect(second.jobs.take(start("d"))).toEqual({ changed: [], started: null });
});

/**
 * A process that opens the store on `dir` and takes until nothing starts, every job it is offered started, and
 * prints the jobs it started. Each take waits on the other process's instead of failing: the database is busy.
 */
const taker = (dir: string, tag: string) => `
  const { openStore } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
  const store = openStore({ home: ${JSON.stringify(dir)}, durable: false });
  const took = [];
  for (let n = 0; ; n++) {
    const { started } = store.jobs.take(() => ({ kind: "start", run: {
      id: "${tag}-" + n, reviewer: "claude", confirmer: null, confirmFallback: null, sha: "${pr1.head.sha}", preview: false,
      startedAt: 0, step: "preparing", stepAt: 0, steps: [],
    } }));
    if (!started) break;
    took.push(started.job.id);
  }
  store.close();
  console.log(JSON.stringify(took));
`;

test("two processes taking from one database start every job once, waiting on each other's takes", async () => {
  const dir = home();
  const store = open(dir);
  const ids = Array.from({ length: 40 }, (_, i) => jobId(`j${i}`));
  for (const id of ids) asked(store, changeId(`sasensi/lookover-sandbox#${id}`), { ...job, id });
  const takers = ["a", "b"].map((tag) =>
    Bun.spawn([process.execPath, "-e", taker(dir, tag)], { stdout: "pipe", stderr: "pipe" }),
  );
  const outputs = await Promise.all(
    takers.map(async (p) => {
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(err).toBe("");
      expect(code).toBe(0);
      return z.array(z.string()).parse(JSON.parse(out));
    }),
  );
  const took = outputs.flat();
  expect(took.toSorted()).toEqual(ids.toSorted());
  expect(store.jobs.waiting().jobs).toEqual([]);
});

test("a job waiting on an engine that failed its self-test is read back with that engine (ADR 0044)", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  const failed = { reason: "engine-failed-self-test", engine: "codex" } as const;
  store.jobs.take(() => ({ kind: "defer", deferral: failed }));
  store.close();
  expect(open(dir).jobs.latest(CHANGE)?.job).toEqual({ ...job, state: "deferred", deferral: failed });
});

test("a job row that doesn't parse throws: an engine's deferral without its engine is not read as Claude's", () => {
  const dir = home();
  asked(open(dir), CHANGE, job);
  const db = new Database(join(dir, DATABASE), { strict: true });
  db.run("UPDATE jobs SET state = 'deferred', deferral_reason = 'engine-signed-out', deferral_engine = NULL");
  db.close();
  expect(() => open(dir).jobs.latest(CHANGE)).toThrow("deferral_engine");
});

const finding: Finding = {
  id: findingId("F1"),
  fingerprints: { location: "l1", meaning: "m1" },
  severity: "blocking",
  category: "security",
  title: "Logs the API key",
  file: "src/invoices.ts",
  side: "head",
  line: 10,
  endLine: null,
  lineText: null,
  anchoring: "reported",
  foundBy: "claude",
  confirmation: { verdict: "not_checked", demoted: false },
  body: "When listing, the key is printed.",
  why: { ruleText: null },
  rule: null,
  snippet: null,
  fix: null,
  status: "open",
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

test("a run is kept with its steps and how it ended", () => {
  const store = open(home());
  asked(store, CHANGE, job);
  // The run starts: its job runs, and is no longer waiting its turn.
  const running: ReviewJob = { ...job, state: "running" };
  expect(started(store, job.id, run)).toEqual(running);
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: running });
  expect(store.jobs.waiting().jobs).toEqual([]);
  store.jobs.runStepped(run.id, "finding", T1 + 4_000);
  // A step done gives where the run now is.
  expect(store.jobs.runStepped(run.id, "publishing", T1 + 64_000)).toEqual({
    step: "publishing",
    stepAt: T1 + 64_000,
    steps: [
      { step: "preparing", ms: 4_000 },
      { step: "finding", ms: 60_000 },
    ],
  });
  // It ends as round 1, saved as it reached publishing: the job is done, and the round left its ledger.
  store.posts.saved(run.id, { n: 1, held: [finding], ledger: [finding], plan: {}, posts: [] }, T1 + 65_000);
  const done: ReviewJob = { ...job, state: "done" };
  expect(store.jobs.runEnded(run.id, { kind: "round" }, T1 + 66_000)).toEqual(done);
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: done });
  // The run ended with it: it is no longer left running.
  expect(store.jobs.leftRunning()).toEqual([]);
  expect(() => store.jobs.runStepped(run.id, "finding", T1 + 67_000)).toThrow("runStepped: run r1 has ended");
  expect(store.rounds.of(CHANGE)).toEqual([{ n: 1, sha: pr1.head.sha }]);
  expect(store.rounds.ledger(CHANGE)).toEqual([finding]);
});

test("a repository's rules are kept as last read, each counted from every change's last round: raised citing it, acted verified fixed (ADR 0048)", () => {
  const dir = home();
  const store = open(dir);
  const SANDBOX = repositoryId("sasensi/lookover-sandbox");
  const OTHER_REPO = repositoryId("sasensi/ledger-api");
  const expire: ReadRule = {
    id: "a1",
    file: "REVIEW.md",
    line: 3,
    text: "Every cache says when it expires.",
    parentIds: [],
  };
  // Nested in `expire`: the rules it sits in are kept with it (ADR 0049).
  const retry: ReadRule = {
    id: "b2",
    file: "REVIEW.md",
    line: 4,
    text: "Never retry a refused request.",
    parentIds: ["a1"],
  };
  const theirs: ReadRule = { id: "c3", file: "AGENTS.md", line: 1, text: "Use tabs.", parentIds: [] };
  store.rules.read(SANDBOX, [expire, retry]);
  store.rules.read(OTHER_REPO, [theirs]);
  const counted = (rule: ReadRule, raised: number, acted: number) => ({
    id: rule.id,
    repoId: SANDBOX,
    source: rule.file,
    line: rule.line,
    text: rule.text,
    parentIds: rule.parentIds,
    raised,
    acted,
  });
  expect(store.rules.of(SANDBOX)).toEqual([counted(expire, 0, 0), counted(retry, 0, 0)]);
  const citing = (id: string, rule: ReadRule, status: Finding["status"]): Finding => ({
    ...finding,
    id: findingId(id),
    rule: { id: rule.id, file: rule.file, line: rule.line },
    status,
  });
  // #1's first round raised two findings citing `expire`; its second verified one fixed: only the last round counts.
  asked(store, CHANGE, job);
  started(store, job.id, run);
  roundEnded(store, run.id, 1, [citing("F1", expire, "open"), citing("F2", expire, "open")], T1);
  const again = { ...job, id: jobId("j2") };
  asked(store, CHANGE, again);
  started(store, again.id, { ...run, id: runId("r2") });
  const last = [citing("F1", expire, "verified_fixed"), citing("F2", expire, "open"), finding];
  roundEnded(store, runId("r2"), 2, last, T2);
  // #2's one round: a finding citing `retry`, dismissed.
  const second = { ...job, id: jobId("j3") };
  asked(store, OTHER, second);
  started(store, second.id, { ...run, id: runId("r3") });
  roundEnded(store, runId("r3"), 1, [citing("F1", retry, "dismissed")], T2);
  expect(store.rules.of(SANDBOX)).toEqual([counted(expire, 2, 1), counted(retry, 1, 0)]);
  // Read again with `expire` edited: a new rule, its counts at zero; the old one is gone, `retry` keeps its own.
  const edited = { ...expire, id: "a9", text: "Every cache says when its entries expire." };
  store.rules.read(SANDBOX, [edited, retry]);
  store.close();
  const reopened = open(dir);
  expect(reopened.rules.of(SANDBOX)).toEqual([
    { ...counted(expire, 0, 0), id: "a9", text: edited.text },
    counted(retry, 1, 0),
  ]);
  expect(reopened.rules.of(OTHER_REPO).map((r) => r.id)).toEqual(["c3"]);
  reopened.rules.read(SANDBOX, []);
  expect(reopened.rules.of(SANDBOX)).toEqual([]);
});

test("a rule read twice is kept once, where it was first read (ADR 0048)", () => {
  const store = open(home());
  const SANDBOX = repositoryId("sasensi/lookover-sandbox");
  const expire: ReadRule = {
    id: "a1",
    file: "REVIEW.md",
    line: 3,
    text: "Every cache says when it expires.",
    parentIds: [],
  };
  const retry: ReadRule = {
    id: "b2",
    file: "REVIEW.md",
    line: 4,
    text: "Never retry a refused request.",
    parentIds: [],
  };
  store.rules.read(SANDBOX, [expire, retry, { ...expire, line: 9 }]);
  expect(store.rules.of(SANDBOX).map((r) => [r.id, r.line])).toEqual([
    ["a1", 3],
    ["b2", 4],
  ]);
});

test("a change's job is pending while it waits or runs; ended, skipped or on another change, it isn't", () => {
  const store = open(home());
  expect(store.jobs.pending(CHANGE)).toBe(false);
  asked(store, CHANGE, job);
  expect(store.jobs.pending(CHANGE)).toBe(true);
  expect(store.jobs.pending(OTHER)).toBe(false);
  started(store, job.id, run);
  expect(store.jobs.pending(CHANGE)).toBe(true);
  roundEnded(store, run.id, 1, [], T2);
  expect(store.jobs.pending(CHANGE)).toBe(false);
  store.jobs.skipped(CHANGE, { sha: job.sha, trigger: "opened", skip: "not-yours", id: () => jobId("j2") });
  expect(store.jobs.pending(CHANGE)).toBe(false);
});

test("\"Too noisy?\"'s counts: the repository's 30 most recently reviewed changes, each by its last round (ADR 0049)", () => {
  const dir = home();
  const store = open(dir);
  const SANDBOX_REPO = repositoryId("sasensi/lookover-sandbox");
  expect(store.rounds.noise(SANDBOX_REPO, "sasensi/lookover-sandbox#")).toEqual({
    reviews: 0,
    postedBelowBlocking: 0,
    raisedByRule: {},
  });
  const db = new Database(join(dir, DATABASE), { strict: true });
  const planted = (change: string, n: number, at: number, ledger: Finding[]) =>
    db.run("INSERT INTO rounds (change_id, n, sha, findings, posted_at) VALUES (?, ?, ?, ?, ?)", [
      change,
      n,
      job.sha,
      JSON.stringify(ledger),
      at,
    ]);
  const rule = (id: string) => ({ id, file: "REVIEW.md" as const, line: 1 });
  const f = (severity: Finding["severity"], posted: boolean, cites: string | null = null): Finding => ({
    ...finding,
    severity,
    posted,
    rule: cites === null ? null : rule(cites),
  });
  try {
    // The oldest change of 31, left out: had it counted, `a1` would have raised 2 and 4 would be posted.
    planted("sasensi/lookover-sandbox#1", 1, T1, [f("should_fix", true, "a1"), f("consider", true)]);
    for (let n = 2; n <= 31; n++) planted(`sasensi/lookover-sandbox#${n}`, 1, T1 + n, [f("blocking", true)]);
    // #2's last round: a posted Should fix citing `a1`, a blocking one citing `b2`, a Consider held off the pull
    // request; its first round's findings don't count.
    planted("sasensi/lookover-sandbox#2", 2, T2, [
      f("should_fix", true, "a1"),
      f("blocking", true, "b2"),
      f("consider", false),
    ]);
    // Other repositories' changes, reviewed last, one named as this one's start: not this repository's.
    planted("sasensi/ledger-api#2", 1, T2 + 1, [f("should_fix", true, "a1")]);
    planted("sasensi/lookover-sandbox-2#1", 1, T2 + 2, [f("consider", true, "a1")]);
  } finally {
    db.close();
  }
  expect(store.rounds.noise(SANDBOX_REPO, "sasensi/lookover-sandbox#")).toEqual({
    reviews: 30,
    postedBelowBlocking: 1,
    raisedByRule: { a1: 1, b2: 1 },
  });
  // `a1` and `b2` nested in `p0`, which raised nothing itself: turning it off removes theirs (Lookover #156 F4).
  const read = (id: string, parentIds: string[]) => ({ ...rule(id), text: id, parentIds });
  store.rules.read(SANDBOX_REPO, [read("p0", []), read("a1", ["p0"]), read("b2", ["p0"])]);
  expect(store.rounds.noise(SANDBOX_REPO, "sasensi/lookover-sandbox#").raisedByRule).toEqual({
    p0: 2,
    a1: 1,
    b2: 1,
  });
  // Fewer than 30 reviewed: as many as there are.
  expect(
    store.rounds.noise(repositoryId("sasensi/lookover-sandbox-2"), "sasensi/lookover-sandbox-2#"),
  ).toEqual({
    reviews: 1,
    postedBelowBlocking: 1,
    raisedByRule: { a1: 1 },
  });
});

test("the rounds of a change are kept in order, and the ledger is what the last one left", () => {
  const store = open(home());
  expect(store.rounds.ledger(CHANGE)).toEqual([]);
  expect(store.rounds.of(CHANGE)).toEqual([]);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  roundEnded(store, run.id, 1, [finding], T2);
  // The fix pushed: a second job, on the new commit, verifies it.
  const fixedSha = commitSha("c3d4e5f60718293a4b5c6d7e8f9012345678a1b2");
  const second: ReviewJob = { ...job, id: jobId("j2"), sha: fixedSha };
  asked(store, CHANGE, second);
  started(store, second.id, { ...run, id: runId("r2"), sha: fixedSha });
  const fixed: Finding = { ...finding, status: "verified_fixed", closedIn: 2, verifiedSha: fixedSha };
  roundEnded(store, runId("r2"), 2, [fixed], T2 + 2);
  expect(store.rounds.of(CHANGE)).toEqual([
    { n: 1, sha: pr1.head.sha },
    { n: 2, sha: fixedSha },
  ]);
  expect(store.rounds.ledger(CHANGE)).toEqual([fixed]);
  expect(store.rounds.ledger(changeId("sasensi/lookover-sandbox#2"))).toEqual([]);
});

test("when a repository's last round was posted: none before its first, another repository's not counted (ADR 0043's hot window)", () => {
  const dir = home();
  const store = open(dir);
  expect(store.rounds.lastPostedAt("sasensi/lookover-sandbox#")).toBeNull();
  asked(store, CHANGE, job);
  started(store, job.id, run);
  roundEnded(store, run.id, 1, [], T2);
  const second: ReviewJob = { ...job, id: jobId("j2"), sha: pr2.head.sha };
  asked(store, OTHER, second);
  started(store, second.id, { ...run, id: runId("r2"), sha: pr2.head.sha });
  // A run that ends without a round posted nothing.
  store.jobs.runEnded(runId("r2"), { kind: "deferred", deferral: SIGNED_OUT }, T2 + 5);
  // Another repository's round, later, is its own: ids of `sasensi/lookover-sandbox-2#` sort past the sandbox's.
  const elsewhere: ReviewJob = { ...job, id: jobId("j3") };
  asked(store, changeId("sasensi/lookover-sandbox-2#1"), elsewhere);
  started(store, elsewhere.id, { ...run, id: runId("r3") });
  roundEnded(store, runId("r3"), 1, [], T2 + 10);
  store.close();
  const again = open(dir);
  expect(again.rounds.lastPostedAt("sasensi/lookover-sandbox#")).toBe(T2);
  expect(again.rounds.lastPostedAt("sasensi/lookover-sandbox-2#")).toBe(T2 + 10);
  expect(again.rounds.lastPostedAt("sasensi/ledger-api#")).toBeNull();
});

test("a repository is asked while a job of one of its changes waits or runs; another repository's doesn't count", () => {
  const store = open(home());
  expect(store.jobs.pendingIn("sasensi/lookover-sandbox#")).toBe(false);
  asked(store, CHANGE, job);
  expect(store.jobs.pendingIn("sasensi/lookover-sandbox#")).toBe(true);
  expect(store.jobs.pendingIn("sasensi/ledger-api#")).toBe(false);
  expect(store.jobs.pendingIn("sasensi/lookover-sandbox-2#")).toBe(false);
  started(store, job.id, run);
  expect(store.jobs.pendingIn("sasensi/lookover-sandbox#")).toBe(true);
  roundEnded(store, run.id, 1, [], T2);
  expect(store.jobs.pendingIn("sasensi/lookover-sandbox#")).toBe(false);
});

test("a job skipped is recorded with its reason, never waits, and lets a review be asked beside it", () => {
  const store = open(home());
  const skipped = store.jobs.skipped(OTHER, {
    sha: pr2.head.sha,
    trigger: "opened",
    skip: "not-yours",
    id: () => jobId("j1"),
  });
  const expected: ReviewJob = {
    id: jobId("j1"),
    sha: pr2.head.sha,
    trigger: "opened",
    state: "skipped",
    deferral: null,
    stepIn: null,
    skip: "not-yours",
    cancel: null,
    failure: null,
    turn: null,
  };
  expect(skipped).toEqual(expected);
  expect(store.jobs.latest(OTHER)).toEqual({ changeId: OTHER, job: expected });
  expect(store.jobs.waiting().jobs).toEqual([]);
  expect(asked(store, OTHER, { ...job, id: jobId("j2"), sha: pr2.head.sha }).changed).toBe(true);
});

test("a run cut short leaves its job deferred with the reason, or failed with why, and no round", () => {
  const store = open(home());
  asked(store, CHANGE, job);
  started(store, job.id, run);
  // Claude signed out during the find pass: the job waits (ADR 0029).
  const signedOut = { reason: "engine-signed-out", engine: "claude" } as const;
  const deferred: ReviewJob = { ...job, state: "deferred", deferral: signedOut };
  expect(store.jobs.runEnded(run.id, { kind: "deferred", deferral: signedOut }, T1 + 5_000)).toEqual(
    deferred,
  );
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: deferred });

  // Its turn again, it runs once more, without its reason, and fails.
  const again: Run = { ...run, id: runId("r2"), startedAt: T2, stepAt: T2 };
  expect(started(store, job.id, again)).toEqual({ ...job, state: "running" });
  const failure = { kind: "review_failed", detail: "invalid_output" } as const;
  // The engine that was reviewing is the run's.
  const failed: ReviewJob = { ...job, state: "failed", failure: { ...failure, engine: "claude" } };
  expect(store.jobs.runEnded(again.id, { kind: "failed", failure }, T2 + 9_000)).toEqual(failed);
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: failed });
  // Both runs ended with the job: neither is left running.
  expect(store.jobs.leftRunning()).toEqual([]);
  expect(() => store.jobs.runEnded(run.id, { kind: "failed", failure }, T2 + 9_000)).toThrow(
    "runEnded: run r1 has ended",
  );
  expect(store.rounds.of(CHANGE)).toEqual([]);
});

test("the jobs a stopped service left running are listed with their run, and failing the run fails them", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const done: ReviewJob = { ...job, id: jobId("j2") };
  asked(store, OTHER, done);
  started(store, done.id, { ...run, id: runId("r2"), reviewer: "codex" });
  roundEnded(store, runId("r2"), 1, [], T1 + 1);
  store.close();

  const again = open(dir);
  const running: ReviewJob = { ...job, state: "running" };
  expect(again.jobs.leftRunning()).toEqual([
    { changeId: CHANGE, job: running, runId: run.id, step: "preparing", retries: 0 },
  ]);
  const stopped = { kind: "service_stopped", detail: "" } as const;
  expect(again.jobs.runEnded(run.id, { kind: "failed", failure: stopped }, T2)).toEqual({
    ...job,
    state: "failed",
    failure: { ...stopped, engine: "claude" },
  });
  expect(again.jobs.leftRunning()).toEqual([]);
});

test("a run's age, for its folder (ADR 0056): unknown, open while it or its job runs, else when it ended", () => {
  const store = open(home());
  expect(store.jobs.runAge("r9")).toEqual({ kind: "unknown" });
  asked(store, CHANGE, job);
  started(store, job.id, run);
  expect(store.jobs.runAge(run.id)).toEqual({ kind: "open" });
  // Interrupted, then run again: the first run ended, but its job runs, so it is open too.
  store.jobs.runEnded(run.id, { kind: "interrupted" }, T2);
  expect(store.jobs.runAge(run.id)).toEqual({ kind: "ended", at: T2 });
  const second: Run = { ...run, id: runId("r2"), startedAt: T2, stepAt: T2 };
  started(store, job.id, second);
  expect(store.jobs.runAge(run.id)).toEqual({ kind: "open" });
  roundEnded(store, second.id, 1, [], T2 + 1);
  expect(store.jobs.runAge(run.id)).toEqual({ kind: "ended", at: T2 });
  expect(store.jobs.runAge(second.id)).toEqual({ kind: "ended", at: T2 + 1 });
});

test("a run a restart interrupted puts its job back in the queue, counted, and its next run is left with the step it reached", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  // Interrupted: the run ends, and the job waits its turn again, as the same job.
  expect(store.jobs.runEnded(run.id, { kind: "interrupted" }, T2)).toEqual(job);
  expect(store.jobs.waiting().jobs).toEqual([waits(CHANGE, job)]);
  expect(store.jobs.waiting().reviewing).toEqual(new Set());
  expect(store.jobs.leftRunning()).toEqual([]);

  // Its second run reaches publishing when the service stops again.
  const second: Run = { ...run, id: runId("r2"), startedAt: T2, stepAt: T2 };
  started(store, job.id, second);
  store.jobs.runStepped(second.id, "publishing", T2 + 60_000);
  store.close();
  expect(open(dir).jobs.leftRunning()).toEqual([
    {
      changeId: CHANGE,
      job: { ...job, state: "running" },
      runId: second.id,
      step: "publishing",
      retries: 1,
    },
  ]);
});

test("a job whose run ends deferred or interrupted while its change has a follow-up yields to it: cancelled", () => {
  const store = open(home());
  const ends: RunEnd[] = [{ kind: "deferred", deferral: SIGNED_OUT }, { kind: "interrupted" }];
  for (const [i, end] of ends.entries()) {
    const ran: ReviewJob = { ...job, id: jobId(`ran-${i}`) };
    const r: Run = { ...run, id: runId(`r${i}`) };
    asked(store, CHANGE, ran);
    started(store, ran.id, r);
    const followUp: ReviewJob = { ...job, id: jobId(`follow-up-${i}`), sha: NEWEST };
    asked(store, CHANGE, followUp);
    expect(store.jobs.runEnded(r.id, end, T2)).toEqual({ ...ran, state: "cancelled", cancel: "replaced" });
    // The follow-up is the change's one waiting job.
    expect(store.jobs.waiting().jobs).toEqual([waits(CHANGE, followUp)]);
    expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: followUp });
    store.jobs.take((s) => (s.job.id === followUp.id ? { kind: "cancel", reason: "closed" } : null));
  }
});

test("a full round that yields to an ordinary follow-up hands it the full ask: its round is a full one", () => {
  const store = open(home());
  const ends: RunEnd[] = [{ kind: "deferred", deferral: SIGNED_OUT }, { kind: "interrupted" }];
  for (const [i, end] of ends.entries()) {
    const ran: ReviewJob = { ...job, id: jobId(`ran-${i}`) };
    const r: Run = { ...run, id: runId(`r${i}`) };
    store.jobs.asked(CHANGE, { sha: ran.sha, trigger: "comment", id: () => ran.id, full: true });
    started(store, ran.id, r);
    // A push while the full round runs: an ordinary follow-up.
    const followUp: ReviewJob = { ...job, id: jobId(`follow-up-${i}`), sha: NEWEST };
    asked(store, CHANGE, followUp);
    expect(store.jobs.waiting().jobs).toEqual([waits(CHANGE, followUp)]);
    store.jobs.runEnded(r.id, end, T2);
    // The follow-up answers the owner's `/lookover review full`: its round is a full one.
    expect(store.jobs.waiting().jobs).toEqual([{ ...waits(CHANGE, followUp), full: true }]);
    store.jobs.take((s) => (s.job.id === followUp.id ? { kind: "cancel", reason: "closed" } : null));
  }
});

test("an interrupted review that posts, beside a waiting preview, goes back to the queue: one waiting job of each kind", () => {
  const store = open(home());
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c1") });
  started(store, job.id, run);
  // The owner's preview, asked for while the review runs, is a job of its own.
  store.jobs.asked(CHANGE, { sha: NEWEST, trigger: "first-review", id: () => jobId("j2"), preview: true });
  expect(store.jobs.runEnded(run.id, { kind: "interrupted" }, T2)).toMatchObject({
    id: job.id,
    state: "queued",
  });
  expect(store.jobs.waiting().jobs.map((w) => [w.job.id, w.preview])).toEqual([
    [job.id, false],
    [jobId("j2"), true],
  ]);
  // The review keeps its request: its round answers it.
  store.requests.reacted(REPO, "c1", "eyes");
  started(store, job.id, { ...run, id: runId("r2") });
  roundEnded(store, runId("r2"), 1, [], T2 + 60_000);
  expect(store.requests.unreacted()).toEqual([{ repo: REPO, commentId: "c1", reaction: "rocket" }]);
});

test("an interrupted preview, beside a waiting review that posts, goes back to the queue: one waiting job of each kind", () => {
  const store = open(home());
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "first-review", id: () => job.id, preview: true });
  started(store, job.id, { ...run, preview: true });
  // A review asked for while the preview runs is a job of its own.
  store.jobs.asked(CHANGE, {
    sha: NEWEST,
    trigger: "comment",
    id: () => jobId("j2"),
    request: request("c1"),
  });
  expect(store.jobs.runEnded(run.id, { kind: "interrupted" }, T2)).toMatchObject({
    id: job.id,
    state: "queued",
  });
  expect(store.jobs.waiting().jobs.map((w) => [w.job.id, w.preview])).toEqual([
    [job.id, true],
    [jobId("j2"), false],
  ]);
});

test("a job keeps the check that follows it, the commit it is on, across a restart, until another replaces it", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  const none = { ref: null, completed: false };
  expect(store.jobs.checkOf(job.id)).toEqual(none);
  store.jobs.checked(job.id, { id: "111954805720", sha: job.sha });
  store.close();
  const again = open(dir);
  expect(again.jobs.checkOf(job.id)).toEqual({ ...none, ref: { id: "111954805720", sha: job.sha } });
  // Moved to a newer commit, the job's next check is another one.
  again.jobs.checked(job.id, { id: "111954805721", sha: NEWEST });
  expect(again.jobs.checkOf(job.id).ref).toEqual({ id: "111954805721", sha: NEWEST });
  again.jobs.checked(job.id, null);
  expect(again.jobs.checkOf(job.id)).toEqual(none);
  again.jobs.checked(job.id, { id: "111954805721", sha: NEWEST });
  // The job itself is as it was: the check is not part of what the UI hears.
  expect(again.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job });
  expect(() => again.jobs.checked(jobId("nobody"), { id: "1", sha: job.sha })).toThrow("job nobody");
});

test("a job that ended without a round owes its check's end, across a restart, until the check is completed", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  const other: ReviewJob = { ...job, id: jobId("j2") };
  asked(store, OTHER, other);
  const third: ReviewJob = { ...job, id: jobId("j3"), sha: pr2.head.sha };
  asked(store, THIRD, third);
  store.jobs.checked(job.id, { id: "111954805720", sha: job.sha });
  // Its change closed; another failed (whether it may start couldn't be asked); the third still waits.
  const failure = { kind: "unexpected", detail: "health check broke" } as const;
  store.jobs.take((s) =>
    s.job.id === job.id
      ? { kind: "cancel", reason: "closed" }
      : s.job.id === other.id
        ? { kind: "fail", failure }
        : null,
  );
  store.close();

  // Each end is the job's, kept with it: why it was cancelled, how it failed. A job whose check was never created
  // owes its end too: the end creates it.
  const again = open(dir);
  expect(again.jobs.checksEnding()).toEqual([
    {
      changeId: CHANGE,
      job: { ...job, state: "cancelled", cancel: "closed" },
      check: { ref: { id: "111954805720", sha: job.sha }, completed: false },
    },
    {
      changeId: OTHER,
      job: { ...other, state: "failed", failure: { ...failure, engine: null } },
      check: { ref: null, completed: false },
    },
  ]);
  again.jobs.checkCompleted(job.id);
  expect(again.jobs.checkOf(job.id)).toEqual({ ref: { id: "111954805720", sha: job.sha }, completed: true });
  expect(again.jobs.checksEnding().map((e) => e.job.id)).toEqual([other.id]);
  // A round completes its job's check: a done job owes nothing.
  started(again, third.id, run);
  roundEnded(again, run.id, 1, [], T2);
  expect(again.jobs.checksEnding().map((e) => e.job.id)).toEqual([other.id]);
});

test("a job that isn't waiting isn't offered to the take, and an ended run can't step or end", () => {
  const store = open(home());
  asked(store, CHANGE, job);
  started(store, job.id, run);
  // Running: it isn't waiting any more.
  const offered: JobId[] = [];
  store.jobs.take((s) => {
    offered.push(s.job.id);
    return null;
  });
  expect(offered).toEqual([]);
  roundEnded(store, run.id, 1, [], T2);
  expect(() => store.jobs.runEnded(run.id, { kind: "round" }, T2 + 1)).toThrow("runEnded: run r1 has ended");
  expect(() =>
    store.posts.saved(run.id, { n: 2, held: [], ledger: [], plan: {}, posts: [] }, T2 + 1),
  ).toThrow("saved: run r1 has ended");
  expect(() => store.jobs.runStepped(run.id, "finding", T2 + 1)).toThrow("runStepped: run r1 has ended");
  // Nothing of the refused calls was kept.
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: { ...job, state: "done" } });
  expect(store.rounds.of(CHANGE)).toEqual([{ n: 1, sha: pr1.head.sha }]);
});

// The outbox (ADR 0044): a round saved before it is posted, with the posts it owes.

/** What a round's posts are rendered from, as the service gives it: kept as given. */
const PLAN = { round: 1, change: { number: 1 } };
const POSTS = ["check", "review", "summary", "completed"] as const;

test("a run that reaches publishing saves its round, the ledger held until its review lands, and its posts, owed", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  store.jobs.runStepped(run.id, "finding", T1 + 4_000);
  const held: Finding = { ...finding, posted: false };
  expect(
    store.posts.saved(
      run.id,
      { n: 1, held: [held], ledger: [finding], plan: PLAN, posts: POSTS },
      T1 + 64_000,
    ),
  ).toEqual({
    step: "publishing",
    stepAt: T1 + 64_000,
    steps: [
      { step: "preparing", ms: 4_000 },
      { step: "finding", ms: 60_000 },
    ],
  });
  store.close();

  // Kept: the round counts and the ledger has moved, its findings not posted yet; the posts are all owed.
  const again = open(dir);
  expect(again.rounds.of(CHANGE)).toEqual([{ n: 1, sha: pr1.head.sha }]);
  expect(again.rounds.ledger(CHANGE)).toEqual([held]);
  expect(again.posts.of(run.id)).toEqual({
    changeId: CHANGE,
    job: { ...job, state: "running" },
    plan: PLAN,
    posts: POSTS.map((kind) => ({ kind, hostId: null, tries: 0 })),
    degraded: false,
    steps: { step: "publishing", stepAt: T1 + 64_000, steps: expect.any(Array) },
  });
  expect(again.posts.of(runId("nobody"))).toBeNull();
  // Left running at publishing: a restart resumes it.
  expect(again.jobs.leftRunning()).toMatchObject([{ runId: run.id, step: "publishing" }]);
});

test("each post sent is kept with the host's id: the check is the job's, the review lands the ledger, the end completes the check", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const held: Finding = { ...finding, posted: false };
  store.posts.saved(run.id, { n: 1, held: [held], ledger: [finding], plan: PLAN, posts: POSTS }, T2);
  store.posts.sending(run.id, "check");
  store.posts.sent(run.id, "check", "111954805720");
  expect(store.jobs.checkOf(job.id)).toEqual({ ref: { id: "111954805720", sha: job.sha }, completed: false });
  store.posts.sending(run.id, "review");
  // Begun, not taken yet: the findings still wait.
  expect(store.rounds.ledger(CHANGE)).toEqual([held]);
  // The review holds a comment on the finding: the ledger says so as it lands (#67).
  store.posts.sent(run.id, "review", "3301", [finding.id]);
  expect(store.rounds.ledger(CHANGE)).toEqual([{ ...finding, commented: true }]);
  store.posts.sending(run.id, "summary");
  store.close();

  const again = open(dir);
  expect(again.posts.of(run.id)?.posts).toEqual([
    { kind: "check", hostId: "111954805720", tries: 1 },
    { kind: "review", hostId: "3301", tries: 1 },
    { kind: "summary", hostId: null, tries: 1 },
    { kind: "completed", hostId: null, tries: 0 },
  ]);
  again.posts.sending(run.id, "summary");
  again.posts.sent(run.id, "summary", "9001");
  again.posts.sending(run.id, "completed");
  again.posts.sent(run.id, "completed", "111954805720");
  expect(again.jobs.checkOf(job.id).completed).toBe(true);
  expect(again.jobs.runEnded(run.id, { kind: "round" }, T2 + 5)).toEqual({ ...job, state: "done" });
  expect(again.jobs.leftRunning()).toEqual([]);
  expect(() => again.posts.sent(runId("nobody"), "check", "1")).toThrow(
    "sent: no round saved for run nobody",
  );
});

test("a round's replies and the comments it minimizes are posts of their own, each kept with the host's id (ADR 0052)", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const posts = ["check", "review", "reply:F1", "summary", "completed", "minimize:IC_c1"] as const;
  store.posts.saved(run.id, { n: 1, held: [], ledger: [], plan: PLAN, posts }, T2);
  store.posts.sending(run.id, "reply:F1");
  store.posts.sent(run.id, "reply:F1", "100004");
  store.posts.sending(run.id, "minimize:IC_c1");
  store.close();
  const again = open(dir);
  expect(again.posts.of(run.id)?.posts).toEqual([
    { kind: "check", hostId: null, tries: 0 },
    { kind: "review", hostId: null, tries: 0 },
    { kind: "reply:F1", hostId: "100004", tries: 1 },
    { kind: "summary", hostId: null, tries: 0 },
    { kind: "completed", hostId: null, tries: 0 },
    { kind: "minimize:IC_c1", hostId: null, tries: 1 },
  ]);
  expect(() => again.posts.sending(run.id, "reply:F2")).toThrow(
    `sending: run ${run.id} owes no reply:F2 post`,
  );
});

test("a round whose review send began and was never marked sent is one the host may hold", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  store.posts.saved(run.id, { n: 1, held: [], ledger: [], plan: PLAN, posts: POSTS }, T2);
  // Never begun: the host can't hold it.
  expect(store.posts.unsure(CHANGE)).toEqual([]);
  store.posts.sending(run.id, "review");
  store.close();
  const again = open(dir);
  expect(again.posts.unsure(CHANGE)).toEqual([{ runId: run.id, plan: PLAN, degraded: false }]);
  again.posts.sent(run.id, "review", "3301");
  expect(again.posts.unsure(CHANGE)).toEqual([]);
});

test("the findings a round held off the pull request are withheld until its review lands", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const kept: Finding = { ...finding, id: findingId("F2"), posted: false };
  const held: Finding = { ...finding, posted: false };
  store.posts.saved(
    run.id,
    { n: 1, held: [held, kept], ledger: [finding, kept], plan: PLAN, posts: POSTS },
    T2,
  );
  store.posts.sending(run.id, "review");
  store.close();
  // Kept in the app by strictness, F2 was never to be posted: only F1 is withheld.
  const again = open(dir);
  expect(again.posts.withheld(CHANGE)).toEqual([finding.id]);
  again.posts.sent(run.id, "review", "3301");
  expect(again.posts.withheld(CHANGE)).toEqual([]);
  expect(again.posts.withheld(OTHER)).toEqual([]);
});

test("the findings a preview held off the pull request are withheld: its empty outbox never lands them", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const held: Finding = { ...finding, posted: false };
  store.posts.saved(run.id, { n: 1, held: [held], ledger: [finding], plan: PLAN, posts: [] }, T2);
  store.close();
  const again = open(dir);
  expect(again.posts.withheld(CHANGE)).toEqual([finding.id]);
  expect(again.posts.withheld(OTHER)).toEqual([]);
});

test("a round whose review goes with its findings in the summary is kept so, after a restart too", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  store.posts.saved(run.id, { n: 1, held: [], ledger: [], plan: PLAN, posts: POSTS }, T2);
  store.posts.sending(run.id, "review");
  store.posts.degrade(run.id);
  store.close();
  const again = open(dir);
  expect(again.posts.of(run.id)?.degraded).toBe(true);
  expect(() => again.posts.degrade(runId("nobody"))).toThrow("degrade: no round saved for run nobody");
});

test("a run posting its round frees its engine, and its change stays busy for the take until the run ends", () => {
  const store = open(home());
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const followUp: ReviewJob = { ...job, id: jobId("j2"), sha: NEWEST };
  asked(store, CHANGE, followUp);
  const other: ReviewJob = { ...job, id: jobId("j3"), sha: pr2.head.sha };
  asked(store, OTHER, other);
  expect(store.jobs.waiting().reviewing).toEqual(new Set(["claude"]));
  store.posts.saved(run.id, { n: 1, held: [], ledger: [], plan: PLAN, posts: POSTS }, T2);
  expect(store.jobs.waiting().reviewing).toEqual(new Set());
  const offered: [JobId, boolean][] = [];
  store.jobs.take((s, _reviewing, changeBusy) => {
    offered.push([s.job.id, changeBusy]);
    return null;
  });
  expect(offered).toEqual([
    [followUp.id, true],
    [other.id, false],
  ]);
  store.jobs.runEnded(run.id, { kind: "round" }, T2 + 1);
  offered.length = 0;
  store.jobs.take((s, _reviewing, changeBusy) => {
    offered.push([s.job.id, changeBusy]);
    return null;
  });
  expect(offered).toEqual([
    [followUp.id, false],
    [other.id, false],
  ]);
});

test("a run confirming on the other engine holds both engines until its round is saved (ADR 0044)", () => {
  const dir = home();
  const store = open(dir);
  asked(store, CHANGE, job);
  const other: ReviewJob = { ...job, id: jobId("j2"), sha: pr2.head.sha };
  asked(store, OTHER, other);
  const crossed: Run = { ...run, confirmer: "codex" };
  started(store, job.id, crossed);
  expect(store.jobs.waiting().reviewing).toEqual(new Set(["claude", "codex"]));
  const offered: [JobId, string[]][] = [];
  store.jobs.take((s, reviewing) => {
    offered.push([s.job.id, [...reviewing.keys()].sort()]);
    return null;
  });
  expect(offered).toEqual([[other.id, ["claude", "codex"]]]);
  store.close();
  // Kept: a restarted service sees both busy.
  const again = open(dir);
  expect(again.jobs.waiting().reviewing).toEqual(new Set(["claude", "codex"]));
  again.posts.saved(crossed.id, { n: 1, held: [], ledger: [], plan: PLAN, posts: POSTS }, T2);
  expect(again.jobs.waiting().reviewing).toEqual(new Set());
});

test("a job waiting its turn holds the engines it waits for: a younger job needing one of them waits behind it", () => {
  const store = open(home());
  // Claude reviews the first change; the second waits for Claude and Codex; the third needs only Codex.
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const both: ReviewJob = { ...job, id: jobId("j2"), sha: pr2.head.sha };
  asked(store, OTHER, both);
  const codexOnly: ReviewJob = { ...job, id: jobId("j3") };
  asked(store, THIRD, codexOnly);
  const offered: [JobId, [string, ChangeId | null][]][] = [];
  const took = store.jobs.take((s, reviewing) => {
    offered.push([s.job.id, [...reviewing].sort()]);
    if (s.job.id === both.id) return { kind: "queue", holds: ["claude", "codex"], turn: BEHIND };
    return reviewing.has("codex")
      ? { kind: "queue", holds: ["codex"], turn: BEHIND }
      : { kind: "start", run: codexRunOf(s) };
  });
  // Each engine with the change whose review holds it; one an older job waits for, with none.
  expect(offered).toEqual([
    [both.id, [["claude", CHANGE]]],
    [
      codexOnly.id,
      [
        ["claude", CHANGE],
        ["codex", null],
      ],
    ],
  ]);
  expect(took.started).toBeNull();
  // What it holds is the take's only: the record says which engines review.
  expect(store.jobs.waiting().reviewing).toEqual(new Set(["claude"]));
});

/** A run of `s`'s job by Codex, confirming on Codex too. */
const codexRunOf = (s: { job: ReviewJob }): Run => ({
  ...run,
  id: runId(`r-${s.job.id}`),
  reviewer: "codex",
  confirmer: "codex",
});

test("a run's end as a round needs a round saved for it", () => {
  const store = open(home());
  asked(store, CHANGE, job);
  started(store, job.id, run);
  expect(() => store.jobs.runEnded(run.id, { kind: "round" }, T2)).toThrow(
    "runEnded: no round saved for run r1",
  );
  expect(store.jobs.latest(CHANGE)).toEqual({ changeId: CHANGE, job: { ...job, state: "running" } });
});

test("a database from before the outbox starts empty: its rounds' findings lack ADR 0044's fields (AGENTS.md rule 10)", () => {
  const dir = home();
  // The database as the migrations before the outbox left it, with a change, a job, a round and an event in it.
  const db = new Database(join(dir, DATABASE), { create: true, strict: true });
  // Data thrown away: its two dozen writes don't wait for the disk.
  db.run("PRAGMA synchronous = OFF");
  db.run("CREATE TABLE migrations (name TEXT PRIMARY KEY)");
  const own = join(import.meta.dir, "migrations");
  for (const file of readdirSync(own)
    .filter((f) => f < OUTBOX_MIGRATION)
    .sort()) {
    db.run(readFileSync(join(own, file), "utf8"));
    db.run("INSERT INTO migrations (name) VALUES (?)", [file.replace(/\.sql$/, "")]);
  }
  db.run("INSERT INTO events (body) VALUES (?)", [JSON.stringify({ type: "clock", at: T1 })]);
  db.run("INSERT INTO repositories (owner, name) VALUES (?, ?)", [REPO.owner, REPO.name]);
  db.run(
    "INSERT INTO changes (repo_owner, repo_name, number, head_sha, draft, author_id, first_seen_at) VALUES (?, ?, 1, ?, 0, 1234, ?)",
    [REPO.owner, REPO.name, job.sha, T1],
  );
  db.run(
    "INSERT INTO jobs (id, change_id, sha, trigger, state, retries, check_completed) VALUES (?, ?, ?, 'manual', 'done', 0, 1)",
    [job.id, CHANGE, job.sha],
  );
  db.run("INSERT INTO rounds (change_id, n, sha, findings, posted_at) VALUES (?, 1, ?, '[{}]', ?)", [
    CHANGE,
    job.sha,
    T1,
  ]);
  db.close();

  const store = open(dir);
  // The outbox ran, and whatever came after it.
  expect(store.migrated).toContain(OUTBOX_MIGRATION.replace(/\.sql$/, ""));
  expect(store.rounds.ledger(CHANGE)).toEqual([]);
  expect(store.rounds.of(CHANGE)).toEqual([]);
  expect(store.events.all()).toEqual([]);
  expect(store.jobs.latest(CHANGE)).toBeNull();
  expect(store.inbox.open(REPO)).toEqual([]);
});

/** A folder of migrations: the store's own, which its handles need, then `files` written in the order given. */
function migrations(files: [name: string, sql: string][]): string {
  const dir = home();
  const own = join(import.meta.dir, "migrations");
  for (const file of readdirSync(own)) copyFileSync(join(own, file), join(dir, file));
  for (const [name, sql] of files) writeFileSync(join(dir, `${name}.sql`), sql);
  return dir;
}

test("migrations are found one per file and run once, in name order whatever order the folder lists them", () => {
  const inNameOrder = [
    "20261010000000-log",
    "20261011000000-a",
    "20261012000000-b",
    "20261013000000-c",
    "20261014000000-d",
    "20261015000000-e",
    "20261016000000-f",
    "20261017000000-g",
    "20261018000000-h",
    "20261019000000-i",
    "20261020000000-j",
    "20261021000000-k",
  ];
  // Written out of order. Each logs its name; the first by name makes the log, so any other order fails.
  const written = [7, 2, 11, 0, 9, 4, 1, 10, 5, 8, 3, 6].map((i) => inNameOrder[i] ?? "");
  const folder = migrations(
    written.map((name): [string, string] => [
      name,
      `${name.endsWith("-log") ? "CREATE TABLE log (name TEXT NOT NULL);" : ""} INSERT INTO log VALUES ('${name}');`,
    ]),
  );
  const dir = home();
  const first = openStore({ home: dir, migrations: folder, durable: false });
  stores.push(first);
  // The store's own come first (named earlier) and aren't this test's: only the order of the planted ones counts.
  expect(first.migrated.filter((name) => inNameOrder.includes(name))).toEqual(inNameOrder);
  first.close();
  const again = openStore({ home: dir, migrations: folder, durable: false });
  stores.push(again);
  expect(again.migrated).toEqual([]);
  again.close();
  const db = new Database(join(dir, DATABASE), { strict: true });
  expect(db.query("SELECT name FROM log ORDER BY rowid").all()).toEqual(
    inNameOrder.map((name) => ({ name })),
  );
  db.close();
});

test("a database holding a migration this Lookover doesn't know is refused, with what to do, and left as it was", () => {
  const dir = home();
  open(dir).close();
  // A newer Lookover, or an older build of this one, recorded a migration this one doesn't know.
  const db = new Database(join(dir, DATABASE), { strict: true });
  db.run("INSERT INTO migrations (name) VALUES ('20991231235959-later')");
  db.close();
  expect(() => open(dir)).toThrow(
    "The database holds migration 20991231235959-later, which this Lookover doesn't know. Reset the data folder.",
  );
  const after = new Database(join(dir, DATABASE), { strict: true });
  expect(after.query("SELECT name FROM migrations WHERE name = '20991231235959-later'").all()).toEqual([
    { name: "20991231235959-later" },
  ]);
  after.close();
});

// The owner's dismissal (ADR 0052): its posts go through an outbox of its own, keyed by the dismissal.

/** What a dismissal does to a ledger, as `core` says it: the finding settled `dismissed`. */
const dismissing =
  (id: string) =>
  (ledger: Finding[]): Finding[] =>
    ledger.map((f) => (f.id === id ? { ...f, status: "dismissed" as const, closedIn: 1 } : f));

const DISMISSAL_POSTS = ["reply", "summary", "completed", "minimize"] as const;

/** Round 1 of `CHANGE` posted by `run`, its check `111` sent, its review landed with `ledger`. */
function postedRound(store: Store, ledger: Finding[]): void {
  asked(store, CHANGE, job);
  started(store, job.id, run);
  store.posts.saved(run.id, { n: 1, held: ledger, ledger, plan: PLAN, posts: POSTS }, T1);
  for (const kind of POSTS) store.posts.sent(run.id, kind, kind === "check" ? "111" : `${kind}-1`);
  store.jobs.runEnded(run.id, { kind: "round" }, T1 + 1);
}

test("the replies Lookover kept for a change are its rounds' and its dismissals', each by the host's id (ADR 0066)", () => {
  const dir = home();
  const store = open(dir);
  expect(store.posts.replies(CHANGE)).toEqual([]);
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const posts = [
    "check",
    "review",
    "reply:F1",
    "reply:F2",
    "summary",
    "completed",
    "minimize:IC_c1",
  ] as const;
  store.posts.saved(run.id, { n: 1, held: [finding], ledger: [finding], plan: PLAN, posts }, T1);
  store.posts.sent(run.id, "check", "111");
  store.posts.sent(run.id, "reply:F1", "100004");
  store.posts.sent(run.id, "minimize:IC_c1", "IC_c1");
  store.posts.sending(run.id, "reply:F2");
  store.jobs.runEnded(run.id, { kind: "round" }, T1 + 1);
  store.dismissals.saved({
    id: "d1",
    changeId: CHANGE,
    findingId: finding.id,
    runId: run.id,
    checkId: "111",
    dismiss: dismissing("F1"),
    posts: DISMISSAL_POSTS,
    at: T2,
  });
  store.dismissals.sent("d1", "reply", "100009");
  store.dismissals.sent("d1", "summary", "9001");
  store.close();
  const again = open(dir);
  // A reply begun and never marked sent has no id: the reply marker finds it.
  expect(again.posts.replies(CHANGE)).toEqual([100004, 100009]);
  expect(again.posts.replies(changeId("sasensi/lookover-sandbox#2"))).toEqual([]);
});

test("the change's latest round that posted is given with its plan and its check; a preview after it is passed over", () => {
  const store = open(home());
  expect(store.posts.latest(CHANGE)).toBeNull();
  postedRound(store, [finding]);
  const preview: ReviewJob = { ...job, id: jobId("j2") };
  asked(store, CHANGE, preview);
  started(store, preview.id, { ...run, id: runId("r2"), preview: true });
  roundEnded(store, runId("r2"), 2, [finding], T2, "preview");
  expect(store.posts.latest(CHANGE)).toEqual({ runId: run.id, plan: PLAN, degraded: false, checkId: "111" });
});

test("a dismissal is saved in one write with the ledger it leaves and its posts owed, and refused while a run of the change goes", () => {
  const dir = home();
  const store = open(dir);
  postedRound(store, [finding]);
  const saved = store.dismissals.saved({
    id: "d1",
    changeId: CHANGE,
    findingId: finding.id,
    runId: run.id,
    checkId: "111",
    dismiss: dismissing("F1"),
    posts: DISMISSAL_POSTS,
    at: T2,
  });
  const dismissed: Finding = { ...finding, status: "dismissed", closedIn: 1 };
  expect(saved).toEqual([dismissed]);
  store.dismissals.sending("d1", "reply");
  store.dismissals.sent("d1", "reply", "100004");
  store.close();

  // Kept: the ledger dismissed, the posts as they stand, the dismissal owing until it ends.
  const again = open(dir);
  expect(again.rounds.ledger(CHANGE)).toEqual([dismissed]);
  expect(again.dismissals.owing()).toEqual(["d1"]);
  expect(again.dismissals.of("d1")).toEqual({
    id: "d1",
    changeId: CHANGE,
    findingId: finding.id,
    plan: PLAN,
    degraded: false,
    checkId: "111",
    posts: [
      { kind: "reply", hostId: "100004", tries: 1 },
      { kind: "summary", hostId: null, tries: 0 },
      { kind: "completed", hostId: null, tries: 0 },
      { kind: "minimize", hostId: null, tries: 0 },
    ],
  });
  expect(again.dismissals.of("nobody")).toBeNull();
  again.dismissals.ended("d1", T2 + 1);
  expect(again.dismissals.owing()).toEqual([]);
  expect(() => again.dismissals.sending("d1", "reply")).toThrow("sending: dismissal d1 has ended");

  // A run of the change under way: refused, nothing written.
  const next: ReviewJob = { ...job, id: jobId("j2") };
  asked(again, CHANGE, next);
  started(again, next.id, { ...run, id: runId("r2") });
  expect(
    again.dismissals.saved({
      id: "d2",
      changeId: CHANGE,
      findingId: finding.id,
      runId: run.id,
      checkId: null,
      dismiss: dismissing("F1"),
      posts: ["reply", "summary", "minimize"],
      at: T2 + 2,
    }),
  ).toBe("reviewing");
  expect(again.dismissals.of("d2")).toBeNull();
});

test("a dismissal's ledger reaches the round whose review hasn't landed: a late landing never undoes it", () => {
  const store = open(home());
  asked(store, CHANGE, job);
  started(store, job.id, run);
  const held: Finding = { ...finding, posted: false };
  const other: Finding = { ...finding, id: findingId("F2") };
  store.posts.saved(
    run.id,
    { n: 1, held: [held, other], ledger: [finding, other], plan: PLAN, posts: POSTS },
    T1,
  );
  store.posts.sending(run.id, "review");
  store.jobs.runEnded(
    run.id,
    { kind: "failed", failure: { kind: "publish_failed", detail: "422" }, posted: false },
    T1 + 1,
  );
  store.dismissals.saved({
    id: "d1",
    changeId: CHANGE,
    findingId: other.id,
    runId: run.id,
    checkId: null,
    dismiss: dismissing("F2"),
    posts: ["reply", "summary", "minimize"],
    at: T2,
  });
  // The review is found on GitHub after all, by its marker: the ledger lands with the dismissal in it.
  store.posts.sent(run.id, "review", "3301");
  expect(store.rounds.ledger(CHANGE).map((f) => [String(f.id), f.status])).toEqual([
    ["F1", "open"],
    ["F2", "dismissed"],
  ]);
});

test("a dismissal owing posts keeps its change busy for the take until it ends", () => {
  const store = open(home());
  postedRound(store, [finding]);
  const next: ReviewJob = { ...job, id: jobId("j2"), sha: NEWEST };
  asked(store, CHANGE, next);
  store.dismissals.saved({
    id: "d1",
    changeId: CHANGE,
    findingId: finding.id,
    runId: run.id,
    checkId: "111",
    dismiss: dismissing("F1"),
    posts: DISMISSAL_POSTS,
    at: T2,
  });
  const busy = () => {
    const offered: boolean[] = [];
    store.jobs.take((_s, _reviewing, changeBusy) => {
      offered.push(changeBusy);
      return null;
    });
    return offered;
  };
  expect(busy()).toEqual([true]);
  store.dismissals.ended("d1", T2 + 1);
  expect(busy()).toEqual([false]);
});

test("a repository gone from the installation: its jobs cancelled, what it owes dropped, its listing forgotten, its history kept (ADR 0053)", () => {
  const dir = home();
  const store = open(dir);
  const ledger = { owner: "sasensi", name: "ledger-api" };
  const ledgerChange = changeId("sasensi/ledger-api#1");
  store.inbox.replace(REPO, [pr1, pr2], T1);
  store.inbox.replace(ledger, [pr1], T1);
  store.repos.setEnabled(REPO, false);
  store.requests.seen(REPO, [], at(T1));
  // #1's job runs, at publishing: its check posted, its review and the rest owed; a request waits for its 👀.
  store.jobs.asked(CHANGE, { sha: job.sha, trigger: "comment", id: () => job.id, request: request("c1") });
  started(store, job.id, run);
  store.posts.saved(run.id, { n: 1, held: [], ledger: [], plan: PLAN, posts: POSTS }, T1 + 1);
  store.posts.sent(run.id, "check", "111");
  // #2's job waits, its check made; #3's ended cancelled and owes its check's end.
  const other: ReviewJob = { ...job, id: jobId("j2") };
  asked(store, OTHER, other);
  store.jobs.checked(other.id, { id: "222", sha: other.sha });
  const third: ReviewJob = { ...job, id: jobId("j3") };
  asked(store, THIRD, third);
  store.jobs.take((s) => (s.job.id === third.id ? { kind: "cancel", reason: "closed" } : null));
  // Another repository's job waits.
  const elsewhere: ReviewJob = { ...job, id: jobId("j9") };
  asked(store, ledgerChange, elsewhere);

  store.repos.removed(REPO, "sasensi/lookover-sandbox#", T2);
  store.close();

  const again = open(dir);
  expect(again.jobs.latest(CHANGE)?.job).toMatchObject({ id: job.id, state: "cancelled", cancel: "closed" });
  expect(again.jobs.latest(OTHER)?.job).toMatchObject({ id: other.id, state: "cancelled", cancel: "closed" });
  expect(again.jobs.leftRunning()).toEqual([]);
  expect(again.jobs.pendingIn("sasensi/lookover-sandbox#")).toBe(false);
  expect(again.jobs.waiting().jobs.map((w) => w.changeId)).toEqual([ledgerChange]);
  // Nothing is owed to a repository Lookover can't reach: no check's end, no post, no reaction.
  expect(again.jobs.checksEnding()).toEqual([]);
  expect(again.posts.of(run.id)?.posts).toEqual([{ kind: "check", hostId: "111", tries: 0 }]);
  expect(again.requests.unreacted()).toEqual([]);
  // Its listing is forgotten: added again, it is new and switched on, its comments read from that first poll.
  expect(again.inbox.open(REPO)).toEqual([]);
  expect(again.requests.place(REPO)).toBeNull();
  expect(again.repos.listed()).toEqual([ledger]);
  expect(again.repos.enabled(REPO)).toBe(true);
  // Its history stays: the round its run saved.
  expect(again.rounds.of(CHANGE)).toEqual([{ n: 1, sha: pr1.head.sha }]);
  expect(again.inbox.replace(REPO, [pr1], T2 + 1).repositoryAdded).toBe(true);
  expect(again.inbox.open(ledger).map((c) => c.number)).toEqual([1]);
});

test("a manifest flow is kept by its state's hash across a restart until used up; those opened before a moment are forgotten (ADR 0053)", () => {
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  expect(store.appFlows.flow("a1")).toBeNull();
  store.appFlows.opened("a1", 1_000, null);
  store.appFlows.opened("b2", 5_000, null);
  store.close();

  const again = open(dir);
  expect(again.appFlows.flow("a1")).toEqual({ openedAt: 1_000, place: null });
  again.appFlows.usedUp("a1");
  expect(again.appFlows.flow("a1")).toBeNull();
  again.appFlows.opened("c3", 9_000, null);
  again.appFlows.forget(9_000);
  expect(again.appFlows.flow("b2")).toBeNull();
  expect(again.appFlows.flow("c3")).toEqual({ openedAt: 9_000, place: null });
});

test("where the App is made is chosen once and kept across a restart, and each flow keeps the place it was opened for (ADR 0059)", () => {
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  const acme = { organisation: { id: 9000, login: "acme" }, person: { id: 42, login: "sam" } };
  // Your own account until an organisation is chosen.
  expect(store.appFlows.chosen()).toBeNull();
  store.appFlows.choose(acme);
  store.appFlows.opened("a1", 1_000, acme);
  store.close();

  const again = open(dir);
  expect(again.appFlows.chosen()).toEqual(acme);
  expect(again.appFlows.flow("a1")).toEqual({ openedAt: 1_000, place: acme });
  again.appFlows.choose(null);
  again.appFlows.opened("b2", 2_000, null);
  expect(again.appFlows.chosen()).toBeNull();
  // A flow keeps the place it was opened for, whatever is chosen after.
  expect(again.appFlows.flow("a1")).toEqual({ openedAt: 1_000, place: acme });
  expect(again.appFlows.flow("b2")).toEqual({ openedAt: 2_000, place: null });

  // No place: a choice not taken, kept as such across a restart until another is chosen.
  again.appFlows.choose("none");
  again.close();
  const third = open(dir);
  expect(third.appFlows.chosen()).toBe("none");
  third.appFlows.choose(acme);
  expect(third.appFlows.chosen()).toEqual(acme);
});

/** The migration that names each change by its repository's owner too (ADR 0066). */
const OWNER_IDS_MIGRATION = "20261030090000-change-ids-with-owner";

test("a data folder from before ADR 0066 names its changes by owner and name: its jobs, rounds, plans, dismissals and first review follow, its events not", () => {
  const dir = home();
  const store = open(dir);
  const ledgerApi = { owner: "ledger-dev", name: "ledger-api" };
  // Both repositories listed: the store keeps them, each of one name in this data folder.
  store.inbox.replace(REPO, [pr1], T1);
  store.inbox.replace(ledgerApi, [{ ...pr2, url: "https://github.com/ledger-dev/ledger-api/pull/2" }], T1);
  // The ids the service wrote before: the repository's name alone.
  const old = changeId("lookover-sandbox#1");
  const oldLedger = changeId("ledger-api#2");
  asked(store, old, job);
  started(store, job.id, run);
  store.posts.saved(run.id, { n: 1, held: [finding], ledger: [finding], plan: PLAN, posts: POSTS }, T1);
  for (const kind of POSTS) store.posts.sent(run.id, kind, kind === "check" ? "111" : `${kind}-1`);
  store.jobs.runEnded(run.id, { kind: "round" }, T1 + 1);
  store.dismissals.saved({
    id: "d1",
    changeId: old,
    findingId: finding.id,
    runId: run.id,
    checkId: "111",
    dismiss: dismissing("F1"),
    posts: DISMISSAL_POSTS,
    at: T2,
  });
  // A job waiting its turn behind the sandbox's change, as its turn said it.
  const waiting: ReviewJob = { ...job, id: jobId("j2"), sha: pr2.head.sha };
  asked(store, oldLedger, waiting);
  const behind: Turn = { behind: "engines", engines: ["claude"], changes: [old], testing: false };
  store.jobs.take((s) => (s.job.id === waiting.id ? { kind: "queue", holds: [], turn: behind } : null));
  // A change of a repository the store keeps no row of.
  const gone = changeId("gone#4");
  asked(store, gone, { ...job, id: jobId("j3") });
  store.setup.write({ firstReviewChange: old });
  store.events.append({ type: "change.closed", at: T2, changeId: old });
  store.close();
  // As the data folder was before the migration ran: it runs again on the next open.
  const db = new Database(join(dir, DATABASE), { strict: true });
  db.run("DELETE FROM migrations WHERE name = ?", [OWNER_IDS_MIGRATION]);
  db.close();

  const again = open(dir);
  expect(again.migrated).toEqual([OWNER_IDS_MIGRATION]);
  const sandbox1 = changeId("sasensi/lookover-sandbox#1");
  const ledger2 = changeId("ledger-dev/ledger-api#2");
  expect(again.jobs.latest(old)).toBeNull();
  expect(again.jobs.latest(sandbox1)?.job).toMatchObject({ id: job.id, state: "done" });
  expect(again.rounds.of(sandbox1)).toEqual([{ n: 1, sha: job.sha }]);
  expect(again.rounds.ledger(sandbox1)).toEqual([{ ...finding, status: "dismissed", closedIn: 1 }]);
  expect(again.posts.latest(sandbox1)).toMatchObject({ runId: run.id, plan: PLAN, checkId: "111" });
  expect(again.dismissals.of("d1")).toMatchObject({ changeId: sandbox1 });
  expect(again.dismissals.owing()).toEqual(["d1"]);
  expect(again.setup.read().firstReviewChange).toBe(sandbox1);
  // The waiting job is its repository's; its turn is said again by the next take, in the new ids.
  expect(again.jobs.latest(ledger2)?.job).toMatchObject({ id: waiting.id, state: "queued", turn: null });
  expect(again.jobs.pendingIn("ledger-dev/ledger-api#")).toBe(true);
  // A name the store keeps no repository of stays as it was; the events are history, as written.
  expect(again.jobs.latest(gone)?.job).toMatchObject({ id: "j3" });
  expect(again.events.all()).toEqual([{ seq: 1, type: "change.closed", at: T2, changeId: old }]);
});

test("an ask to install on an account is kept per person across a restart, the last one winning, by its id, until reached or another signs in (ADR 0067)", () => {
  const dir = home();
  const store = open(dir);
  const sam = 1234;
  const bob = 5678;
  const ledger = { id: 9101, login: "ledger-dev" };
  const acme = { id: 9102, login: "acme" };
  const bobsOrg = { id: 9104, login: "bobs-org" };
  expect(store.installAsks.of(sam)).toEqual([]);
  store.installAsks.asked(sam, ledger, T1);
  store.installAsks.asked(sam, acme, T1 + 1);
  // Asked again, by its id whatever its login says (renamed since): one ask, at the later time, under its new login.
  store.installAsks.asked(sam, { ...ledger, login: "ledger-co" }, T2);
  store.close();
  const again = open(dir);
  // Each with the account's id, so it can be shown when nothing else names it.
  expect(again.installAsks.of(sam)).toEqual([
    { account: acme, askedAt: T1 + 1 },
    { account: { ...ledger, login: "ledger-co" }, askedAt: T2 },
  ]);
  // Another person's asks are theirs alone.
  expect(again.installAsks.of(bob)).toEqual([]);
  // Reached: forgotten, by its id, whatever login it has now.
  again.installAsks.reached(acme.id);
  expect(again.installAsks.of(sam)).toEqual([{ account: { ...ledger, login: "ledger-co" }, askedAt: T2 }]);
  // Bob signs in: Sam's asks are forgotten, Bob's kept.
  again.installAsks.asked(bob, bobsOrg, T2);
  again.installAsks.signedIn(bob);
  expect(again.installAsks.of(sam)).toEqual([]);
  expect(again.installAsks.of(bob)).toEqual([{ account: bobsOrg, askedAt: T2 }]);
});
