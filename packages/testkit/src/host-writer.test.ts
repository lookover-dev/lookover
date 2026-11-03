import { describe, expect, test } from "bun:test";
import {
  type ChangeRef,
  commitSha,
  REVIEW_MARKER,
  type RepositoryRef,
  type ReviewPost,
  STATUS_END_MARKER,
  STATUS_MARKER,
} from "@lookover/contracts";
import {
  describeHostWriter,
  type FakeChange,
  FakeGitHost,
  type HostRefusal,
  type HostWriterFixture,
} from "./index.ts";
import { AT_ONCE, LAG, LAGGING_PATIENCE, laggingGitHost } from "./lagging-git-host.test-support.ts";

const repo: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
const sha = commitSha("5d9114c0a1b2c3d4e5f60718293a4b5c6d7e8f9a");
const bot = { id: 338297045, login: "lookover-dev[bot]" };
/** The person signed in to the shared App, who posts (ADR 0066) and owns the repository. */
const person = { id: 11247504, login: "sasensi" };
/** Someone else on the pull request. */
const teammate = { id: 1234567, login: "teammate" };

/** Sandbox pull request 1 as the fake holds it: one hunk, `+2,20`, on `src/invoice.ts`, which removed base line 8. */
const change: FakeChange = {
  number: 1,
  title: "Add unpaid filter and rewrite total",
  url: "https://github.com/sasensi/lookover-sandbox/pull/1",
  author: teammate,
  draft: false,
  head: { ref: "planted-bugs", sha },
  base: { ref: "main", sha: commitSha("0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3") },
  diff: [
    { path: "src/invoice.ts", side: "head", from: 2, to: 21 },
    { path: "src/invoice.ts", side: "base", from: 8, to: 8 },
  ],
};
const ref: ChangeRef = { repo, number: 1 };

const host = () => new FakeGitHost({ repo, bot, person, changes: [change] });

/**
 * A fresh fake and the suite's fixture on it, refusing every call for `failure` when one is given; with `lag`, the App's
 * reads made before a write answer stale for that many reads after it, as GitHub's do (ADR 0069).
 */
const fixture =
  (failure?: HostRefusal, lag = 0) =>
  async (): Promise<HostWriterFixture> => {
    const fake = new FakeGitHost({ repo, bot, person, changes: [change] });
    if (failure) fake.refuse(failure);
    const host = laggingGitHost(fake, lag).port;
    return {
      writer: host,
      change: ref,
      sha,
      inDiff: { path: "src/invoice.ts", side: "head", line: 12 },
      offDiff: { path: "src/invoice.ts", side: "head", line: 1 },
      removed: { path: "src/invoice.ts", side: "base", line: 8 },
      range: { path: "src/invoice.ts", side: "head", line: 12, endLine: 14 },
      poster: person,
      comment: (body) => Promise.resolve(host.seedComment(ref, { author: teammate, body })),
      editDescription: (body) => Promise.resolve(host.editDescription(ref, body)),
      observe: () => Promise.resolve(host.view(ref)),
      intake: host,
    };
  };

for (const [lag, patience] of [
  [0, AT_ONCE],
  [LAG, LAGGING_PATIENCE],
] as const)
  describeHostWriter(
    lag === 0 ? "FakeGitHost" : "FakeGitHost, lagging as GitHub does after a write (ADR 0069)",
    {
      open: fixture(undefined, lag),
      patience,
      refusing: {
        unauthorized: fixture("unauthorized", lag),
        rate_limited: fixture("rate_limited", lag),
        unavailable: fixture("unavailable", lag),
      },
    },
  );

describe("FakeGitHost writer on its own", () => {
  test("records every post in the order it was asked", async () => {
    const fake = host();
    const output = { title: "Reviewing", summary: "Round 1 in progress.", text: "" };
    const checkId = await fake.createCheck(repo, sha, "in_progress", output, "job-1");
    await fake.publishReview(ref, {
      sha,
      body: "1 finding.",
      comments: [{ path: "src/invoice.ts", side: "head", line: 12, endLine: null, body: "Off by one." }],
    });
    await fake.upsertStatus(ref, () => "One thing to fix");
    await fake.completeCheck(repo, checkId, "neutral", { ...output, title: "1 finding" });
    expect(fake.posts.map((p) => p.kind)).toEqual([
      "check.created",
      "review",
      "status.written",
      "check.completed",
    ]);
  });

  test("a change opens with its author's description, and each status write is a post", async () => {
    const fake = new FakeGitHost({ repo, bot, person, changes: [{ ...change, description: "Fixes it." }] });
    await fake.upsertStatus(ref, () => "Round 1");
    await fake.upsertStatus(ref, () => "Round 1");
    await fake.upsertStatus(ref, () => "One thing to fix");
    const block = (text: string) => `Fixes it.\n\n---\n\n${STATUS_MARKER}\n${text}\n${STATUS_END_MARKER}`;
    // The same block again leaves the description as it is: nothing written.
    expect(fake.posts).toEqual([
      { kind: "status.written", number: 1, description: block("Round 1") },
      { kind: "status.written", number: 1, description: block("One thing to fix") },
    ]);
    expect(fake.view(ref).description).toBe(block("One thing to fix"));
  });

  test("the author's edit moves the open changes' listing, as it moves a pull request's last update", async () => {
    const fake = host();
    await fake.listOpenChanges(repo);
    fake.editDescription(ref, "Edited.");
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(false);
    await fake.upsertStatus(ref, () => "Round 1");
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(false);
    expect((await fake.listOpenChanges(repo)).unchanged).toBe(true);
  });

  test("a description the person may not edit is refused as invalid, never as signed out, and nothing is written", async () => {
    const fake = host();
    fake.forbidDescription(ref);
    await expect(fake.upsertStatus(ref, () => "Round 1")).rejects.toMatchObject({ failure: "invalid" });
    expect(fake.posts).toEqual([]);
    expect(fake.view(ref).description).toBe("");
  });

  test("the status write refused once: the next one answers", async () => {
    const fake = host();
    fake.refuseNext("unavailable", { post: "status" });
    await fake.publishReview(ref, oneFinding);
    await expect(fake.upsertStatus(ref, () => "Round 1")).rejects.toMatchObject({ failure: "unavailable" });
    await fake.upsertStatus(ref, () => "Round 1");
    expect(fake.posts.map((p) => p.kind)).toEqual(["review", "status.written"]);
  });

  test("a push moves earlier comments with their text; one on a replaced line reads null, its original line kept", async () => {
    const fake = host();
    const comment = (line: number) => ({
      path: "src/invoice.ts",
      side: "head" as const,
      line,
      endLine: null,
      body: `On ${line}.`,
    });
    await fake.publishReview(ref, {
      sha,
      body: "3 findings.",
      comments: [comment(5), comment(12), comment(18)],
    });
    const next = commitSha("c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2");
    // Lines 10 to 12 became one line: 5 is above the edit, 12 was in it, 18 is two lines up now.
    fake.push(
      ref,
      next,
      [{ path: "src/invoice.ts", side: "head", from: 2, to: 19 }],
      [{ path: "src/invoice.ts", line: 10, removed: 3, added: 1 }],
    );
    // Inline comments have ids of their own, as on GitHub.
    const at = { path: "src/invoice.ts", side: "head" as const, minimized: null };
    expect(fake.view(ref).reviews[0]?.comments).toEqual([
      { ...at, id: "100001", line: 5, endLine: null, originalLine: 5, body: "On 5." },
      { ...at, id: "100002", line: null, endLine: null, originalLine: 12, body: "On 12." },
      { ...at, id: "100003", line: 16, endLine: null, originalLine: 18, body: "On 18." },
    ]);
  });

  test("a comment gone with one push stays gone; the others keep moving, and other files don't", async () => {
    const fake = host();
    const comments = [
      { path: "src/invoice.ts", side: "head" as const, line: 4, endLine: null, body: "Gone." },
      { path: "src/invoice.ts", side: "head" as const, line: 20, endLine: null, body: "Moves twice." },
    ];
    await fake.publishReview(ref, { sha, body: "2 findings.", comments });
    const diff = [{ path: "src/invoice.ts", side: "head" as const, from: 2, to: 30 }];
    fake.push(ref, commitSha("c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2"), diff, [
      { path: "src/invoice.ts", line: 4, removed: 1, added: 0 },
    ]);
    // Two lines inserted before line 3, and an edit in another file.
    fake.push(ref, commitSha("d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3"), diff, [
      { path: "src/invoice.ts", line: 3, removed: 0, added: 2 },
      { path: "src/other.ts", line: 1, removed: 5, added: 0 },
    ]);
    expect(fake.view(ref).reviews[0]?.comments.map((c) => [c.line, c.originalLine])).toEqual([
      [null, 4],
      [21, 20],
    ]);
  });

  test("a comment whose line the new diff no longer shows reads null, as GitHub sets a line only on the diff", async () => {
    const fake = host();
    const comment = {
      path: "src/invoice.ts",
      side: "head" as const,
      line: 20,
      endLine: null,
      body: "Near the end.",
    };
    await fake.publishReview(ref, { sha, body: "1 finding.", comments: [comment] });
    // The push reverts lines 15 to 21 to the base: its text is unchanged, but the diff ends at line 14 now.
    fake.push(ref, commitSha("c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2"), [
      { path: "src/invoice.ts", side: "head", from: 2, to: 14 },
    ]);
    expect(fake.view(ref).reviews[0]?.comments).toEqual([
      { ...comment, id: "100001", line: null, originalLine: 20, minimized: null },
    ]);
  });

  test("a range that leaves the lines a comment can go on is outside the diff, as on GitHub", async () => {
    const fake = host();
    const range = (line: number, endLine: number) => ({
      path: "src/invoice.ts",
      side: "head" as const,
      line,
      endLine,
      body: "A range.",
    });
    for (const comment of [range(20, 22), range(1, 3)]) {
      await expect(fake.publishReview(ref, { sha, body: "", comments: [comment] })).rejects.toMatchObject({
        failure: "unplaceable_comment",
      });
    }
    expect(fake.view(ref).reviews).toEqual([]);
  });

  test("a push moves a range with its text; a range one of whose lines is replaced reads null", async () => {
    const fake = host();
    const range = (line: number, endLine: number) => ({
      path: "src/invoice.ts",
      side: "head" as const,
      line,
      endLine,
      body: `On ${line}-${endLine}.`,
    });
    await fake.publishReview(ref, { sha, body: "", comments: [range(4, 6), range(14, 16)] });
    // Line 5 replaced by two lines: the first range loses a line, the second moves down by one.
    fake.push(
      ref,
      commitSha("c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2"),
      [{ path: "src/invoice.ts", side: "head", from: 2, to: 22 }],
      [{ path: "src/invoice.ts", line: 5, removed: 1, added: 2 }],
    );
    expect(fake.view(ref).reviews[0]?.comments.map((c) => [c.line, c.endLine, c.originalLine])).toEqual([
      [null, null, 4],
      [15, 17, 14],
    ]);
  });

  test("the view shows one commit's checks, as GitHub does: the head's, or the commit named", async () => {
    const fake = host();
    const output = { title: "Reviewing", summary: "Round 1 in progress.", text: "" };
    const first = await fake.createCheck(repo, sha, "in_progress", output, "job-1");
    const next = commitSha("c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2");
    fake.push(ref, next, [{ path: "src/invoice.ts", side: "head", from: 2, to: 21 }]);
    const second = await fake.createCheck(repo, next, "queued", output, "job-1");
    expect(fake.view(ref).checks.map((c) => c.id)).toEqual([second]);
    expect(fake.view(ref, sha).checks.map((c) => c.id)).toEqual([first]);
  });

  test("a push moves the head commit and the diff", async () => {
    const fake = host();
    const next = commitSha("c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2");
    fake.push(ref, next, [{ path: "src/invoice.ts", side: "head", from: 2, to: 30 }]);
    expect((await fake.getChange(repo, 1)).head.sha).toBe(next);
    const review: ReviewPost = {
      sha: next,
      body: "",
      comments: [{ path: "src/invoice.ts", side: "head", line: 25, endLine: null, body: "x" }],
    };
    await expect(fake.publishReview(ref, review)).resolves.toBeString();
  });

  const oneFinding: ReviewPost = {
    sha,
    body: "1 finding.",
    comments: [{ path: "src/invoice.ts", side: "head", line: 12, endLine: null, body: "Off by one." }],
  };

  test("the next post refused once posts nothing, then the host answers again; reads are not posts", async () => {
    const fake = host();
    fake.refuseNext("unavailable");
    await expect(fake.findReview(ref, REVIEW_MARKER)).resolves.toBeNull();
    await expect(fake.publishReview(ref, oneFinding)).rejects.toMatchObject({ failure: "unavailable" });
    expect(fake.posts).toEqual([]);
    await expect(fake.publishReview(ref, oneFinding)).resolves.toBeString();
    expect(fake.posts.map((p) => p.kind)).toEqual(["review"]);
  });

  test("a post refused once though saved is on the host all the same, as GitHub's internal error once was", async () => {
    const fake = host();
    fake.refuseNext("unavailable", { saved: true });
    await expect(fake.publishReview(ref, oneFinding)).rejects.toMatchObject({ failure: "unavailable" });
    expect(fake.view(ref).reviews.map((r) => r.body)).toEqual(["1 finding."]);
  });

  test("the next post of one kind refused once: the others before it answer", async () => {
    const fake = host();
    fake.refuseNext("rate_limited", { post: "status" });
    const output = { title: "Reviewing", summary: "Round 1 in progress.", text: "" };
    await fake.createCheck(repo, sha, "in_progress", output, "job-1");
    await fake.publishReview(ref, oneFinding);
    await expect(fake.upsertStatus(ref, () => "Round 1")).rejects.toMatchObject({ failure: "rate_limited" });
    await fake.upsertStatus(ref, () => "Round 1");
    expect(fake.posts.map((p) => p.kind)).toEqual(["check.created", "review", "status.written"]);
  });
});
