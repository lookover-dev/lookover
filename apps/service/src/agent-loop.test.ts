// The agent loop runs by itself (ADR 0043, spec #69's demo world): the service and `lookover wait` on one fake
// GitHub, one clock. The agent's pull request opens and round 1 posts with nobody asking; `wait` reads that
// round's check and says there is something to fix (3). The agent pushes the fix and runs `wait` again: it asks
// with `/lookover review`, the poll picks the request up, round 2 posts, and `wait` says nothing is left (0).
// Nobody clicks, no process is spawned, and nothing waits on the wall clock: `wait`'s sleeps move the clock the
// service's timers run on.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { run, type World } from "@lookover/agent-cli";
import { type CommitSha, isReviewRequest, reviewRequest } from "@lookover/contracts";
import {
  type DemoClock,
  type FakeGitHost,
  type HostPost,
  ScriptedRetrieval,
  type ScriptedRun,
} from "@lookover/testkit";
import {
  BOT,
  fakeEngines,
  OWNER,
  pr1,
  SANDBOX,
  SHA1,
  SHA1_PUSHED,
  start,
  stopAll,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const PR1 = { repo: SANDBOX, number: 1 };
/** The App's slug, as the agent names it to `wait`: its bot's login without `[bot]`. */
const APP = "lookover-spike-sasensi";

/** Round 1's find pass: one blocking finding on a line of the diff. */
const ROUND_1: ScriptedRun = {
  outcome: "ok",
  text: [
    "The total skips the last invoice.",
    "```json",
    JSON.stringify({
      findings: [
        {
          path: "src/total.ts",
          line: 12,
          severity: "blocking",
          category: "correctness",
          title: "The total skips the last invoice",
          body: "The loop stops one short, so the last invoice is never added.",
          defect_key: "total-skips-last-invoice",
        },
      ],
    }),
    "```",
  ].join("\n"),
};

/** Round 1's confirm pass, in a new session: the finding confirmed, still blocking (ADR 0044). */
const CONFIRM_1: ScriptedRun = {
  outcome: "ok",
  text: [
    "The loop's bound is length - 1.",
    "```json",
    JSON.stringify({
      verdicts: [
        {
          id: "C1",
          verdict: "confirmed",
          reason: "The loop's bound is length - 1.",
          evidence: ["src/total.ts:12"],
          severity: "blocking",
        },
      ],
    }),
    "```",
  ].join("\n"),
};

/** Round 2's find pass: round 1's finding fixed, nothing new. */
const ROUND_2: ScriptedRun = {
  outcome: "ok",
  text: [
    "The loop now reaches the last invoice.",
    "```json",
    JSON.stringify({
      findings: [],
      earlier: [{ id: "F1", present: false, why: "The loop now reaches the last invoice." }],
    }),
    "```",
  ].join("\n"),
};

/**
 * The coding agent: a checkout of pull request #1's branch whose head the test moves, and `lookover` run with the
 * owner's own account on the same fake GitHub. Its sleeps move the held clock, so the service's timers fire as
 * the agent waits.
 */
function agentOn(host: FakeGitHost, time: DemoClock) {
  const local: { head: CommitSha } = { head: SHA1 };
  let out: string[] = [];
  let err: string[] = [];
  const world: World = {
    host: () => Promise.resolve(host.asAgent(OWNER)),
    git: {
      head: () => Promise.resolve(local.head),
      branch: () => Promise.resolve(pr1.head.ref),
      origin: () => Promise.resolve(SANDBOX),
    },
    env: { LOOKOVER_APP: APP },
    clock: time,
    sleep: (ms) => time.advance(ms),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return {
    local,
    /** Runs `lookover wait --json`; its exit code, what it printed on stdout (parsed) and on stderr. */
    async wait(): Promise<{ exit: number; json: unknown; err: string[] }> {
      out = [];
      err = [];
      const exit = await run(["wait", "--json"], world);
      return { exit, json: JSON.parse(out.join("\n")), err };
    },
  };
}

/** A post as a short line: a check with its state, a reaction, a review or the summary. */
function line(p: HostPost): string {
  switch (p.kind) {
    case "check.created":
    case "check.updated":
      return `check ${p.status}`;
    case "check.completed":
      return `check ${p.conclusion}`;
    case "reaction":
      return p.reaction;
    case "review":
      return "review";
    case "summary.created":
    case "summary.edited":
    case "reply":
    case "minimized":
      return p.kind;
  }
}

test("the pull request opens, round 1 posts by itself, wait says fix; the fix is pushed, wait asks, round 2 posts, wait says done", async () => {
  const engines = fakeEngines();
  engines.answer(ROUND_1, CONFIRM_1, ROUND_2);
  const retrieval = new ScriptedRetrieval();
  // Nothing open at the first start: the agent's pull request is opened while the service runs.
  const { host, time } = await start({ changes: [], engines, retrieval });
  const agent = agentOn(host, time);

  // The agent opens its pull request. Within the idle minute the poll sees it and round 1 runs, unasked.
  host.open(pr1);
  await time.advance(MIN);
  expect(host.posts.map(line)).toEqual([
    "check queued",
    "check in_progress",
    "review",
    "summary.created",
    "check neutral",
  ]);

  const first = await agent.wait();
  expect(first.exit).toBe(3);
  expect(first.json).toMatchObject({
    commit: SHA1,
    change: 1,
    exit: 3,
    meaning: "fix",
    next_action: "fix",
    findings: [{ id: "F1", severity: "blocking", title: "The total skips the last invoice" }],
  });
  // Round 1 was there already: `wait` asked for nothing.
  expect(first.err[0]).toBe("Waiting for Lookover on a1b2c3d (pull request #1).");
  expect(host.view(PR1).comments.filter((c) => isReviewRequest(c.body))).toEqual([]);

  // The agent pushes its fix ("review after every push" is off: the push alone asks for nothing) and waits.
  host.push(PR1, SHA1_PUSHED, pr1.diff);
  agent.local.head = SHA1_PUSHED;
  const posted = host.posts.length;
  const second = await agent.wait();
  expect(second.err[0]).toBe("Asked Lookover to review c3d4e5f (pull request #1).");
  expect(second.exit).toBe(0);
  expect(second.json).toMatchObject({
    commit: SHA1_PUSHED,
    change: 1,
    exit: 0,
    meaning: "nothing_to_fix",
    next_action: "stop",
    findings: [],
  });
  expect(host.posts.slice(posted).map(line)).toEqual([
    "eyes",
    "check queued",
    "check in_progress",
    "review",
    "summary.edited",
    "check success",
    "minimized",
    "rocket",
  ]);
  // The one request is the agent's, written as the owner, answered with 👀 and 🚀 by the App, minimized once answered.
  expect(host.view(PR1).comments.filter((c) => c.author.id !== BOT.id)).toEqual([
    {
      id: expect.any(String),
      author: OWNER,
      body: reviewRequest(SHA1_PUSHED),
      reactions: { eyes: 1, rocket: 1 },
      minimized: "resolved",
    },
  ]);
  // Two rounds, each on fakes alone: no git, no `claude`; round 1 found then confirmed, round 2 found nothing new.
  expect(engines.runs).toHaveLength(3);
  expect(retrieval.prepared).toHaveLength(2);
});

test("on a colleague's pull request, skipped when it opened, wait asks anyway; the request is reviewed and wait reads its round", async () => {
  const engines = fakeEngines();
  engines.answer(ROUND_1, CONFIRM_1);
  const { host, time } = await start({ changes: [], engines });
  const agent = agentOn(host, time);

  // A colleague opens it: nobody asked, so it is skipped with the reason on its check (ADR 0016).
  host.open({ ...pr1, author: { id: 583231, login: "octocat" } });
  await time.advance(MIN);
  expect(host.posts.map(line)).toEqual(["check queued", "check skipped"]);

  // The owner's agent waits on it: that skip answers nobody, so `wait` asks, and the request is reviewed.
  const posted = host.posts.length;
  const waited = await agent.wait();
  expect(waited.err[0]).toBe("Asked Lookover to review a1b2c3d (pull request #1).");
  expect(waited.exit).toBe(3);
  expect(waited.json).toMatchObject({ commit: SHA1, change: 1, meaning: "fix", next_action: "fix" });
  expect(host.posts.slice(posted).map(line)).toEqual([
    "eyes",
    "check queued",
    "check in_progress",
    "review",
    "summary.created",
    "check neutral",
    "minimized",
    "rocket",
  ]);
  // One round: its find pass, then its confirm pass.
  expect(engines.runs).toHaveLength(2);
});
