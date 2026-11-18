// The agent loop runs by itself (ADR 0043, spec #69's demo world): the service and `lookover wait` on one fake
// GitHub, one clock. The agent's pull request opens and round 1 posts with nobody asking; `wait` reads that
// round's check and says there is something to fix (3). The agent pushes the fix and runs `wait` again: it asks
// with `/lookover review`, the poll picks the request up, round 2 posts, and `wait` says nothing is left (0).
// Nobody clicks, no process is spawned, and nothing waits on the wall clock: `wait`'s sleeps move the clock the
// service's timers run on. And #791's loop (ADR 0100): a correct finding the agent answers won't fix twice is kept,
// then escalated, `wait` saying a person is needed (4); the owner accepts it as is from the app, GitHub says so, and
// the next `wait` resolves its thread and ends (0). And #801's (ADR 0101): the owner tells their agent instead, whose
// `lookover settle` exits 0 once Lookover settled it, and the next `wait` resolves its thread and ends (0).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { run, type World } from "@lookover/agent-cli";
import {
  type ChangeRef,
  type CommitSha,
  changeId,
  isReviewRequest,
  readResult,
  reviewRequest,
  SHARED_APP,
  type State,
  statusOf,
  withoutWordmark,
} from "@lookover/contracts";
import {
  type DemoClock,
  type FakeGitHost,
  type HostPost,
  ScriptedRetrieval,
  type ScriptedRun,
} from "@lookover/testkit";
import { again, CONFIRMED, FOUND, STILL, TOTAL_ADDED } from "./claims.test-support.ts";
import {
  fakeEngines,
  OWNER,
  openApp,
  post,
  pr1,
  SANDBOX,
  SHA1,
  SHA1_PUSHED,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const PR1: ChangeRef = { repo: SANDBOX, number: 1 };

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
    /** Runs `lookover reply <finding> <claim> <text>`: its exit code. */
    reply(finding: string, claim: string, text: string): Promise<number> {
      return run(["reply", finding, claim, text], world);
    },
    /** Runs `lookover settle <finding> <decision> --confirmed-by-owner <reason>`: its exit code and stderr. */
    async settle(
      finding: string,
      decision: string,
      reason: string,
    ): Promise<{ exit: number; err: string[] }> {
      out = [];
      err = [];
      const exit = await run(["settle", finding, decision, "--confirmed-by-owner", reason], world);
      return { exit, err };
    },
  };
}

/** A post as a short line: a check with its state, a reaction, a review or the status block. */
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
    case "status.written":
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
  // F1 is off the scripted diff: it is in the status block, and the round posts no review (ADR 0074).
  expect(host.posts.map(line)).toEqual([
    "check queued",
    "check in_progress",
    // The status block follows the job: Looking over (ADR 0074).
    "status.written",
    "status.written",
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
    // The status block follows the job: Looking over (ADR 0074).
    "status.written",
    "status.written",
    "check success",
    "minimized",
    "rocket",
  ]);
  // The one request is the agent's, written as the owner, answered with 👀 and 🚀 posted as the owner, minimized once answered.
  expect(host.view(PR1).comments.filter((c) => isReviewRequest(c.body))).toEqual([
    {
      id: expect.any(String),
      author: OWNER,
      body: reviewRequest(SHA1_PUSHED),
      reactions: { eyes: 1, rocket: 1, confused: 0 },
      minimized: "resolved",
    },
  ]);
  // Two rounds, each on fakes alone: no git, no `claude`; round 1 found then confirmed, round 2 found nothing new.
  expect(engines.runs).toHaveLength(3);
  expect(retrieval.prepared).toHaveLength(2);
});

test("on a colleague's pull request, which got nothing when it opened, wait asks; the request is reviewed and wait reads its round", async () => {
  const engines = fakeEngines();
  engines.answer(ROUND_1, CONFIRM_1);
  const { host, time } = await start({ changes: [], engines });
  const agent = agentOn(host, time);

  // A colleague opens it: nobody asked, so nothing is posted on it (ADR 0078).
  host.open({ ...pr1, author: { id: 583231, login: "octocat" } });
  await time.advance(MIN);
  expect(host.posts.map(line)).toEqual([]);

  // The owner's agent waits on it: no check of the person's names the commit, so `wait` asks, and the request is
  // reviewed.
  const posted = host.posts.length;
  const waited = await agent.wait();
  expect(waited.err[0]).toBe("Asked Lookover to review a1b2c3d (pull request #1).");
  expect(waited.exit).toBe(3);
  expect(waited.json).toMatchObject({ commit: SHA1, change: 1, meaning: "fix", next_action: "fix" });
  expect(host.posts.slice(posted).map(line)).toEqual([
    "eyes",
    "check queued",
    "check in_progress",
    // The status block follows the job: Looking over (ADR 0074).
    "status.written",
    "status.written",
    "check neutral",
    "minimized",
    "rocket",
  ]);
  // One round: its find pass, then its confirm pass.
  expect(engines.runs).toHaveLength(2);
});

/**
 * #791's loop up to the escalation: round 1 finds F1, the agent says won't fix twice, each `wait` asks again and the
 * round keeps the finding, then escalates it; the last `wait`'s answer given.
 */
async function escalation() {
  const engines = fakeEngines();
  engines.answer(FOUND, CONFIRMED);
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = TOTAL_ADDED;
  const { host, time, service } = await start({ changes: [], engines, retrieval });
  const agent = agentOn(host, time);
  host.open(pr1);
  await time.advance(MIN);
  expect((await agent.wait()).exit).toBe(3);
  const cookie = await openApp(service);
  const stateOf = (): Promise<State> => snapshot(service, cookie);
  const f1 = async () => (await stateOf()).reviews[changeId("sasensi/lookover-sandbox#1")]?.findings[0];

  await time.advance(MIN);
  expect(await agent.reply("F1", "wont-fix", "The deploy window covers the last invoice.")).toBe(0);
  engines.answer(again(true, STILL));
  expect((await agent.wait()).exit).toBe(3);
  expect(await f1()).toMatchObject({ id: "F1", status: "open", kept: 1 });
  await time.advance(MIN);
  expect(await agent.reply("F1", "wont-fix", "It stays as it is.")).toBe(0);
  engines.answer(again(true, STILL));
  const escalated = await agent.wait();
  return { engines, host, time, service, agent, cookie, stateOf, f1, escalated };
}

test("a correct finding the agent won't fix is escalated, the owner accepts it as is, GitHub says so, and wait ends", async () => {
  const { engines, host, time, service, agent, cookie, stateOf, f1, escalated } = await escalation();
  expect(escalated.exit).toBe(4);
  expect(escalated.err.join("\n")).toContain("a person is needed");
  // It names the finding only the owner settles, and where they settle it (ADR 0100).
  const settle =
    "The owner settles it in Lookover's app (`lookover open`), on this pull request's review: Accept as is, or Too noisy? › This finding is wrong. Or ask them: on their word, `lookover settle <finding> accepted|wrong --confirmed-by-owner \"<their reason>\"`.";
  expect(escalated.err.slice(-2)).toEqual([
    "F1 · Blocking · The total skips the last invoice (src/total.ts:12)",
    settle,
  ]);
  expect(escalated.json).toMatchObject({
    for_the_owner: {
      findings: [
        {
          id: "F1",
          severity: "blocking",
          title: "The total skips the last invoice",
          path: "src/total.ts",
          line: 12,
        },
      ],
      settle,
    },
  });
  expect(await f1()).toMatchObject({ id: "F1", status: "escalated" });

  // The owner accepts it as is, from the app.
  const noiseOf = async () => (await stateOf()).repos.map((r) => r.noise);
  const noise = await noiseOf();
  const [thread] = await host.threads(PR1);
  const before = host.posts.length;
  const accepted = await post(service, cookie, {
    type: "finding.accept",
    changeId: changeId("sasensi/lookover-sandbox#1"),
    findingId: "F1",
    reason: "Accepted deploy-window gap",
  });
  expect(accepted.status).toBe(200);
  await time.advance(1_000);

  const reply = host.posts.slice(before).find((p) => p.kind === "reply");
  expect(reply).toMatchObject({ commentId: thread?.commentId });
  expect(reply?.kind === "reply" && withoutWordmark(reply.body)).toStartWith(
    "Accepted by the owner\n\nAccepted deploy-window gap\n\nIt won't be raised again on this pull request.",
  );
  expect(statusOf(host.view(PR1).description)).toContain(" · 1 accepted");
  const last = host.posts.findLast((p) => p.kind === "check.completed");
  const result = last?.kind === "check.completed" ? readResult(last.output.text) : null;
  expect(result?.counts).toMatchObject({ accepted: 1, dismissed: 0 });
  expect(result?.findings[0]).toMatchObject({
    id: "F1",
    status: "accepted",
    needs_action_by: "none",
    resolution: { kind: "accepted", explanation: "Accepted deploy-window gap" },
  });
  // Accepting is no verdict on the reviewer: the repository's noise counts are as they were.
  expect(await noiseOf()).toEqual(noise);

  // The agent's next `wait` resolves the thread and ends.
  const done = await agent.wait();
  expect(done.exit).toBe(0);
  const threads = await host.asAgent(OWNER).threads(PR1, SHARED_APP.slug, OWNER.id);
  expect(threads.map((t) => [String(t.findingId), t.resolved])).toEqual([["F1", true]]);

  // A push that keeps the line, and a round that reports the same defect: it is never raised again.
  host.push(PR1, SHA1_PUSHED, pr1.diff);
  agent.local.head = SHA1_PUSHED;
  engines.answer(FOUND);
  const runs = engines.runs.length;
  const pushed = await agent.wait();
  // The finder ran, not given F1, and its candidate is F1 again: nothing to confirm, nothing raised.
  expect(engines.runs).toHaveLength(runs + 1);
  expect(engines.runs.at(-1)?.prompt).not.toContain("The total skips the last invoice");
  expect(pushed.exit).toBe(0);
  expect(pushed.json).toMatchObject({ commit: SHA1_PUSHED, findings: [] });
  const round = host.posts.findLast((p) => p.kind === "check.completed");
  const after = round?.kind === "check.completed" ? readResult(round.output.text) : null;
  expect(after?.findings.map((f) => [f.id, f.status])).toEqual([["F1", "accepted"]]);
});

test.each([
  [
    "accepted",
    "accepted",
    "Accepted",
    "accept F1 as is",
    "F1 accepted as is on the owner's word. Run lookover wait.",
    ["reply", "status.written", "check success", "rocket"],
  ],
  [
    "wrong",
    "dismissed",
    "Dismissed",
    "mark F1 as wrong",
    "F1 marked wrong on the owner's word. Run lookover wait.",
    // A finding marked wrong has its root comment hidden too (ADR 0052).
    ["reply", "status.written", "check success", "minimized", "rocket"],
  ],
] as const)(
  "#801: escalated, exit 4, the owner tells the agent; lookover settle F1 %s exits 0, then wait resolves the thread and exits 0",
  async (decision, status, opening, asked, done, posts) => {
    const { host, agent, f1, escalated } = await escalation();
    expect(escalated.exit).toBe(4);
    expect(escalated.err.at(-1)).toContain("lookover settle <finding> accepted|wrong --confirmed-by-owner");
    const [thread] = await host.threads(PR1);

    // The owner answered in the conversation; the agent settles on their word, its comment written as them.
    const before = host.posts.length;
    const settled = await agent.settle("F1", decision, "The deploy window covers the last invoice.");
    expect(settled).toEqual({
      exit: 0,
      err: [`Asked Lookover to ${asked}, on the owner's word (pull request #1).`, done],
    });
    // Lookover replies in the thread, rewrites the block and the check, then puts its 🚀 on the settle comment.
    expect(host.posts.slice(before).map(line)).toEqual([...posts]);
    const comments = host.view(PR1).comments.filter((c) => c.body.startsWith("/lookover settle"));
    expect(comments.map((c) => [c.author.id, c.reactions])).toEqual([
      [OWNER.id, { eyes: 0, rocket: 1, confused: 0 }],
    ]);
    const reply = host.posts.findLast((p) => p.kind === "reply");
    expect(reply).toMatchObject({ commentId: thread?.commentId });
    expect(reply?.kind === "reply" && withoutWordmark(reply.body)).toStartWith(
      `${opening} on the owner's word, through their coding agent\n\nThe deploy window covers the last invoice.\n\n`,
    );
    expect(await f1()).toMatchObject({ id: "F1", status, decidedVia: "agent" });

    // The agent's next `wait` resolves the thread and ends.
    const next = await agent.wait();
    expect(next.exit).toBe(0);
    const threads = await host.asAgent(OWNER).threads(PR1, SHARED_APP.slug, OWNER.id);
    expect(threads.map((t) => [String(t.findingId), t.resolved])).toEqual([["F1", true]]);
  },
);
