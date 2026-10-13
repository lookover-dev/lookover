import { describe, expect, test } from "bun:test";
import {
  type ChangeRef,
  commitSha,
  FINDING_MARKER,
  type HostChange,
  type RepositoryRef,
  SUMMARY_MARKER,
} from "@lookover/contracts";
import { describeHostIntake, FakeGitHost, type HostRefusal } from "./index.ts";

const repo: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
const owner = { login: "sasensi", id: 1234567 };
const bot = { id: 338297044, login: "lookover-spike-sasensi[bot]" };
const ref: ChangeRef = { repo, number: 1 };

const change: HostChange = {
  host: "github",
  number: 1,
  title: "Add unpaid filter and rewrite total",
  url: "https://github.com/sasensi/lookover-sandbox/pull/1",
  author: owner,
  draft: false,
  fork: false,
  head: { ref: "planted-bugs", sha: commitSha("5d9114c0a1b2c3d4e5f60718293a4b5c6d7e8f9a") },
  base: { ref: "main", sha: commitSha("0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3") },
};

/** A draft the suite opens. */
const wip: HostChange = {
  ...change,
  number: 2,
  title: "Work in progress",
  url: "https://github.com/sasensi/lookover-sandbox/pull/2",
  draft: true,
  fork: false,
  head: { ref: "wip", sha: commitSha("2222222222222222222222222222222222222222") },
};

/** A change from a fork: its head on a branch the fork's owner named, in the fork. */
const fromFork: HostChange = {
  ...change,
  number: 3,
  title: "Fix the total",
  url: "https://github.com/sasensi/lookover-sandbox/pull/3",
  author: { login: "mira", id: 7654321 },
  fork: true,
  head: { ref: "fix-total", sha: commitSha("3333333333333333333333333333333333333333") },
};

/** A change whose fork was deleted after it was opened. */
const fromDeletedFork: HostChange = {
  ...fromFork,
  number: 4,
  url: "https://github.com/sasensi/lookover-sandbox/pull/4",
  head: { ref: "gone", sha: commitSha("4444444444444444444444444444444444444444") },
};

/** The suite's repository names its default branch otherwise than `main`, so the fetch spec can't guess it. */
const DEFAULT_BRANCH = "trunk";

/** 2026-10-07 12:00:00 UTC, when the suite's host starts. */
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

/** A clock the test moves by hand. */
const heldClock = () => {
  let now = T0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

/** The change's one hunk: head lines 2 to 21 of `src/invoice.ts` take a comment. */
const DIFF = [{ path: "src/invoice.ts", side: "head" as const, from: 2, to: 21 }];
/** The line the suite's finding is on, which `outdate` replaces. */
const FINDING_LINE = { path: "src/invoice.ts", side: "head" as const, line: 12, endLine: null };

const host = (clock = heldClock()) =>
  new FakeGitHost({ repo, bot, clock, defaultBranch: DEFAULT_BRANCH, changes: [{ ...change, diff: DIFF }] });

/** Fresh commits, one per push. */
let pushed = 0;
const nextSha = () => commitSha((++pushed).toString(16).padStart(40, "c"));

const refusing = (failure: HostRefusal) => () => {
  const fake = host();
  fake.refuse(failure);
  return Promise.resolve({ intake: fake, repo, open: change });
};

describeHostIntake("FakeGitHost", {
  open: () => {
    const clock = heldClock();
    const fake = host(clock);
    // A second passes between two moves of the world, as it would on GitHub between two calls.
    const tick = <T>(value: T) => {
      clock.advance(1_000);
      return Promise.resolve(value);
    };
    return Promise.resolve({
      intake: fake,
      repo,
      open: change,
      defaultBranch: DEFAULT_BRANCH,
      owner,
      before: T0,
      comment: (body) => tick(fake.seedComment(ref, { author: owner, body })),
      edit: (id, body) => tick(fake.editComment(id, body)),
      later: () => tick(undefined),
      push: (commits, rewrite = false, messages) => {
        const sha = nextSha();
        fake.push(ref, sha, [], [], {
          commits,
          ...(messages ? { messages } : {}),
          ...(rewrite ? { onto: change.base.sha } : {}),
        });
        return tick(sha);
      },
      openDraft: () => {
        fake.open({ ...wip, diff: [] });
        return tick(wip);
      },
      markReady: (number) => tick(fake.markReady({ repo, number })),
      close: () => tick(fake.close(ref)),
      bot,
      postFinding: async (finding) => {
        const { head } = await fake.getChange(repo, 1);
        const body = `**Off by one** · Should fix\n\n${FINDING_MARKER}${JSON.stringify({ v: 1, id: finding })} -->`;
        const reviewId = await fake.publishReview(ref, {
          sha: head.sha,
          body: "",
          comments: [{ ...FINDING_LINE, body }],
        });
        const root = fake.view(ref).reviews.find((r) => r.id === reviewId)?.comments[0]?.id;
        return tick(Number(root));
      },
      commentInline: (body) => tick(fake.seedInline(ref, owner, { ...FINDING_LINE, line: 14, body })),
      reply: (commentId, body) => tick(fake.seedReply(ref, commentId, { author: owner, body })),
      outdate: () =>
        tick(fake.push(ref, nextSha(), DIFF, [{ path: FINDING_LINE.path, line: 12, removed: 1, added: 1 }])),
    });
  },
  refusing: {
    unauthorized: refusing("unauthorized"),
    rate_limited: refusing("rate_limited"),
    unavailable: refusing("unavailable"),
  },
  notInstalled: () =>
    Promise.resolve({
      intake: new FakeGitHost({ repo, bot, changes: [{ ...change, diff: [] }], installed: false }),
      repo,
      open: change,
    }),
  forks: () => {
    const fake = host();
    // To the fake a deleted fork is what GitHub makes of it: a change from a fork still.
    fake.open({ ...fromFork, diff: [] });
    fake.open({ ...fromDeletedFork, diff: [] });
    return Promise.resolve({ intake: fake, repo, fork: fromFork, deletedFork: fromDeletedFork });
  },
});

describe("FakeGitHost intake on its own", () => {
  test("a repository it does not hold is not found, as GitHub answers 404", async () => {
    await expect(host().listOpenChanges({ owner: "someone", name: "else" })).rejects.toMatchObject({
      failure: "not_found",
    });
  });

  test("its fetch spec can point at a local bare repository, so retrieval runs real git on it", async () => {
    const local = new FakeGitHost({ repo, bot, changes: [], cloneUrl: "C:/lookover/sandbox.git" });

    const spec = await local.fetchSpec(repo);

    expect(spec.cloneUrl).toBe("C:/lookover/sandbox.git");
  });

  test("its fetch spec names `main` as the default branch unless told another", async () => {
    expect((await new FakeGitHost({ repo, bot, changes: [] }).fetchSpec(repo)).defaultBranch).toBe("main");
  });

  test("its fetch spec reads the repository as GitHub's does: refused, it is refused itself", async () => {
    const fake = host();
    fake.refuse("unavailable");
    await expect(fake.fetchSpec(repo)).rejects.toMatchObject({ failure: "unavailable" });
  });

  test("a refusal holds for the writer too, and posts nothing; lifted, the host answers again", async () => {
    const fake = host();
    fake.refuse("rate_limited");
    const output = { title: "Reviewing", summary: "Round 1 in progress.", text: "" };
    await expect(fake.createCheck(repo, change.head.sha, "queued", output, "job-1")).rejects.toMatchObject({
      failure: "rate_limited",
    });
    expect(fake.posts).toEqual([]);
    fake.refuse(null);
    expect(await fake.getChange(repo, 1)).toEqual(change);
  });

  test("rate-limited until a time, every call says when it may be asked again", async () => {
    const fake = host();
    fake.refuse("rate_limited", { retryAt: T0 + 60_000 });
    const waits = { failure: "rate_limited", retryAt: T0 + 60_000 };
    await expect(fake.listComments(repo, T0)).rejects.toMatchObject(waits);
    await expect(fake.react(repo, "1", "eyes")).rejects.toMatchObject(waits);
    fake.refuse("unavailable");
    await expect(fake.listOpenChanges(repo)).rejects.toMatchObject({
      failure: "unavailable",
      retryAt: undefined,
    });
  });

  test("not installed, every listing and post is refused as not found, the App uninstalled, as GitHub finds no installation; installed, it answers", async () => {
    const fake = new FakeGitHost({ repo, bot, changes: [{ ...change, diff: [] }], installed: false });
    const uninstalled = { failure: "not_found", connectionCause: { kind: "uninstalled", suspended: false } };
    await expect(fake.listOpenChanges(repo)).rejects.toMatchObject(uninstalled);
    await expect(fake.listComments(repo, T0)).rejects.toMatchObject(uninstalled);
    await expect(fake.getChange(repo, 1)).rejects.toMatchObject(uninstalled);
    await expect(fake.fetchSpec(repo)).rejects.toMatchObject(uninstalled);
    const output = { title: "Reviewing", summary: "Round 1 in progress.", text: "" };
    await expect(fake.createCheck(repo, change.head.sha, "queued", output, "job-1")).rejects.toMatchObject(
      uninstalled,
    );
    expect(fake.posts).toEqual([]);
    // The agent's own token is not the App's: it reads and writes meanwhile.
    const agent = fake.asAgent({ id: 4242, login: "coding-agent" });
    expect(await agent.getChange(ref)).toEqual({ number: 1, head: change.head.sha, fork: false });
    expect(await agent.comment(ref, "/lookover review")).toBe("1");

    fake.install();

    expect((await fake.listOpenChanges(repo)).items).toEqual([change]);
    expect(await fake.getChange(repo, 1)).toEqual(change);
  });

  test("it holds several repositories, each with its own changes by number, comments and listings", async () => {
    const ledger: RepositoryRef = { owner: "sasensi", name: "ledger-api" };
    const inLedger: HostChange = {
      ...change,
      title: "Ledger's first",
      url: "https://github.com/sasensi/ledger-api/pull/1",
    };
    const fake = new FakeGitHost({
      repo,
      repositories: [ledger],
      bot,
      changes: [
        { ...change, diff: [] },
        { ...inLedger, repo: ledger, diff: [] },
      ],
    });
    await fake.listOpenChanges(repo);
    fake.seedComment({ repo: ledger, number: 1 }, { author: owner, body: "/lookover review" });

    expect(await fake.getChange(ledger, 1)).toEqual(inLedger);
    expect(await fake.getChange(repo, 1)).toEqual(change);
    expect((await fake.listOpenChanges(ledger)).items).toEqual([inLedger]);
    expect((await fake.listComments(ledger, 0)).items.map((c) => c.body)).toEqual(["/lookover review"]);
    expect((await fake.listComments(repo, 0)).items).toEqual([]);
    // A comment in one repository leaves the other's listing as it was.
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(true);
    expect(() => fake.open({ ...inLedger, repo: ledger, diff: [] })).toThrow("already holds pull request 1");
  });

  test("a change it already holds can't be opened again", () => {
    expect(() => host().open({ ...change, diff: [] })).toThrow("already holds pull request 1");
  });

  test("a reaction changes the comments' listing, as GitHub lists each comment with its reactions' counts", async () => {
    const fake = host();
    const id = fake.seedComment(ref, { author: owner, body: "/lookover review" });
    await fake.listComments(repo, T0);
    await fake.react(repo, id, "eyes");
    expect((await fake.listComments(repo, T0)).unchanged).toBe(false);
    expect((await fake.listComments(repo, T0)).unchanged).toBe(true);
  });

  test("the open changes' listing changes with a comment or a review, as a pull request's last update does on GitHub", async () => {
    const fake = host();
    await fake.listOpenChanges(repo);
    fake.seedComment(ref, { author: owner, body: "A comment." });
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(false);
    await fake.publishReview(ref, { sha: change.head.sha, body: "No finding.", comments: [] });
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(false);
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(true);
  });

  test("comments are stamped to the second by the injected clock, and the bot's summary is listed too", async () => {
    const clock = heldClock();
    const fake = host(clock);
    clock.advance(1_500);
    const id = fake.seedComment(ref, { author: owner, body: "/lookover review" });
    clock.advance(1_000);
    const summary = await fake.upsertSummary(ref, `${SUMMARY_MARKER}\nRound 1.`);

    const { items } = await fake.listComments(repo, T0);

    expect(items).toEqual([
      {
        id: summary,
        nodeId: `IC_${summary}`,
        change: 1,
        author: bot,
        body: `${SUMMARY_MARKER}\nRound 1.`,
        createdAt: T0 + 2_000,
        updatedAt: T0 + 2_000,
      },
      {
        id,
        nodeId: `IC_${id}`,
        change: 1,
        author: owner,
        body: "/lookover review",
        createdAt: T0 + 1_000,
        updatedAt: T0 + 1_000,
      },
    ]);
  });

  test("commits pushed on top of a pushed head count from any earlier head; a commit it never saw is not found", async () => {
    const fake = host();
    const second = commitSha("2222222222222222222222222222222222222222");
    const third = commitSha("3333333333333333333333333333333333333333");
    fake.push(ref, second, [], [], { commits: 2, messages: ["one", "two"] });
    const fifth = "five\n\nCo-authored-by: Claude <noreply@anthropic.com>";
    fake.push(ref, third, [], [], { commits: 3, messages: ["three", "four", fifth] });
    expect(await fake.countCommits(repo, change.head.sha, third)).toEqual({
      commits: 5,
      diverged: false,
      messages: ["one", "two", "three", "four", fifth],
    });
    expect(await fake.countCommits(repo, second, third)).toMatchObject({
      messages: ["three", "four", fifth],
    });
    expect(await fake.countCommits(repo, third, change.head.sha)).toEqual({
      commits: 0,
      diverged: true,
      messages: [],
    });
    await expect(
      fake.countCommits(repo, change.head.sha, commitSha("4444444444444444444444444444444444444444")),
    ).rejects.toMatchObject({ failure: "not_found" });
  });

  test("a change held with its commits' messages counts them from its base, as GitHub's compare does", async () => {
    const signed = "Fix the total\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
    const fake = new FakeGitHost({
      repo,
      bot,
      changes: [{ ...change, diff: [], messages: ["Start the filter", signed] }],
    });
    fake.open({ ...wip, diff: [], messages: ["One more"] });
    expect(await fake.countCommits(repo, change.base.sha, change.head.sha)).toEqual({
      commits: 2,
      diverged: false,
      messages: ["Start the filter", signed],
    });
    expect((await fake.countCommits(repo, wip.base.sha, wip.head.sha)).messages).toEqual(["One more"]);
    // Shown as GitHub shows a pull request: its commits aren't part of it.
    expect(await fake.getChange(repo, 1)).toEqual(change);
  });
});
