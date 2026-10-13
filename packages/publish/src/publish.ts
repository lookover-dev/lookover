// The check following its job (ADR 0043), and one round, posted in the fixed order of ADR 0039 through the
// `HostWriter` port: the check in progress (created here only when the job has none), the review with its inline
// comments, the summary comment, the check completed with the result. The result's text is measured in bytes
// against `CHECK_OUTPUT_MAX_BYTES` before it is sent (ADR 0022). Each post is tried again after a transient refusal
// (`retry.ts`), and a review with a comment the host can't place is sent once more, its findings in the summary.
import {
  CHECK_OUTPUT_MAX_BYTES,
  type ChangeRef,
  type CheckOutput,
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
import { cap, degrade, placeFindings } from "./place.ts";
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
  renderSummary,
  replyMarker,
  reviewMarker,
} from "./render.ts";
import { type ActedOn, buildResult, endedResult, withActors } from "./result.ts";
import { persist } from "./retry.ts";
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
): Promise<string> {
  const { repo } = job.change;
  const { standing } = job;
  const create = async (status: OpenCheckStatus, output: CheckOutput): Promise<string> => {
    const id = await writer.createCheck(repo, job.sha, status, output, job.job.id);
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
 * The round's findings placed as its posts show them, with who acts on each. What it posts whose lines are of
 * another commit (withheld by a round given up, and a push since) is found again by its line's text; `refused`:
 * the host refused a comment, so the round's go into the summary; past the review's most comments, the least
 * urgent go there too. Throws for a finding `core` gave nobody to act on.
 */
function placementOf(round: PlacedRound, refused: boolean): ActedOn[] {
  const { reconciled } = round;
  const posting = new Set(reconciled.post.map((f) => f.id));
  const commitOf = new Map(round.rounds.map((r) => [r.n, r.sha]));
  const moved = new Set(
    reconciled.post
      .filter((f) => f.anchoredIn !== round.round && commitOf.get(f.anchoredIn) !== round.sha)
      .map((f) => f.id),
  );
  const found = placeFindings(indexDiff(round.diff), reconciled.findings, posting, moved);
  return withActors(
    cap(refused ? degrade(found, posting) : found, posting, REVIEW_MAX_COMMENTS),
    reconciled.actionBy,
  );
}

/** The round's findings its review holds a comment on, placed so. */
const commentedIn = (round: PlacedRound, placed: ActedOn[]): FindingId[] => {
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
 * The posts a round owes, in the order they are sent (ADR 0039, ADR 0044, ADR 0052): the check in progress
 * (created only when the job has none), the review, a reply on each thread the round answers, the summary comment,
 * the check completed, then each comment it minimizes. What the caller saves as owed before the first is sent.
 */
export function postsOf(round: PlacedRound): PostKind[] {
  return [
    "check",
    "review",
    ...repliesOf(round).map(({ reply }): PostKind => `reply:${reply.findingId}`),
    "summary",
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

const nameOf = (change: ChangeRef) => `${change.repo.owner}/${change.repo.name}#${change.number}`;

/**
 * The posts a dismissal owes, in the order they are sent (ADR 0052): the reply on the finding's thread, the summary,
 * the round's check when it is rewritten (`checkId`), then the thread's root minimized. What the caller saves as owed
 * before the first is sent.
 */
export function dismissalPostsOf(checkId: string | null): DismissalPostKind[] {
  return ["reply", "summary", ...(checkId === null ? [] : ["completed" as const]), "minimize"];
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
  secretsRemoved,
}: PublisherOptions): Publisher {
  /**
   * The round as it is posted (ADR 0056): every text an engine or a person wrote filtered once, as `publish` receives
   * it, so the review, the replies, the summary, the check and the result all show the same; the caller keeps the raw.
   * `placing`: its findings placed on their paths as given, so a comment goes where the diff names its file, and shown
   * filtered, their paths too.
   */
  const postable = <R extends PlacedRound>(given: R) => {
    const text = (t: string) => postableText(t, secretsRemoved);
    const finding = findingFilter({ text, path: (p) => postablePath(p, secretsRemoved) });
    const placing = (refused: boolean): ActedOn[] =>
      placementOf(given, refused).map((p) => ({ ...p, finding: finding(p.finding) }));
    return { round: filteredRound(given, text, finding), placing };
  };
  /**
   * A reply of this round already on the host, found by its marker among the bot's replies in the threads: its id,
   * or null when none holds it (or there is no reader to look with).
   */
  const sentReply = async (change: ChangeRef, marker: string): Promise<string | null> => {
    if (!threads) return null;
    const found = (await threads(change))
      .flatMap((t) => t.replies)
      .find((r) => r.author.bot && r.body.includes(marker));
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
       * The findings placed, with who acts on each: when the host refused a comment, the round's in the summary; past
       * the review's most comments, the least urgent in the summary.
       */
      let degraded = outbox.degraded;
      // Checked before the first post: a round `core` left incomplete posts nothing.
      let placed = placing(degraded);
      const { send, saved } = sender<PostKind>(outbox, time, signal);
      /**
       * The review; refused for a comment the host can't place, sent once more with every finding of the round in
       * the summary, kept in the outbox first so the summary and a restart say the same.
       */
      const review = async (): Promise<string> => {
        try {
          return await writer.publishReview(change, renderReview(round, placed));
        } catch (error) {
          if (degraded || !unplaceable(error)) throw error;
          outbox.degrade();
          degraded = true;
          placed = placing(true);
          return writer.publishReview(change, renderReview(round, placed));
        }
      };
      // The job's check, in progress since the run started, is the round's: created only when it has none, and
      // looked for by the job's id first when a create began whose answer was lost.
      const checkId = await send(
        "check",
        async () => {
          if (round.checkId !== null) return round.checkId;
          return writer.createCheck(
            change.repo,
            round.sha,
            "in_progress",
            checkInProgress(round),
            round.run.job,
          );
        },
        () => writer.findCheck(change.repo, round.sha, round.run.job),
      );
      /** The round's findings the review holds a comment on, as it was sent. */
      const commented = () => commentedIn(round, placed);
      const reviewId = await send(
        "review",
        review,
        () => writer.findReview(change, reviewMarker(round)),
        commented,
      );
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
              `${nameOf(change)}: no reply on ${reply.findingId}'s thread: ${error.failure}: ${error.message}`,
            ),
        );
      }
      const summaryId = await send("summary", () =>
        writer.upsertSummary(change, renderSummary(round, placed)),
      );
      // The threads, read once as the check is completed (not when it already was): the result names each
      // finding's. A transient refusal is tried again like a post; a refusal that stands leaves them out.
      const read =
        saved("completed").hostId === null
          ? await threadsOf(change, signal, (wait) => outbox.waiting(wait))
          : null;
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
          (error) => log(`${nameOf(change)}: ${nodeId} not minimized: ${error.failure}: ${error.message}`),
        );
      }
      return { checkId, reviewId, summaryId, result };
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
        log(`${nameOf(change)}: ${what} on ${dismissal.findingId}: ${error.failure}: ${error.message}`);
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
      await send("summary", () => writer.upsertSummary(change, renderSummary(round, placed)));
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
    async findReview(given, degraded) {
      // Placed as `publish` placed it: the round filtered the same way.
      const { round, placing } = postable(given);
      const reviewId = await writer.findReview(round.change, reviewMarker(round));
      return reviewId === null ? null : { reviewId, commented: commentedIn(round, placing(degraded)) };
    },
    check: (job, created = () => {}) => follow(writer, job, created, offset),
  };
}
