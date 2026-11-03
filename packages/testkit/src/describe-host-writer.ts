// The `HostWriter` port suite: run against `FakeGitHost` in `bun run check` and against `github` on throwaway sandbox
// pull requests in `bun run live` (ADR 0039, ADR 0041); the check's whole lifecycle too (ADR 0043: `queued`, its reason
// changed, `in_progress`, back to `queued`, completed `success`, `neutral` or `skipped`). `setup.open` is called once
// per case and gives a change nobody has posted on yet, so no case depends on another's posts: the adapter, the change,
// one line a comment can go on and one it can't, who posts as the host knows them (the person signed in to the shared
// App, ADR 0066), a way to comment as someone else and as the poster by hand, and `observe`, which reads back what the
// host shows now as contracts' `HostView` for the change's head commit (the fake's `view`; GitHub's API for the real
// adapter). `setup.refusing` gives, for each way a host can refuse every call, a fresh adapter in that state, `observe`
// still reading what the host shows; one the host
// can't be brought to on demand is left out, and its case is skipped (the real GitHub can't be made to rate-limit). Its
// threads (ADR 0052): a reply read back through the App's own intake (`intake`), comments minimized by the node ids the
// intake gives, and a completed check completed again. Every output posted here has a title, a summary and a text:
// GitHub requires the summary and reads an empty text back as null, so empty strings would fail the live run for
// reasons that are not the port's. `setup.patience` is how long the host may take to show a write (ADR 0069): each
// read after a write that expects its effect reads until it shows it, its predicate the `expect`s after it; a read
// that proves nothing was posted, or nothing changed, stays a single read. Before a review is sent again, the case
// waits for the host to show the first, so the writer's own look for it before posting doesn't miss it.
// The status block (ADR 0074): the fixture rewrites the description as its author (`editDescription`), and the cases
// write the block on an empty description, under the author's text, again (the author's text kept byte for byte),
// after the author's edit (kept, though a lagging host's read still shows the text before it), twice after an opening
// marker with no end (kept, with its half block), past its room (refused, nothing written) and filling it exactly
// (GitHub's 65,536 characters).
import { describe, expect, test } from "bun:test";
import type {
  ChangeRef,
  CommitSha,
  DiffLocation,
  HostConversationComment,
  HostIntake,
  HostThread,
  HostView,
  HostWriter,
  Listing,
  ReviewPost,
} from "@lookover/contracts";
import {
  CHECK_NAME,
  CHECK_OUTPUT_MAX_BYTES,
  COMMENT_MAX_BYTES,
  characterCount,
  DESCRIPTION_MAX_CHARACTERS,
  FINDING_MARKER,
  findingId,
  REVIEW_MARKER,
  REVIEW_MAX_COMMENTS,
  STATUS_END_MARKER,
  STATUS_MARKER,
  statusOf,
  utf8Bytes,
} from "@lookover/contracts";
import type { HostRefusal } from "./fake-git-host.ts";
import { equals, matches } from "./matchers.ts";
import { holds, type Patience, readUntil } from "./read-until.ts";

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
  /** Who posts, as the host knows them: the person signed in to the shared App (ADR 0066), every post theirs. */
  poster: { id: number; login: string };
  /** Writes a comment on the change's conversation as someone other than the poster. Returns its id. */
  comment(body: string): Promise<string>;
  /** Writes the change's description as its author would, by hand: the whole text, "" for none. */
  editDescription(body: string): Promise<void>;
  observe(): Promise<HostView>;
  /** The host read by an intake of the same App: how a reply or a node id is read back. */
  intake: HostIntake;
}

export interface HostWriterSetup {
  open(): Promise<HostWriterFixture>;
  /**
   * How long the host may take to show a write (ADR 0069): the fakes `{ boundMs: 0, pauseMs: 0 }`, GitHub
   * `LIVE_SHOWN_MS` and 1 s.
   */
  patience: Patience;
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
/** A status block as the description holds it (ADR 0074). */
const marked = (block: string) => `${STATUS_MARKER}\n${block}\n${STATUS_END_MARKER}`;
/** A finding's inline comment as `publish` ends it: with the marker naming the finding. */
const FINDING_F1 = `**Off by one** · Should fix\n\n${FINDING_MARKER}{"v":1,"id":"F1"} -->`;

export function describeHostWriter(name: string, { open: setup, patience, refusing }: HostWriterSetup): void {
  /**
   * Reads until `shows` holds of the read, within the setup's patience, and returns the last read: the `expect` after
   * it is unchanged. Only for a read that expects a write's effect (ADR 0069). A wait that runs out ends its case (its
   * `expect` fails at once, or the case throws); one that passes costs GitHub's lag, seconds, so a case of N waits
   * could near N whole bounds only if GitHub lagged near the bound at every one.
   */
  const shown = <T>(read: () => Promise<T>, shows: (read: T) => boolean, what: string): Promise<T> =>
    readUntil(read, shows, what, patience);
  /**
   * `shown` where no `expect` follows: what the case goes on from (a review before it is sent again, what nothing may
   * change after). Running out throws, so the case ends there as at a failed `expect`.
   */
  const mustShow = async <T>(
    read: () => Promise<T>,
    shows: (read: T) => boolean,
    what: string,
  ): Promise<T> => {
    const last = await shown(read, shows, what);
    if (!shows(last)) throw new Error(`The host doesn't show ${what}`);
    return last;
  };
  /** The check of that id, as the host shows it now. */
  const checkOf = async (f: HostWriterFixture, id: string) =>
    (await f.observe()).checks.find((c) => c.id === id);
  /** The check of that id once the host shows it as `toMatchObject(expected)` takes it. */
  const checkShown = (f: HostWriterFixture, id: string, expected: Record<string, unknown>, what: string) =>
    shown(() => checkOf(f, id), matches(expected), what);
  describe(`HostWriter port: ${name}`, () => {
    test("a check created in progress is completed with its conclusion and output", async () => {
      const f = await setup();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "in_progress", RUNNING, JOB);
      const running = { name: CHECK_NAME, sha: f.sha, status: "in_progress", output: RUNNING };
      const inProgress = await checkShown(f, id, running, "the check in progress");
      expect(inProgress).toMatchObject(running);

      await f.writer.completeCheck(f.change.repo, id, "success", DONE);
      const done = { status: "completed", conclusion: "success", output: DONE };
      const completed = await checkShown(f, id, done, "the check completed");
      expect(completed).toMatchObject(done);
    });

    test("a check follows its job: queued with why it waits, the reason changed, in progress, then skipped", async () => {
      const f = await setup();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "queued", WAITING, JOB);
      const check = (expected: Record<string, unknown>, what: string) => checkShown(f, id, expected, what);
      const created = { name: CHECK_NAME, sha: f.sha, status: "queued", conclusion: null, output: WAITING };
      expect(await check(created, "the check queued")).toMatchObject(created);

      await f.writer.updateCheck(f.change.repo, id, "queued", SIGNED_OUT);
      const signedOut = { status: "queued", conclusion: null, output: SIGNED_OUT };
      expect(await check(signedOut, "the check's new reason")).toMatchObject(signedOut);

      await f.writer.updateCheck(f.change.repo, id, "in_progress", RUNNING);
      const running = { status: "in_progress", conclusion: null, output: RUNNING };
      expect(await check(running, "the check in progress")).toMatchObject(running);

      // A run that finds its engine signed out waits again; a restart puts an interrupted run back in the queue.
      await f.writer.updateCheck(f.change.repo, id, "queued", SIGNED_OUT);
      expect(await check(signedOut, "the check queued again")).toMatchObject(signedOut);

      await f.writer.completeCheck(f.change.repo, id, "skipped", SKIPPED);
      const skipped = { status: "completed", conclusion: "skipped", output: SKIPPED };
      expect(await check(skipped, "the check skipped")).toMatchObject(skipped);
    });

    test("a check created queued can be completed neutral without running", async () => {
      const f = await setup();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "queued", WAITING, JOB);
      await f.writer.completeCheck(f.change.repo, id, "neutral", FAILED);
      const neutral = { status: "completed", conclusion: "neutral", output: FAILED };
      const completed = await checkShown(f, id, neutral, "the check completed neutral");
      expect(completed).toMatchObject(neutral);
    });

    test("a check output over the byte limit is refused, and nothing changes", async () => {
      const f = await setup();
      const id = await f.writer.createCheck(f.change.repo, f.sha, "in_progress", RUNNING, JOB);
      // What nothing may change: the host showing the check just created.
      const before = await mustShow(
        f.observe,
        (seen) => seen.checks.some((c) => c.id === id),
        "the check just created",
      );
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
      const found = await shown(
        () => f.writer.findCheck(f.change.repo, f.sha, JOB),
        (read) => read === id,
        "the check by its job's id",
      );
      expect(found).toBe(id);
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
      const posted = await shown(
        async () => (await f.observe()).reviews.find((r) => r.id === id),
        matches(review),
        "the review",
      );
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
      const placed = [
        { ...f.removed, endLine: null, originalLine: f.removed.line },
        { ...f.range, originalLine: f.range.line },
      ];
      const posted = await shown(
        async () => (await f.observe()).reviews.find((r) => r.id === id),
        (read) => matches(placed)(read?.comments),
        "the review's two comments",
      );
      expect(posted?.comments).toMatchObject(placed);
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
      // Sent again once the host shows the first: the writer's look for it, before posting, sees it (ADR 0069).
      await mustShow(
        () => f.writer.findReview(f.change, marker),
        (read) => read === first,
        "the review sent",
      );
      expect(await send()).toBe(first);
      const ids = async () => (await f.observe()).reviews.map((r) => r.id);
      expect(await shown(ids, equals([first]), "the one review")).toEqual([first]);
    });

    test("the poster's review is found by the marker its body holds; a marker no review holds finds none (ADR 0044)", async () => {
      const f = await setup();
      const marker = `${REVIEW_MARKER}round-1 -->`;
      const review: ReviewPost = {
        sha: f.sha,
        body: `1 finding.\n\n${marker}`,
        comments: [{ ...f.inDiff, endLine: null, body: "Off by one." }],
      };
      expect(await f.writer.findReview(f.change, marker)).toBeNull();
      const id = await f.writer.publishReview(f.change, review);
      const found = await shown(
        () => f.writer.findReview(f.change, marker),
        (read) => read === id,
        "the review by its marker",
      );
      expect(found).toBe(id);
      expect(await f.writer.findReview(f.change, `${REVIEW_MARKER}round-2 -->`)).toBeNull();
    });

    test("a review of the most comments, its body and a comment at the byte limit, are posted whole", async () => {
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
      const whole = (seen: HostView) => {
        const posted = seen.reviews.find((r) => r.id === id);
        expect(utf8Bytes(posted?.body ?? "")).toBe(COMMENT_MAX_BYTES);
        expect(posted?.body).toBe(review.body);
        expect(posted?.comments.map((c) => c.body)).toEqual(review.comments.map((c) => c.body));
      };
      whole(await shown(f.observe, holds(whole), "the review, whole"));
    });

    test("a review body or an inline comment over the byte limit is refused, and nothing is posted", async () => {
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
      expect(await f.observe()).toEqual(before);
    });

    /** The description once the host shows it as `expected`, before the next write builds on it. */
    const described = (f: HostWriterFixture, expected: string, what: string) =>
      mustShow(f.observe, (seen) => seen.description === expected, what);
    /** The description once the host shows it as `expected`, for the `expect` after it. */
    const descriptionShown = async (f: HostWriterFixture, expected: string, what: string) =>
      (await shown(f.observe, (seen) => seen.description === expected, what)).description;

    test("the status block on an empty description is the block alone, with the room the host leaves it", async () => {
      const f = await setup();
      await f.editDescription("");
      await described(f, "", "the description emptied");
      const rooms: number[] = [];
      await f.writer.upsertStatus(f.change, (room) => {
        rooms.push(room);
        return "Round 1";
      });
      // 65,536 characters less the two markers and their line breaks.
      expect(rooms).toEqual([65_485]);
      const expected = marked("Round 1");
      expect(await descriptionShown(f, expected, "the block alone")).toBe(expected);
    });

    test("the status block goes under the author's text, a rule between", async () => {
      const f = await setup();
      await f.editDescription("Fixes the total.\n");
      await described(f, "Fixes the total.\n", "the author's text");
      await f.writer.upsertStatus(f.change, () => "Round 1");
      const expected = `Fixes the total.\n\n---\n\n${marked("Round 1")}`;
      expect(await descriptionShown(f, expected, "the block under the author's text")).toBe(expected);
    });

    test("a rewrite replaces only the block, the author's text kept byte for byte", async () => {
      const f = await setup();
      const author = "Fixes the total.\r\n\r\n- [ ] tests";
      await f.editDescription(author);
      await described(f, author, "the author's text");
      await f.writer.upsertStatus(f.change, () => "Looking over abc1234");
      await described(f, `${author}\n\n---\n\n${marked("Looking over abc1234")}`, "the first block");
      await f.writer.upsertStatus(f.change, () => "One thing to fix");
      const expected = `${author}\n\n---\n\n${marked("One thing to fix")}`;
      expect(await descriptionShown(f, expected, "the block rewritten")).toBe(expected);
    });

    test("the author's edit between two writes is kept, before the block and after it", async () => {
      const f = await setup();
      await f.editDescription("First words.");
      await described(f, "First words.", "the author's text");
      await f.writer.upsertStatus(f.change, () => "Round 1");
      await described(f, `First words.\n\n---\n\n${marked("Round 1")}`, "the first block");
      const edited = `Second words.\n\n---\n\n${marked("Round 1")}\n\nA note under it.`;
      await f.editDescription(edited);
      await described(f, edited, "the author's edit");
      await f.writer.upsertStatus(f.change, () => "Round 2");
      const expected = `Second words.\n\n---\n\n${marked("Round 2")}\n\nA note under it.`;
      expect(await descriptionShown(f, expected, "the block rewritten in the edit")).toBe(expected);
    });

    test("a block with no end is left in the author's text, on every write, and the block written at the end", async () => {
      const f = await setup();
      const author = `Intro\n${STATUS_MARKER}\nhalf a block`;
      await f.editDescription(author);
      await described(f, author, "the author's text");
      await f.writer.upsertStatus(f.change, () => "Round 1");
      await described(f, `${author}\n\n---\n\n${marked("Round 1")}`, "the block at the end");
      await f.writer.upsertStatus(f.change, () => "Round 2");
      const expected = `${author}\n\n---\n\n${marked("Round 2")}`;
      expect(await descriptionShown(f, expected, "the block rewritten, the half block kept")).toBe(expected);
    });

    test("a block past its room is refused and nothing is written; none is nothing; one filling the room is written", async () => {
      const f = await setup();
      await f.editDescription("Intro");
      const before = await described(f, "Intro", "the author's text");
      await expect(f.writer.upsertStatus(f.change, (room) => "y".repeat(room + 1))).rejects.toMatchObject({
        failure: "too_large",
      });
      await f.writer.upsertStatus(f.change, () => null);
      expect(await f.observe()).toEqual(before);
      await f.writer.upsertStatus(f.change, (room) => "y".repeat(room));
      const full = (seen: HostView) =>
        expect(characterCount(seen.description)).toBe(DESCRIPTION_MAX_CHARACTERS);
      full(await shown(f.observe, holds(full), "the description filled to its limit"));
    });

    test("a round posted in the port's order shows as one completed check, one review and its status block", async () => {
      const f = await setup();
      const checkId = await f.writer.createCheck(f.change.repo, f.sha, "in_progress", RUNNING, JOB);
      const review = {
        sha: f.sha,
        body: "1 finding.",
        comments: [{ ...f.inDiff, endLine: null, body: "Off by one." }],
      };
      const reviewId = await f.writer.publishReview(f.change, review);
      const block = "One thing to fix\n\nRound 1";
      await f.writer.upsertStatus(f.change, () => block);
      const done = { title: "1 thing to fix", summary: "Round 1: 1 open.", text: "<!-- result -->" };
      await f.writer.completeCheck(f.change.repo, checkId, "neutral", done);

      const round = (view: HostView) => {
        expect(view.checks).toMatchObject([
          { id: checkId, status: "completed", conclusion: "neutral", output: done },
        ]);
        expect(view.reviews).toMatchObject([{ id: reviewId, ...review }]);
        expect(view.comments).toEqual([]);
        expect(statusOf(view.description)).toBe(block);
      };
      round(await shown(f.observe, holds(round), "the round's check, review and status block"));
    });

    test("the poster reacts to a comment; the same reaction again stays one", async () => {
      const f = await setup();
      const id = await f.comment("/lookover review");
      await f.writer.react(f.change.repo, id, "eyes");
      await f.writer.react(f.change.repo, id, "eyes");
      await f.writer.react(f.change.repo, id, "rocket");
      const reactions = async () => (await f.observe()).comments.find((c) => c.id === id)?.reactions;
      const both = { eyes: 1, rocket: 1 };
      expect(await shown(reactions, equals(both), "the poster's two reactions")).toEqual(both);
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
      const done = { status: "completed", conclusion: "success", output: DONE };
      const completed = await checkShown(f, id, done, "the check completed again");
      expect(completed).toMatchObject(done);
    });

    /**
     * Posts a round's review holding one finding on a line of the diff, and waits for the host to show it: the review,
     * its root comment, its marker.
     */
    const postFinding = async (f: HostWriterFixture, marker = `${REVIEW_MARKER}round-1 -->`) => {
      const review = {
        sha: f.sha,
        body: `1 finding.\n\n${marker}`,
        comments: [{ ...f.inDiff, endLine: null, body: FINDING_F1 }],
      };
      const reviewId = await f.writer.publishReview(f.change, review);
      const rootOf = (seen: HostView) => seen.reviews.find((r) => r.id === reviewId)?.comments[0]?.id;
      const root = rootOf(
        await shown(f.observe, (seen) => rootOf(seen) !== undefined, "the finding just posted"),
      );
      if (root === undefined) throw new Error("The finding just posted is not shown");
      return { reviewId, root: Number(root), marker };
    };

    test("the poster's reply is read back in its thread, by them; the round's review is still found by its marker", async () => {
      const f = await setup();
      const { reviewId, root, marker } = await postFinding(f);
      const body = "Kept: the guard is still missing on line 12.";
      const replyId = await f.writer.reply(f.change, root, body);

      const replied = (threads: HostThread[]) => {
        expect(threads.map((t) => [t.commentId, t.findingId])).toEqual([[root, findingId("F1")]]);
        expect(threads[0]?.replies).toEqual([
          {
            commentId: Number(replyId),
            nodeId: expect.any(String),
            author: { ...f.poster, bot: false },
            body,
            at: expect.any(String),
          },
        ]);
      };
      replied(
        await shown(() => f.intake.threads(f.change), holds(replied), "the poster's reply in its thread"),
      );
      // The host files the reply as a review of its own, with an empty body: never the round's (spike 03, step 11).
      const filed = [
        [false, [FINDING_F1]],
        [true, [body]],
      ];
      const reviews = async () =>
        (await f.observe()).reviews.map((r) => [r.body === "", r.comments.map((c) => c.body)]);
      expect(await shown(reviews, equals(filed), "the reply filed as a review of its own")).toEqual(filed);
      const found = await shown(
        () => f.writer.findReview(f.change, marker),
        (read) => read === reviewId,
        "the round's review by its marker",
      );
      expect(found).toBe(reviewId);
    });

    test("a reply to a reply lands in its thread, after the root comment", async () => {
      const f = await setup();
      const { root } = await postFinding(f);
      const first = await f.writer.reply(f.change, root, "Kept.");
      const second = await f.writer.reply(f.change, Number(first), "Still kept.");
      const thread = [
        [
          root,
          [
            [first, "Kept."],
            [second, "Still kept."],
          ],
        ],
      ];
      const threads = async () =>
        (await f.intake.threads(f.change)).map((t) => [
          t.commentId,
          t.replies.map((r) => [String(r.commentId), r.body]),
        ]);
      expect(await shown(threads, equals(thread), "the thread with its two replies")).toEqual(thread);
    });

    test("a reply over the byte limit is refused, and nothing is posted; a root comment the change hasn't is not found", async () => {
      const f = await setup();
      const { reviewId, root } = await postFinding(f);
      // What nothing may change: the host showing the finding just posted.
      const before = await mustShow(
        f.observe,
        (seen) => seen.reviews.some((r) => r.id === reviewId && r.comments.length > 0),
        "the finding just posted",
      );
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
      const [thread] = await shown(
        () => f.intake.threads(f.change),
        (threads) => threads[0] !== undefined,
        "the finding's thread",
      );
      // Each wait ends the case when it runs out, before the next one runs.
      if (!thread) throw new Error("The thread or the request is not read back");
      const nodeOf = (listed: Listing<HostConversationComment>) =>
        listed.items.find((c) => c.id === request)?.nodeId;
      const listed = await shown(
        () => f.intake.listComments(f.change.repo, 0),
        (read) => nodeOf(read) !== undefined,
        "the request comment",
      );
      const requestNode = nodeOf(listed);
      if (requestNode === undefined) throw new Error("The thread or the request is not read back");

      await f.writer.minimize(f.change.repo, thread.nodeId, "resolved");
      await f.writer.minimize(f.change.repo, requestNode, "outdated");
      const minimized = (view: HostView) => {
        const inline = view.reviews.flatMap((r) => r.comments).find((c) => c.id === String(root));
        expect(inline?.minimized).toBe("resolved");
        expect(view.comments.find((c) => c.id === request)?.minimized).toBe("outdated");
      };
      minimized(await shown(f.observe, holds(minimized), "the finding resolved and the request outdated"));

      await f.writer.minimize(f.change.repo, requestNode, "resolved");
      const why = async () => (await f.observe()).comments.find((c) => c.id === request)?.minimized;
      expect(await shown(why, (read) => read === "resolved", "the request resolved")).toBe("resolved");
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
          // What nothing may change: the host showing the comment just written.
          const before = await mustShow(
            f.observe,
            (seen) => seen.comments.some((c) => c.id === request),
            "the request comment",
          );
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
          await expect(f.writer.upsertStatus(f.change, () => "Round 1")).rejects.toMatchObject(fails);
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
