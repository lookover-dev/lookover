import { describe, expect, test } from "bun:test";
import {
  type AgentHost,
  type ChangeRef,
  commitSha,
  FINDING_MARKER,
  type RepositoryRef,
} from "@lookover/contracts";
import {
  type AgentHostFixture,
  describeAgentHost,
  type FakeChange,
  FakeGitHost,
  type HostRefusal,
  lagging,
  readUntil,
} from "./index.ts";
import { AT_ONCE, LAG, LAGGING_PATIENCE } from "./lagging-git-host.test-support.ts";

const repo: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
const head = commitSha("5d9114c0a1b2c3d4e5f60718293a4b5c6d7e8f9a");
const bot = { id: 338297044, login: "lookover-spike-sasensi[bot]" };
const owner = { id: 1234567, login: "sasensi" };
const ref: ChangeRef = { repo, number: 7 };

const change: FakeChange = {
  number: 7,
  title: "Add unpaid filter",
  url: "https://github.com/sasensi/lookover-sandbox/pull/7",
  author: owner,
  draft: false,
  head: { ref: "feature/unpaid", sha: head },
  base: { ref: "main", sha: commitSha("0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3") },
  diff: [{ path: "src/invoice.ts", side: "head", from: 2, to: 21 }],
};

const host = () => new FakeGitHost({ repo, bot, changes: [change] });
/** The person signed in to the App, on the fake's person mode (ADR 0066): someone other than the agent's account. */
const person = { id: 11247504, login: "signed-in" };

let pushes = 0;
/** A commit no other push of this file made. */
const nextSha = () => commitSha((++pushes).toString(16).padStart(40, "c"));

/** The line the suite's finding is on, which `outdate` replaces; another line of the diff for the account's. */
const FINDING_LINE = { path: "src/invoice.ts", side: "head" as const, line: 12, endLine: null };
const OTHER_LINE = { ...FINDING_LINE, line: 14 };

const findingBody = (id: string) =>
  `**Off by one** · Should fix\n\n${FINDING_MARKER}${JSON.stringify({ v: 1, id })} -->`;

/** The App posts a review with one finding on `FINDING_LINE`. Returns the inline comment's id. */
async function postFinding(fake: FakeGitHost, id: string): Promise<number> {
  const reviewId = await fake.publishReview(ref, {
    sha: (await fake.getChange(repo, ref.number)).head.sha,
    body: "",
    comments: [{ ...FINDING_LINE, body: findingBody(id) }],
  });
  const root = fake.view(ref).reviews.find((r) => r.id === reviewId)?.comments[0]?.id;
  if (root === undefined) throw new Error("The finding just posted is not shown");
  return Number(root);
}

/** Each of the agent's calls, read or write: a call the port gains must be sorted here, or this fails to compile. */
const AGENT_CALLS = {
  account: "read",
  changeOf: "read",
  getChange: "read",
  checks: "read",
  comments: "read",
  comment: "write",
  threads: "read",
  reply: "write",
  resolve: "write",
} as const satisfies Record<keyof AgentHost, "read" | "write">;
/** The agent's reads: what a lagging host answers stale after a write. */
const isCall = (key: string): key is keyof AgentHost => key in AGENT_CALLS;
const AGENT_READS = Object.keys(AGENT_CALLS)
  .filter(isCall)
  .filter((call) => AGENT_CALLS[call] === "read");

/**
 * A fresh change on a fresh fake; with `lag`, the agent's reads made before a write answer stale for that many reads
 * after it, as GitHub's do (ADR 0069).
 */
const fixture =
  (signedIn?: typeof person, lag = 0) =>
  async (): Promise<AgentHostFixture> => {
    const fake = new FakeGitHost({ repo, bot, changes: [change], ...(signedIn ? { person: signedIn } : {}) });
    const agent = lagging(fake.asAgent(owner), AGENT_READS, lag);
    /** A write through the fixture: the agent's reads lag behind it. */
    const wrote = <T>(written: T | Promise<T>): Promise<T> =>
      Promise.resolve(written).then((value) => {
        agent.wrote();
        return value;
      });
    return {
      ...(signedIn ? { person: signedIn } : {}),
      host: agent.port,
      change: ref,
      branch: "feature/unpaid",
      head,
      app: "lookover-spike-sasensi",
      botId: bot.id,
      account: owner,
      check: (sha, status, output, externalId) =>
        wrote(fake.createCheck(repo, sha, status, output, externalId)),
      complete: (id, conclusion, output) => wrote(fake.completeCheck(repo, id, conclusion, output)),
      react: (id, reaction) => wrote(fake.react(repo, id, reaction)),
      push: () => {
        const sha = nextSha();
        fake.push(ref, sha, change.diff);
        return wrote(sha);
      },
      foreignCheck: async (sha) => {
        await wrote(fake.foreignCheck(sha, "someone-elses-app"));
      },
      postFinding: (id) => wrote(postFinding(fake, id)),
      appReply: (commentId, body) => wrote(fake.reply(ref, commentId, body).then(Number)),
      commentInline: (body) => wrote(fake.seedInline(ref, owner, { ...OTHER_LINE, body })),
      outdate: () =>
        wrote(
          fake.push(ref, nextSha(), change.diff, [
            { path: FINDING_LINE.path, line: 12, removed: 1, added: 1 },
          ]),
        ),
      unresolving: () => fake.asAgent(owner, { mayResolve: false }),
    };
  };

const refusing = (failure: HostRefusal) => () => {
  const fake = host();
  fake.refuse(failure);
  return Promise.resolve({ host: fake.asAgent(owner), change: ref, branch: "feature/unpaid", head });
};

for (const [name, signedIn, lag, patience] of [
  ["FakeGitHost", undefined, 0, AT_ONCE],
  ["FakeGitHost posting as a person", person, 0, AT_ONCE],
  ["FakeGitHost lagging as GitHub does after a write (ADR 0069)", undefined, LAG, LAGGING_PATIENCE],
  ["FakeGitHost posting as a person, lagging", person, LAG, LAGGING_PATIENCE],
] as const)
  describeAgentHost(name, {
    open: fixture(signedIn, lag),
    patience,
    refusing: {
      unauthorized: refusing("unauthorized"),
      rate_limited: refusing("rate_limited"),
      unavailable: refusing("unavailable"),
    },
  });

describe("FakeGitHost's agent side on its own", () => {
  test("the agent's comment is seen by the App's side, written by the agent's account", async () => {
    const fake = host();
    const id = await fake.asAgent(owner).comment(ref, "/lookover review");
    const listed = await fake.listComments(repo, 0);
    expect(listed.items.map((c) => [c.id, c.author, c.body])).toEqual([[id, owner, "/lookover review"]]);
  });

  test("a closed change is no branch's open change, and still read by its number", async () => {
    const fake = host();
    fake.close(ref);
    expect(await fake.asAgent(owner).changeOf(repo, "feature/unpaid")).toBeNull();
    expect(await fake.asAgent(owner).getChange(ref)).toEqual({ number: 7, head, fork: false });
  });

  test("a thread another App's bot rooted is none of Lookover's, whatever its marker", async () => {
    const fake = host();
    const other = { id: 41898282, login: "github-actions[bot]" };
    fake.seedInline(ref, other, { ...FINDING_LINE, body: findingBody("F1") });
    expect(await fake.asAgent(owner).threads(ref, "lookover-spike-sasensi")).toEqual([]);
    expect(await fake.asAgent(owner).threads(ref, "github-actions")).toHaveLength(1);
  });

  test("the App's side reads a thread the agent resolved and replied in, without its thread id", async () => {
    const fake = host();
    const root = await postFinding(fake, "F1");
    const agent = fake.asAgent(owner);
    const reply = await agent.reply(ref, root, "Fixed.");
    const [thread] = await agent.threads(ref, "lookover-spike-sasensi");
    if (!thread) throw new Error("The finding's thread is not read");
    await agent.resolve(thread.threadId);
    const { threadId: _, resolved: __, ...shown } = thread;
    expect(await fake.threads(ref)).toEqual([shown]);
    expect(shown.replies.map((r) => [r.commentId, r.author, r.body])).toEqual([
      [reply, { ...owner, bot: false }, "Fixed."],
    ]);
  });

  test("a thread id of another kind of node is not found", async () => {
    const fake = host();
    const root = await postFinding(fake, "F1");
    await expect(fake.asAgent(owner).resolve(`PRRC_${root}`)).rejects.toMatchObject({
      failure: "not_found",
    });
  });

  test("lagging, a read made before a write answers as before for its lag, and readUntil at bound 0 returns that stale read", async () => {
    const fake = host();
    const lag = lagging(fake.asAgent(owner), ["checks", "comments"], 2);
    const app = "lookover-spike-sasensi";
    const output = { title: "Waiting for its turn", summary: "Queued.", text: "" };
    expect(await lag.port.checks(repo, head, app)).toEqual([]);
    const id = await fake.createCheck(repo, head, "queued", output, "job-1");
    lag.wrote();

    const once = await readUntil(
      () => lag.port.checks(repo, head, app),
      (checks) => checks.length === 1,
      "the new check",
      { boundMs: 0 },
    );
    expect(once).toEqual([]);
    expect(await lag.port.checks(repo, head, app)).toEqual([]);
    expect((await lag.port.checks(repo, head, app)).map((c) => c.id)).toEqual([id]);
  });

  test("lagging, readUntil with a bound waits the lag out; a read never made before, and the port's own writes", async () => {
    const fake = host();
    const lag = lagging(fake.asAgent(owner), ["checks", "comments"], 3);
    const app = "lookover-spike-sasensi";
    expect(await lag.port.comments(ref)).toEqual([]);
    // A write through the port itself counts, as the fixture's do.
    const id = await lag.port.comment(ref, "Pushed the fix.");
    expect(await lag.port.comments(ref)).toEqual([]);
    const shown = await readUntil(
      () => lag.port.comments(ref),
      (comments) => comments.length === 1,
      "the comment",
      { boundMs: 1_000, pauseMs: 1, log: () => {} },
    );
    expect(shown.map((c) => c.id)).toEqual([id]);
    // Never read before the write: it passes through.
    expect(await lag.port.checks(repo, head, app)).toEqual([]);
  });

  test("another App's check shows in the App's own view, as GitHub shows every check of the name", () => {
    const fake = host();
    fake.foreignCheck(head, "someone-elses-app");
    expect(fake.view(ref).checks.map((c) => c.name)).toEqual(["Lookover"]);
  });
});
