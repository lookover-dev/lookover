import { describe, expect, test } from "bun:test";
import {
  type ChangeRef,
  commitSha,
  FINDING_MARKER,
  type HostChange,
  type RepositoryRef,
} from "@lookover/contracts";
import { describeHostIntake, FakeGitHost, type HostRefusal } from "./index.ts";
import { AT_ONCE, LAG, LAGGING_PATIENCE, laggingGitHost } from "./lagging-git-host.test-support.ts";

const repo: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
/** Someone else on the repository, who opens the changes and comments: not the person. */
const teammate = { login: "teammate", id: 1234567 };
const bot = { id: 338297045, login: "lookover-dev[bot]" };
const ref: ChangeRef = { repo, number: 1 };

const change: HostChange = {
  host: "github",
  number: 1,
  title: "Add unpaid filter and rewrite total",
  url: "https://github.com/sasensi/lookover-sandbox/pull/1",
  author: teammate,
  draft: false,
  fork: false,
  // 2026-10-07 12:00:00 UTC: opened as the suite's host starts, by its clock (`T0`).
  openedAt: Date.UTC(2026, 9, 7, 12, 0, 0),
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

/** The person signed in to the shared App, who posts (ADR 0066) and owns the repository. */
const person = { id: 11247504, login: "sasensi" };

const host = (clock = heldClock()) =>
  new FakeGitHost({
    repo,
    bot,
    person,
    clock,
    defaultBranch: DEFAULT_BRANCH,
    changes: [{ ...change, diff: DIFF }],
  });

/** Fresh commits, one per push. */
let pushed = 0;
const nextSha = () => commitSha((++pushed).toString(16).padStart(40, "c"));

const refusing = (failure: HostRefusal) => () => {
  const fake = host();
  fake.refuse(failure);
  return Promise.resolve({ intake: fake, repo, open: change });
};

// GitHub as it would be if it showed a write at once, then lagging as it does (ADR 0069): the App's reads made before a
// write answer stale for a few reads after it.
for (const [lag, patience] of [
  [0, AT_ONCE],
  [LAG, LAGGING_PATIENCE],
] as const)
  describeHostIntake(
    lag === 0 ? "FakeGitHost" : "FakeGitHost, lagging as GitHub does after a write (ADR 0069)",
    {
      open: () => {
        const clock = heldClock();
        const fake = laggingGitHost(host(clock), lag).port;
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
          owner: teammate,
          before: T0,
          comment: (body) => tick(fake.seedComment(ref, { author: teammate, body })),
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
            // Opened with no time given: now, by the host's clock.
            const { openedAt: _, ...untimed } = wip;
            fake.open({ ...untimed, diff: [] });
            return tick({ ...wip, openedAt: clock.now() });
          },
          markReady: (number) => tick(fake.markReady({ repo, number })),
          close: () => tick(fake.close(ref)),
          poster: person,
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
          commentInline: (body) => tick(fake.seedInline(ref, teammate, { ...FINDING_LINE, line: 14, body })),
          reply: (commentId, body) => tick(fake.seedReply(ref, commentId, { author: teammate, body })),
          outdate: () =>
            tick(
              fake.push(ref, nextSha(), DIFF, [{ path: FINDING_LINE.path, line: 12, removed: 1, added: 1 }]),
            ),
        });
      },
      patience,
      refusing: {
        unauthorized: refusing("unauthorized"),
        rate_limited: refusing("rate_limited"),
        unavailable: refusing("unavailable"),
      },
      notInstalled: () =>
        Promise.resolve({
          intake: new FakeGitHost({
            repo,
            bot,
            person,
            changes: [{ ...change, diff: [] }],
            installed: false,
          }),
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
    },
  );

describe("FakeGitHost intake on its own", () => {
  test("a change opened with no time is opened by the host's clock, to the second; one given its time keeps it", async () => {
    const clock = heldClock();
    clock.advance(2_750);
    const fake = new FakeGitHost({ repo, bot, person, clock, changes: [] });
    const { openedAt: _, ...untimed } = change;
    fake.open({ ...untimed, diff: [] });
    // Weeks before the host's clock: 2026-09-16 08:30:05 UTC.
    fake.open({ ...wip, openedAt: Date.UTC(2026, 8, 16, 8, 30, 5), diff: [] });
    clock.advance(60_000);
    fake.close(ref);
    fake.reopen(ref);

    const { items } = await fake.listOpenChanges(repo);
    expect(items.map((c) => [c.number, c.openedAt])).toEqual([
      [1, Date.UTC(2026, 9, 7, 12, 0, 2)],
      [2, Date.UTC(2026, 8, 16, 8, 30, 5)],
    ]);
  });

  test("a repository it does not hold is not found, as GitHub answers 404", async () => {
    await expect(host().listOpenChanges({ owner: "someone", name: "else" })).rejects.toMatchObject({
      failure: "not_found",
    });
  });

  test("its fetch spec can point at a local bare repository, so retrieval runs real git on it", async () => {
    const local = new FakeGitHost({ repo, bot, person, changes: [], cloneUrl: "C:/lookover/sandbox.git" });

    const spec = await local.fetchSpec(repo);

    expect(spec.cloneUrl).toBe("C:/lookover/sandbox.git");
  });

  test("its fetch spec names `main` as the default branch unless told another", async () => {
    expect((await new FakeGitHost({ repo, bot, person, changes: [] }).fetchSpec(repo)).defaultBranch).toBe(
      "main",
    );
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

  test("slow to read a new repository, a first listing refused still counts as GitHub's first: the next one is not held", async () => {
    const fake = host();
    const first = fake.holdFirstPolls();
    fake.refuse("unavailable");
    const refused = fake.listOpenChanges(repo);
    first();
    await expect(refused).rejects.toMatchObject({ failure: "unavailable" });
    fake.holdFirstPolls();
    fake.refuse(null);
    const again = await Promise.race([
      fake.listOpenChanges(repo).then((l) => l.items.map((c) => c.number)),
      Bun.sleep(100).then(() => "held"),
    ]);
    expect(again).toEqual([1]);
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
    const fake = new FakeGitHost({ repo, bot, person, changes: [{ ...change, diff: [] }], installed: false });
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
      person,
      changes: [
        { ...change, diff: [] },
        { ...inLedger, repo: ledger, diff: [] },
      ],
    });
    await fake.listOpenChanges(repo);
    fake.seedComment({ repo: ledger, number: 1 }, { author: teammate, body: "/lookover review" });

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
    const id = fake.seedComment(ref, { author: teammate, body: "/lookover review" });
    await fake.listComments(repo, T0);
    await fake.react(repo, id, "eyes");
    expect((await fake.listComments(repo, T0)).unchanged).toBe(false);
    expect((await fake.listComments(repo, T0)).unchanged).toBe(true);
  });

  test("the open changes' listing changes with a comment or a review, as a pull request's last update does on GitHub", async () => {
    const fake = host();
    await fake.listOpenChanges(repo);
    fake.seedComment(ref, { author: teammate, body: "A comment." });
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(false);
    await fake.publishReview(ref, { sha: change.head.sha, body: "No finding.", comments: [] });
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(false);
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(true);
  });

  test("comments are stamped to the second by the injected clock, and the person's are listed too", async () => {
    const clock = heldClock();
    const fake = host(clock);
    clock.advance(1_500);
    const id = fake.seedComment(ref, { author: teammate, body: "/lookover review" });
    clock.advance(1_000);
    const theirs = fake.seedComment(ref, { author: person, body: "Pushed a fix." });

    const { items } = await fake.listComments(repo, T0);

    expect(items).toEqual([
      {
        id: theirs,
        nodeId: `IC_${theirs}`,
        change: 1,
        author: person,
        body: "Pushed a fix.",
        createdAt: T0 + 2_000,
        updatedAt: T0 + 2_000,
      },
      {
        id,
        nodeId: `IC_${id}`,
        change: 1,
        author: teammate,
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
      mergeBase: change.head.sha,
    });
    expect(await fake.countCommits(repo, second, third)).toMatchObject({
      messages: ["three", "four", fifth],
      mergeBase: second,
    });
    expect(await fake.countCommits(repo, third, change.head.sha)).toEqual({
      commits: 0,
      diverged: true,
      messages: [],
      mergeBase: change.head.sha,
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
      person,
      changes: [{ ...change, diff: [], messages: ["Start the filter", signed] }],
    });
    fake.open({ ...wip, diff: [], messages: ["One more"] });
    expect(await fake.countCommits(repo, change.base.sha, change.head.sha)).toEqual({
      commits: 2,
      diverged: false,
      messages: ["Start the filter", signed],
      mergeBase: change.base.sha,
    });
    expect((await fake.countCommits(repo, wip.base.sha, wip.head.sha)).messages).toEqual(["One more"]);
    // Shown as GitHub shows a pull request: its commits aren't part of it.
    expect(await fake.getChange(repo, 1)).toEqual(change);
  });

  test("a change held without its commits' messages sits on its base all the same: its merge base is the base", async () => {
    // As the real-retrieval tests hold the sandbox's commits: the head's parent is the base.
    expect(await host().countCommits(repo, change.base.sha, change.head.sha)).toEqual({
      commits: 0,
      diverged: false,
      messages: [],
      mergeBase: change.base.sha,
    });
  });

  test("the merge base is the nearest commit both hold: a head pushed again onto the base meets the old one there", async () => {
    const fake = host();
    const first = nextSha();
    fake.push(ref, first, [], [], { commits: 2 });
    const rewritten = nextSha();
    fake.push(ref, rewritten, [], [], { onto: change.base.sha });
    // `first` sits on the change's head, which sits on the base; `rewritten` on the base itself.
    expect((await fake.countCommits(repo, first, rewritten)).mergeBase).toBe(change.base.sha);
    expect((await fake.countCommits(repo, rewritten, first)).mergeBase).toBe(change.base.sha);
    expect((await fake.countCommits(repo, first, first)).mergeBase).toBe(first);
  });

  test("two commits with no common history are not found, as GitHub's compare answers 404", async () => {
    const fake = host();
    const orphan = commitSha("6666666666666666666666666666666666666666");
    fake.open({
      ...wip,
      number: 5,
      base: { ref: "orphan", sha: commitSha("7777777777777777777777777777777777777777") },
      head: { ref: "orphan-work", sha: orphan },
      diff: [],
    });
    await expect(fake.countCommits(repo, change.head.sha, orphan)).rejects.toMatchObject({
      failure: "not_found",
    });
    await expect(fake.countCommits(repo, orphan, change.base.sha)).rejects.toMatchObject({
      failure: "not_found",
    });
  });
});
