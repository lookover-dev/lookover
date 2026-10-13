// The `HostWriter` port suite: run against `FakeGitHost` in `bun run check` and against `github` on throwaway
// sandbox pull requests in `bun run live` (ADR 0039, ADR 0041); the check's whole lifecycle too (ADR 0043:
// `queued`, its reason changed, `in_progress`, back to `queued`, completed `success`, `neutral` or `skipped`).
// `setup.open` is called once per case and gives a change nobody has posted on yet, so no case depends on another's posts: the adapter, the change, one line a
// comment can go on and one it can't, the bot as the host knows it, a way to comment as someone else, and
// `observe`, which reads back what the host shows now as contracts' `HostView` for the change's head commit (the
// fake's `view`; GitHub's API for the real adapter). `setup.refusing` gives, for each way a host can refuse every
// call, a fresh adapter in that state, `observe` still reading what the host shows; one the host can't be
// brought to on demand is left out, and its case is skipped (the real GitHub can't be made to rate-limit).
// Its threads (ADR 0052): a reply read back through the App's own intake (`intake`), comments minimized by the
// node ids the intake gives, and a completed check completed again.
// Every output posted here has a title, a summary and a text: GitHub requires the summary and reads an empty
// text back as null, so empty strings would fail the live run for reasons that are not the port's.
import { describe, expect, test } from "bun:test";
import type {
  ChangeRef,
  CommitSha,
  DiffLocation,
  HostIntake,
  HostView,
  HostWriter,
  ReviewPost,
} from "@lookover/contracts";
import {
  CHECK_NAME,
  CHECK_OUTPUT_MAX_BYTES,
  COMMENT_MAX_BYTES,
  FINDING_MARKER,
  findingId,
  REVIEW_MARKER,
  REVIEW_MAX_COMMENTS,
  SUMMARY_MARKER,
  utf8Bytes,
} from "@lookover/contracts";
import type { HostRefusal } from "./fake-git-host.ts";

export interface HostWriterFixture {
  writer: HostWriter;
  /** A change open on the host, with nothing posted on it yet. */
  change: ChangeRef;
  /** The change's head commit. */
  sha: CommitSha;
  /** A line inside the change's diff, and one outside it. */
  inDiff: DiffLocation;
  offDiff: DiffLocation;
  /** A line the change removed: a comment on it goes on the `base` side. */
  removed: DiffLocation;
  /** A range of head lines inside one hunk: `line` to `endLine`. */
  range: DiffLocation & { endLine: number };
  /** The reviewer bot as the host knows it: every post of the writer is its. */
  bot: { id: number; login: string };
  /** Writes a comment on the change's conversation as someone other than the bot. Returns its id. */
  comment(body: string): Promise<string>;
  observe(): Promise<HostView>;
  /** The host read by an intake of the same App: how a reply or a node id is read back. */
  intake: HostIntake;
}

export interface HostWriterSetup {
  open(): Promise<HostWriterFixture>;
  /** An adapter whose every call the host refuses for that reason, on a change nobody has posted on. */
  refusing: Partial<Record<HostRefusal, () => Promise<HostWriterFixture>>>;
}

const REFUSALS = {
  unauthorized: { failure: "unauthorized", when: "the credentials are refused" },
  rate_limited: { failure: "rate_limited", when: "the host asks to wait" },
  unavailable: { failure: "unavailable", when: "the host can't be reached" },
} as const satisfies { [F in HostRefusal]: { failure: F; when: string } };

const RUNNING = { title: "Reviewing", summary: "Round 1 is running.", text: "Lookover is reading the diff." };
const DONE = { title: "No blocking finding", summary: "Round 1: 0 open.", text: "<!-- result -->" };
const WAITING = { title: "Waiting for its turn", summary: "Queued.", text: "The review starts by itself." };
const SIGNED_OUT = {
  title: "Waiting: Claude is signed out",
  summary: "Deferred.",
  text: "Sign in to go on.",
};
const SKIPPED = { title: "A newer commit was pushed", summary: "Not reviewed.", text: "<!-- result -->" };
const FAILED = { title: "The review failed", summary: "Not reviewed.", text: "<!-- result -->" };
/** The review job a check is created for: the host keeps its id with the check (ADR 0044). */
const JOB = "job-1";
/** How many comments the host gives on one page of a listing: GitHub's most. */
const PAGE = 100;
/** The time limit of a case that writes a page of comments first. */
const SLOW_MS = 600_000;
/** A comment nobody reacted to. */
const NONE = { eyes: 0, rocket: 0 };
/** A finding's inline comment as `publish` ends it: with the marker naming the finding. */
const FINDING_F1 = `**Off by one** · Should fix\n\n${FINDING_MARKER}{"v":1,"id":"F1"} -->`;

export function describeHostWriter(name: string, { open: setup, refusing }: HostWriterSetup): void {
  describe(`HostWriter port: ${name}`, () => {
    test("a check created in progress is completed with its conclusion and output", async () => {
      const f = await setup();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "in_progress", RUNNING, JOB);
      const inProgress = (await f.observe()).checks.find((c) => c.id === id);
      expect(inProgress).toMatchObject({
        name: CHECK_NAME,
        sha: f.sha,
        status: "in_progress",
        output: RUNNING,
      });

      await f.writer.completeCheck(f.change.repo, id, "success", DONE);
      const completed = (await f.observe()).checks.find((c) => c.id === id);
      expect(completed).toMatchObject({ status: "completed", conclusion: "success", output: DONE });
    });

    test("a check follows its job: queued with why it waits, the reason changed, in progress, then skipped", async () => {
      const f = await setup();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "queued", WAITING, JOB);
      const check = async () => (await f.observe()).checks.find((c) => c.id === id);
      expect(await check()).toMatchObject({
        name: CHECK_NAME,
        sha: f.sha,
        status: "queued",
        conclusion: null,
        output: WAITING,
      });

      await f.writer.updateCheck(f.change.repo, id, "queued", SIGNED_OUT);
      expect(await check()).toMatchObject({ status: "queued", conclusion: null, output: SIGNED_OUT });

      await f.writer.updateCheck(f.change.repo, id, "in_progress", RUNNING);
      expect(await check()).toMatchObject({ status: "in_progress", conclusion: null, output: RUNNING });

      // A run that finds its engine signed out waits again; a restart puts an interrupted run back in the queue.
      await f.writer.updateCheck(f.change.repo, id, "queued", SIGNED_OUT);
      expect(await check()).toMatchObject({ status: "queued", conclusion: null, output: SIGNED_OUT });

      await f.writer.completeCheck(f.change.repo, id, "skipped", SKIPPED);
      expect(await check()).toMatchObject({ status: "completed", conclusion: "skipped", output: SKIPPED });
    });

    test("a check created queued can be completed neutral without running", async () => {
      const f = await setup();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "queued", WAITING, JOB);
      await f.writer.completeCheck(f.change.repo, id, "neutral", FAILED);
      const shown = (await f.observe()).checks.find((c) => c.id === id);
      expect(shown).toMatchObject({ status: "completed", conclusion: "neutral", output: FAILED });
    });

    test("a check output over the byte limit is refused, and nothing changes", async () => {
      const f = await setup();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "in_progress", RUNNING, JOB);
      const before = await f.observe();
      const text = "a".repeat(CHECK_OUTPUT_MAX_BYTES + 1);
      const tooBig = { title: "Too big", summary: "Round 1: 1 open.", text };
      await expect(f.writer.completeCheck(f.change.repo, id, "neutral", tooBig)).rejects.toMatchObject({
        failure: "too_large",
      });
      await expect(f.writer.updateCheck(f.change.repo, id, "queued", tooBig)).rejects.toMatchObject({
        failure: "too_large",
      });
      await expect(f.writer.createCheck(f.change.repo, f.sha, "queued", tooBig, JOB)).rejects.toMatchObject({
        failure: "too_large",
      });
      expect(await f.observe()).toEqual(before);
    });

    test("a check is found by its job's id on its commit; another id finds none (ADR 0044)", async () => {
      const f = await setup();
      expect(await f.writer.findCheck(f.change.repo, f.sha, JOB)).toBeNull();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "in_progress", RUNNING, JOB);
      expect(await f.writer.findCheck(f.change.repo, f.sha, JOB)).toBe(id);
      expect(await f.writer.findCheck(f.change.repo, f.sha, "job-2")).toBeNull();
    });

    test("updating or completing a check the host doesn't have is not found", async () => {
      const f = await setup();
      await expect(
        f.writer.completeCheck(f.change.repo, "999999999999", "success", DONE),
      ).rejects.toMatchObject({ failure: "not_found" });
      await expect(
        f.writer.updateCheck(f.change.repo, "999999999999", "in_progress", RUNNING),
      ).rejects.toMatchObject({ failure: "not_found" });
    });

    test("a review posts its top comment and its inline comments together", async () => {
      const f = await setup();
      const review = {
        sha: f.sha,
        body: "1 finding.",
        comments: [{ ...f.inDiff, endLine: null, body: "Off by one." }],
      };
      const id = await f.writer.publishReview(f.change, review);
      const posted = (await f.observe()).reviews.find((r) => r.id === id);
      expect(posted).toMatchObject(review);
    });

    test("a comment on a removed line goes on the base side, and one on a range covers its lines", async () => {
      const f = await setup();
      const review: ReviewPost = {
        sha: f.sha,
        body: "2 findings.",
        comments: [
          { ...f.removed, endLine: null, body: "The guard this line held is gone." },
          { ...f.range, body: "This loop never ends on a 4xx." },
        ],
      };
      const id = await f.writer.publishReview(f.change, review);
      const posted = (await f.observe()).reviews.find((r) => r.id === id);
      expect(posted?.comments).toMatchObject([
        { ...f.removed, endLine: null, originalLine: f.removed.line },
        { ...f.range, originalLine: f.range.line },
      ]);
    });

    test("one comment outside the diff fails the whole review, and nothing of it is posted", async () => {
      const f = await setup();
      const before = await f.observe();
      const review = {
        sha: f.sha,
        body: "2 findings.",
        comments: [
          { ...f.inDiff, endLine: null, body: "Fine here." },
          { ...f.offDiff, endLine: null, body: "Not on the diff." },
        ],
      };
      await expect(f.writer.publishReview(f.change, review)).rejects.toMatchObject({
        failure: "unplaceable_comment",
      });
      expect(await f.observe()).toEqual(before);
    });

    test("a review sent again is posted once: the writer finds it by its marker first (ADR 0044)", async () => {
      const f = await setup();
      const marker = `${REVIEW_MARKER}round-1 -->`;
      const review: ReviewPost = {
        sha: f.sha,
        body: `1 finding.\n\n${marker}`,
        comments: [{ ...f.inDiff, endLine: null, body: "Off by one." }],
      };
      // What a caller does to send a review that may be on the host already: look for its marker, then post.
      const send = async () =>
        (await f.writer.findReview(f.change, marker)) ?? (await f.writer.publishReview(f.change, review));
      const first = await send();
      expect(await send()).toBe(first);
      expect((await f.observe()).reviews.map((r) => r.id)).toEqual([first]);
    });

    test("the bot's review is found by the marker its body holds; a marker no review holds finds none (ADR 0044)", async () => {
      const f = await setup();
      const marker = `${REVIEW_MARKER}round-1 -->`;
      const review: ReviewPost = {
        sha: f.sha,
        body: `1 finding.\n\n${marker}`,
        comments: [{ ...f.inDiff, endLine: null, body: "Off by one." }],
      };
      expect(await f.writer.findReview(f.change, marker)).toBeNull();
      const id = await f.writer.publishReview(f.change, review);
      expect(await f.writer.findReview(f.change, marker)).toBe(id);
      expect(await f.writer.findReview(f.change, `${REVIEW_MARKER}round-2 -->`)).toBeNull();
    });

    test("a review of the most comments, its body and a comment at the byte limit, and a summary at it, are posted whole", async () => {
      const f = await setup();
      // Two-byte characters: a host that counted characters would take twice as many.
      const atLimit = (start: string) => {
        const room = COMMENT_MAX_BYTES - utf8Bytes(start);
        return `${start}${"é".repeat(Math.floor(room / 2))}${"a".repeat(room % 2)}`;
      };
      const review: ReviewPost = {
        sha: f.sha,
        body: atLimit("Many findings.\n\n"),
        comments: Array.from({ length: REVIEW_MAX_COMMENTS }, (_, i) => ({
          ...f.inDiff,
          endLine: null,
          body: i === 0 ? atLimit("Off by one.\n\n") : `Finding ${i + 1}.`,
        })),
      };
      const id = await f.writer.publishReview(f.change, review);
      const summary = atLimit(`${SUMMARY_MARKER}\n`);
      await f.writer.upsertSummary(f.change, summary);
      const seen = await f.observe();
      const posted = seen.reviews.find((r) => r.id === id);
      expect(utf8Bytes(posted?.body ?? "")).toBe(COMMENT_MAX_BYTES);
      expect(posted?.body).toBe(review.body);
      expect(posted?.comments.map((c) => c.body)).toEqual(review.comments.map((c) => c.body));
      expect(seen.comments.map((c) => c.body)).toEqual([summary]);
    });

    test("a review body, an inline comment or a summary over the byte limit is refused, and nothing is posted", async () => {
      const f = await setup();
      const before = await f.observe();
      const tooBig = "a".repeat(COMMENT_MAX_BYTES + 1);
      const comment = { ...f.inDiff, endLine: null, body: "Off by one." };
      const tooLarge = { failure: "too_large" };
      await expect(
        f.writer.publishReview(f.change, { sha: f.sha, body: tooBig, comments: [comment] }),
      ).rejects.toMatchObject(tooLarge);
      await expect(
        f.writer.publishReview(f.change, {
          sha: f.sha,
          body: "1 finding.",
          comments: [{ ...comment, body: tooBig }],
        }),
      ).rejects.toMatchObject(tooLarge);
      await expect(f.writer.upsertSummary(f.change, `${SUMMARY_MARKER}\n${tooBig}`)).rejects.toMatchObject(
        tooLarge,
      );
      expect(await f.observe()).toEqual(before);
    });

    test("the summary is created once by the bot, then edited in place", async () => {
      const f = await setup();
      const first = `${SUMMARY_MARKER}\nRound 1: 1 open.`;
      const second = `${SUMMARY_MARKER}\nRound 2: 0 open, 1 verified fixed.`;
      const id = await f.writer.upsertSummary(f.change, first);
      expect(await f.writer.upsertSummary(f.change, second)).toBe(id);
      expect(await f.writer.upsertSummary(f.change, second)).toBe(id);
      expect((await f.observe()).comments).toEqual([
        { id, body: second, author: f.bot, reactions: NONE, minimized: null },
      ]);
    });

    test(
      "the summary is found past the host's first 100 comments, and edited in place",
      async () => {
        const f = await setup();
        for (let i = 1; i <= PAGE + 1; i++) await f.comment(`Comment ${i} before the summary.`);
        const first = `${SUMMARY_MARKER}\nRound 1: 1 open.`;
        const second = `${SUMMARY_MARKER}\nRound 2: 0 open, 1 verified fixed.`;
        const id = await f.writer.upsertSummary(f.change, first);
        expect(await f.writer.upsertSummary(f.change, second)).toBe(id);
        const comments = (await f.observe()).comments;
        expect(comments).toHaveLength(PAGE + 2);
        expect(comments.filter((c) => c.body.includes(SUMMARY_MARKER))).toEqual([
          { id, body: second, author: f.bot, reactions: NONE, minimized: null },
        ]);
      },
      // A hundred comments written one by one, on GitHub at about a second each.
      SLOW_MS,
    );

    test("a comment holding the marker that the bot didn't write is not the summary: the bot posts its own", async () => {
      const f = await setup();
      const theirs = `${SUMMARY_MARKER}\nCopied from an earlier round by someone.`;
      await f.comment(theirs);
      const ours = `${SUMMARY_MARKER}\nRound 1: 1 open.`;
      const id = await f.writer.upsertSummary(f.change, ours);
      const comments = (await f.observe()).comments;
      expect(comments.map((c) => c.body)).toEqual([theirs, ours]);
      expect(comments[1]).toEqual({ id, body: ours, author: f.bot, reactions: NONE, minimized: null });
      expect(comments[0]?.author.id).not.toBe(f.bot.id);
    });

    test("a summary without the marker is refused, and nothing is posted", async () => {
      const f = await setup();
      const before = await f.observe();
      await expect(f.writer.upsertSummary(f.change, "Round 1: 1 open.")).rejects.toMatchObject({
        failure: "missing_marker",
      });
      expect(await f.observe()).toEqual(before);
    });

    test("a round posted in the port's order shows as one completed check, one review and one summary", async () => {
      const f = await setup();
      const checkId = await f.writer.createCheck(f.change.repo, f.sha, "in_progress", RUNNING, JOB);
      const review = {
        sha: f.sha,
        body: "1 finding.",
        comments: [{ ...f.inDiff, endLine: null, body: "Off by one." }],
      };
      const reviewId = await f.writer.publishReview(f.change, review);
      const summary = `${SUMMARY_MARKER}\nRound 1: 1 open.`;
      const summaryId = await f.writer.upsertSummary(f.change, summary);
      const done = { title: "1 thing to fix", summary: "Round 1: 1 open.", text: "<!-- result -->" };
      await f.writer.completeCheck(f.change.repo, checkId, "neutral", done);

      const shown = await f.observe();
      expect(shown.checks).toMatchObject([
        { id: checkId, status: "completed", conclusion: "neutral", output: done },
      ]);
      expect(shown.reviews).toMatchObject([{ id: reviewId, ...review }]);
      expect(shown.comments).toEqual([
        { id: summaryId, body: summary, author: f.bot, reactions: NONE, minimized: null },
      ]);
    });

    test("the bot reacts to a comment; the same reaction again stays one", async () => {
      const f = await setup();
      const id = await f.comment("/lookover review");
      await f.writer.react(f.change.repo, id, "eyes");
      await f.writer.react(f.change.repo, id, "eyes");
      await f.writer.react(f.change.repo, id, "rocket");
      const comment = (await f.observe()).comments.find((c) => c.id === id);
      expect(comment?.reactions).toEqual({ eyes: 1, rocket: 1 });
    });

    test("a reaction on a comment the host doesn't have is not found", async () => {
      const f = await setup();
      await expect(f.writer.react(f.change.repo, "999999999999", "eyes")).rejects.toMatchObject({
        failure: "not_found",
      });
    });

    test("a completed check completed again shows its new conclusion and output (ADR 0052)", async () => {
      const f = await setup();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "in_progress", RUNNING, JOB);
      await f.writer.completeCheck(f.change.repo, id, "neutral", FAILED);
      await f.writer.completeCheck(f.change.repo, id, "success", DONE);
      const shown = (await f.observe()).checks.find((c) => c.id === id);
      expect(shown).toMatchObject({ status: "completed", conclusion: "success", output: DONE });
    });

    /** Posts a round's review holding one finding on a line of the diff: the review, its root comment, its marker. */
    const postFinding = async (f: HostWriterFixture, marker = `${REVIEW_MARKER}round-1 -->`) => {
      const review = {
        sha: f.sha,
        body: `1 finding.\n\n${marker}`,
        comments: [{ ...f.inDiff, endLine: null, body: FINDING_F1 }],
      };
      const reviewId = await f.writer.publishReview(f.change, review);
      const root = (await f.observe()).reviews.find((r) => r.id === reviewId)?.comments[0]?.id;
      if (root === undefined) throw new Error("The finding just posted is not shown");
      return { reviewId, root: Number(root), marker };
    };

    test("the bot's reply is read back in its thread, by the bot; the round's review is still found by its marker", async () => {
      const f = await setup();
      const { reviewId, root, marker } = await postFinding(f);
      const body = "Kept: the guard is still missing on line 12.";
      const replyId = await f.writer.reply(f.change, root, body);

      const threads = await f.intake.threads(f.change);
      expect(threads.map((t) => [t.commentId, t.findingId])).toEqual([[root, findingId("F1")]]);
      expect(threads[0]?.replies).toEqual([
        {
          commentId: Number(replyId),
          nodeId: expect.any(String),
          author: { ...f.bot, bot: true },
          body,
          at: expect.any(String),
        },
      ]);
      // The host files the reply as a review of its own, with an empty body: never the round's (spike 03, step 11).
      expect((await f.observe()).reviews.map((r) => [r.body === "", r.comments.map((c) => c.body)])).toEqual([
        [false, [FINDING_F1]],
        [true, [body]],
      ]);
      expect(await f.writer.findReview(f.change, marker)).toBe(reviewId);
    });

    test("a reply to a reply lands in its thread, after the root comment", async () => {
      const f = await setup();
      const { root } = await postFinding(f);
      const first = await f.writer.reply(f.change, root, "Kept.");
      const second = await f.writer.reply(f.change, Number(first), "Still kept.");
      const threads = await f.intake.threads(f.change);
      expect(threads.map((t) => [t.commentId, t.replies.map((r) => [String(r.commentId), r.body])])).toEqual([
        [
          root,
          [
            [first, "Kept."],
            [second, "Still kept."],
          ],
        ],
      ]);
    });

    test("a reply over the byte limit is refused, and nothing is posted; a root comment the change hasn't is not found", async () => {
      const f = await setup();
      const { root } = await postFinding(f);
      const before = await f.observe();
      await expect(f.writer.reply(f.change, root, "a".repeat(COMMENT_MAX_BYTES + 1))).rejects.toMatchObject({
        failure: "too_large",
      });
      await expect(f.writer.reply(f.change, 999_999_999_999, "Kept.")).rejects.toMatchObject({
        failure: "not_found",
      });
      expect(await f.observe()).toEqual(before);
    });

    test("a minimized comment shows why: the finding's root comment resolved, a conversation comment outdated, then resolved", async () => {
      const f = await setup();
      const { root } = await postFinding(f);
      const request = await f.comment("/lookover review");
      const [thread] = await f.intake.threads(f.change);
      const listed = await f.intake.listComments(f.change.repo, 0);
      const requestNode = listed.items.find((c) => c.id === request)?.nodeId;
      if (!thread || requestNode === undefined) throw new Error("The thread or the request is not read back");

      await f.writer.minimize(f.change.repo, thread.nodeId, "resolved");
      await f.writer.minimize(f.change.repo, requestNode, "outdated");
      const shown = await f.observe();
      const inline = shown.reviews.flatMap((r) => r.comments).find((c) => c.id === String(root));
      expect(inline?.minimized).toBe("resolved");
      expect(shown.comments.find((c) => c.id === request)?.minimized).toBe("outdated");

      await f.writer.minimize(f.change.repo, requestNode, "resolved");
      expect((await f.observe()).comments.find((c) => c.id === request)?.minimized).toBe("resolved");
    });

    test("minimizing a comment the host doesn't have is not found", async () => {
      const f = await setup();
      await expect(
        f.writer.minimize(f.change.repo, "MDEyOk5vU3VjaE5vZGUx", "resolved"),
      ).rejects.toMatchObject({ failure: "not_found" });
    });

    for (const { failure, when } of Object.values(REFUSALS)) {
      const refused = refusing[failure];
      (refused ? test : test.skip)(
        `when ${when}, every call fails as ${failure}, and nothing is posted`,
        async () => {
          if (!refused) return;
          const f = await refused();
          const request = await f.comment("/lookover review");
          const before = await f.observe();
          const fails = { failure };
          await expect(
            f.writer.createCheck(f.change.repo, f.sha, "in_progress", RUNNING, JOB),
          ).rejects.toMatchObject(fails);
          await expect(
            f.writer.updateCheck(f.change.repo, "1", "in_progress", RUNNING),
          ).rejects.toMatchObject(fails);
          await expect(f.writer.completeCheck(f.change.repo, "1", "success", DONE)).rejects.toMatchObject(
            fails,
          );
          const review = {
            sha: f.sha,
            body: "1 finding.",
            comments: [{ ...f.inDiff, endLine: null, body: "x" }],
          };
          await expect(f.writer.publishReview(f.change, review)).rejects.toMatchObject(fails);
          await expect(f.writer.findReview(f.change, `${REVIEW_MARKER}round-1 -->`)).rejects.toMatchObject(
            fails,
          );
          await expect(f.writer.findCheck(f.change.repo, f.sha, JOB)).rejects.toMatchObject(fails);
          await expect(f.writer.upsertSummary(f.change, `${SUMMARY_MARKER}\nRound 1.`)).rejects.toMatchObject(
            fails,
          );
          await expect(f.writer.react(f.change.repo, request, "eyes")).rejects.toMatchObject(fails);
          await expect(f.writer.reply(f.change, 1, "Kept.")).rejects.toMatchObject(fails);
          // Refused before the host looks the id up.
          await expect(
            f.writer.minimize(f.change.repo, "MDEyOk5vU3VjaE5vZGUx", "resolved"),
          ).rejects.toMatchObject(fails);
          expect(await f.observe()).toEqual(before);
        },
      );
    }
  });
}
