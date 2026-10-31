// The poller (ADR 0043, ADR 0053): each watched repository's open changes, listed by the service itself, and what
// changed since the last listing turned into events and handed to the queue. One for the room, beside the queue: one
// loop goes over every repository watched, one after the other (GitHub asks for serial requests), each at its own
// cadence; a repository switched off is polled all the same (its `/lookover review` is recorded as a skip, ADR 0047).
// - Each poll of a repository lists the open changes and compares them with the inbox (the last listing, kept in the
//   store), never with the host's "unchanged" answer: the listing is shared with every other reader of the adapter. A change new
//   to the inbox is `change.opened` and the queue's `opened` (`core.intake` with the "opened" trigger); a draft
//   listed ready is `change.opened` again (the UI keeps its review) and `opened` too; a moved head is
//   `change.pushed` with the commits GitHub's compare counts between the two heads (0 when it can't: the timeline
//   then says "pushed new commits"), and the queue's `pushed`; a change no longer listed is `change.closed`, its
//   waiting job left to the next take, which cancels it. The first listing of a repository (a fresh data folder) only
//   shows what is open: nothing was asked of what was there before Lookover watched it.
// - Who wrote each change (ADR 0044) is read from GitHub's compares: `core.writerOf` over the messages of the commits
//   since the last read (their `Co-authored-by` trailers), the writer kept and the branch prefix. The inbox keeps it
//   with the head commit it was read through: a change opened is read from its base, a push from where the last read
//   stopped, which is the compare the push's count already asks for unless a read failed. A compare that fails reads
//   nothing: the change stays unread from the same commit, and the next poll compares again. The queue's round plan
//   reads the writer kept; a change opened carries it in `change.opened`, and a writer changed later (a push signed
//   by another agent, a read that failed before) sends the change again as `change.opened`, after any
//   `change.pushed` (the UI keeps its review and its counts). At most 4 compares run at once (a first listing reads
//   every open change); one refused as rate limited waits as a listing refused so does, and the compares left and the
//   comments wait for the next poll. GitHub's compare gives the oldest 100 commits of its range (`CommitCount.messages`): on a
//   push of more than 100 the newest signal may be missed, and the writer kept, or the branch's, decides.
// - Then the repository's conversation comments, kept track of in the store (ADR 0043): listed from a minute before
//   the newest comment time seen (GitHub may list a comment late, behind newer ones), never from before the floor,
//   the first poll's "now" on a fresh data folder: what was written before Lookover watched is no request. That "now"
//   is GitHub's (when it answered the poll's listing of the changes, its `Date`), so this machine's clock, ahead or
//   behind, never moves the line: every time the poll compares is GitHub's. A comment GitHub lists twice (its pages
//   shift when one is edited between two reads) counts once, as last edited. Each
//   comment written since where the poll lists from and not handled yet is handled once, after a restart too; a
//   review request (`readRequest`) the owner wrote (by numeric id: never the App, nor anyone else) on an open
//   change goes to the queue's `requested`, oldest first, saying whether it asks for a full round
//   (`/lookover review full`, ADR 0052). A request on a commit already reviewed is a new round all the same. An
//   edit is not a request: an old comment edited was written before where the poll lists from, and one the poll already looked at is handled. The one exception: a comment
//   written and then edited between two polls counts with its text when the poll first sees it. A comment on a
//   number the changes listed don't have is left for the next poll while it was written within the overlap before
//   that listing: its pull request may have opened since (GitHub's comments don't tell a pull request from an
//   issue). Older, it is on an issue or a closed pull request, no open change: handled, so a pull request reopened
//   later never turns it into a request. The place then moves to the newest comment time listed, and what GitHub is
//   owed is sent again now that it answers: the reactions on requests, and the checks' ends it refused before.
// - Polls run one at a time, in the order asked: the loop's, "Refresh", "Review now" (its change's repository only)
//   and the demo's scripted push all go through `poll`, so the inbox has one writer and a push is counted once.
//   `poll` says whether it saw anything; the caller takes then (the loop does after each poll that saw something).
// - The loop wakes every 10 s and polls each repository whose poll is due: every 10 s while it is hot, every 60 s
//   otherwise (`core.pollEvery`: a review of one of its changes asked, waiting or running, or a round of one posted
//   in the last 30 minutes). The rate limit is the installation's, one for every repository: a listing refused as
//   rate limited waits until the time GitHub gave (a minute when it gave none), and the connection says so
//   (`limitUntil`) until a listing answers again; meanwhile the loop asks GitHub nothing, of any repository, and a
//   poll stops at the repository that met it. A refusal that is the installation's (the key refused, a cause the
//   adapter named: the App uninstalled or suspended) stops a poll too: the repositories after it wait for the next
//   one. GitHub unavailable, or not finding one repository, is that repository's: the others are asked all the same,
//   so one answering 5xx at every poll never starves those after it.
// - The connection (ADR 0047, ADR 0053) is the installation's, one for every repository: a listing of the changes
//   refused for the installation (unauthorised, or a cause the adapter named: the App uninstalled, refused as not
//   found, or suspended) shows it `disconnected` with that cause, since now; GitHub unavailable shows it so (GitHub
//   unreachable) only once every repository watched was last refused so, never because one answers 5xx while
//   another answers. A listing that answers shows it `connected` again, since now; a poll that brought it back counts
//   as one that saw something, so the loop takes and what waited on the host starts, and the installation's
//   repositories are listed again (`discover`: a reinstall gives a new installation). A rate limit is no
//   disconnection. A connection not made yet (no bot) is left alone, and the loop doesn't poll: the setup flow
//   reports it, and lists once the bot is installed. What a listing of the installation's repositories met is told
//   too (`reached`): a refusal that is the installation's (uninstalled, suspended, the key refused) shows the
//   connection down even while it was up, GitHub unreachable only when no repository is watched or it is down already;
//   an answer shows it back when no repository is watched, so a service that started while GitHub refused it comes
//   back, and one with nothing to poll never stays connected to an installation that is gone.
// - Every account at once (ADR 0066): a listing refused with the cause `uninstalled` or `sso`, the rule by kind, is
//   the repository's account's when the installation takes it (`accountRefused`, on the shared App): that account
//   shows the cause, the connection stays as it is, and the poll goes on to the repositories after it, its other
//   accounts still used. A listing that answers clears its account's cause (`accountAnswered`), and counts as one
//   that saw something then, as the connection back does. A refusal of a repository whose account holds a cause
//   already (a suspension discovery read, refused with no cause of its own) is that account's too. Such a repository
//   is polled at the cadence of one with nothing asked: what it waits for waits on its account. On an own App every
//   cause stays the connection's.
// - A repository's listing refused as not found with no cause (its token refused: it may have left the installation)
//   has the installation's repositories listed again at once (`discover`), not at the next 5-minute listing; once a
//   minute at most, as a repository the installation still lists is refused so at every poll of it.
// Errors: what a listing throws reaches `poll`'s caller ("Refresh", "Review now", "Reconnect"), once the repositories
// after it were polled (unless it was a rate limit or the installation's), the first error of the poll (an account's
// refusal only logged: its account says it); the loop logs
// each and polls again when the next one is due. The first poll at start (`first`) never throws: it logs what each
// listing threw, the connection showing the cause, so the service starts. A compare that fails is a count of 0
// and no writer read, never an error. A comments listing that fails is logged (a rate limit kept as GitHub's wait, as the listing's), the changes already
// seen stand, and the next poll lists the comments from the same place.
// Once stopping, nothing is armed, and `stop` waits for the poll under way. A repository no longer watched (it left
// the installation while its poll was under way) is polled no further: what GitHub answered of it is dropped.
// Whose poll it is (ADR 0066): a poll begins under the sign-in or App held then (`holding`). Every wait on GitHub is
// `answered`'s, which asks nothing and returns nothing once another is held, and every other wait of the poll is
// followed by `still`: past each, another held since ends the poll there (`Superseded`), before anything GitHub
// answered changes the connection, an account, GitHub's wait, the inbox or the requests, and before anything more is
// asked. What it ended is no error: nothing is logged or thrown, and the repository is polled as if it hadn't been.
// (No wait is wrapped twice: the queue's and the checks' tests count on how many turns a poll takes.)
// It must never know: what a job is or when one runs (the queue's), the rules (`core`'s), or which reactions are owed
// (the store's and `reactions`').

import {
  type AccountCause,
  accountOf,
  type ChangeId,
  type Clock,
  type CommitCount,
  type CommitSha,
  type Connection,
  type ConnectionCause,
  changeIdOf,
  changePrefixOf,
  connectionCauseOf,
  type EventBody,
  type HostChange,
  type HostConversationComment,
  HostError,
  type HostIntake,
  type Listing,
  type Repository,
  type RepositoryId,
  type RepositoryRef,
  type ReviewRequestText,
  readRequest,
  sameRepository,
} from "@lookover/contracts";
import { pollEvery, writerOf } from "@lookover/core";
import type { CommentPlace, OpenChange, RequestComment, Store, WriterRead } from "@lookover/store";
import { said } from "./said.ts";
import { changeOf, repoIdOf } from "./snapshot.ts";
import type { Timers } from "./timers.ts";

/** How often the loop wakes: the hot cadence, `pollEvery`'s shortest. */
const WAKE_MS = 10_000;
/** How long a rate-limited listing waits when GitHub gave no time. */
const LIMIT_MS = 60_000;
/** How far behind the newest comment time seen the comments are listed again: GitHub may list one late. */
const OVERLAP_MS = 60_000;

/** Where the comments are listed from: the overlap behind the newest seen, never before the first place. */
const listedFrom = (place: CommentPlace): number => Math.max(place.floor, place.newest - OVERLAP_MS);

/**
 * Whether a listing's failure is a disconnection (ADR 0047, ADR 0053): one that gives the connection a cause
 * (`connectionCauseOf`), GitHub unreachable or refusing the key, or the cause the adapter named (the App uninstalled,
 * refused as not found); a rate limit or anything else is not.
 */
export const disconnects = (error: unknown): error is HostError =>
  error instanceof HostError && connectionCauseOf(error) !== null;

/**
 * Whether a listing's failure is the installation's, not one repository's: the key refused, or a cause the adapter
 * named (the App uninstalled or suspended). GitHub unavailable may be one repository's answer: the others are asked.
 */
const installationWide = (error: unknown): error is HostError =>
  error instanceof HostError && (error.failure === "unauthorized" || error.connectionCause !== undefined);

export interface PollerDeps {
  store: Store;
  clock: Clock;
  timers: Timers;
  intake: HostIntake;
  /** The repositories watched now, in the order each poll goes over them. */
  repos(): readonly RepositoryRef[];
  /** A watched repository as the UI is told of it once first listed: with its switch and its settings. */
  repository(repo: RepositoryRef): Repository;
  /** The owner on the host: their changes are "you". */
  owner: { id: number };
  emit(body: EventBody): void;
  /** The connection as the UI shows it now: the service's in-memory copy. */
  connection(): Connection;
  /** The queue's: a change opened, or a draft marked ready, asks for a review as `core.intake` says. */
  opened(changeId: ChangeId): void;
  /** The queue's: a change pushed to `sha`, its waiting job moved there, and a review asked if the switch says. */
  pushed(changeId: ChangeId, sha: CommitSha): void;
  /**
   * The queue's: the owner's review request comment on an open change, recorded with the job it leads to; `full` when
   * it asks for a full round (`/lookover review full`, ADR 0052).
   */
  requested(changeId: ChangeId, request: RequestComment, full: boolean): void;
  /**
   * GitHub answered a poll: what it is owed is sent, the reactions on review requests (👀 for those just recorded,
   * any refused before) and the checks' ends it refused before (a job that failed while GitHub was down).
   */
  resend(): void;
  /** The queue's take, after a poll of the loop that saw something. */
  take(): void;
  /**
   * The installation's repositories listed again, not waited for (ADR 0053): a repository's listing refused as not
   * found with no cause (it may have left the installation), or the connection back after a disconnection (the
   * installation may have moved: a reinstall gives a new id). `why` tells which: a refusal's comes once a minute at
   * most, the connection back's at once.
   */
  discover(why: "refused" | "regained"): void;
  /** Which sign-in or App is held now (ADR 0066), as a number that moves when another is: what a listing began under. */
  holding(): number;
  /**
   * A listing of `repo` begun under the holding `at` refused with an account's cause (ADR 0066): true when its
   * account holds it (the shared App), or when it was an earlier holding's (nothing to say of the one held now);
   * false when it is the connection's (an own App).
   */
  accountRefused(repo: RepositoryRef, cause: AccountCause, at: number): boolean;
  /** A listing of `repo` begun under the holding `at` answered: true when that cleared its account's cause. */
  accountAnswered(repo: RepositoryRef, at: number): boolean;
  log(line: string): void;
}

export interface Poller {
  /**
   * Lists the open changes of `repo`, else of every repository watched, once, after any poll under way; true when it
   * saw anything change.
   */
  poll(repo?: RepositoryRef): Promise<boolean>;
  /**
   * The first poll at start, of every repository watched. Never throws (ADR 0053: the service starts when GitHub
   * refuses it): what each listing threw is logged, and the connection shows a disconnection as any poll does. A rate
   * limit is only a wait.
   */
  first(): Promise<void>;
  /**
   * What a listing of the installation's repositories met (ADR 0053): refused for the installation (the App
   * uninstalled or suspended, its key refused), the connection shows it down with that cause, connected or not;
   * GitHub unreachable, only when no repository is watched (otherwise their listings say) or it is down already, for
   * another cause; answered, the connection shows back when no repository is watched.
   */
  reached(cause: ConnectionCause | null): void;
  /** Starts the loop. */
  start(): void;
  /** Stops the loop and waits for the poll under way. */
  stop(): Promise<void>;
}

const pushKey = (number: number, from: CommitSha, to: CommitSha) => `${number} ${from} ${to}`;

/** A poll ended: another sign-in or App is held now than the one it began under (ADR 0066). Nothing is applied. */
class Superseded extends Error {}

/** The cause of a refusal when it is one account's by the rule by kind (ADR 0066): `uninstalled` or `sso`. */
const accountCauseOf = (error: unknown): AccountCause | null => {
  const cause = error instanceof HostError ? error.connectionCause : undefined;
  return cause?.kind === "uninstalled" || cause?.kind === "sso" ? cause : null;
};

/** What the compares of one poll said: the commits each push brought, and the writers read, by number. */
interface Compared {
  counts: Map<string, number>;
  writers: Map<number, WriterRead>;
}

/**
 * Where a listed change is compared from: the head before a push (null when its head didn't move), and where the
 * last read of its writer stopped, its base when never read (null when its head was read).
 */
function fromWhere(
  c: HostChange,
  was: OpenChange | undefined,
): { pushedFrom: CommitSha | null; readFrom: CommitSha | null } {
  const to = c.head.sha;
  if (was === undefined) return { pushedFrom: null, readFrom: c.base.sha };
  return {
    pushedFrom: was.head === to ? null : was.head,
    readFrom: was.writerThrough === to ? null : (was.writerThrough ?? c.base.sha),
  };
}

/** How many compares one poll runs at once: a first listing reads every open change. */
const COMPARES_AT_ONCE = 4;

/** Runs `work` on each item, at most `n` at once. */
async function atMost<T>(n: number, items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let item = items[next++]; item !== undefined; item = items[next++]) await work(item);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * Each comment once, as last edited: GitHub pages the comments by "last edited, newest first", so a comment edited
 * between two page reads moves the others down a place, and the one at a page's end is listed on the next page too.
 */
function eachOnce(listed: HostConversationComment[]): HostConversationComment[] {
  const byId = new Map<string, HostConversationComment>();
  for (const c of listed) {
    const kept = byId.get(c.id);
    if (kept === undefined || c.updatedAt > kept.updatedAt) byId.set(c.id, c);
  }
  return [...byId.values()];
}

export function createPoller(d: PollerDeps): Poller {
  const now = () => d.clock.now();
  /** The polls asked for, one after the other; never rejects. */
  let chain: Promise<unknown> = Promise.resolve();
  /** When each repository was last polled, by id; none before its first poll. */
  const lastPollAt = new Map<RepositoryId, number>();
  /** Until when GitHub asked to wait, for every repository (the installation's limit); null when it asks nothing. */
  let limitUntil: number | null = d.connection().limitUntil;
  let wake: (() => void) | null = null;
  let stopping = false;
  /**
   * The repositories whose last listing GitHub refused as unavailable, by id: GitHub is unreachable only once every
   * one watched is, never because one repository answers 5xx while the others answer.
   */
  const unavailable = new Set<RepositoryId>();
  /**
   * The refusals an account took or holds (ADR 0066): its cause given by this refusal, or held already (a suspension
   * discovery read). The poll goes on past them, and they are never thrown.
   */
  const ofAnAccount = new WeakSet<object>();

  /** Ends the poll begun under the holding `at` when another is held now: nothing more of it is applied or asked. */
  const still = (at: number): void => {
    if (d.holding() !== at) throw new Superseded();
  };

  /** Whether the account `repo` is on holds a cause of its own (ADR 0066): never on an own App. */
  const accountHeld = (repo: RepositoryRef): boolean =>
    (accountOf(d.connection().accounts, repo.owner)?.cause ?? null) !== null;

  /** The connection says until when GitHub asked to wait, or that it asks nothing any more. */
  const limited = (until: number | null) => {
    limitUntil = until;
    if (d.connection().limitUntil === until) return;
    d.emit({ type: "connection.changed", at: now(), patch: { limitUntil: until } });
  };

  /** Whether GitHub's wait is on now: nothing is asked of it until it ends. */
  const waiting = () => limitUntil !== null && now() < limitUntil;

  /**
   * What the host answers, asked under the holding `at` the poll began under; a rate-limited answer is kept as
   * GitHub's wait, and thrown. Every wait on GitHub is this one (ADR 0066): nothing is asked once another is held, and
   * what it answers or throws then is `Superseded`, nothing of it kept.
   */
  async function answered<T>(at: number, ask: () => Promise<T>): Promise<T> {
    still(at);
    let answer: T;
    try {
      answer = await ask();
    } catch (error) {
      still(at);
      // A reset time already past (the machine's clock ahead of GitHub's) still waits a wake: never a busy loop.
      if (error instanceof HostError && error.failure === "rate_limited")
        limited(Math.max(error.retryAt ?? now() + LIMIT_MS, now() + WAKE_MS));
      throw error;
    }
    still(at);
    if (limitUntil !== null) limited(null);
    return answer;
  }

  /**
   * The connection shows `state` and its cause (ADR 0053), since now, unless it does already; true when its state
   * changed. One not made yet (no bot) is left alone: there is nothing to lose or to regain. A connection still down
   * for another cause shows the new one, since it was first lost.
   */
  const connection = (state: "connected" | "disconnected", cause: ConnectionCause | null): boolean => {
    const shown = d.connection();
    if (shown.state === "not-connected") return false;
    if (shown.state === state) {
      if (!Bun.deepEquals(shown.cause, cause))
        d.emit({ type: "connection.changed", at: now(), patch: { cause } });
      return false;
    }
    const at = now();
    d.emit({ type: "connection.changed", at, patch: { state, cause, since: at } });
    return true;
  };

  /**
   * One compare from `from` to `to`; null when GitHub refused it, or a rate limit refused one before it in this poll
   * (kept as GitHub's wait, as a listing's is: the compares left wait for the next poll).
   */
  async function compare(
    repo: RepositoryRef,
    from: CommitSha,
    to: CommitSha,
    at: number,
  ): Promise<CommitCount | null> {
    if (limitUntil !== null) return null;
    try {
      return await answered(at, () => d.intake.countCommits(repo, from, to));
    } catch (error) {
      if (error instanceof Superseded) throw error;
      return null;
    }
  }

  /**
   * What GitHub's compares say of the changes listed: the commits each push brought, by change, from and to (0 for a
   * count GitHub couldn't give); and who wrote each change whose head was not read yet, from where the last read
   * stopped (its base for one never read): `core.writerOf`, the newest commit an agent signed, else the writer kept,
   * else the branch prefix. One compare serves both when they start from the same commit. A compare that fails reads
   * no writer: the change stays unread from the same commit.
   */
  async function compared(repo: RepositoryRef, listed: HostChange[], at: number): Promise<Compared> {
    const before = new Map(d.store.inbox.open(repo).map((c) => [c.number, c]));
    const into: Compared = { counts: new Map(), writers: new Map() };
    await atMost(COMPARES_AT_ONCE, listed, (c) => compareOne(repo, c, before.get(c.number), into, at));
    still(at);
    return into;
  }

  /** The compares one listed change needs, `was` being its row from the last listing; what they said goes `into`. */
  async function compareOne(
    repo: RepositoryRef,
    c: HostChange,
    was: OpenChange | undefined,
    into: Compared,
    at: number,
  ): Promise<void> {
    const to = c.head.sha;
    const { pushedFrom, readFrom } = fromWhere(c, was);
    const pushed = pushedFrom === null ? null : await compare(repo, pushedFrom, to, at);
    still(at);
    if (pushedFrom !== null) into.counts.set(pushKey(c.number, pushedFrom, to), pushed?.commits ?? 0);
    if (readFrom === null) return;
    const read = readFrom === pushedFrom ? pushed : await compare(repo, readFrom, to, at);
    still(at);
    if (read === null) return;
    const by = writerOf({ branch: c.head.ref, messages: read.messages, before: was?.writtenBy ?? null });
    into.writers.set(c.number, { by, through: to });
  }

  /**
   * The open changes as the host lists them now, and when the host answered, by its clock; and whether the answer
   * brought the connection back (the installation's repositories are then listed again). A refusal is told
   * (`refused`) before it is thrown. Begun under the holding `at`: one that answers once another is held says nothing,
   * of the connection, its accounts or when the repository was polled.
   */
  async function listed(
    repo: RepositoryRef,
    at: number,
  ): Promise<{ listing: Listing<HostChange>; regained: boolean }> {
    const id = repoIdOf(repo);
    try {
      const listing = await answered(at, () => d.intake.listOpenChanges(repo));
      still(at);
      lastPollAt.set(id, now());
      unavailable.delete(id);
      const regained = connection("connected", null);
      if (regained) d.discover("regained");
      // An account's cause cleared is something regained too: what waited on it starts.
      const accountBack = d.accountAnswered(repo, at);
      return { listing, regained: regained || accountBack };
    } catch (error) {
      if (error instanceof Superseded) throw error;
      lastPollAt.set(id, now());
      refused(repo, error, at);
      throw error;
    }
  }

  /**
   * What a listing's refusal says: the installation's shows the connection down at once, with its cause; GitHub
   * unavailable, once every repository watched was last refused so (any other refusal takes the repository out of
   * that count); not found with no cause, that the repository may have left the installation, which is listed again
   * (ADR 0053).
   */
  function refused(repo: RepositoryRef, error: unknown, at: number): void {
    const id = repoIdOf(repo);
    const accountCause = accountCauseOf(error);
    if (accountCause !== null && error instanceof HostError && d.accountRefused(repo, accountCause, at)) {
      ofAnAccount.add(error);
      unavailable.delete(id);
      return;
    }
    if (disconnects(error) && !installationWide(error)) {
      unavailable.add(id);
      if (d.repos().every((r) => unavailable.has(repoIdOf(r))))
        connection("disconnected", connectionCauseOf(error));
      return;
    }
    // Refused otherwise: no longer counted toward GitHub unreachable.
    unavailable.delete(id);
    if (installationWide(error)) connection("disconnected", connectionCauseOf(error));
    else if (error instanceof HostError && error.failure === "not_found") d.discover("refused");
  }

  /** What a comment asks, when it is a review request the owner wrote on an open change (ADR 0043); else null. */
  const requestOf = (c: HostConversationComment, open: ReadonlySet<number>): ReviewRequestText | null =>
    open.has(c.change) && c.author.id === d.owner.id ? readRequest(c.body) : null;

  /**
   * The comments listed from `from`: each written since then and not handled yet is handled now, the owner's review
   * requests on open changes, oldest first, handed to the queue; except one on a number the changes listed at
   * `hostNow` don't have, written within the overlap before that listing, which the next poll looks at again. The
   * place moves to the newest comment time listed. True when a request was handed over.
   */
  function handled(
    repo: RepositoryRef,
    listed: HostConversationComment[],
    place: CommentPlace,
    from: number,
    hostNow: number,
  ): boolean {
    const items = eachOnce(listed);
    // Written before where the poll lists from: an edit of an old comment, never a request.
    const fresh = items.filter((c) => c.createdAt >= from);
    const done = d.store.requests.handled(
      repo,
      fresh.map((c) => c.id),
    );
    const open = new Set(d.store.inbox.open(repo).map((c) => c.number));
    // On a number the changes listed don't have: a pull request opened after they were listed, an issue, or a closed
    // pull request (GitHub's comments don't say which). Written within the overlap before that listing, it waits for
    // the next poll, whose listing has a pull request opened since; older, it names no open change.
    const later = (c: HostConversationComment) => !open.has(c.change) && c.createdAt >= hostNow - OVERLAP_MS;
    const news = fresh
      .filter((c) => !done.has(c.id) && !later(c))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en", { numeric: true }));
    const requests = news.flatMap((c) => {
      const asks = requestOf(c, open);
      return asks === null ? [] : [{ c, full: asks.full }];
    });
    for (const { c, full } of requests) {
      const request: RequestComment = {
        repo,
        comment: { id: c.id, createdAt: c.createdAt },
        nodeId: c.nodeId,
      };
      d.requested(changeIdOf(repo, c.change), request, full);
    }
    const newest = items.reduce((at, c) => Math.max(at, c.updatedAt), place.newest);
    d.store.requests.seen(
      repo,
      news.map((c) => ({ id: c.id, createdAt: c.createdAt })),
      // What the next poll lists from: the comments that were no request before it are never looked at again.
      { newest, keepFrom: listedFrom({ newest, floor: place.floor }) },
    );
    return requests.length > 0;
  }

  /**
   * The repository's review requests since the poll's place, less the overlap (on a fresh data folder, from
   * `hostNow`, GitHub's time of this poll: what was written before Lookover watched is no request). True when one
   * was handed to the queue. What the listing throws is logged (a rate limit kept as GitHub's wait), and the next
   * poll lists from the same place.
   */
  async function requests(repo: RepositoryRef, hostNow: number, at: number): Promise<boolean> {
    let place = d.store.requests.place(repo);
    if (place === null) {
      d.store.requests.seen(repo, [], { newest: hostNow, keepFrom: hostNow });
      place = { newest: hostNow, floor: hostNow };
    }
    const from = listedFrom(place);
    let items: HostConversationComment[];
    try {
      items = (await answered(at, () => d.intake.listComments(repo, from))).items;
      still(at);
    } catch (error) {
      if (error instanceof Superseded) throw error;
      d.log(`the comments could not be listed: ${said(error)}`);
      return false;
    }
    return !gone(repo) && handled(repo, items, place, from, hostNow);
  }

  /**
   * Whether what GitHub answered about `repo` is to be dropped: the poller stops, and the store may be closed by
   * then; or the repository left the installation meanwhile (ADR 0053), and its rows are gone with it.
   */
  const gone = (repo: RepositoryRef): boolean => stopping || !d.repos().some((r) => sameRepository(r, repo));

  /** One repository's poll, begun under the holding `at`: true when it saw anything; `Superseded` once another is. */
  async function once(repo: RepositoryRef, at: number): Promise<boolean> {
    if (gone(repo)) return false;
    still(at);
    const { listing, regained } = await listed(repo, at);
    still(at);
    const read = await compared(repo, listing.items, at);
    still(at);
    if (gone(repo)) return false;
    const changed = recorded(repo, listing.items, read);
    // After the changes: a request on a pull request opened since the last poll is on an open change. A compare
    // refused as rate limited asked to wait: the comments wait for the next poll.
    const asked = limitUntil === null && (await requests(repo, listing.at, at));
    still(at);
    if (gone(repo)) return false;
    d.resend();
    // The connection back is something seen: the caller takes, and what waited on the host starts.
    return changed || asked || regained;
  }

  /** The listing kept in the inbox, what changed sent and handed to the queue; true when anything changed. */
  function recorded(repo: RepositoryRef, items: HostChange[], { counts, writers }: Compared): boolean {
    const at = now();
    const delta = d.store.inbox.replace(repo, items, at, writers);
    // The first listing of a repository: what was open before Lookover watched it is shown, not reviewed.
    const asking = !delta.repositoryAdded;
    if (delta.repositoryAdded) d.emit({ type: "repo.added", at, repo: d.repository(repo) });
    for (const entry of [...delta.opened, ...delta.ready]) {
      d.emit({ type: "change.opened", at, change: changeOf(entry, d.owner) });
      if (asking) d.opened(changeIdOf(repo, entry.change.number));
    }
    for (const entry of delta.pushed) {
      const changeId = changeIdOf(repo, entry.change.number);
      const sha = entry.change.head.sha;
      // Who pushed is not known yet: "you" until something tells an agent's push from the owner's.
      const count = counts.get(pushKey(entry.change.number, entry.from, sha)) ?? 0;
      d.emit({ type: "change.pushed", at, changeId, sha, commits: count, by: "you" });
      d.pushed(changeId, sha);
    }
    // Another writer read (a push signed by another agent, a read that failed before): the app's change is sent
    // again, as the host shows it now.
    for (const entry of delta.written)
      d.emit({ type: "change.opened", at, change: changeOf(entry, d.owner) });
    for (const number of delta.closed)
      d.emit({ type: "change.closed", at, changeId: changeIdOf(repo, number) });
    return delta.opened.length + delta.ready.length + delta.pushed.length + delta.closed.length > 0;
  }

  /**
   * Polls each of `repos` in turn: whether any saw anything change, and what each listing that failed threw, in order.
   * A rate limit met (by a listing or a compare) or a disconnection leaves the repositories after it to the next poll.
   * Once a listing answered, what GitHub is owed is sent. Begun under the sign-in or App held now (ADR 0066): once
   * another is, the poll ends, what the repository under way met dropped, the repositories after it left to the next.
   */
  async function each(repos: readonly RepositoryRef[]): Promise<{ saw: boolean; errors: unknown[] }> {
    const at = d.holding();
    const polled: { saw: boolean; error?: unknown }[] = [];
    for (const repo of repos) {
      // GitHub's wait is the installation's: met in this poll, it holds for every repository after.
      if (stopping || (polled.length > 0 && waiting())) break;
      const one = await tried(repo, at);
      // Another sign-in or App held meanwhile: what this poll met is dropped (`Superseded` too).
      if (d.holding() !== at) break;
      polled.push(one);
      if (stopsAt(repo, one)) break;
    }
    return {
      saw: polled.some((one) => one.saw),
      errors: polled.flatMap((one) => ("error" in one ? [one.error] : [])),
    };
  }

  /**
   * Whether the repositories after `repo` wait for the next poll: its listing refused for the installation. A refusal
   * of a repository whose account holds a cause is that account's (ADR 0066): the poll goes on.
   */
  function stopsAt(repo: RepositoryRef, one: { saw: boolean; error?: unknown }): boolean {
    if (!("error" in one)) return false;
    if (one.error instanceof HostError && accountHeld(repo)) ofAnAccount.add(one.error);
    return installationWide(one.error) && !ofAnAccount.has(one.error);
  }

  /** One repository's poll: whether it saw anything, or what its listing threw. */
  const tried = (repo: RepositoryRef, at: number): Promise<{ saw: boolean; error?: unknown }> =>
    once(repo, at).then(
      (saw) => ({ saw }),
      (error: unknown) => ({ saw: false, error }),
    );

  /** `work` after the polls asked before it, one at a time. */
  function serially<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work);
    chain = next.catch(() => {});
    return next;
  }

  function poll(repo?: RepositoryRef): Promise<boolean> {
    return serially(() => each(repo === undefined ? d.repos() : [repo])).then(({ saw, errors }) => {
      // An account's refusal is said by its account (ADR 0066), never thrown at "Refresh": logged.
      const thrown = errors.filter((error) => !(error instanceof HostError && ofAnAccount.has(error)));
      for (const error of errors) if (!thrown.includes(error)) logRefusal(error);
      if (thrown.length > 0) throw thrown[0];
      return saw;
    });
  }

  async function first(): Promise<void> {
    const { errors } = await serially(() => each(d.repos()));
    // A rate limit is only a wait: the loop lists at GitHub's reset.
    for (const error of errors)
      if (!(error instanceof HostError && error.failure === "rate_limited")) logRefusal(error);
  }

  /**
   * Whether the repository's poll is due at `at`: GitHub's wait over, and the cadence `core` gives for it (its own
   * changes asked or reviewed lately) passed since its last one.
   */
  function due(repo: RepositoryRef, at: number): boolean {
    if (limitUntil !== null) return at >= limitUntil;
    const last = lastPollAt.get(repoIdOf(repo));
    if (last === undefined) return true;
    const changes = changePrefixOf(repo);
    // Its account holding a cause, what it waits for waits on that account: polled as one with nothing asked.
    const held = accountHeld(repo);
    const every = pollEvery({
      asked: !held && d.store.jobs.pendingIn(changes),
      lastPostedAt: held ? null : d.store.rounds.lastPostedAt(changes),
      now: at,
    });
    return at - last >= every;
  }

  function arm(): void {
    if (stopping) return;
    // GitHub's wait ends between two wakes: the loop wakes at its end.
    const until = limitUntil === null ? WAKE_MS : Math.min(WAKE_MS, Math.max(0, limitUntil - now()));
    wake = d.timers.after(until, () => {
      wake = null;
      void tick();
    });
  }

  const logRefusal = (error: unknown) => d.log(`the pull requests could not be listed: ${said(error)}`);

  async function tick(): Promise<void> {
    try {
      // No bot installed yet: nothing to list until the setup installs it and lists (ADR 0047).
      if (d.connection().state === "not-connected") return;
      const at = now();
      const dueNow = d.repos().filter((repo) => due(repo, at));
      if (dueNow.length === 0) return;
      const { saw, errors } = await serially(() => each(dueNow));
      for (const error of errors) logRefusal(error);
      if (saw && !stopping) d.take();
    } catch (error) {
      logRefusal(error);
    } finally {
      arm();
    }
  }

  return {
    poll,
    first,
    reached: (cause) => {
      const none = d.repos().length === 0;
      if (cause === null) {
        if (none) connection("connected", null);
      } else if (cause.kind !== "unreachable" || none || d.connection().state === "disconnected")
        connection("disconnected", cause);
    },
    start: arm,
    stop: async () => {
      stopping = true;
      wake?.();
      wake = null;
      await chain;
    },
  };
}
