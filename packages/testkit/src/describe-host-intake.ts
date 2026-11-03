// The `HostIntake` port suite: run against `FakeGitHost` in `bun run check` and against `github` on the
// sandbox in `bun run live` (ADR 0039, ADR 0041, ADR 0043). `setup.open` is called once per case and gives a
// fresh adapter, the repository and one change open on it nobody else touches, with the values the host must
// report for it, written by hand, and what the case needs to move the world: comment and edit as the owner, let a
// second pass on the host's clock, push commits. `setup.refusing` gives, for each way a host can refuse every
// call, a fresh adapter in that state; one the host can't be brought to on demand is left out, and its case is
// skipped (the real GitHub can't be made to rate-limit on purpose). `setup.notInstalled`, the same for an App
// with no installation, every call not found as GitHub answers (ADR 0053; the sandbox has it installed: skipped
// live). Whether the refusal names the App uninstalled is the adapter's to tell: GitHub's 404 for a repository's
// installation can't, the service's discovery does (`HostAccounts.accounts` without it).
// `setup.forks`, the same for a change from a fork and one whose fork is gone (ADR 0048): the sandbox has none,
// since GitHub lets no account fork its own repository, so it runs against the fake only.
// The host keeps comments' times to the second, so a case that needs one comment edited after a point lets a
// second pass first, and no case expects two comments written in the same second in a given order.
// Lookover's threads (ADR 0052): the fixture posts a finding as who posts (the person signed in to the shared App,
// ADR 0066), replies and comments inline as the owner,
// and pushes a commit that replaces the finding's line.
// Nothing in the suite is GitHub's: the clone URL is checked as any host's.
// `setup.patience` is how long the host may take to show a write (ADR 0069): each read after a write that expects its
// effect reads until it shows it, its predicate the `expect`s after it; a read that proves something absent, or a
// listing unchanged, stays a single read. Reading a listing again moves the adapter's ETag, so a stale answer can be
// followed by an unchanged one: a wait on a listing's change asks that it changed and shows what was written, never
// that it changed alone.
import { describe, expect, test } from "bun:test";
import {
  type CommitSha,
  commitSha,
  FINDING_MARKER,
  type FindingId,
  findingId,
  type HostChange,
  type HostConversationComment,
  HostError,
  type HostFailure,
  type HostIntake,
  type HostThread,
  type Listing,
  type RepositoryRef,
} from "@lookover/contracts";
import type { HostRefusal } from "./fake-git-host.ts";
import { equals } from "./matchers.ts";
import { holds, type Patience, readUntil } from "./read-until.ts";

export interface HostIntakeFixture {
  intake: HostIntake;
  repo: RepositoryRef;
  /** A change open on `repo`, from a branch of `repo` itself (no fork), exactly as `getChange` must report it. */
  open: HostChange;
  /** The repository's default branch, as the host names it now. */
  defaultBranch: string;
  /** The account `comment` writes as, as the host knows it. */
  owner: { id: number; login: string };
  /** A time on the host's clock (milliseconds since the Unix epoch) before anything the fixture writes. */
  before: number;
  /** Writes a comment on `open`'s conversation as `owner`. Returns its id. */
  comment(body: string): Promise<string>;
  /** Edits a comment `comment` wrote. */
  edit(commentId: string, body: string): Promise<void>;
  /** Returns once a second has passed on the host's clock: what is written after is a second later at least. */
  later(): Promise<void>;
  /**
   * Pushes `commits` new commits on `open`: on its head, or, with `rewrite`, in place of its head commit (a
   * force-push), each with its message from `messages` (oldest first) when given. Returns the new head once the
   * host shows it.
   */
  push(commits: number, rewrite?: boolean, messages?: string[]): Promise<CommitSha>;
  /** Opens another change on `repo`, as a draft. Returns it exactly as `getChange` must report it. */
  openDraft(): Promise<HostChange>;
  /** Marks the draft numbered `number` ready for review. Returns once the host shows it. */
  markReady(number: number): Promise<void>;
  /** Closes `open`. Returns once the host shows it. */
  close(): Promise<void>;
  /**
   * Who posts, as the host knows them: the author of Lookover's threads, the person signed in to the shared App (ADR
   * 0066); `owner`, when someone else, is one whose copied marker names no thread.
   */
  poster: { id: number; login: string };
  /**
   * Posts, as the poster, a review of `open` with one inline comment ending in the finding marker of `finding`, on a
   * line `outdate` replaces. Returns the comment's id: the thread's root.
   */
  postFinding(finding: FindingId): Promise<number>;
  /**
   * Writes an inline comment on `open` as someone other than the poster, on a line of its diff: `owner`, or, where
   * `owner` is the poster (live on the shared App: a live run has one person, ADR 0066), another account, such as an
   * App's bot. Returns its id.
   */
  commentInline(body: string): Promise<number>;
  /** Replies as `owner` in the thread whose root comment is `commentId`. Returns the reply's id. */
  reply(commentId: number, body: string): Promise<number>;
  /** Pushes a commit on `open` replacing the line `postFinding` comments on. Returns once the host shows it. */
  outdate(): Promise<void>;
}

/** What a refusal case needs: an adapter, and what it asks about. */
export type RefusingIntakeFixture = Pick<HostIntakeFixture, "intake" | "repo" | "open">;

/**
 * Two changes open on `repo` from forks, each exactly as `getChange` must report it: `fork`'s head in a fork that
 * still exists, `deletedFork`'s in one deleted since.
 */
export interface ForkIntakeFixture extends Pick<HostIntakeFixture, "intake" | "repo"> {
  fork: HostChange;
  deletedFork: HostChange;
}

export interface HostIntakeSetup {
  open(): Promise<HostIntakeFixture>;
  /**
   * How long the host may take to show a write (ADR 0069): the fakes `{ boundMs: 0, pauseMs: 0 }`, GitHub
   * `LIVE_SHOWN_MS` and 1 s.
   */
  patience: Patience;
  /** An adapter whose every call the host refuses for that reason. `open` names a change it would hold. */
  refusing: Partial<Record<HostRefusal, () => Promise<RefusingIntakeFixture>>>;
  /**
   * An adapter for an App with no installation (ADR 0047, ADR 0053): GitHub finds none for the repository, so every
   * call is refused as `not_found`. None, and the case is skipped (the sandbox always has the App installed).
   */
  notInstalled?: () => Promise<RefusingIntakeFixture>;
  /** Changes from forks. None, and the case is skipped (the sandbox has none). */
  forks?: () => Promise<ForkIntakeFixture>;
}

const REFUSALS = {
  unauthorized: { failure: "unauthorized", when: "the credentials are refused" },
  rate_limited: { failure: "rate_limited", when: "the host asks to wait" },
  unavailable: { failure: "unavailable", when: "the host can't be reached" },
} as const satisfies { [F in HostRefusal]: { failure: F; when: string } };

/** A commit no repository has. */
const NO_COMMIT = commitSha("0000000000000000000000000000000000000001");

/**
 * The repository the suite asks for to be told it doesn't exist: next to `repo`, under the same owner. An adapter
 * that refuses repositories off a list must list this one, or the case proves the list and not the host.
 */
export function noSuchRepository(repo: RepositoryRef): RepositoryRef {
  return { owner: repo.owner, name: `${repo.name}-no-such-repository` };
}

/** Each item's last edit is no later than the one before it's. */
const newestEditedFirst = (items: HostConversationComment[]) =>
  items.every((c, i) => i === 0 || c.updatedAt <= (items[i - 1]?.updatedAt ?? 0));

export function describeHostIntake(name: string, setup: HostIntakeSetup): void {
  /**
   * Reads until `shows` holds of the read, within the setup's patience, and returns the last read: the `expect` after
   * it is unchanged. Only for a read that expects a write's effect (ADR 0069). A wait that runs out ends its case (its
   * `expect` fails at once, or the case throws); one that passes costs GitHub's lag, seconds, so a case of N waits
   * could near N whole bounds only if GitHub lagged near the bound at every one.
   */
  const shown = <T>(read: () => Promise<T>, shows: (read: T) => boolean, what: string): Promise<T> =>
    readUntil(read, shows, what, setup.patience);

  describe(`HostIntake port: ${name}`, () => {
    test("the open changes include the one the fixture names, with its draft flag and author", async () => {
      const { intake, repo, open } = await setup.open();
      // Just opened by the fixture: listed once the host shows it.
      const listed = async () =>
        (await intake.listOpenChanges(repo)).items.find((c) => c.number === open.number);
      expect(await shown(listed, equals(open), "the change just opened, listed")).toEqual(open);
    });

    test("the open changes listed again unchanged say so; a push shows at the next listing", async () => {
      const f = await setup.open();
      const first = await f.intake.listOpenChanges(f.repo);
      expect(first.unchanged).toBe(false);
      const { at: _first, ...again } = await f.intake.listOpenChanges(f.repo);
      expect(again).toEqual({ unchanged: true, items: first.items });

      const head = await f.push(1);
      const pushed = (after: Listing<HostChange>) => {
        expect(after.unchanged).toBe(false);
        expect(after.items.find((c) => c.number === f.open.number)?.head.sha).toBe(head);
      };
      const listing = () => f.intake.listOpenChanges(f.repo);
      pushed(await shown(listing, holds(pushed), "the listing changed, with the pushed head"));
    });

    test("a change carries when the host says it was opened, to the second: listed and read, a push keeps it", async () => {
      const f = await setup.open();
      const listed = async () => {
        const { items, at } = await f.intake.listOpenChanges(f.repo);
        return { at, openedAt: items.find((c) => c.number === f.open.number)?.openedAt };
      };
      const carried = (first: { at: number; openedAt: number | undefined }) => {
        expect(first.openedAt).toBe(f.open.openedAt);
        expect(f.open.openedAt % 1000).toBe(0);
        // Opened by the fixture before it handed it over, so after its point in time and by the listing at the latest.
        expect(f.open.openedAt).toBeGreaterThanOrEqual(Math.floor(f.before / 1000) * 1000);
        expect(f.open.openedAt).toBeLessThanOrEqual(first.at);
      };
      carried(await shown(listed, holds(carried), "the change just opened, listed"));

      await f.push(1);
      expect((await listed()).openedAt).toBe(f.open.openedAt);
      expect((await f.intake.getChange(f.repo, f.open.number)).openedAt).toBe(f.open.openedAt);
    });

    test("a draft is listed open as a draft; marked ready, it is listed ready", async () => {
      const f = await setup.open();
      const draft = await f.openDraft();
      expect(draft.draft).toBe(true);
      const listed = async () =>
        (await f.intake.listOpenChanges(f.repo)).items.find((c) => c.number === draft.number);
      expect(await shown(listed, equals(draft), "the draft listed")).toEqual(draft);

      await f.markReady(draft.number);
      const ready = { ...draft, draft: false };
      expect(await shown(listed, equals(ready), "the draft listed ready")).toEqual(ready);
    });

    test("a closed change is no longer listed open, and is still read by its number", async () => {
      const f = await setup.open();
      const numbers = async () => (await f.intake.listOpenChanges(f.repo)).items.map((c) => c.number);
      // Listed open before the close, so its absence after is the close's own effect, and waiting can't fake it. Just
      // opened by the fixture: listed once the host shows it.
      const open = (numbers: number[]) => expect(numbers).toContain(f.open.number);
      open(await shown(numbers, holds(open), "the change just opened, listed"));
      await f.close();
      const closed = (numbers: number[]) => expect(numbers).not.toContain(f.open.number);
      closed(await shown(numbers, holds(closed), "the change closed"));
      expect(await f.intake.getChange(f.repo, f.open.number)).toEqual(f.open);
    });

    test("a change from a branch of the repository itself is no fork, listed and read", async () => {
      const { intake, repo, open } = await setup.open();
      expect(open.fork).toBe(false);
      const fork = async () =>
        (await intake.listOpenChanges(repo)).items.find((c) => c.number === open.number)?.fork;
      expect(await shown(fork, (read) => read === false, "the change just opened, listed")).toBe(false);
      expect((await intake.getChange(repo, open.number)).fork).toBe(false);
    });

    const { forks } = setup;
    (forks ? test : test.skip)(
      "a change from a fork is a fork's, listed and read; its fork deleted, still",
      async () => {
        if (!forks) return;
        const { intake, repo, fork, deletedFork } = await forks();
        expect([fork.fork, deletedFork.fork]).toEqual([true, true]);
        // Opened by the fixture: listed once the host shows both.
        const listed = (items: HostChange[]) => {
          for (const change of [fork, deletedFork])
            expect(items.find((c) => c.number === change.number)).toEqual(change);
        };
        const open = async () => (await intake.listOpenChanges(repo)).items;
        const items = await shown(open, holds(listed), "the changes from forks, listed");
        for (const change of [fork, deletedFork]) {
          expect(items.find((c) => c.number === change.number)).toEqual(change);
          expect(await intake.getChange(repo, change.number)).toEqual(change);
        }
      },
    );

    test("one change is reported with its head, base, author, draft flag and title", async () => {
      const { intake, repo, open } = await setup.open();
      expect(await intake.getChange(repo, open.number)).toEqual(open);
    });

    test("a number that is no change is not found", async () => {
      const { intake, repo } = await setup.open();
      await expect(intake.getChange(repo, 999_999_999)).rejects.toMatchObject({ failure: "not_found" });
    });

    test("a repository that isn't one is not found, not empty", async () => {
      const { intake, repo, open } = await setup.open();
      const missing = noSuchRepository(repo);
      const notFound = { failure: "not_found" };
      await expect(intake.listOpenChanges(missing)).rejects.toMatchObject(notFound);
      await expect(intake.listComments(missing, 0)).rejects.toMatchObject(notFound);
      await expect(intake.countCommits(missing, open.base.sha, open.head.sha)).rejects.toMatchObject(
        notFound,
      );
    });

    test("the comments edited since a point are listed newest edited first, each with its change, author, body and times", async () => {
      const f = await setup.open();
      const first = await f.comment("First comment of the intake suite.");
      // The host keeps times to the second: two comments in one second have no order to read back.
      await f.later();
      const second = await f.comment("Second comment of the intake suite.");

      const written = (id: string, body: string) => ({
        id,
        nodeId: expect.any(String),
        change: f.open.number,
        author: f.owner,
        body,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      const listed = (items: HostConversationComment[]) => {
        expect(newestEditedFirst(items)).toBe(true);
        expect(items.every((c) => c.updatedAt >= f.before)).toBe(true);
        const ours = items
          .filter((c) => c.id === first || c.id === second)
          .sort((a, b) => a.createdAt - b.createdAt);
        expect(ours).toEqual([
          written(first, "First comment of the intake suite."),
          written(second, "Second comment of the intake suite."),
        ]);
        for (const comment of ours) {
          expect(comment.createdAt).toBeGreaterThanOrEqual(f.before);
          expect(comment.updatedAt).toBe(comment.createdAt);
        }
      };
      const items = async () => (await f.intake.listComments(f.repo, f.before)).items;
      listed(await shown(items, holds(listed), "the two comments"));
    });

    test("a comment last edited before the point is not listed; edited after it, it is listed first", async () => {
      const f = await setup.open();
      const id = await f.comment("Written before the point.");
      const writtenIn = (listed: HostConversationComment[]) => listed.find((c) => c.id === id);
      const before = async () => (await f.intake.listComments(f.repo, f.before)).items;
      const written = writtenIn(
        await shown(before, (listed) => writtenIn(listed) !== undefined, "the comment just written"),
      );
      if (!written) throw new Error("The comment just written is not listed");
      const point = written.updatedAt + 1_000;
      expect((await f.intake.listComments(f.repo, point)).items.map((c) => c.id)).not.toContain(id);

      await f.later();
      await f.later();
      await f.edit(id, "Edited after the point.");

      const edited = (items: HostConversationComment[]) => {
        expect(items[0]).toMatchObject({ id, body: "Edited after the point.", createdAt: written.createdAt });
        expect(items[0]?.updatedAt).toBeGreaterThanOrEqual(point);
      };
      const since = async () => (await f.intake.listComments(f.repo, point)).items;
      edited(await shown(since, holds(edited), "the comment edited, listed first"));
    });

    test("a listing says when the host answered, by the host's clock: after what was written before it", async () => {
      const f = await setup.open();
      const id = await f.comment("Written before the listing.");
      await f.later();
      const answered = (comments: Listing<HostConversationComment>) => {
        const written = comments.items.find((c) => c.id === id);
        expect(written).toBeDefined();
        expect(comments.at).toBeGreaterThan(written?.createdAt ?? Number.POSITIVE_INFINITY);
      };
      const comments = await shown(
        () => f.intake.listComments(f.repo, f.before),
        holds(answered),
        "the comment just written",
      );
      answered(comments);
      const changes = await f.intake.listOpenChanges(f.repo);
      expect(changes.at).toBeGreaterThanOrEqual(comments.at);
      // Unchanged, it is still the host's time of this answer.
      const again = await f.intake.listComments(f.repo, f.before);
      expect(again.at).toBeGreaterThanOrEqual(comments.at);
    });

    test("the comments listed again unchanged say so; a new comment shows at the next listing", async () => {
      const f = await setup.open();
      const first = await f.intake.listComments(f.repo, f.before);
      expect(first.unchanged).toBe(false);
      const { at: _first, ...again } = await f.intake.listComments(f.repo, f.before);
      expect(again).toEqual({ unchanged: true, items: first.items });

      const id = await f.comment("A comment the next listing shows.");
      const commented = (after: Listing<HostConversationComment>) => {
        expect(after.unchanged).toBe(false);
        expect(after.items[0]?.id).toBe(id);
      };
      const listing = () => f.intake.listComments(f.repo, f.before);
      commented(await shown(listing, holds(commented), "the listing changed, with the new comment first"));
    });

    test("the commits a push brought are counted, the history kept", async () => {
      const f = await setup.open();
      const from = f.open.head.sha;
      const to = await f.push(2);
      // Each commit with its message, oldest first: who wrote a change is read from them (ADR 0044).
      const messages = [expect.any(String), expect.any(String)];
      const brought = { commits: 2, diverged: false, messages };
      const count = () => f.intake.countCommits(f.repo, from, to);
      expect(await shown(count, equals(brought), "the two commits pushed")).toEqual(brought);
      expect(await f.intake.countCommits(f.repo, to, to)).toEqual({
        commits: 0,
        diverged: false,
        messages: [],
      });
    });

    test("each commit's message comes whole, its Co-authored-by trailers included, oldest first", async () => {
      const f = await setup.open();
      const from = f.open.head.sha;
      // As Claude Code and Codex sign their commits: who wrote a change is read from these (ADR 0044).
      const messages = [
        "Fix the total\n\nKeep the cents.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
        "Rewrite the filter\n\nCo-authored-by: Codex <codex@openai.com>",
      ];
      const to = await f.push(2, false, messages);
      const read = async () => (await f.intake.countCommits(f.repo, from, to)).messages;
      expect(await shown(read, equals(messages), "the two commits' messages")).toEqual(messages);
    });

    test("a force-push that replaced the head commit is diverged, its own commits counted", async () => {
      const f = await setup.open();
      const from = f.open.head.sha;
      const to = await f.push(1, true);
      const diverged = { commits: 1, diverged: true, messages: [expect.any(String)] };
      const count = () => f.intake.countCommits(f.repo, from, to);
      expect(await shown(count, equals(diverged), "the force-push diverged")).toEqual(diverged);
    });

    test("a commit the repository doesn't have is not found", async () => {
      const { intake, repo, open } = await setup.open();
      await expect(intake.countCommits(repo, open.head.sha, NO_COMMIT)).rejects.toMatchObject({
        failure: "not_found",
      });
    });

    test("the fetch spec names the repository's HTTPS clone URL, with no credentials, and gives them apart", async () => {
      const { intake, repo, defaultBranch } = await setup.open();
      const spec = await intake.fetchSpec(repo);
      // Where the repository's rules are read (ADR 0048): its default branch as the host names it now.
      expect(spec.defaultBranch).toBe(defaultBranch);
      const url = new URL(spec.cloneUrl);
      expect(url.protocol).toBe("https:");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.pathname.replace(/\.git$/, "")).toEndWith(`/${repo.owner}/${repo.name}`);
      const { username, password } = await spec.credentials();
      expect(username).not.toBe("");
      expect(password).not.toBe("");
      expect(spec.cloneUrl).not.toContain(password);
    });

    test("who posts is the fixture's poster, by numeric id; a repository that isn't one is not found", async () => {
      const { intake, repo, poster } = await setup.open();
      expect(await intake.poster(repo)).toEqual(poster);
      await expect(intake.poster(noSuchRepository(repo))).rejects.toMatchObject({ failure: "not_found" });
    });

    test("a change nobody reviewed has no threads; a change that isn't one is not found", async () => {
      const { intake, repo, open } = await setup.open();
      expect(await intake.threads({ repo, number: open.number })).toEqual([]);
      await expect(intake.threads({ repo, number: 999_999_999 })).rejects.toMatchObject({
        failure: "not_found",
      });
    });

    test("Lookover's thread is read with its replies, oldest first, each with its author; another's inline comment is no thread of Lookover's", async () => {
      const f = await setup.open();
      const change = { repo: f.repo, number: f.open.number };
      const root = await f.postFinding(findingId("F1"));
      const first = await f.reply(root, "Won't fix: the caller checks the range.");
      await f.later();
      const second = await f.reply(root, "Fixed in the next commit.");
      // A marker in someone else's comment: quoted, or forged, it names no thread of Lookover's (ADR 0052).
      await f.commentInline(`Copied: ${FINDING_MARKER}{"v":1,"id":"F9"} -->`);

      const reply = (commentId: number, body: string) => ({
        commentId,
        nodeId: expect.any(String),
        author: { ...f.owner, bot: false },
        body,
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
      const thread = [
        {
          commentId: root,
          nodeId: expect.any(String),
          url: expect.stringContaining(String(root)),
          findingId: findingId("F1"),
          outdated: false,
          replies: [
            reply(first, "Won't fix: the caller checks the range."),
            reply(second, "Fixed in the next commit."),
          ],
        },
      ];
      const threads = await shown(
        () => f.intake.threads(change),
        equals(thread),
        "Lookover's thread with its two replies",
      );
      expect(threads).toEqual(thread);
    });

    test("a thread whose line a push replaced is outdated, and still read by its marker", async () => {
      const f = await setup.open();
      const change = { repo: f.repo, number: f.open.number };
      const root = await f.postFinding(findingId("F2"));
      const reply = await f.reply(root, "Fixed.");
      await f.outdate();
      const outdated = (threads: HostThread[]) => {
        expect(threads.map((t) => [t.commentId, t.findingId, t.outdated])).toEqual([
          [root, findingId("F2"), true],
        ]);
        expect(threads[0]?.replies.map((r) => [r.commentId, r.body])).toEqual([[reply, "Fixed."]]);
      };
      const threads = () => f.intake.threads(change);
      outdated(await shown(threads, holds(outdated), "the thread outdated, with its reply"));
    });

    /** Every call of the adapter `refusing` gives fails as `failure`. */
    const everyCallFails = async (refusing: () => Promise<RefusingIntakeFixture>, failure: HostFailure) => {
      const { intake, repo, open } = await refusing();
      const refused = { failure };
      await expect(intake.listOpenChanges(repo)).rejects.toMatchObject(refused);
      await expect(intake.listComments(repo, 0)).rejects.toMatchObject(refused);
      await expect(intake.getChange(repo, open.number)).rejects.toMatchObject(refused);
      await expect(intake.countCommits(repo, open.base.sha, open.head.sha)).rejects.toMatchObject(refused);
      await expect(intake.threads({ repo, number: open.number })).rejects.toMatchObject(refused);
      // The fetch spec may ask the host itself (GitHub reads the default branch), else its credentials do.
      await expect(intake.fetchSpec(repo).then((spec) => spec.credentials())).rejects.toMatchObject(refused);
    };

    for (const { failure, when } of Object.values(REFUSALS)) {
      const refusing = setup.refusing[failure];
      (refusing ? test : test.skip)(`when ${when}, every call fails as ${failure}`, async () => {
        if (refusing) await everyCallFails(refusing, failure);
      });
    }

    const { notInstalled } = setup;
    (notInstalled ? test : test.skip)(
      "when the App isn't installed, every call fails as not_found",
      async () => {
        if (!notInstalled) return;
        await everyCallFails(notInstalled, "not_found");
        // GitHub's 404 can't say the App is uninstalled, but nothing may blame the person's sign-in.
        const { intake, repo } = await notInstalled();
        const cause = await intake.listOpenChanges(repo).then(
          () => "answered",
          (error: unknown) => (error instanceof HostError ? error.connectionCause?.kind : undefined),
        );
        expect([undefined, "uninstalled"]).toContain(cause);
      },
    );
  });
}
