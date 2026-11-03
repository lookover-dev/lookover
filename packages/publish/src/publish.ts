// The check following its job (ADR 0043), and one round, posted in the fixed order of ADR 0039 through the
// `HostWriter` port: the check in progress (created here only when the job has none), the review with its inline
// comments (only when the round has one, ADR 0074), the replies on the threads, the status block in the pull request's
// description, the check completed with the result. The block is rendered as it is written, from where the change
// stands then (`PublisherOptions.status`), never from a text kept. The result's text is measured in bytes against
// `CHECK_OUTPUT_MAX_BYTES` before it is sent (ADR 0022). Each post is tried again after a transient refusal
// (`retry.ts`); a review with a comment the host can't place is not sent again: its findings go in the block, and the
// round owes no review from then on.
import {
  CHECK_OUTPUT_MAX_BYTES,
  type ChangeRef,
  type CheckOutput,
  changeName,
  checkExternalId,
  type FindingId,
  HostError,
  type HostFailure,
  type HostThread,
  type HostWriter,
  newestThread,
  type OpenCheckStatus,
  REVIEW_MAX_COMMENTS,
  type ReviewResult,
  type ThreadReply,
  utf8Bytes,
} from "@lookover/contracts";
import { indexDiff } from "@lookover/diff";
import { filteredRound, findingFilter, hiddenRemoved, postablePath, postableText } from "./filter.ts";
import { clip } from "./fit.ts";
import { cap, degrade, type PlacedFinding, placeFindings } from "./place.ts";
import {
  checkCompleted,
  checkEnded,
  checkInProgress,
  checkRunning,
  checkText,
  checkWaiting,
  dismissalMarker,
  endedHeadline,
  headline,
  renderReply,
  renderReview,
  replyMarker,
  reviewMarker,
} from "./render.ts";
import { type ActedOn, buildResult, endedResult, withActors } from "./result.ts";
import { persist } from "./retry.ts";
import { statusBlock } from "./status.ts";
import type {
  Created,
  DismissalOutbox,
  DismissalPostKind,
  JobCheck,
  Outbox,
  PlacedRound,
  PostKind,
  PostTime,
  PostWait,
  Publisher,
  PublisherOptions,
  RoundToPost,
  Status,
  StatusRound,
  ThreadRoot,
} from "./types.ts";

/** The most the result's headline holds, in bytes: a sentence, a few hundred at most but for a file's name. */
const RESULT_HEADLINE_MAX_BYTES = 1_024;

/**
 * The job's check shows its standing: created or updated while it waits or runs, completed once it ended. A check
 * created is given to `created` at once, before anything else is sent for it.
 */
async function follow(
  writer: HostWriter,
  job: JobCheck,
  created: Created,
  offset: (at: number) => number,
  person: () => number,
): Promise<string> {
  const { repo } = job.change;
  const { standing } = job;
  const create = async (status: OpenCheckStatus, output: CheckOutput): Promise<string> => {
    const id = await writer.createCheck(repo, job.sha, status, output, checkExternalId(job.job.id, person()));
    created(id);
    return id;
  };
  const open = async (status: OpenCheckStatus, output: CheckOutput): Promise<string> => {
    if (job.checkId === null) return create(status, output);
    await writer.updateCheck(repo, job.checkId, status, output);
    return job.checkId;
  };
  switch (standing.kind) {
    case "waiting": {
      const { until } = standing;
      const reset = until === null ? null : { at: until, offset: offset(until) };
      return open("queued", checkWaiting(job.sha, standing.deferral, reset));
    }
    case "running":
      return open("in_progress", checkRunning(job.sha, standing.round));
    case "ended": {
      const { ended } = standing;
      const engine = job.run?.engine ?? null;
      const result = endedResult(job, ended, endedHeadline(ended, engine));
      const output = checkEnded(job.sha, ended, engine, result, job.onlyCodex);
      // A commit is never left without its check's end: one never created is created, then completed.
      const id = job.checkId ?? (await create("queued", output));
      await writer.completeCheck(repo, id, ended.kind === "failed" ? "neutral" : "skipped", output);
      return id;
    }
  }
}

/** An outbox nobody keeps: every post owed, as for a round sent once, start to end. */
function freshOutbox(): Outbox {
  return {
    posts: [],
    degraded: false,
    degrade: () => {},
    sending: () => {},
    sent: () => {},
    waiting: () => {},
  };
}

/**
 * The round's findings placed as its posts show them. What it posts whose lines are of another commit (withheld by a
 * round given up, and a push since) is found again by its line's text; `refused`: the host refused a comment, so the
 * round's go into the status block; past the review's most comments, the least urgent go there too.
 */
function placedOf(round: PlacedRound, refused: boolean): PlacedFinding[] {
  const { reconciled } = round;
  const posting = new Set(reconciled.post.map((f) => f.id));
  const commitOf = new Map(round.rounds.map((r) => [r.n, r.sha]));
  const moved = new Set(
    reconciled.post
      .filter((f) => f.anchoredIn !== round.round && commitOf.get(f.anchoredIn) !== round.sha)
      .map((f) => f.id),
  );
  const found = placeFindings(indexDiff(round.diff), reconciled.findings, posting, moved);
  return cap(refused ? degrade(found, posting) : found, posting, REVIEW_MAX_COMMENTS);
}

/** `placedOf`, with who acts on each finding. Throws for a finding `core` gave nobody to act on. */
const placementOf = (round: PlacedRound, refused: boolean): ActedOn[] =>
  withActors(placedOf(round, refused), round.reconciled.actionBy);

/** The round's findings its review holds a comment on, placed so: none, and the round owes no review (ADR 0074). */
const commentedIn = (round: PlacedRound, placed: readonly PlacedFinding[]): FindingId[] => {
  const posting = new Set(round.reconciled.post.map((f) => f.id));
  return placed.flatMap((p) => (p.placement === "inline" && posting.has(p.finding.id) ? [p.finding.id] : []));
};

const unplaceable = (error: unknown) => error instanceof HostError && error.failure === "unplaceable_comment";

/** The round's replies that have a thread to go on, each with its thread's root as the run read it. */
function repliesOf(round: PlacedRound): { reply: ThreadReply; root: ThreadRoot }[] {
  const roots = round.roots ?? [];
  return round.reconciled.replies.flatMap((reply) => {
    const root = roots.find((r) => r.findingId === reply.findingId);
    // An answer is its reason alone: with none, there is nothing to say (`core` always gives one). Hidden characters
    // say nothing either: the filter removes them, so the posts owed and the posts sent agree.
    const silent = reply.kind === "answered" && hiddenRemoved(reply.why).trim() === "";
    return root && !silent ? [{ reply, root }] : [];
  });
}

/** What the round minimizes once its check completes: the requests it answered, the roots of findings it withdrew. */
function tidiedOf(round: PlacedRound): string[] {
  const withdrawn = repliesOf(round).flatMap(({ reply, root }) =>
    reply.kind === "withdrawn" || reply.kind === "dismissed" ? [root.nodeId] : [],
  );
  return [...new Set([...(round.requests ?? []), ...withdrawn])];
}

/**
 * The posts a round owes, in the order they are sent (ADR 0039, ADR 0044, ADR 0052, ADR 0074): the check in progress
 * (created only when the job has none), the review when the round has a line comment, a reply on each thread the
 * round answers, the status block, the check completed, then each comment it minimizes. What the caller saves as owed
 * before the first is sent.
 */
export function postsOf(round: PlacedRound): PostKind[] {
  const owesReview = commentedIn(round, placedOf(round, false)).length > 0;
  return [
    "check",
    ...(owesReview ? ["review" as const] : []),
    ...repliesOf(round).map(({ reply }): PostKind => `reply:${reply.findingId}`),
    "status",
    "completed",
    ...tidiedOf(round).map((nodeId): PostKind => `minimize:${nodeId}`),
  ];
}

/**
 * The refusals of a reply that stand and never fail the round: its thread's root deleted (404), or a reply GitHub
 * finds invalid (422). Any other, a lost token say, stops the round like any post's.
 */
const STANDING_REPLY_REFUSALS: ReadonlySet<HostFailure> = new Set(["not_found", "invalid"]);

/**
 * `post`, a host refusal that `stands` said (`say`) instead of thrown: the round goes on. Anything else propagates.
 */
async function unless(
  post: () => Promise<unknown>,
  stands: (failure: HostFailure) => boolean,
  say: (error: HostError) => void,
): Promise<void> {
  try {
    await post();
  } catch (error) {
    if (!(error instanceof HostError && stands(error.failure))) throw error;
    say(error);
  }
}

/**
 * The posts a dismissal owes, in the order they are sent (ADR 0052): the reply on the finding's thread, the status
 * block, the round's check when it is rewritten (`checkId`), then the thread's root minimized. What the caller saves
 * as owed before the first is sent.
 */
export function dismissalPostsOf(checkId: string | null): DismissalPostKind[] {
  return ["reply", "status", ...(checkId === null ? [] : ["completed" as const]), "minimize"];
}

/**
 * An outbox's posts as saved, and its marks: a round's (`Outbox`), which hears its waits too, or a dismissal's
 * (`DismissalOutbox`).
 */
interface Marks<K extends string> {
  readonly posts: readonly { kind: K; hostId: string | null; tries: number }[];
  sending(kind: K): void;
  sent(kind: K, hostId: string, commented?: readonly FindingId[]): void;
  waiting?(wait: PostWait | null): void;
}

/**
 * How `outbox`'s posts are sent: `send(kind, post, held, commented)` sends `kind` unless it was sent; once begun
 * before (the host may hold it with no answer kept), `held` looks for it first. Each post is marked sent before the
 * next is begun. A transient refusal tries again, looking first. `saved(kind)`: the post as the outbox held it when
 * this began.
 */
function sender<K extends string>(
  outbox: Marks<K>,
  time: PostTime | undefined,
  signal: AbortSignal | undefined,
) {
  const saved = (kind: K) => outbox.posts.find((p) => p.kind === kind) ?? { kind, hostId: null, tries: 0 };
  /** The posts whose send began here: the outbox's `posts` is as it was when this began. */
  const begun = new Set<K>();
  const send = (
    kind: K,
    post: () => Promise<string>,
    held?: () => Promise<string | null>,
    commented?: () => readonly FindingId[],
  ): Promise<string> =>
    persist(
      async () => {
        const { hostId, tries } = saved(kind);
        if (hostId !== null) return hostId;
        const found = (tries > 0 || begun.has(kind)) && held ? await held() : null;
        if (found !== null) {
          outbox.sent(kind, found, commented?.());
          return found;
        }
        outbox.sending(kind);
        begun.add(kind);
        const id = await post();
        outbox.sent(kind, id, commented?.());
        return id;
      },
      time,
      signal,
      (wait) => outbox.waiting?.(wait),
    );
  return { send, saved };
}

/**
 * The check's completed output for `round` as placed, with its result: the headline cut short when a file's name
 * makes it too long, the findings that fit the check, and the threads `read` names (none when null).
 */
function completedOf(
  round: RoundToPost,
  placed: ActedOn[],
  read: HostThread[] | null,
): { output: CheckOutput; result: ReviewResult } {
  const left = (result: ReviewResult) => round.reconciled.findings.length - result.findings.length;
  const fits = (result: ReviewResult) => utf8Bytes(checkText(result, left(result))) <= CHECK_OUTPUT_MAX_BYTES;
  const { result } = buildResult(round, placed, clip(headline(round), RESULT_HEADLINE_MAX_BYTES), fits, read);
  return { output: checkCompleted(round, result, left(result)), result };
}

/**
 * The refusals of a status block that stand and never fail the round (ADR 0074): the person may not edit the
 * description (403, `invalid`), or it is too long for GitHub. Any other stops the round like any post's.
 */
const STANDING_STATUS_REFUSALS: ReadonlySet<HostFailure> = new Set(["invalid", "too_large"]);

/** A status block's post id: the description it is in has none of its own. */
const DESCRIBED = "description";

/** The URL of each finding's newest thread among `read`. */
function linksOf(read: readonly HostThread[]): StatusRound["threads"] {
  return [...new Set(read.map((t) => t.findingId))].flatMap((findingId) => {
    const thread = newestThread(read, findingId);
    return thread === undefined ? [] : [{ findingId, url: thread.url }];
  });
}

/**
 * `round` posted, as its status block says it with no reader of the change's status: its ledger, the findings it
 * posts holding a comment of its review when `commented` names them (as the store marks them once it lands), and
 * the threads `threads` links.
 */
function postedOf(
  round: PlacedRound,
  commented: readonly FindingId[],
  threads: StatusRound["threads"],
): Status {
  const ids = new Set(commented);
  const posting = new Set(round.reconciled.post.map((f) => f.id));
  return {
    kind: "posted",
    posted: {
      n: round.round,
      sha: round.sha,
      base: round.base,
      rounds: [...round.rounds.filter((r) => r.n !== round.round), { n: round.round, sha: round.sha }],
      findings: round.reconciled.findings.map((f) =>
        posting.has(f.id) ? { ...f, commented: ids.has(f.id) } : f,
      ),
      loop: round.reconciled.loop,
      threads,
    },
  };
}

/** A dismissal's outbox nobody keeps: every post owed. */
const freshDismissalOutbox = (): DismissalOutbox => ({ posts: [], sending: () => {}, sent: () => {} });

/** The machine's offset from UTC at an instant, in minutes east. */
const machineOffset = (at: number): number => -new Date(at).getTimezoneOffset();

export function createPublisher({
  writer,
  threads,
  time,
  log = () => {},
  offset = machineOffset,
  person,
  lookovers,
  secretsRemoved,
  status: current,
}: PublisherOptions): Publisher {
  /**
   * The round as it is posted (ADR 0056): every text an engine or a person wrote filtered once, as `publish` receives
   * it, so the review, the replies, the status block, the check and the result all show the same; the caller keeps the raw.
   * `placing`: its findings placed on their paths as given, so a comment goes where the diff names its file, and shown
   * filtered, their paths too.
   */
  const text = (t: string) => postableText(t, secretsRemoved);
  /** A new filter of findings: each finding filtered once however often it is given. */
  const findingsFiltered = () => findingFilter({ text, path: (p) => postablePath(p, secretsRemoved) });
  const postable = <R extends PlacedRound>(given: R) => {
    const finding = findingsFiltered();
    const placing = (refused: boolean): ActedOn[] =>
      placementOf(given, refused).map((p) => ({ ...p, finding: finding(p.finding) }));
    return { round: filteredRound(given, text, finding), placing };
  };
  /**
   * A reply of this round already on the host, found by its marker among Lookover's replies in the threads (ADR 0066:
   * a teammate's copy of it is never Lookover's): its id, or null when none holds it (or there is no reader to look
   * with).
   */
  const sentReply = async (change: ChangeRef, marker: string): Promise<string | null> => {
    if (!threads || !lookovers) return null;
    const [read, isLookovers] = await Promise.all([threads(change), lookovers(change)]);
    const found = read.flatMap((t) => t.replies).find((r) => isLookovers(r) && r.body.includes(marker));
    return found === undefined ? null : String(found.commentId);
  };
  /**
   * The change's Lookover threads for the result (ADR 0052): null without a reader, or when the host's refusal
   * stands (the result then names no thread: the check is never held back for them). The signal's abort propagates.
   */
  const threadsOf = async (
    change: ChangeRef,
    signal: AbortSignal | undefined,
    waiting?: (wait: PostWait | null) => void,
  ): Promise<HostThread[] | null> => {
    if (!threads) return null;
    try {
      return await persist(() => threads(change), time, signal, waiting);
    } catch (error) {
      if (error instanceof HostError) return null;
      throw error;
    }
  };
  /** The status block for `status` within `room`, the findings' words as the round's posts show them (ADR 0056). */
  const blockOf = (change: ChangeRef, status: Status, room: number): string | null => {
    // A running round lists nothing; the others list a posted round's findings, filtered.
    if (status.kind === "running") return statusBlock(change, status, room, offset);
    const finding = findingsFiltered();
    const filtered = (posted: StatusRound): StatusRound => ({
      ...posted,
      findings: posted.findings.map(finding),
    });
    const shown: Status =
      status.kind === "posted"
        ? { ...status, posted: filtered(status.posted) }
        : { ...status, posted: status.posted && filtered(status.posted) };
    return statusBlock(change, shown, room, offset);
  };
  /**
   * Writes the change's status block (ADR 0074), rendered as the description is read, from where the change stands
   * then: the caller's `current`, else `given` (the round being posted). Nothing for a pull request Lookover skips;
   * nothing either when even the block's heading doesn't fit, said in the log. The block has no id of its own: its
   * post's is `DESCRIBED`.
   */
  const described = async (
    change: ChangeRef,
    read: HostThread[] | null,
    given: (threads: StatusRound["threads"]) => Status,
  ): Promise<string> => {
    const links = linksOf(read ?? []);
    await writer.upsertStatus(change, (room) => {
      const now = current ? current(change, links) : given(links);
      if (now === null) return null;
      const block = blockOf(change, now, room);
      if (block === null)
        log(`${changeName(change)}: no status block: the description leaves ${room} characters`);
      return block;
    });
    return DESCRIBED;
  };
  /** A status block refused for good is said, and the round goes on: it landed all the same. */
  const describing = (change: ChangeRef, write: () => Promise<unknown>) =>
    unless(
      write,
      (failure) => STANDING_STATUS_REFUSALS.has(failure),
      (error) => log(`${changeName(change)}: no status block: ${error.failure}: ${error.message}`),
    );
  /** Minimizes a comment as `resolved`: its global id is the post's id. */
  const minimized = async (change: ChangeRef, nodeId: string): Promise<string> => {
    await writer.minimize(change.repo, nodeId, "resolved");
    return nodeId;
  };
  return {
    async publish(given, outbox = freshOutbox(), signal) {
      const { round, placing } = postable(given);
      const { change, reconciled } = round;
      /**
       * The findings placed, with who acts on each: when the host refused a comment, the round's in the status block;
       * past the review's most comments, the least urgent in the block.
       */
      // Checked before the first post: a round `core` left incomplete posts nothing.
      let placed = placing(outbox.degraded);
      const { send, saved } = sender<PostKind>(outbox, time, signal);
      // The job's check, in progress since the run started, is the round's: created only when it has none, and
      // looked for by its external id (the job's and the person's) first when a create began whose answer was lost.
      const externalId = checkExternalId(round.run.job, person());
      const checkId = await send(
        "check",
        async () => {
          if (round.checkId !== null) return round.checkId;
          return writer.createCheck(
            change.repo,
            round.sha,
            "in_progress",
            checkInProgress(round),
            externalId,
          );
        },
        () => writer.findCheck(change.repo, round.sha, externalId),
      );
      /** The round's findings the review holds a comment on, as it was sent. */
      const commented = () => commentedIn(round, placed);
      // The review, only with a line comment (ADR 0074). Refused for a comment the host can't place, it is not sent
      // again: its findings go in the status block, kept in the outbox first so the block and a restart say the same.
      let reviewId: string | null = null;
      if (commented().length > 0) {
        try {
          reviewId = await send(
            "review",
            () => writer.publishReview(change, renderReview(round, placed)),
            () => writer.findReview(change, reviewMarker(round)),
            commented,
          );
        } catch (error) {
          if (!unplaceable(error)) throw error;
          outbox.degrade();
          placed = placing(true);
        }
      }
      // The replies on the threads (ADR 0052), each once: one begun before is looked for by its marker first. A
      // thread GitHub no longer has, or a reply it finds invalid, is said, and the round goes on.
      for (const { reply, root } of repliesOf(round)) {
        await unless(
          () =>
            send(
              `reply:${reply.findingId}`,
              () => writer.reply(change, root.commentId, renderReply(round, reply)),
              () => sentReply(change, replyMarker(round, reply.findingId)),
            ),
          (failure) => STANDING_REPLY_REFUSALS.has(failure),
          (error) =>
            log(
              `${changeName(change)}: no reply on ${reply.findingId}'s thread: ${error.failure}: ${error.message}`,
            ),
        );
      }
      // The threads, read once for the status block and the check (not once both were sent): the block links each
      // finding's, the result names it. A transient refusal is tried again like a post; one that stands leaves them out.
      const read = (["status", "completed"] as const).some((kind) => saved(kind).hostId === null)
        ? await threadsOf(change, signal, (wait) => outbox.waiting(wait))
        : null;
      // The status block (ADR 0074): its send begun lands a round with no review, whatever GitHub answers.
      await describing(change, () =>
        send("status", () => described(change, read, (links) => postedOf(given, commented(), links))),
      );
      const { output, result } = completedOf(round, placed, read);
      await send("completed", async () => {
        await writer.completeCheck(change.repo, checkId, reconciled.conclusion, output);
        return checkId;
      });
      // What the round settled, tidied once its check completed: a refusal that stands is said, and the rest go on.
      for (const nodeId of tidiedOf(round)) {
        await unless(
          () => send(`minimize:${nodeId}`, () => minimized(change, nodeId)),
          () => true,
          (error) =>
            log(`${changeName(change)}: ${nodeId} not minimized: ${error.failure}: ${error.message}`),
        );
      }
      return { checkId, reviewId, result };
    },
    async dismiss(dismissal, outbox = freshDismissalOutbox(), signal) {
      const { round, placing } = postable<RoundToPost>({ ...dismissal.round, checkId: dismissal.checkId });
      const { change } = round;
      const placed = placing(dismissal.degraded);
      const { send } = sender<DismissalPostKind>(outbox, time, signal);
      // One read finds the finding's thread (the newest, if two) and names the threads in the check's result.
      const read = await threadsOf(change, signal);
      const root = newestThread(read ?? [], dismissal.findingId);
      const marker = dismissalMarker(dismissal.id, dismissal.findingId);
      const said = (what: string) => (error: HostError) =>
        log(`${changeName(change)}: ${what} on ${dismissal.findingId}: ${error.failure}: ${error.message}`);
      if (root)
        await unless(
          () =>
            send(
              "reply",
              () =>
                writer.reply(
                  change,
                  root.commentId,
                  renderReply(round, { findingId: dismissal.findingId, kind: "dismissed", why: "" }, marker),
                ),
              () => sentReply(change, marker),
            ),
          (failure) => STANDING_REPLY_REFUSALS.has(failure),
          said("no dismissal said"),
        );
      await describing(change, () =>
        send("status", () => described(change, read, (links) => postedOf(dismissal.round, [], links))),
      );
      const { checkId } = dismissal;
      if (checkId !== null) {
        const { output } = completedOf(round, placed, read);
        await send("completed", async () => {
          await writer.completeCheck(change.repo, checkId, round.reconciled.conclusion, output);
          return checkId;
        });
      }
      if (root)
        await unless(
          () => send("minimize", () => minimized(change, root.nodeId)),
          () => true,
          said("root not minimized"),
        );
    },
    async findReview(given) {
      // Placed as `publish` placed it: the round filtered the same way (a round that owes a review never degraded).
      const { round, placing } = postable(given);
      const reviewId = await writer.findReview(round.change, reviewMarker(round));
      return reviewId === null ? null : { reviewId, commented: commentedIn(round, placing(false)) };
    },
    check: (job, created = () => {}) => follow(writer, job, created, offset, person),
    async status(change) {
      const now = current?.(change, []) ?? null;
      if (now === null) return;
      // The threads only for a block that lists findings: a running round's lists none.
      const listed = now.kind === "posted" || (now.kind !== "running" && now.posted !== null);
      // A read refused leaves the findings unlinked: the block is written all the same.
      const read =
        listed && threads
          ? await threads(change).catch((error: unknown) => {
              if (error instanceof HostError) return null;
              throw error;
            })
          : null;
      await describing(change, () => described(change, read, () => now));
    },
    statusBlock: blockOf,
  };
}
