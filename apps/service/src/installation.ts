// The person signed in to the shared App, the installations their sign-in reaches, and the repositories those list
// (ADR 0066, ADR 0073). Its users are the room, which watches what it lists, and the setup's GitHub step, which it
// moves on once the shared App is installed.
// - The sign-in: the sign-in store's (`side.shared.signIns`), kept, no longer opening, or none. A data folder with a
//   sign-in kept is the person's, the person signed in (named by `GET /user` as they signed in) being the owner; one
//   with none shows the setup's GitHub step, whatever else it holds (an App of its own from an earlier version,
//   `github/app.json`, is read no more). A sign-in finished while the service runs (`signedIn`) is kept, replacing the
//   last whoever it names, and held at once: the ports post as the person from then on, then the install waited for.
//   A sign-in whose tokens no longer open is still held: its ports refuse as signed out, which only a new sign-in
//   mends. With none, every call is refused signed out (nothing should ask: nothing is polled).
// - Starting while GitHub refuses (ADR 0053): what `open` was refused (the accounts, their repositories: GitHub down,
//   the sign-in refused, the App installed nowhere any more) is logged and never thrown; `down` gives the cause the
//   connection shows at start, the room keeps what it listed last, and the installations are listed again a minute on.
// - Discovery: every installation of the shared App the sign-in reaches (`HostAccounts`) and their repositories
//   (archived ones left out by the port), all watched together, cut to `allowed` when `live.json` gives an allow-list.
//   At start (`open`, when the setup says the App is installed), every 2 minutes (every minute while GitHub refuses
//   it, never before the end of a wait GitHub asked for), on "Reconnect", and when the poller asks (`discover`: a
//   repository's token refused, the connection back): a repository the room doesn't watch is added (`added`: polled
//   at once, `repo.added` with its switch on), one no installation lists any more removed (`removed`: its jobs
//   cancelled, a running one stopped, its unsent posts dropped, `repo.removed`). What each met is told (`reached`):
//   answered, or the cause of its refusal. Whose accounts they are, and those not reached, are the room's `unreached`
//   (ADR 0067): the installation asks no `gh`.
// - The install's wait (`waitForInstall`, while the setup waits for it, ADR 0053): the accounts read every 4 s until
//   they list repositories, sent as soon as they are read, before any repository is polled (ADR 0086); one listing
//   none is "nothing granted" (the setup says so, and the wait goes on); one listing some has every one added
//   (switched on, each polled once) and only then the setup done. A refusal is logged once, and once when GitHub
//   answers again. A check whose listing is refused for a cause (signed out, GitHub unreachable) shows it on the
//   connection at once, the poller saying nothing before the setup is done; a new sign-in or a listing answered clears
//   it. A repository's first poll refused is never the connection's: its account's, or nobody's until the next check.
//   One wait at a time; asked again while it runs, it reads now.
// - The install look (`look`, ADR 0088): the installations listed at once, then every 4 s, until a listing finds an
//   account or a repository none listed when it began, or an account then listed with a cause (or since, or no longer
//   reached) listed again with none (what arrived: the accounts' logins, those back, how many repositories) or
//   3 minutes pass with nothing new. Begun while nothing is listed under the sign-in (refused at start), it measures
//   from the repositories the room watches and their accounts, an account its first answer lists with no repository
//   beyond them taken as already there; under a new sign-in, or with nothing watched, from its first answer. Asked
//   again while it runs, listed at once and its end moved 3 minutes on; the tab coming back (`returned`,
//   `connection.returned`, ADR 0091) lists at once only while one runs, its end unmoved, and does nothing else.
//   One look at a time, kept as `Connection.look` and sent as it moves: when it began, when it ends, when a listing
//   during it last answered, when it ended and what arrived; ended with nothing new and not stopped by GitHub's wait,
//   the first later listing that finds something beyond what it began with (an owner approving later) is said as what
//   arrived, within 15 minutes of its end, or later when an account awaiting an owner's approval as it ended is among
//   it (a find dropped as too late is taken as there: a later arrival never counts it). A refused listing doesn't end
//   it: it goes on at its pace, the connection showing the cause. Every listing counts, whoever asks; a new sign-in
//   drops it. Nobody signed in, it is refused.
// - GitHub's wait (ADR 0088): a listing refused as rate limited keeps the time GitHub gave as `Connection.limitUntil`
//   (`limited`, the poller's too: one limit for the person's sign-in, a minute when GitHub gave none; the start's,
//   `limitedAtStart`, given to the poller by the room once it runs) and stops the look running (`stopped:
//   "rate-limited"`; what a listing found arrived all the same when only a new repository's first poll met it); a
//   sign-in by another person clears it (it was the last one's token's), the same person's keeps it; while a wait holds (`limitUntil`, whoever met it), nothing is listed, a look asked then stops at
//   once, and the next listing comes at its end (the install's check 4 s on at the least): a look asked, or a listing
//   held back or refused, so arms it there, never later, a wait a repository's poll met included. A listing answered once the wait is over clears it; one under way when another act
//   met it leaves it.
// - One timer for all three: the install's wait's check while it waits (a look then rides on its checks, ended by
//   the first past its end), else the look's next listing while one runs, else the next discovery (a minute on after a
//   refused listing, the look's end included).
// - Listed (`listed`, ADR 0086): whether a listing answered under the sign-in held now, the start's, discovery's or an
//   install's check, even one finding nothing new; false again once another sign-in is held, sent with its person
//   (and the accounts gone, when the person is another: theirs are never the last one's). A listing refused while not
//   listed keeps its cause (`listingCause`), sent as it moves, whatever the repositories' polls say meanwhile (one
//   watched answering keeps the connection connected); a listing answered or another sign-in held clears it.
// - The accounts (`accounts`, ADR 0066): each account reached, its installation, what it grants (ADR 0091: the ids
//   of the repositories its listing names, cut to the allow-list, as the room names them; none when that listing gave
//   a cause) and its own cause: the one `accounts()` gives (suspended, SSO asked) or the poller's (`refused`: an act on
//   one of its repositories refused `uninstalled` or `sso`, the rule by kind), cleared once one of its repositories
//   answers (`answered`) or a listing gives none. They are sent as `connection.changed` when they move, so before
//   their repositories are watched. They know nothing of what the room has read. An account with a cause lists no
//   repositories, yet those of its repositories the room watches stay watched, refused until the cause is mended: what
//   their reviews waited for is kept, and nothing departs for a suspension or an SSO session run out. An account no
//   longer reached at all is gone, its repositories with it; with none reached any more, every one goes, and the
//   connection shows the shared App uninstalled until a listing finds one again. A cause cleared, by a listing or the
//   poller, is told (`accountBack`): what waited on that account starts. A repository whose owner is no account listed
//   takes no cause: its refusal is the connection's.
// Ordering: listings, the install's checks and the holding of another sign-in (`signedIn`) run one at a time, in one
// turn (`serially`, `inTurn`), so two never add the same repository twice and no work of one holding runs once another
// is held. Each holding is numbered (`holding`): the number moves as another is asked to be held, which ends the work
// under way at once (each of its waits, `settled`, races the move), skips the work queued before it, and moves again
// once it is held, so what the poller began in between is dropped too. Every wait of a holding's work is `settled` or
// followed by `still`: past it, the holding is the one it began under, else the work ends there (`Superseded`),
// nothing applied (ADR 0066). Once stopping, nothing is armed, and a listing that answers late changes nothing.
// Errors: `discover` throws the host's `HostError` (installed nowhere: `not_found`, cause `uninstalled`); `open` only
// what isn't GitHub's (the sign-in store unreadable); the timers log what theirs throw. `signedIn` throws the sign-in
// store's error, and nothing is changed then.
// It must never know: the queue, the poller or the setup's steps (the room's moves, given as `added`, `removed` and
// `installed`); and it never logs, sends or keeps a token anywhere but through the sign-in store.

import { isDeepStrictEqual } from "node:util";
import {
  type AccountCause,
  accountOf,
  type Connection,
  type ConnectionAccount,
  type ConnectionCause,
  type ConnectionId,
  connectionCauseOf,
  DISCOVERY_MS,
  DISCOVERY_RETRY_MS,
  type EventBody,
  type HostAccounts,
  HostError,
  type HostIntake,
  type HostLogin,
  type HostSignIn,
  type HostWriter,
  type InstallLook,
  type LookRefusal,
  type ReachedAccount,
  type RepositoryRef,
  type Setup,
  type SignIn,
  type SignInKeeper,
  sameLogin,
  sameRepository,
} from "@lookover/contracts";
import { installationLines } from "./log-lines.ts";
import { isRateLimit } from "./rate-limit.ts";
import { said } from "./said.ts";
import type { SignInStore } from "./sign-in-store.ts";
import { connectionIdOf, repoIdOf } from "./snapshot.ts";
import type { Timers } from "./timers.ts";

// The installations are listed every 2 minutes while nobody looks (`DISCOVERY_MS`, the contracts', which the app says):
// 30 listings an hour, 150 requests for four installations, 3% of the person's 5,000 an hour; a minute on after GitHub
// refused the last (`DISCOVERY_RETRY_MS`), the poll's quiet cadence.
/** How often the accounts are read while the setup waits for the install: the "few seconds" the screen says. */
const INSTALL_CHECK_MS = 4_000;
/**
 * How long an install look goes on with nothing new, from the last command that asked it (ADR 0088): enough for a
 * person to finish GitHub's install page and come back; about 45 listings at most, 225 requests for four installations.
 */
const LOOK_MS = 3 * 60_000;
/** How often the installations are listed while a look runs: the install wait's "few seconds". */
const LOOK_EVERY_MS = INSTALL_CHECK_MS;
/**
 * How long after a look ended with nothing new what a listing finds is still its arrival (ADR 0088): an owner who
 * approves within it, or one the person asked, whenever.
 */
const LATE_ARRIVAL_MS = 15 * 60_000;

/** The repository ports the room reviews through: GitHub's, as the person signed in. */
export interface HostPorts {
  intake: HostIntake;
  writer: HostWriter;
}

/**
 * The shared App (ADR 0066): GitHub's device flow to sign a person in, where the sign-in is kept, and what it reaches,
 * read and renewed through the store's keeper.
 */
interface SharedSide {
  /** GitHub's side of a sign-in: the device code, its polls. */
  signIn: HostSignIn;
  /** The sign-in store: the data folder's, or the folder the options name (`bun run live`'s, ADR 0066). */
  signIns: SignInStore;
  /** Who the sign-in `keeper` keeps is, and the accounts it reaches through the shared App. */
  accounts(keeper: SignInKeeper): HostAccounts;
  /** The repository ports, as the person whose sign-in `keeper` keeps. */
  connect(keeper: SignInKeeper): HostPorts;
}

/** How the service reaches GitHub (ADR 0066, ADR 0073): the shared App, and what `live.json` lets it watch. */
export interface GitHubSide {
  /** The shared App, signed in to. */
  shared: SharedSide;
  /** `live.json`'s allow-list: only these are watched, whatever the installations list. Absent: every one listed. */
  allowed?: readonly RepositoryRef[];
}

/** The person signed in, held: what their sign-in reaches, and the ports as them; or nobody yet. */
type Held =
  | { state: "none" }
  | { state: "signed-in"; person: HostLogin; accounts: HostAccounts; ports: HostPorts };

/** Who can be listed for: the person signed in. */
type Listable = Extract<Held, { state: "signed-in" }>;

/** What the installations list: the accounts they are on, and the repositories watched of them. */
interface Listed {
  accounts: ConnectionAccount[];
  repos: RepositoryRef[];
}

/**
 * What an install look measures from (ADR 0088): the accounts' logins and the repositories listed as it began; `away`,
 * those of its accounts with a cause then or in a listing since, or that a listing since didn't reach (one listed
 * again with no cause is back); `unlisted`, true until a first listing answers when nothing was listed under the
 * sign-in as it began (the room's watched repositories and their owners stood in): an account that answer lists with
 * no repository beyond them is taken as one already there.
 */
interface LookedFrom {
  accounts: string[];
  repos: RepositoryRef[];
  away: string[];
  unlisted: boolean;
}

/** The logins of `accounts`. */
const loginsOf = (accounts: readonly ConnectionAccount[]): string[] => accounts.map((a) => a.account.login);

/** `logins` with those `more` adds, each once (GitHub ignores a login's case). */
function withLogins(logins: readonly string[], more: readonly string[]): string[] {
  const all = [...logins];
  for (const login of more) if (!all.some((was) => sameLogin(was, login))) all.push(login);
  return all;
}

export interface InstallationDeps {
  side: GitHubSide;
  timers: Timers;
  emit(body: EventBody): void;
  now(): number;
  /** The repositories the room watches now. */
  watched(): readonly RepositoryRef[];
  /** Repositories the installations list and the room doesn't watch: watched from now on, polled at once. */
  added(repos: RepositoryRef[]): Promise<void>;
  /** A repository no installation lists any more: no longer watched, what it waited for dropped. */
  removed(repo: RepositoryRef): Promise<void>;
  /** The setup's GitHub step: the shared App's installation found, granting repositories or none. */
  installed(granted: boolean): void;
  /**
   * What a listing of the installations' repositories met (ADR 0053): GitHub answered (null), or refused for a cause
   * the connection then shows.
   */
  reached(cause: ConnectionCause | null): void;
  /** An account's cause cleared (ADR 0066): what waited on it can start. */
  accountBack(): void;
  /**
   * Until when GitHub asked the person's sign-in to wait (`Connection.limitUntil`), whoever met it (a listing, a
   * repository's poll); null when it asks nothing.
   */
  limitUntil(): number | null;
  /** GitHub asked a listing to wait until `until`, or answered one again (null): the poller waits with it. */
  limited(until: number | null): void;
  /**
   * The logins of the accounts awaiting an owner's approval (ADR 0067, 0088): not reached, the person having asked
   * their owner to install the shared App (`UnreachedAccount.askedAt`).
   */
  asked(): readonly string[];
  log(line: string): void;
}

export interface Installation {
  /** The repository ports, as the person now held: what the room's parts are given, once. */
  ports: HostPorts;
  /**
   * The owner on GitHub: the person signed in (ADR 0066). Read at each use, so a sign-in held later is the owner's.
   * Every "is it yours" asks it, by numeric id.
   */
  owner: { readonly id: number; readonly login: string };
  /** The connection's id once installed: the person's (`github:<login>`); null before a sign-in. */
  connectionId(): ConnectionId | null;
  /** The person signed in to the shared App, held (ADR 0066); null before a sign-in. */
  person(): HostLogin | null;
  /**
   * A sign-in to the shared App finished (ADR 0066): kept in the sign-in store in place of the last, then held, the
   * ports posting as its person from then on, and the connection told who. Throws when the store can't keep it:
   * nothing changes.
   */
  signedIn(signIn: SignIn): Promise<void>;
  /** Each account reached, with its installation and its own cause (ADR 0066), once listed; none before. */
  accounts(): ConnectionAccount[];
  /**
   * Whether the installations have been listed under the sign-in held now (ADR 0086): false from the moment one is
   * held, true once a listing under it answers, the start's included.
   */
  listed(): boolean;
  /**
   * What refused the last listing while not `listed()` (`Connection.listingCause`), whether or not the repositories
   * answer their polls; null once a listing answers, at each sign-in held, and while none was refused.
   */
  listingCause(): ConnectionCause | null;
  /**
   * Which holding is held now (ADR 0066): a number that moves each time another sign-in is held. What an act read
   * under one (`refused`, `answered`) is that one's.
   */
  holding(): number;
  /**
   * An act on `repo` begun under the holding `at` refused with `cause`, its account's by the rule by kind (ADR 0066):
   * the account named by the repository's owner holds it, the connection told when it moved; true then, its other
   * accounts still used. False when no account listed is the repository's owner: the cause is the connection's.
   * Begun under an earlier holding, it is that one's: true, nothing told.
   */
  refused(repo: RepositoryRef, cause: AccountCause, at: number): boolean;
  /**
   * `repo` answered (its listing, begun under the holding `at`): its account's cause, when it held one, cleared and the
   * connection told. True when it cleared one, so what waited on the account can start; false, nothing cleared, when
   * begun under an earlier holding.
   */
  answered(repo: RepositoryRef, at: number): boolean;
  /** Why the connection can't be used at start (ADR 0053): GitHub's refusal of what `open` read; null otherwise. */
  down(): ConnectionCause | null;
  /**
   * Until when GitHub asked what `open` read to wait (ADR 0088); null when it asked nothing. The room gives it to the
   * poller once it runs: nothing is sent before the start is done.
   */
  limitedAtStart(): number | null;
  /**
   * At start: the sign-in read, and, when `installed` (the setup says so), the installations' repositories, the
   * room's to watch. Null when nothing was listed (no sign-in, the App not installed yet, GitHub's refusal, the App
   * installed nowhere any more): the room keeps what it listed last, and `down` says why. A refusal is logged, never
   * thrown: the service starts when GitHub refuses it.
   */
  open(installed: boolean): Promise<RepositoryRef[] | null>;
  /**
   * After start, as the setup stands: the install waited for while the setup waits for it (or nothing was granted),
   * else the listing every 2 minutes once installed.
   */
  begin(setup: Setup): void;
  /**
   * "Reconnect", the timer, or the poller's asking: the installations' repositories listed, each added or removed as
   * the room needs, and what it met told (`reached`). Throws GitHub's refusal, or `not_found` (cause `uninstalled`)
   * when the shared App is installed nowhere the person reaches.
   */
  discover(): Promise<void>;
  /** The setup waits for the install: the accounts read now, then every 4 s until they list repositories. */
  waitForInstall(): void;
  /**
   * `connection.look` (ADR 0088): an install look begun, or, while one runs, its end moved 3 minutes on; either way
   * the installations' listing queued now, settled without waiting on GitHub to answer (what it throws logged, the
   * look going on). Refused with nobody signed in.
   */
  look(): Promise<"ok" | { refused: LookRefusal }>;
  /**
   * The tab coming back (ADR 0091): while a look runs and GitHub asks no wait, the installations' listing queued now,
   * the look's end unmoved (a return is not the person asking); else, or nobody signed in, nothing.
   */
  returned(): void;
  /** Nothing armed any more; a listing under way changes nothing once it answers. */
  stop(): void;
}

/** Every call refused signed out: the ports while nobody is signed in. */
const SIGNED_OUT_PORTS = ((): HostPorts => {
  const refuse = () =>
    Promise.reject(
      new HostError("unauthorized", "Nobody is signed in to the shared App", {
        connectionCause: { kind: "signed-out" },
      }),
    );
  return {
    intake: {
      listOpenChanges: refuse,
      listComments: refuse,
      getChange: refuse,
      threads: refuse,
      poster: refuse,
      countCommits: refuse,
      fetchSpec: refuse,
    },
    writer: {
      createCheck: refuse,
      findCheck: refuse,
      updateCheck: refuse,
      completeCheck: refuse,
      publishReview: refuse,
      findReview: refuse,
      upsertStatus: refuse,
      react: refuse,
      reply: refuse,
      minimize: refuse,
    },
  };
})();

/** Ports that go to whichever `current` gives at each call. */
function following(current: () => HostPorts): HostPorts {
  const intake = () => current().intake;
  const writer = () => current().writer;
  return {
    intake: {
      listOpenChanges: (...a) => intake().listOpenChanges(...a),
      listComments: (...a) => intake().listComments(...a),
      getChange: (...a) => intake().getChange(...a),
      threads: (...a) => intake().threads(...a),
      poster: (...a) => intake().poster(...a),
      countCommits: (...a) => intake().countCommits(...a),
      fetchSpec: (...a) => intake().fetchSpec(...a),
    },
    writer: {
      createCheck: (...a) => writer().createCheck(...a),
      findCheck: (...a) => writer().findCheck(...a),
      updateCheck: (...a) => writer().updateCheck(...a),
      completeCheck: (...a) => writer().completeCheck(...a),
      publishReview: (...a) => writer().publishReview(...a),
      findReview: (...a) => writer().findReview(...a),
      upsertStatus: (...a) => writer().upsertStatus(...a),
      react: (...a) => writer().react(...a),
      reply: (...a) => writer().reply(...a),
      minimize: (...a) => writer().minimize(...a),
    },
  };
}

/**
 * A reached account as the connection keeps it: the account, its installation's id, its cause, and what it grants
 * (ADR 0091): its repositories as `cut` leaves them (the allow-list), named as the room names them, none when it is
 * listed with a cause; whether the person owns it unknown (null) here.
 */
const accountOfReached = (
  { installation, cause, repositories }: ReachedAccount,
  cut: (repos: readonly RepositoryRef[]) => RepositoryRef[],
): ConnectionAccount => ({
  account: { ...installation.account },
  installationId: installation.id,
  owner: null,
  cause,
  granted: cause === null ? cut(repositories).map(repoIdOf) : [],
});

/** A holding's work ended: another sign-in is held now, or the service stops. Nothing it read is applied. */
class Superseded extends Error {}

/** What a wait resolves to when the holding it waits under is left. */
const LEFT = Symbol("left");

export function createInstallation(d: InstallationDeps): Installation {
  const { shared, allowed } = d.side;
  let held: Held = { state: "none" };
  let current: HostPorts = SIGNED_OUT_PORTS;
  /** Each account reached as last listed, with its own cause; none before the first listing. */
  let accounts: ConnectionAccount[] = [];
  /** Whether a listing answered under the sign-in held now (`Connection.listed`, ADR 0086). */
  let listed = false;
  /** What refused the last listing while not listed (`Connection.listingCause`); null once one answers. */
  let listingCause: ConnectionCause | null = null;
  let stopping = false;
  /**
   * Which holding this is: moved each time another sign-in is held (`signedIn`). A listing, or a refusal the poller
   * met, read under an earlier one is that one's, never applied to the one held now.
   */
  let holding = 0;
  /** Resolves (to `LEFT`) once the holding held now is left: what waits under it stops waiting. */
  let leave: () => void = () => {};
  let left = new Promise<typeof LEFT>((resolve) => {
    leave = () => resolve(LEFT);
  });
  /** The listings, the install's checks and the holdings, one after the other; never rejects. */
  let chain: Promise<unknown> = Promise.resolve();
  /** The timer armed: the next discovery, the look's next listing, or the install's next check; null when none is. */
  let timer: (() => void) | null = null;
  /** The install look (`Connection.look`, ADR 0088): the one running, or the last; null before any and once dropped. */
  let look: InstallLook | null = null;
  /**
   * What the look measures from: what a listing during it finds beyond it is what arrived. Null for a look begun under
   * a new sign-in not listed yet: its first answered listing is then what it measures from.
   */
  let lookedFrom: LookedFrom | null = null;
  /**
   * Whether the repositories the room watches are the person's held now: true from the start (the room's log is
   * theirs), false from a new sign-in of another person (or the first) until a listing under it answers.
   */
  let watchedTheirs = true;
  /** The accounts awaiting an owner's approval when the look ended with nothing new: theirs arrive however late. */
  let askedWhenEnded: readonly string[] = [];
  /** Whether the last discovery was refused: the next one, after a look too, is then a minute on. */
  let refusedLast = false;
  /** Whether the install is waited for, and whether its last check was refused (logged once). */
  let waiting = false;
  let refused = false;
  /**
   * The cause the connection shows while the install is waited for (signed out, GitHub unreachable), null when none:
   * the poller says nothing before the setup is done, so the install's check says it, and a check answered or a new
   * sign-in clears it.
   */
  let causeWaiting: ConnectionCause | null = null;
  /** GitHub's refusal of what `open` listed, as the connection's cause; null when it listed, or wasn't asked. */
  let refusedAtStart: ConnectionCause | null = null;
  /** Until when GitHub asked what `open` listed to wait; null when it asked nothing. */
  let limitedAtStart: number | null = null;

  /** The person signed in, held: what their sign-in reaches, and the ports as them. */
  const hold = (person: HostLogin): void => {
    const next: Listable = {
      state: "signed-in",
      person: { id: person.id, login: person.login },
      accounts: shared.accounts(shared.signIns.keeper),
      ports: shared.connect(shared.signIns.keeper),
    };
    held = next;
    current = next.ports;
  };

  /** The person held; null before a sign-in. */
  const personHeld = (): HostLogin | null => (held.state === "signed-in" ? held.person : null);
  /**
   * `person` signing in: whether the accounts kept are another person's. Another than the one held (or the first),
   * what the room watches isn't theirs either, until theirs are listed, and GitHub's wait was the last one's sign-in's
   * (one user token): cleared, the poller's too, and the connection told. The same person keeps it.
   */
  const anotherKept = (person: HostLogin): boolean => {
    if (personHeld()?.id === person.id) return false;
    watchedTheirs = false;
    if (d.limitUntil() !== null) d.limited(null);
    return accounts.length > 0;
  };

  /** `work` in the one turn, after everything asked before it. */
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work);
    chain = next.catch(() => {});
    return next;
  };

  /**
   * A holding's `work` in the one turn, under the holding it was asked under (`at`): skipped (`otherwise`) when
   * another is held before its turn comes, and `otherwise` too when it ends `Superseded`.
   */
  const serially = <T>(work: (at: number) => Promise<T>, otherwise: T): Promise<T> => {
    const at = holding;
    return inTurn(async () => {
      if (at !== holding) return otherwise;
      try {
        return await work(at);
      } catch (error) {
        if (error instanceof Superseded) return otherwise;
        throw error;
      }
    });
  };

  /** Another holding asked: the work under way ends at its wait, the work queued before is skipped. */
  const moveHolding = (): void => {
    holding += 1;
    const leaving = leave;
    left = new Promise<typeof LEFT>((resolve) => {
      leave = () => resolve(LEFT);
    });
    leaving();
  };

  /** Ends the work begun under the holding `at` when another is held now, or the service stops. */
  const still = (at: number): void => {
    if (stopping || at !== holding) throw new Superseded();
  };

  /**
   * `act` begun and waited for under the holding `at`: what it gives or throws, past the wait, only while `at` is still
   * held; the holding left (another held, or the service stopping) ends the work there, at once, without waiting
   * for `act` (whatever it was doing goes on, its outcome dropped).
   */
  const settled = async <T>(at: number, act: () => Promise<T>): Promise<T> => {
    still(at);
    let read: T | typeof LEFT;
    try {
      read = await Promise.race([act(), left]);
    } catch (error) {
      still(at);
      throw error;
    }
    if (read === LEFT) throw new Superseded();
    still(at);
    return read;
  };

  /** The repositories cut to the allow-list, when there is one. */
  const allowedOf = (repos: readonly RepositoryRef[]): RepositoryRef[] =>
    allowed === undefined ? [...repos] : repos.filter((r) => allowed.some((a) => sameRepository(a, r)));

  /**
   * What the installations list now, cut to the allow-list: every account the sign-in reaches, each with its cause,
   * their repositories together, with those the room watches on an account with a cause kept (refused until it is
   * mended, never departed); null when it reaches none.
   */
  const list = async (now: Listable): Promise<Listed | null> => {
    const reached = await now.accounts.accounts();
    if (reached.length === 0) return null;
    const found = reached.map((a) => accountOfReached(a, allowedOf));
    const kept = d.watched().filter((repo) => (accountOf(found, repo.owner)?.cause ?? null) !== null);
    return { accounts: found, repos: [...allowedOf(reached.flatMap((a) => a.repositories)), ...kept] };
  };

  /** The shared App installed nowhere the person reaches. */
  const uninstalled = (now: Listable) =>
    new HostError("not_found", installationLines.notReached(now.person.login), {
      connectionCause: { kind: "uninstalled", suspended: false },
    });

  /** Listed now under the sign-in held: what refused an earlier listing is over; the patch that says it. */
  const listedNow = (): Partial<Connection> => {
    listed = true;
    watchedTheirs = true;
    const refusedBefore = listingCause !== null;
    listingCause = null;
    return { listed: true, ...(refusedBefore ? { listingCause } : {}) };
  };

  /**
   * The accounts kept, sent when they moved, in every state: uninstalled and installed again while the setup shows
   * "nothing granted", the new installation is the one its links lead to. Sent as soon as they are listed, before
   * their repositories are polled (ADR 0086). A `listing` that answered makes them listed, said with them, or alone
   * when they didn't move.
   */
  const installedAs = (now: ConnectionAccount[], listing = false): void => {
    const moved = !isDeepStrictEqual(accounts, now);
    const nowListed = listing && !listed;
    if (!(moved || nowListed)) return;
    const was = accounts;
    accounts = now;
    d.emit({
      type: "connection.changed",
      at: d.now(),
      patch: { ...(moved ? { accounts } : {}), ...(nowListed ? listedNow() : {}) },
    });
    const back = now.some(
      (a) => a.cause === null && (accountOf(was, a.account.login)?.cause ?? null) !== null,
    );
    if (back && !stopping) d.accountBack();
  };

  /**
   * `cause` (null: none) held by the account `repo` is on, the connection told when it moved; false when the cause is
   * the connection's (no sign-in, or no account listed is the repository's owner).
   */
  const accountHolds = (repo: RepositoryRef, cause: AccountCause | null): boolean => {
    if (held.state !== "signed-in") return false;
    const account = accountOf(accounts, repo.owner);
    if (account === undefined) return false;
    if (isDeepStrictEqual(account.cause, cause)) return true;
    installedAs(accounts.map((a) => (a === account ? { ...a, cause } : a)));
    return true;
  };

  /**
   * The room watches what the installations list under the holding `at`: each gone removed, then the new ones added;
   * nothing more once another is held.
   */
  const follow = async (repos: readonly RepositoryRef[], at: number): Promise<void> => {
    const watched = d.watched();
    for (const repo of watched.filter((w) => !repos.some((r) => sameRepository(r, w))))
      await settled(at, () => d.removed(repo));
    const fresh = repos.filter((r) => !watched.some((w) => sameRepository(w, r)));
    if (fresh.length > 0) await settled(at, () => d.added(fresh));
  };

  const arm = (ms: number, fire: () => void): void => {
    timer?.();
    timer = stopping ? null : d.timers.after(ms, fire);
  };

  /** The log line of a listing GitHub refused. */
  const notListed = (error: unknown): void =>
    d.log(`the installation's repositories could not be listed: ${said(error)}`);

  /** A listing begun by a timer or a look: what it throws is logged, as it arms the one after. */
  const logged = (listing: Promise<void>): Promise<void> => listing.catch(notListed);
  const discoverLogged = (): Promise<void> => logged(discover());

  /** The next discovery, `ms` on (2 minutes unless said); `discover` arms the one after. */
  const armDiscovery = (ms = DISCOVERY_MS): void =>
    arm(ms, () => {
      timer = null;
      void discoverLogged();
    });

  /** The look running now; null when none runs. */
  const looking = (): InstallLook | null => (look !== null && look.ended === null ? look : null);

  /** How long GitHub's wait has left: 0 when it asks none. */
  const limitLeft = (): number => {
    const until = d.limitUntil();
    return until === null ? 0 : Math.max(0, until - d.now());
  };

  /** The look moved to `next`, and the connection told. */
  const lookMoved = (next: InstallLook | null): void => {
    if (stopping) return;
    look = next;
    d.emit({ type: "connection.changed", at: d.now(), patch: { look } });
  };

  /** A new sign-in: the look is the last one's, what it measured from not this one's; the patch that says it. */
  const lookDropped = (): Partial<Connection> => {
    if (look === null) return {};
    look = null;
    return { look };
  };

  /** The look running ended with nothing new once its end has come. */
  const lookBound = (): void => {
    const running = looking();
    if (stopping || running === null || d.now() < running.until) return;
    askedWhenEnded = d.asked();
    lookMoved({ ...running, ended: d.now() });
  };

  /**
   * What a look begun now measures from: what is listed under this sign-in; while nothing is, the repositories the
   * room watches and their accounts, when it watches some of this person's (refused at start); else null, its first
   * answered listing (a new sign-in, or nothing ever watched: nothing tells an old install from a new one).
   */
  const lookStart = (): LookedFrom | null => {
    const away = loginsOf(accounts.filter((a) => a.cause !== null));
    if (listed) return { accounts: loginsOf(accounts), repos: [...d.watched()], away, unlisted: false };
    const repos = [...d.watched()];
    if (!watchedTheirs || repos.length === 0) return null;
    return {
      accounts: withLogins(
        [],
        repos.map((r) => r.owner),
      ),
      repos,
      away,
      unlisted: true,
    };
  };

  /**
   * What `found` lists beyond what the look measured from (`from`): the logins of the accounts that arrived, of those
   * back (away since, now listed with no cause), and how many repositories, those new and those of the accounts back.
   * Measured from what the room watched (`unlisted`), an account with no repository beyond it isn't one arrived.
   */
  const beyond = (from: LookedFrom, found: Listed | null): NonNullable<InstallLook["arrived"]> | null => {
    const reached = found?.accounts ?? [];
    const repos = found?.repos ?? [];
    const fresh = repos.filter((r) => !from.repos.some((was) => sameRepository(was, r)));
    const back = loginsOf(
      reached.filter((a) => a.cause === null && from.away.some((was) => sameLogin(was, a.account.login))),
    );
    const accounts = loginsOf(reached).filter(
      (login) =>
        !from.accounts.some((was) => sameLogin(was, login)) &&
        (!from.unlisted || fresh.some((r) => sameLogin(r.owner, login))),
    );
    const counted = repos.filter((r) => fresh.includes(r) || back.some((login) => sameLogin(login, r.owner)));
    return accounts.length > 0 || back.length > 0 || counted.length > 0
      ? { accounts, back, repositories: counted.length }
      : null;
  };

  /**
   * What the look measures from once `found` answered: an account it lists with a cause, or one it no longer reaches,
   * is away; measured from what the room watched, every account it lists is then one already there.
   */
  const measuredOn = (from: LookedFrom, found: Listed | null): LookedFrom => {
    const reached = found?.accounts ?? [];
    const unreached = from.accounts.filter((was) => !reached.some((a) => sameLogin(a.account.login, was)));
    const caused = loginsOf(reached.filter((a) => a.cause !== null));
    return {
      accounts: from.unlisted ? withLogins(from.accounts, loginsOf(reached)) : from.accounts,
      repos: from.repos,
      away: withLogins(from.away, [...caused, ...unreached]),
      unlisted: false,
    };
  };

  /**
   * What a look ended with nothing new measures from once a later listing (`found`) was judged, said or dropped as no
   * longer its news: what it found is taken as there (its accounts and repositories, those back no longer away), so a
   * later arrival counts only what came after.
   */
  const foldedIn = (from: LookedFrom, found: Listed | null): LookedFrom => {
    const measured = measuredOn(from, found);
    const reached = found?.accounts ?? [];
    const fresh = (found?.repos ?? []).filter((r) => !from.repos.some((was) => sameRepository(was, r)));
    return {
      accounts: withLogins(measured.accounts, loginsOf(reached)),
      repos: [...from.repos, ...fresh],
      away: measured.away.filter(
        (login) => !reached.some((a) => a.cause === null && sameLogin(a.account.login, login)),
      ),
      unlisted: false,
    };
  };

  /**
   * A listing after the look ended with nothing new and not stopped by GitHub's wait (`ended`): what it finds beyond
   * what the look began with (an owner approving later, found by discovery) is what arrived, said once, the look
   * ending when it did, so the line says it rather than nothing new. Within 15 minutes of its end; later, only when
   * an account awaiting an owner's approval as it ended is among what arrived: anything else is no longer its news.
   */
  const lateArrival = (ended: InstallLook, from: LookedFrom, found: Listed | null): void => {
    if (ended.arrived !== null || ended.stopped !== null || ended.ended === null) return;
    const arrived = beyond(from, found);
    lookedFrom = foldedIn(from, found);
    if (arrived === null) return;
    const late = d.now() - ended.ended > LATE_ARRIVAL_MS;
    const wasAsked = arrived.accounts.some((login) =>
      askedWhenEnded.some((asked) => sameLogin(asked, login)),
    );
    if (late && !wasAsked) return;
    lookMoved({ ...ended, arrived });
  };

  /**
   * A listing answered (`found`, null when it reached no account) while a look runs: when it looked, and what arrived
   * since the look began, which ends it.
   */
  const lookAnswered = (found: Listed | null): void => {
    // Past its end (the install's wait reads on), the look ended before this listing.
    lookBound();
    if (look === null || stopping) return;
    const from = lookedFrom;
    if (from === null) {
      // A new sign-in not listed yet as it began: this first answer is what it measures from.
      const reached = found?.accounts ?? [];
      lookedFrom = {
        accounts: loginsOf(reached),
        repos: [...(found?.repos ?? [])],
        away: loginsOf(reached.filter((a) => a.cause !== null)),
        unlisted: false,
      };
      if (look.ended === null) lookMoved({ ...look, lookedAt: d.now() });
      return;
    }
    if (look.ended !== null) {
      lateArrival(look, from, found);
      return;
    }
    const arrived = beyond(from, found);
    lookedFrom = measuredOn(from, found);
    const at = d.now();
    lookMoved({ ...look, lookedAt: at, ...(arrived === null ? {} : { ended: at, arrived }) });
  };

  /** The look running stopped by GitHub's wait (ADR 0088): nothing is listed before its end. */
  const lookStopped = (): void => {
    const running = looking();
    if (running !== null) lookMoved({ ...running, ended: d.now(), stopped: "rate-limited" });
  };

  /**
   * Whether GitHub's wait holds every listing back now; the look running then stopped. A wait any act met (a
   * repository's poll too) is the person's sign-in's, as the listing's.
   */
  const heldBack = (): boolean => {
    if (limitLeft() === 0) return false;
    lookStopped();
    return true;
  };

  /**
   * A listing refused as rate limited: GitHub's wait kept until the time it gave (a minute when it gave none), the
   * poller waiting with it (a wait of its own ending later stays), and the look running stopped. A time already past
   * holds nothing back: the listings' own pace (4 s at the most) is never a busy loop. False for any other refusal.
   */
  const rateLimited = (error: unknown): boolean => {
    if (!isRateLimit(error) || stopping) return false;
    d.limited(error.retryAt ?? d.now() + DISCOVERY_RETRY_MS);
    lookStopped();
    return true;
  };

  /**
   * A listing answered: GitHub's wait, once over, is cleared. One still to come was met while this listing was under
   * way (a repository's poll, another listing): it holds.
   */
  const answeredAgain = (): void => {
    if (d.limitUntil() !== null && limitLeft() === 0 && !stopping) d.limited(null);
  };

  /**
   * After a listing, outside the install's wait: the look's next listing 4 s on while it runs (sooner when its end
   * comes first), else the next discovery, a minute on when the last was refused, and never before GitHub's wait
   * ends; `atWaitEnd` (the listing held back or refused by the wait), right at its end.
   */
  const armNext = (atWaitEnd = false): void => {
    lookBound();
    const running = looking();
    if (running !== null)
      arm(Math.min(LOOK_EVERY_MS, running.until - d.now()), () => {
        timer = null;
        lookBound();
        if (looking()) void discoverLogged();
        else armNext();
      });
    else {
      const left = limitLeft();
      const pace = refusedLast ? DISCOVERY_RETRY_MS : DISCOVERY_MS;
      armDiscovery(atWaitEnd && left > 0 ? left : Math.max(pace, left));
    }
  };

  /**
   * What a listing under the holding `at` found (`found`, null when it reached no account) followed, then said to the
   * look. A repository's first poll refused (GitHub's wait) throws out of the following once each was added: what was
   * listed arrived all the same, so the look is told before the refusal can stop it.
   */
  const followedThenLooked = async (found: Listed | null, at: number): Promise<void> => {
    try {
      await follow(found?.repos ?? [], at);
    } catch (error) {
      if (!(error instanceof Superseded)) lookAnswered(found);
      throw error;
    }
    still(at);
    lookAnswered(found);
  };

  /** The installations' repositories listed and followed; false with nobody signed in. */
  const listedAgain = async (at: number): Promise<boolean> => {
    if (held.state !== "signed-in") return false;
    const now = held;
    // Another sign-in held meanwhile: what this one reached is not theirs (ADR 0066), and the work ends here.
    const found = await settled(at, () => list(now));
    answeredAgain();
    if (found === null) {
      // No account reached any more departs every one, as one gone departs (ADR 0066); then refused.
      installedAs([], true);
      await followedThenLooked(null, at);
      throw uninstalled(now);
    }
    installedAs(found.accounts, true);
    await followedThenLooked(found, at);
    return true;
  };

  /**
   * A listing refused while not listed: its cause kept and sent when it moved (`Connection.listingCause`), whatever
   * the repositories' polls say. Once listed, a refusal (a repository's, past the listing) is not the listing's.
   */
  const listingRefused = (cause: ConnectionCause | null): void => {
    if (listed || cause === null || stopping || isDeepStrictEqual(cause, listingCause)) return;
    listingCause = cause;
    d.emit({ type: "connection.changed", at: d.now(), patch: { listingCause } });
  };

  /** A listing refused for a cause the connection shows: the room is told, and the listing's cause kept. */
  const refusedFor = (error: unknown): void => {
    const cause = error instanceof HostError ? connectionCauseOf(error) : null;
    listingRefused(cause);
    if (cause !== null && !stopping) d.reached(cause);
  };

  /**
   * The installations listed again, whoever asks (the timer, "Reconnect", a repository refused or regained), and the
   * next one armed after it: a minute on while GitHub refuses it, so a refused listing (at start, after Sign in again)
   * is tried again within the minute its cause promises (ADR 0070). The setup's install check keeps its own timer.
   * While GitHub asks to wait, nothing is listed: the next one comes at the wait's end.
   */
  async function discover(): Promise<void> {
    try {
      if ((await listedOnce()) === "held back") {
        if (!waiting) armNext(true);
        return;
      }
    } catch (error) {
      refusedLast = true;
      if (!waiting) armNext(isRateLimit(error));
      throw error;
    }
    refusedLast = false;
    if (!waiting) armNext();
  }

  /**
   * One listing of the installations, in the turn: the room told what it reached, or the cause that refused it.
   * "listed" (superseded too), or "held back" when GitHub's wait holds it back as its turn comes: a wait met
   * meanwhile by a listing queued before it holds it back too.
   */
  async function listedOnce(): Promise<"listed" | "held back"> {
    return serially<"listed" | "held back">(
      async (at) =>
        heldBack()
          ? "held back"
          : listedAgain(at).then(
              (followedAll) => {
                still(at);
                if (followedAll) d.reached(null);
                return "listed" as const;
              },
              (error: unknown) => {
                still(at);
                if (!rateLimited(error)) refusedFor(error);
                throw error;
              },
            ),
      "listed",
    );
  }

  /**
   * The installations listed and followed; null when not installed yet, or when another sign-in was held while they
   * were read (what it read is not theirs: the wait goes on), "refused" when GitHub refused (logged once, not every
   * few seconds while it keeps refusing, and once when it answers again).
   */
  const followed = async (now: Listable, at: number): Promise<Listed | null | "refused"> => {
    let found: Listed | null;
    try {
      found = await settled(at, () => list(now));
    } catch (error) {
      if (error instanceof Superseded) throw error;
      checkListingRefused(error);
      return checkRefused(error);
    }
    try {
      return await checkAnswered(found, at);
    } catch (error) {
      if (error instanceof Superseded) throw error;
      // A repository's first poll refused: its account's, or the poller's to say once the setup's done, never the
      // whole connection's (one organisation's SSO or uninstall is not every account's).
      return checkRefused(error);
    }
  };
  /** An install's check GitHub answered under the holding `at`: what it lists followed, a refusal before it over. */
  const checkAnswered = async (found: Listed | null, at: number): Promise<Listed | null> => {
    answeredAgain();
    // Answered: the accounts sent now, before their repositories' first poll; installed nowhere, listed all the same,
    // and every account an earlier check sent gone (uninstalled since, its first poll refused meanwhile).
    installedAs(found === null ? [] : found.accounts, true);
    if (causeWaiting !== null) d.emit(causeCleared());
    if (found === null) lookAnswered(null);
    else await followedThenLooked(found, at);
    if (refused) d.log("the pull requests are listed again");
    refused = false;
    return found;
  };
  /**
   * An install's check whose listing itself was refused: GitHub's wait kept when it asked to wait, else the cause the
   * connection shows, and the listing's.
   */
  const checkListingRefused = (error: unknown): void => {
    if (rateLimited(error)) return;
    causeAt(error);
    listingRefused(error instanceof HostError ? connectionCauseOf(error) : null);
  };
  /** An install's check refused: logged once while it keeps refusing. */
  const checkRefused = (error: unknown): "refused" => {
    if (!refused) d.log(`the pull requests could not be listed: ${said(error)}`);
    refused = true;
    return "refused";
  };

  /**
   * The installations' listing refused for a cause (signed out, GitHub unreachable): the connection's from now on,
   * rather than looking on (ADR 0086), the poller saying nothing before setup's done.
   */
  const causeAt = (error: unknown): void => {
    const cause = error instanceof HostError ? connectionCauseOf(error) : null;
    if (cause === null || isDeepStrictEqual(cause, causeWaiting) || stopping) return;
    causeWaiting = cause;
    d.emit({ type: "connection.changed", at: d.now(), patch: { cause } });
  };

  /** The cause the install's check showed, cleared: a check answered, or the person signed in again. */
  const causeCleared = (): EventBody => {
    causeWaiting = null;
    return { type: "connection.changed", at: d.now(), patch: { cause: null } };
  };

  /** One check of the install: listed, followed, and the setup told; armed again until repositories are granted. */
  const check = (): Promise<void> =>
    serially(async (at) => {
      if (stopping || held.state !== "signed-in" || heldBack()) return;
      const found = await followed(held, at);
      // Still the holding it began under: the install found is that person's.
      still(at);
      if (found === null || found === "refused") return;
      d.installed(found.repos.length > 0);
      if (found.repos.length > 0) waiting = false;
    }, undefined).finally(() => {
      if (stopping || held.state === "none") return;
      if (waiting) {
        // The wait keeps its pace; a look beside it rides on its checks, and ends at the first past its end.
        lookBound();
        arm(Math.max(INSTALL_CHECK_MS, limitLeft()), () => void check());
      } else {
        refusedLast = false;
        armNext();
      }
    });

  /** What the installations list at start for `now`; null, logged and kept as `down`'s cause, when GitHub refused. */
  const listedAtStart = async (now: Listable): Promise<RepositoryRef[] | null> => {
    const at = holding;
    try {
      const found = await list(now);
      // Nothing is held before the start is done; were another held meanwhile, what was read is not theirs.
      if (at !== holding) return null;
      listed = true;
      if (found === null) throw uninstalled(now);
      accounts = found.accounts;
      return found.repos;
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
      refusedOnStart(error);
      return null;
    }
  };
  /**
   * The start's listing refused: logged, its cause kept as `down`'s, GitHub's wait as `limitedAtStart` (a minute
   * when it gave none). Nothing is sent before the start is done: the snapshot's facts carry it.
   */
  const refusedOnStart = (error: HostError): void => {
    notListed(error);
    refusedAtStart = connectionCauseOf(error);
    if (isRateLimit(error)) limitedAtStart = error.retryAt ?? d.now() + DISCOVERY_RETRY_MS;
    if (!listed) listingCause = refusedAtStart;
  };

  /**
   * The first discovery after start, once installed: 2 minutes on; a minute on when the start's listing was refused;
   * at the end of the wait GitHub asked it for.
   */
  const firstDiscoveryIn = (): number => {
    const left = limitedAtStart === null ? 0 : limitedAtStart - d.now();
    if (left > 0) return left;
    return refusedAtStart === null && limitedAtStart === null ? DISCOVERY_MS : DISCOVERY_RETRY_MS;
  };

  const waitForInstall = (): void => {
    if (stopping) return;
    waiting = true;
    timer?.();
    timer = null;
    void check();
  };
  /** Whether a look may list: someone signed in, the room not stopping. */
  const mayLook = (): boolean => held.state !== "none" && !stopping;
  /**
   * The installations listed now, in the one turn, without waiting on GitHub to answer (what it throws logged): the
   * install's wait's check while it runs, which then keeps its own pace, else a discovery, the look's pace after it.
   */
  const listNow = (): void => {
    void logged(waiting ? check() : discover());
  };

  return {
    ports: following(() => current),
    owner: {
      get id() {
        return personHeld()?.id ?? 0;
      },
      get login() {
        return personHeld()?.login ?? "";
      },
    },
    connectionId: () => {
      const person = personHeld();
      return person === null ? null : connectionIdOf(person.login);
    },
    person: () => {
      const person = personHeld();
      return person === null ? null : { ...person };
    },
    signedIn: async (signIn) => {
      // What the last holding runs ends now, then the sign-in is held in the turn, nothing of the last one after it.
      moveHolding();
      await inTurn(async () => {
        await shared.signIns.write(signIn);
        // Another person's accounts are never theirs (ADR 0066): sent as listed, they go until theirs are listed.
        const another = anotherKept(signIn.person);
        hold(signIn.person);
        moveHolding();
        // Not listed under this sign-in yet: still looking (ADR 0086).
        listed = false;
        // What refused the last one's listing is not this one's.
        const refusedBefore = listingCause !== null;
        listingCause = null;
        if (another) accounts = [];
        d.emit({
          type: "connection.changed",
          at: d.now(),
          patch: {
            person: { ...signIn.person },
            listed: false,
            ...(refusedBefore ? { listingCause } : {}),
            ...(another ? { accounts } : {}),
            ...lookDropped(),
          },
        });
        if (causeWaiting !== null) d.emit(causeCleared());
      });
    },
    accounts: () => accounts,
    listed: () => listed,
    listingCause: () => listingCause,
    holding: () => holding,
    refused: (repo, cause, at) => at !== holding || accountHolds(repo, cause),
    answered: (repo, at) =>
      at === holding && (accountOf(accounts, repo.owner)?.cause ?? null) !== null && accountHolds(repo, null),
    down: () => refusedAtStart,
    limitedAtStart: () => limitedAtStart,
    open: async (installed) => {
      const read = await shared.signIns.read();
      // A sign-in no longer opening is still held: its ports refuse as signed out (ADR 0066).
      if (read.state !== "none") hold(read.state === "kept" ? read.signIn.person : read.person);
      return held.state === "signed-in" && installed ? listedAtStart(held) : null;
    },
    begin: (setup) => {
      if (held.state === "none") return;
      if (setup.github === "waiting-for-install" || setup.github === "nothing-granted") waitForInstall();
      // Refused at start: listed again a minute on, as after any refused listing; asked to wait, at the wait's end.
      else if (setup.github === "done") armDiscovery(firstDiscoveryIn());
    },
    discover,
    waitForInstall,
    look: async () => {
      if (!mayLook()) return { refused: "signed-out" };
      const at = d.now();
      const running = looking();
      if (running !== null) lookMoved({ ...running, until: at + LOOK_MS });
      else {
        lookedFrom = lookStart();
        lookMoved({
          since: at,
          until: at + LOOK_MS,
          lookedAt: null,
          ended: null,
          arrived: null,
          stopped: null,
        });
      }
      // GitHub asks to wait: the look stops at once, nothing listed before the wait's end, and the next listing right
      // at it, whoever met the wait (a repository's poll arms no listing). A timer armed sooner would only be held
      // back (the look's own, stopped now, would arm discovery's pace); the install's wait keeps its own pace.
      if (heldBack()) {
        if (!waiting) armDiscovery(limitLeft());
        return "ok";
      }
      listNow();
      return "ok";
    },
    returned: () => {
      if (mayLook() && looking() !== null && limitLeft() <= 0) listNow();
    },
    stop: () => {
      stopping = true;
      timer?.();
      timer = null;
    },
  };
}
