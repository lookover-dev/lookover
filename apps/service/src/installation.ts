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
//   At start (`open`, when the setup says the App is installed), every 5 minutes (every minute while GitHub refuses
//   it), on "Reconnect", and when the poller asks (`discover`: a repository's token refused, the connection back): a
//   repository the room doesn't watch is added (`added`: polled at once, `repo.added` with its switch on), one no
//   installation lists any more removed (`removed`: its jobs cancelled, a running one stopped, its unsent posts
//   dropped, `repo.removed`). What each met is told (`reached`): answered, or the cause of its refusal. Whose accounts
//   they are, and those not reached, are the room's `unreached` (ADR 0067): the installation asks no `gh`.
// - The install's wait (`waitForInstall`, while the setup waits for it, ADR 0053): the accounts read every 4 s until
//   they list repositories; one listing none is "nothing granted" (the setup says so, and the wait goes on); one listing
//   some has every one added (switched on) and the setup done. A refusal is logged once, and once when GitHub answers
//   again. A check refused signed out (the sign-in lost, or revoked) is the connection's cause at once, the poller
//   saying nothing before the setup is done; a new sign-in or a check answered clears it. One wait at a time; asked
//   again while it runs, it reads now.
// - The accounts (`accounts`, ADR 0066): each account reached, its installation and its own cause, sent as
//   `connection.changed` when they move: the one `accounts()` gives (suspended, SSO asked) or the poller's (`refused`:
//   an act on one of its repositories refused `uninstalled` or `sso`, the rule by kind), cleared once one of its
//   repositories answers (`answered`) or a listing gives none. An account with a cause lists no repositories, yet those
//   of its repositories the room watches stay watched, refused until the cause is mended: what their reviews waited for
//   is kept, and nothing departs for a suspension or an SSO session run out. An account no longer reached at all is
//   gone, its repositories with it; with none reached any more, every one goes, and the connection shows the shared
//   App uninstalled until a listing finds one again. A cause cleared, by a listing or the poller, is told
//   (`accountBack`): what waited on that account starts. A repository whose owner is no account listed takes no cause:
//   its refusal is the connection's.
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
  type ConnectionAccount,
  type ConnectionCause,
  type ConnectionId,
  connectionCauseOf,
  type EventBody,
  type HostAccounts,
  HostError,
  type HostIntake,
  type HostLogin,
  type HostSignIn,
  type HostWriter,
  type ReachedAccount,
  type RepositoryRef,
  type Setup,
  type SignIn,
  type SignInKeeper,
  sameRepository,
} from "@lookover/contracts";
import { installationLines } from "./log-lines.ts";
import { said } from "./said.ts";
import type { SignInStore } from "./sign-in-store.ts";
import { connectionIdOf } from "./snapshot.ts";
import type { Timers } from "./timers.ts";

/** How often the installations' repositories are listed while installed: GitHub sends no webhook here. */
const DISCOVERY_MS = 5 * 60_000;
/** How soon they are listed again when GitHub refused the last listing: the poll's quiet cadence. */
export const DISCOVERY_RETRY_MS = 60_000;
/** How often the accounts are read while the setup waits for the install: the "few seconds" the screen says. */
const INSTALL_CHECK_MS = 4_000;

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
   * At start: the sign-in read, and, when `installed` (the setup says so), the installations' repositories, the
   * room's to watch. Null when nothing was listed (no sign-in, the App not installed yet, GitHub's refusal, the App
   * installed nowhere any more): the room keeps what it listed last, and `down` says why. A refusal is logged, never
   * thrown: the service starts when GitHub refuses it.
   */
  open(installed: boolean): Promise<RepositoryRef[] | null>;
  /**
   * After start, as the setup stands: the install waited for while the setup waits for it (or nothing was granted),
   * else the listing every 5 minutes once installed.
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
 * A reached account as the connection keeps it: the account, its installation's id, its cause; whether the person
 * owns it unknown (null) here.
 */
const accountOfReached = ({ installation, cause }: ReachedAccount): ConnectionAccount => ({
  account: { ...installation.account },
  installationId: installation.id,
  owner: null,
  cause,
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
  /** The timer armed: the next discovery, or the install's next check; null when none is. */
  let timer: (() => void) | null = null;
  /** Whether the install is waited for, and whether its last check was refused (logged once). */
  let waiting = false;
  let refused = false;
  /**
   * Whether the connection shows the person signed out while the install is waited for: the poller says nothing
   * before the setup is done, so the install's check says it, and a new sign-in clears it.
   */
  let signedOutWaiting = false;
  /** GitHub's refusal of what `open` listed, as the connection's cause; null when it listed, or wasn't asked. */
  let refusedAtStart: ConnectionCause | null = null;

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
  const allowedOf = (listed: readonly RepositoryRef[]): RepositoryRef[] =>
    allowed === undefined ? [...listed] : listed.filter((r) => allowed.some((a) => sameRepository(a, r)));

  /**
   * What the installations list now, cut to the allow-list: every account the sign-in reaches, each with its cause,
   * their repositories together, with those the room watches on an account with a cause kept (refused until it is
   * mended, never departed); null when it reaches none.
   */
  const list = async (now: Listable): Promise<Listed | null> => {
    const reached = await now.accounts.accounts();
    if (reached.length === 0) return null;
    const listed = reached.map(accountOfReached);
    const kept = d.watched().filter((repo) => (accountOf(listed, repo.owner)?.cause ?? null) !== null);
    return { accounts: listed, repos: [...allowedOf(reached.flatMap((a) => a.repositories)), ...kept] };
  };

  /** The shared App installed nowhere the person reaches. */
  const uninstalled = (now: Listable) =>
    new HostError("not_found", installationLines.notReached(now.person.login), {
      connectionCause: { kind: "uninstalled", suspended: false },
    });

  /**
   * The accounts kept, sent when they moved, in every state: uninstalled and installed again while the setup shows
   * "nothing granted", the new installation is the one its links lead to. Only the first found while the install is
   * waited for go with the connection the setup makes (`installed`).
   */
  const installedAs = (now: ConnectionAccount[]): void => {
    if (isDeepStrictEqual(accounts, now)) return;
    const first = accounts.length === 0;
    const was = accounts;
    accounts = now;
    if (!(waiting && first)) d.emit({ type: "connection.changed", at: d.now(), patch: { accounts } });
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

  /**
   * The next discovery, `ms` on (5 minutes unless said): what it throws is logged, and the one after comes a minute on
   * while GitHub refuses it, so a service that started while GitHub didn't answer comes back by itself within a minute
   * of its answering (ADR 0070).
   */
  const armDiscovery = (ms = DISCOVERY_MS): void =>
    arm(ms, () => {
      timer = null;
      discover().then(
        () => {
          if (!waiting) armDiscovery();
        },
        (error: unknown) => {
          d.log(`the installation's repositories could not be listed: ${said(error)}`);
          if (!waiting) armDiscovery(DISCOVERY_RETRY_MS);
        },
      );
    });

  /** The installations' repositories listed and followed; false with nobody signed in. */
  const listedAgain = async (at: number): Promise<boolean> => {
    if (held.state !== "signed-in") return false;
    const now = held;
    // Another sign-in held meanwhile: what this one reached is not theirs (ADR 0066), and the work ends here.
    const listed = await settled(at, () => list(now));
    if (listed === null) {
      // No account reached any more departs every one, as one gone departs (ADR 0066); then refused.
      installedAs([]);
      await follow([], at);
      still(at);
      throw uninstalled(now);
    }
    installedAs(listed.accounts);
    await follow(listed.repos, at);
    still(at);
    return true;
  };

  /** A listing refused for a cause the connection shows: the room is told. */
  const refusedFor = (error: unknown): void => {
    const cause = error instanceof HostError ? connectionCauseOf(error) : null;
    if (cause !== null && !stopping) d.reached(cause);
  };

  async function discover(): Promise<void> {
    await serially(
      (at) =>
        listedAgain(at).then(
          (listed) => {
            still(at);
            if (listed) d.reached(null);
          },
          (error: unknown) => {
            still(at);
            refusedFor(error);
            throw error;
          },
        ),
      undefined,
    );
  }

  /**
   * The installations listed and followed; null when not installed yet, or when another sign-in was held while they
   * were read (what it read is not theirs: the wait goes on), "refused" when GitHub refused (logged once, not every
   * few seconds while it keeps refusing, and once when it answers again).
   */
  const followed = async (now: Listable, at: number): Promise<Listed | null | "refused"> => {
    try {
      const listed = await settled(at, () => list(now));
      return await checkAnswered(listed, at);
    } catch (error) {
      if (error instanceof Superseded) throw error;
      return checkRefused(error);
    }
  };
  /** An install's check GitHub answered under the holding `at`: what it lists followed, a refusal before it over. */
  const checkAnswered = async (listed: Listed | null, at: number): Promise<Listed | null> => {
    if (listed !== null) {
      installedAs(listed.accounts);
      await follow(listed.repos, at);
      still(at);
    }
    if (refused) d.log("the pull requests are listed again");
    refused = false;
    if (signedOutWaiting) d.emit(signedInAgain());
    return listed;
  };
  /** An install's check refused: logged once while it keeps refusing; signed out, the connection's cause. */
  const checkRefused = (error: unknown): "refused" => {
    if (!refused) d.log(`the pull requests could not be listed: ${said(error)}`);
    refused = true;
    signedOutAt(error);
    return "refused";
  };

  /** A check refused signed out: the connection's cause from now on, the poller saying nothing before setup's done. */
  const signedOutAt = (error: unknown): void => {
    const cause = error instanceof HostError ? connectionCauseOf(error) : null;
    if (cause?.kind !== "signed-out" || signedOutWaiting || stopping) return;
    signedOutWaiting = true;
    d.emit({ type: "connection.changed", at: d.now(), patch: { cause } });
  };

  /** The signed-out cause the install's check showed, cleared: the person signed in again. */
  const signedInAgain = (): EventBody => {
    signedOutWaiting = false;
    return { type: "connection.changed", at: d.now(), patch: { cause: null } };
  };

  /** One check of the install: listed, followed, and the setup told; armed again until repositories are granted. */
  const check = (): Promise<void> =>
    serially(async (at) => {
      if (stopping || held.state !== "signed-in") return;
      const listed = await followed(held, at);
      // Still the holding it began under: the install found is that person's.
      still(at);
      if (listed === null || listed === "refused") return;
      d.installed(listed.repos.length > 0);
      if (listed.repos.length > 0) waiting = false;
    }, undefined).finally(() => {
      if (stopping || held.state === "none") return;
      if (waiting) arm(INSTALL_CHECK_MS, () => void check());
      else armDiscovery();
    });

  /** What the installations list at start for `now`; null, logged and kept as `down`'s cause, when GitHub refused. */
  const listedAtStart = async (now: Listable): Promise<RepositoryRef[] | null> => {
    const at = holding;
    try {
      const listed = await list(now);
      // Nothing is held before the start is done; were another held meanwhile, what was read is not theirs.
      if (at !== holding) return null;
      if (listed === null) throw uninstalled(now);
      accounts = listed.accounts;
      return listed.repos;
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
      d.log(`the installation's repositories could not be listed: ${said(error)}`);
      refusedAtStart = connectionCauseOf(error);
      return null;
    }
  };

  const waitForInstall = (): void => {
    if (stopping) return;
    waiting = true;
    timer?.();
    timer = null;
    void check();
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
        hold(signIn.person);
        moveHolding();
        d.emit({ type: "connection.changed", at: d.now(), patch: { person: { ...signIn.person } } });
        if (signedOutWaiting) d.emit(signedInAgain());
      });
    },
    accounts: () => accounts,
    holding: () => holding,
    refused: (repo, cause, at) => at !== holding || accountHolds(repo, cause),
    answered: (repo, at) =>
      at === holding && (accountOf(accounts, repo.owner)?.cause ?? null) !== null && accountHolds(repo, null),
    down: () => refusedAtStart,
    open: async (installed) => {
      const read = await shared.signIns.read();
      // A sign-in no longer opening is still held: its ports refuse as signed out (ADR 0066).
      if (read.state !== "none") hold(read.state === "kept" ? read.signIn.person : read.person);
      return held.state === "signed-in" && installed ? listedAtStart(held) : null;
    },
    begin: (setup) => {
      if (held.state === "none") return;
      if (setup.github === "waiting-for-install" || setup.github === "nothing-granted") waitForInstall();
      // Refused at start: listed again a minute on, as after any refused listing.
      else if (setup.github === "done")
        armDiscovery(refusedAtStart === null ? DISCOVERY_MS : DISCOVERY_RETRY_MS);
    },
    discover,
    waitForInstall,
    stop: () => {
      stopping = true;
      timer?.();
      timer = null;
    },
  };
}
