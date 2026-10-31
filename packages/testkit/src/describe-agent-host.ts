// The `AgentHost` port suite: run against `FakeGitHost.asAgent` in `bun run check` and against `agent-cli`'s
// GitHub adapter, with the owner's own token, on throwaway sandbox pull requests in `bun run live` (ADR 0039,
// ADR 0043). `setup.open` is called once per case and gives a change nobody has posted on yet, from a branch of
// the repository: the adapter, the change, its branch and head, the App's slug and, as that App, ways to create
// and complete a `Lookover` check and to react; the account the adapter's token belongs to; a push. A check of
// another App named `Lookover` can't be made on GitHub on demand (only an App creates checks), so that half of
// its case runs where the fixture gives `foreignCheck`; the other half, asking for another App's slug, runs
// everywhere. Lookover's threads: the App posts a finding on a line of the diff (`postFinding`) and replies in its
// thread, the account writes an inline comment of its own, and a push replaces the finding's line (`outdate`); a
// token that may not resolve a thread can't be made on GitHub on demand, so its case runs where the fixture gives
// `unresolving`. `setup.refusing` gives, for each way a host can refuse every call, a fresh adapter in that state;
// one the host can't be brought to on demand is left out, and its case is skipped.
import { describe, expect, test } from "bun:test";
import type {
  AgentHost,
  AgentThread,
  ChangeRef,
  CheckConclusion,
  CheckOutput,
  CommitSha,
  FindingId,
  OpenCheckStatus,
  Reaction,
} from "@lookover/contracts";
import {
  CHECK_NAME,
  COMMENT_MAX_BYTES,
  checkExternalId,
  commitSha,
  FINDING_MARKER,
  findingId,
  reviewRequest,
} from "@lookover/contracts";
import type { HostRefusal } from "./fake-git-host.ts";

export interface AgentHostFixture {
  host: AgentHost;
  /** An open change nobody has posted on, its head on a branch of the repository itself. */
  change: ChangeRef;
  branch: string;
  head: CommitSha;
  /** The App's slug: the checks `check` creates are its. */
  app: string;
  /** The numeric id of the App's bot, as the App knows itself (REST's): its replies in a thread name it. */
  botId: number;
  /** The account the adapter's token belongs to: what `host.comment` writes as. */
  account: { id: number; login: string };
  /**
   * The person the App posts as, signed in to it (ADR 0066): its threads are theirs, asked for by their id, and
   * `account` is someone else. None: the App posts as its bot.
   */
  person?: { id: number; login: string };
  /**
   * The App creates the `Lookover` check on the commit, with that status and external id (`checkExternalId`'s).
   * Returns its id.
   */
  check(sha: CommitSha, status: OpenCheckStatus, output: CheckOutput, externalId: string): Promise<string>;
  /** The App completes its check. */
  complete(checkId: string, conclusion: CheckConclusion, output: CheckOutput): Promise<void>;
  /** The App puts its reaction on a comment of the change. */
  react(commentId: string, reaction: Reaction): Promise<void>;
  /** One commit pushed on the change. Returns the new head once the host shows it. */
  push(): Promise<CommitSha>;
  /** Another App creates a check named `Lookover` on the commit; absent where the host can't be brought to it. */
  foreignCheck?: (sha: CommitSha) => Promise<void>;
  /**
   * The App posts a review of the change with one inline comment ending in the finding marker of `finding`, on the
   * line `outdate` replaces. Returns the comment's id: the thread's root.
   */
  postFinding(finding: FindingId): Promise<number>;
  /** The App replies in the thread holding the comment `commentId`. Returns the reply's id. */
  appReply(commentId: number, body: string): Promise<number>;
  /**
   * Someone other than who the App posts as writes an inline comment on a line of the diff: the account, or, where the
   * account is the person the App posts as (live on the shared App: a live run has one person, ADR 0066), another
   * account, such as an App's bot. Returns its id.
   */
  commentInline(body: string): Promise<number>;
  /** Pushes a commit replacing the line `postFinding` comments on. Returns once the host shows the thread outdated. */
  outdate(): Promise<void>;
  /** The same host through a token that may not resolve a thread; absent where one can't be made on demand. */
  unresolving?: () => AgentHost;
}

/** An adapter the host refuses, and a change that exists. */
export interface RefusingAgentFixture {
  host: AgentHost;
  change: ChangeRef;
  branch: string;
  head: CommitSha;
}

export interface AgentHostSetup {
  open(): Promise<AgentHostFixture>;
  /** An adapter whose every call the host refuses for that reason. */
  refusing: Partial<Record<HostRefusal, () => Promise<RefusingAgentFixture>>>;
}

const REFUSALS = {
  unauthorized: { failure: "unauthorized", when: "the token is refused" },
  rate_limited: { failure: "rate_limited", when: "the host asks to wait" },
  unavailable: { failure: "unavailable", when: "the host can't be reached" },
} as const satisfies { [F in HostRefusal]: { failure: F; when: string } };

const WAITING = { title: "Waiting for its turn", summary: "Queued.", text: "The review starts by itself." };
const RUNNING = {
  title: "Looking over",
  summary: "Round 2 is running.",
  text: "The result comes at the end.",
};
const SKIPPED = { title: "A newer commit was pushed", summary: "Not reviewed.", text: "<!-- result -->" };
/** No pull request any repository of the suite has. */
const NO_CHANGE = 999_999;
/** No review comment any change of the suite has. */
const NO_COMMENT = 999_999_999_999;
/** An account id no host has. */
const NO_PERSON = 999_999_999;
/** A thread id no host has. */
const NO_THREAD = "PRRT_kwDOLookoverNoSuchThread";
/** The finding marker `publish` ends an inline comment with, naming `id`. */
const marker = (id: string) => `${FINDING_MARKER}${JSON.stringify({ v: 1, id })} -->`;
/** The external ids of the checks the cases create: two jobs', for one person (ADR 0066). */
const JOB_1 = checkExternalId("agent-host-1", 1234567);
const JOB_2 = checkExternalId("agent-host-2", 1234567);
/** A commit no repository has. */
const NO_COMMIT = commitSha("0123456789abcdef0123456789abcdef01234567");

export function describeAgentHost(name: string, { open: setup, refusing }: AgentHostSetup): void {
  describe(`AgentHost port: ${name}`, () => {
    test("the open change of a branch of the repository itself, with its head, no fork's", async () => {
      const f = await setup();
      expect(await f.host.changeOf(f.change.repo, f.branch)).toEqual({
        number: f.change.number,
        head: f.head,
        fork: false,
      });
    });

    test("the token's own account, as the host knows it: whose checks the agent waits on (ADR 0066)", async () => {
      const f = await setup();
      expect(await f.host.account()).toEqual(f.account);
    });

    test("a branch with no open change reads null", async () => {
      const f = await setup();
      expect(await f.host.changeOf(f.change.repo, `${f.branch}-no-such-branch`)).toBeNull();
    });

    test("a change read by number gives its head, and the new head after a push", async () => {
      const f = await setup();
      expect(await f.host.getChange(f.change)).toEqual({
        number: f.change.number,
        head: f.head,
        fork: false,
      });
      const pushed = await f.push();
      expect(await f.host.getChange(f.change)).toEqual({
        number: f.change.number,
        head: pushed,
        fork: false,
      });
      expect(await f.host.changeOf(f.change.repo, f.branch)).toEqual({
        number: f.change.number,
        head: pushed,
        fork: false,
      });
    });

    test("a number that is no change is not found, and nothing is written there", async () => {
      const f = await setup();
      const missing = { ...f.change, number: NO_CHANGE };
      await expect(f.host.getChange(missing)).rejects.toMatchObject({ failure: "not_found" });
      await expect(f.host.comments(missing)).rejects.toMatchObject({ failure: "not_found" });
      await expect(f.host.comment(missing, "Nowhere.")).rejects.toMatchObject({ failure: "not_found" });
    });

    test("a commit with no check reads an empty list", async () => {
      const f = await setup();
      expect(await f.host.checks(f.change.repo, f.head, f.app)).toEqual([]);
    });

    test("the App's checks of the commit, oldest first, as they move, each with its external id", async () => {
      const f = await setup();
      const first = await f.check(f.head, "queued", WAITING, JOB_1);
      expect(await f.host.checks(f.change.repo, f.head, f.app)).toEqual([
        {
          id: first,
          name: CHECK_NAME,
          sha: f.head,
          status: "queued",
          conclusion: null,
          output: WAITING,
          externalId: JOB_1,
        },
      ]);

      await f.complete(first, "skipped", SKIPPED);
      const second = await f.check(f.head, "in_progress", RUNNING, JOB_2);
      expect(await f.host.checks(f.change.repo, f.head, f.app)).toEqual([
        {
          id: first,
          name: CHECK_NAME,
          sha: f.head,
          status: "completed",
          conclusion: "skipped",
          output: SKIPPED,
          externalId: JOB_1,
        },
        {
          id: second,
          name: CHECK_NAME,
          sha: f.head,
          status: "in_progress",
          conclusion: null,
          output: RUNNING,
          externalId: JOB_2,
        },
      ]);
    });

    test("only the commit asked about: a pushed commit shows none of the earlier one's checks", async () => {
      const f = await setup();
      const earlier = await f.check(f.head, "queued", WAITING, JOB_1);
      const pushed = await f.push();
      expect(await f.host.checks(f.change.repo, pushed, f.app)).toEqual([]);
      expect((await f.host.checks(f.change.repo, f.head, f.app)).map((c) => c.id)).toEqual([earlier]);
    });

    test("another App's checks are left out, whatever their name", async () => {
      const f = await setup();
      const ours = await f.check(f.head, "queued", WAITING, JOB_1);
      expect(await f.host.checks(f.change.repo, f.head, `${f.app}-other`)).toEqual([]);
      if (f.foreignCheck) await f.foreignCheck(f.head);
      expect((await f.host.checks(f.change.repo, f.head, f.app)).map((c) => c.id)).toEqual([ours]);
    });

    test("a commit the repository doesn't have is not found", async () => {
      const f = await setup();
      await expect(f.host.checks(f.change.repo, NO_COMMIT, f.app)).rejects.toMatchObject({
        failure: "not_found",
      });
    });

    test("comments written as the account read back oldest first, with the App's reactions", async () => {
      const f = await setup();
      const note = await f.host.comment(f.change, "Pushed the fix.");
      const request = await f.host.comment(f.change, reviewRequest(f.head));
      await f.react(request, "eyes");

      const ours = (await f.host.comments(f.change)).filter((c) => c.id === note || c.id === request);
      expect(ours).toEqual([
        { id: note, author: f.account, body: "Pushed the fix.", reactions: { eyes: 0, rocket: 0 } },
        { id: request, author: f.account, body: reviewRequest(f.head), reactions: { eyes: 1, rocket: 0 } },
      ]);
    });

    test("a change nobody reviewed has no threads; a change that isn't one is not found, and nothing is replied", async () => {
      const f = await setup();
      expect(await f.host.threads(f.change, f.app, f.person?.id)).toEqual([]);
      const missing = { ...f.change, number: NO_CHANGE };
      await expect(f.host.threads(missing, f.app, f.person?.id)).rejects.toMatchObject({
        failure: "not_found",
      });
      const root = await f.postFinding(findingId("F1"));
      await expect(f.host.reply(missing, root, "Fixed.")).rejects.toMatchObject({ failure: "not_found" });
      await expect(f.host.reply(f.change, NO_COMMENT, "Fixed.")).rejects.toMatchObject({
        failure: "not_found",
      });
      expect((await f.host.threads(f.change, f.app, f.person?.id)).map((t) => t.replies)).toEqual([[]]);
    });

    test("Lookover's thread is read with its id, unresolved, and every reply oldest first: the account's, the App's, one to a reply; another's marker names no thread", async () => {
      const f = await setup();
      const root = await f.postFinding(findingId("F1"));
      const first = await f.host.reply(f.change, root, "Won't fix: the caller checks the range.");
      const kept = await f.appReply(root, "Kept: the caller is not the only one.");
      // A reply to a reply lands in the same thread, after the others (#174's live run).
      const second = await f.host.reply(f.change, first, "Disputed: there is no other caller.");
      // A marker in someone else's comment: quoted, or forged, it names no thread of Lookover's (ADR 0052).
      await f.commentInline(`Copied: ${marker("F9")}`);

      const reply = (commentId: number, author: AgentThread["replies"][number]["author"], body: string) => ({
        commentId,
        nodeId: expect.any(String),
        author,
        body,
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
      const account = { ...f.account, bot: false };
      const app = f.person ? { ...f.person, bot: false } : { id: f.botId, login: `${f.app}[bot]`, bot: true };
      expect(await f.host.threads(f.change, f.app, f.person?.id)).toEqual([
        {
          commentId: root,
          nodeId: expect.any(String),
          url: expect.stringContaining(String(root)),
          findingId: findingId("F1"),
          outdated: false,
          threadId: expect.any(String),
          resolved: false,
          replies: [
            reply(first, account, "Won't fix: the caller checks the range."),
            reply(kept, app, "Kept: the caller is not the only one."),
            reply(second, account, "Disputed: there is no other caller."),
          ],
        },
      ]);
      // Another App's threads are left out, whatever their marker.
      expect(await f.host.threads(f.change, `${f.app}-other`)).toEqual([]);
      // Asked for another person's, the person's roots are none of Lookover's; the bot's still are (ADR 0066).
      const nobody = await f.host.threads(f.change, f.app, NO_PERSON);
      expect(nobody.map((t) => t.commentId)).toEqual(f.person ? [] : [root]);
    });

    test("a thread resolved reads resolved, and resolving it again changes nothing; a thread that isn't one is not found", async () => {
      const f = await setup();
      await f.postFinding(findingId("F1"));
      const [thread] = await f.host.threads(f.change, f.app, f.person?.id);
      if (!thread) throw new Error("The finding's thread is not read");
      await f.host.resolve(thread.threadId);
      expect(await f.host.threads(f.change, f.app, f.person?.id)).toEqual([{ ...thread, resolved: true }]);
      await f.host.resolve(thread.threadId);
      expect((await f.host.threads(f.change, f.app, f.person?.id)).map((t) => t.resolved)).toEqual([true]);
      await expect(f.host.resolve(NO_THREAD)).rejects.toMatchObject({ failure: "not_found" });
    });

    test("a thread whose line a push replaced is outdated, and still read by its marker", async () => {
      const f = await setup();
      const root = await f.postFinding(findingId("F2"));
      const reply = await f.host.reply(f.change, root, "Fixed.");
      await f.outdate();
      const threads = await f.host.threads(f.change, f.app, f.person?.id);
      expect(threads.map((t) => [t.commentId, t.findingId, t.outdated, t.resolved])).toEqual([
        [root, findingId("F2"), true, false],
      ]);
      expect(threads[0]?.replies.map((r) => [r.commentId, r.body])).toEqual([[reply, "Fixed."]]);
    });

    test("a reply over the size limit is refused, and nothing is posted", async () => {
      const f = await setup();
      const root = await f.postFinding(findingId("F1"));
      const big = "x".repeat(COMMENT_MAX_BYTES + 1);
      await expect(f.host.reply(f.change, root, big)).rejects.toMatchObject({ failure: "too_large" });
      // Its size is known before anything is asked: too large, even to a change that isn't one.
      const missing = { ...f.change, number: NO_CHANGE };
      await expect(f.host.reply(missing, NO_COMMENT, big)).rejects.toMatchObject({ failure: "too_large" });
      expect((await f.host.threads(f.change, f.app, f.person?.id)).map((t) => t.replies)).toEqual([[]]);
    });

    test("a token that may not resolve a thread is refused plainly, and the thread stays open", async () => {
      const f = await setup();
      if (!f.unresolving) return;
      await f.postFinding(findingId("F1"));
      const [thread] = await f.host.threads(f.change, f.app, f.person?.id);
      if (!thread) throw new Error("The finding's thread is not read");
      const refused = f.unresolving().resolve(thread.threadId);
      await expect(refused).rejects.toMatchObject({ failure: "unauthorized" });
      await expect(refused).rejects.toThrow(`GitHub refused to resolve thread ${thread.threadId}: `);
      expect((await f.host.threads(f.change, f.app, f.person?.id)).map((t) => t.resolved)).toEqual([false]);
    });

    for (const { failure: refusal, when } of Object.values(REFUSALS)) {
      const refused = refusing[refusal];
      test.skipIf(refused === undefined)(`every call fails ${refusal} when ${when}`, async () => {
        if (!refused) return;
        const f = await refused();
        const failure = { failure: refusal };
        await expect(f.host.account()).rejects.toMatchObject(failure);
        await expect(f.host.changeOf(f.change.repo, f.branch)).rejects.toMatchObject(failure);
        await expect(f.host.getChange(f.change)).rejects.toMatchObject(failure);
        await expect(f.host.checks(f.change.repo, f.head, "lookover")).rejects.toMatchObject(failure);
        await expect(f.host.comments(f.change)).rejects.toMatchObject(failure);
        await expect(f.host.comment(f.change, "Refused.")).rejects.toMatchObject(failure);
        await expect(f.host.threads(f.change, "lookover")).rejects.toMatchObject(failure);
        await expect(f.host.reply(f.change, 1, "Refused.")).rejects.toMatchObject(failure);
        await expect(f.host.resolve(NO_THREAD)).rejects.toMatchObject(failure);
      });
    }
  });
}
