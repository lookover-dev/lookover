// The App the service runs as, its installation on the App's account, and the repositories that installation
// lists (ADR 0053). Its users are the room, which watches what it lists, and the setup's GitHub step, which it moves
// on once the App is installed.
// - The App: `live.json`'s, used as it is (`given`: its id and key, described by GitHub at start, or, GitHub refusing
//   then, at the first call that needs it, the connection then showing its bot and App), else the data folder's
//   (`apps`, the App store): kept, lost (its key no longer opens), or none. `live.json`'s App owned by an
//   organisation works for the person `side.person` names (the owner's own `gh` login); without it, the start is
//   refused. With none, nothing is listed or
//   polled: the setup shows. An App stored while the service runs is adopted at once (`adopt`): the App store
//   written, the repository ports signing with its key from then on, then the install waited for, or, already
//   installed, its repositories listed again. The App's account (a user or an organisation) and the owner, the
//   person it works for, are kept apart (ADR 0059): on a personal account they are one. The bot is `<slug>[bot]`.
// - The repository ports (`ports`) follow the App: `connect`'s for the App kept; `live.json`'s not described yet
//   describes it first; with a lost key, every call refused with the cause the connection shows (`key-lost`, or
//   `unreachable` when the keychain didn't answer: its fix, "Reconnect", reads the App store again, which is what can
//   help, where "Add a new key" would replace a key still there; contracts have no cause naming the keychain); with
//   none, refused too (nothing should ask: nothing is polled).
// - Starting while GitHub refuses (ADR 0053): what `open` was refused (the App, its installation, its repositories:
//   GitHub down, the key refused, the App not installed any more) is logged and never thrown; `down` gives the cause
//   the connection shows at start, the room keeps what it listed last, and the installation is listed again a minute
//   on.
// - Discovery: the installation on the App's account and its repositories (archived ones left out by the port),
//   cut to `allowed` when `live.json` gives an allow-list. At start (`open`, when the setup says the App is
//   installed), every 5 minutes (every minute while GitHub refuses it), on "Reconnect", and when the poller asks
//   (`discover`: a repository's token refused, the connection back): a repository the room doesn't watch is added
//   (`added`: polled at once, `repo.added` with its switch on), one the installation no longer lists removed
//   (`removed`: its jobs cancelled, a running one stopped, its unsent posts dropped, `repo.removed`); a new
//   installation id is sent as `connection.changed`. What each met is told (`reached`): answered, or the cause of its
//   refusal.
// - The install's wait (`waitForInstall`, while the setup waits for it, ADR 0053): the installation read every 4 s
//   until it lists repositories; one listing none is "nothing granted" (the setup says so, and the wait goes on);
//   one listing some has every one added (switched on) and the setup done. A refusal is logged once, and once when
//   GitHub answers again. A key lost is read again from the App store at each check; with no App left, the wait
//   ends. On `shared`, a check refused signed out (the sign-in lost, or revoked) is the connection's cause at once,
//   the poller saying nothing before the setup is done; a new sign-in, an own App or a check answered clears it.
//   One wait at a time; asked again while it runs, it reads now.
// - The person's membership (ADR 0059), on an organisation's App only: asked of their own `gh` (`member`) before the
//   App's ports open, every way they do (`admit`: at start, its key lost or not, a lost key back, `live.json`'s App
//   described; `adopt`: the answer "Use an existing App" just got, else for another App `gh` asked then), then every
//   hour, its key lost or not, and on "Check again" (`checkMembership`). Only an answer for the person counts, kept
//   with the data folder's App (`live.json`'s keeps none, asked again at each start): no longer an active member
//   (absent, or only invited), every call is refused with the cause `not-a-member` and nothing is listed, not even
//   while the install is waited for, until a later answer says they are one again; `gh` signed in as another
//   account, or unable to answer, leaves the last answer, the log saying why. A personal App never asks.
// - The shared App (ADR 0066), when `side.shared` offers it: a data folder with no App of its own (`github/app.json`)
//   and a sign-in kept is on `shared`, the person signed in (named by `GET /user` as they signed in) being the owner;
//   one with its own App is on `own` even with a sign-in beside it; one with neither offers both. A sign-in finished
//   while the service runs (`signedIn`) is kept, replacing the last whoever it names, and held at once: the ports post
//   as the person from then on, then the install waited for, as an App adopted is. "Use your own App" (`adopt`) moves
//   to `own` the same way. On `shared`, the installations listed are every account the sign-in reaches (`HostAccounts`)
//   and their repositories, all watched together; the installation asks no `gh` there (whose accounts they are, and
//   those not reached, are the room's `unreached`, ADR 0067). A sign-in whose tokens no longer open is
//   still `shared`: its ports refuse as signed out, which only a new sign-in mends.
// - The accounts (`accounts`, ADR 0066): each account reached, its installation and its own cause, sent as
//   `connection.changed` when they move. On `own`, the App's one installation, its cause always null (the App's
//   causes are the connection's). On `shared`, every installation the sign-in reaches, its cause the one `accounts()`
//   gives (suspended, SSO asked) or the poller's (`refused`: an act on one of its repositories refused `uninstalled`
//   or `sso`, the rule by kind), cleared once one of its repositories answers (`answered`) or a listing gives none.
//   An account with a cause lists no repositories, yet those of its repositories the room watches stay watched,
//   refused until the cause is mended: what their reviews waited for is kept, and nothing departs for a suspension or
//   an SSO session run out. An account no longer reached at all is gone, its repositories with it; with none reached
//   any more, every one goes, and the connection shows the shared App uninstalled until a listing finds one again. A
//   cause cleared, by a listing or the poller, is told (`accountBack`): what waited on that account starts. A
//   repository whose owner is no account listed takes no cause: its refusal is the connection's.
// Ordering: listings, the install's checks and the holding of another sign-in or App (`signedIn`, `adopt`) run one at a
// time, in one turn (`serially`, `inTurn`), so two never add the same repository twice and no work of one holding
// runs once another is held. Each holding is numbered (`holding`): the number moves as another is asked to be held,
// which ends the work under way at once (each of its waits, `settled`, races the move), skips the work queued before
// it, and moves again once it is held, so what the poller began in between is dropped too. Every wait of a holding's
// work is `settled` or followed by `still`: past it, the holding is the one it began under, else the work ends there
// (`Superseded`), nothing applied (ADR 0066). Once stopping, nothing is armed, and a listing that answers late changes
// nothing.
// Errors: `discover` throws the host's `HostError` (an installation that is gone: `not_found`, cause `uninstalled`);
// `open` only what isn't GitHub's (the App store unreadable); the timers log what theirs throw. `adopt` throws the App store's error, and nothing is changed then.
// It must never know: the queue, the poller or the setup's steps (the room's moves, given as `added`, `removed` and
// `installed`); and it never logs, sends or keeps a key anywhere but through the App store.

import { isDeepStrictEqual } from "node:util";
import {
  type AccountCause,
  type AppCredentials,
  accountOf,
  type ConnectionAccount,
  type ConnectionApp,
  type ConnectionCause,
  type ConnectionId,
  type ConnectionWay,
  connectionCauseOf,
  type EventBody,
  type HostAccounts,
  type HostApp,
  HostError,
  type HostInstallations,
  type HostIntake,
  type HostLogin,
  type HostSignIn,
  type HostWriter,
  type KeyProtection,
  type ReachedAccount,
  type RepositoryRef,
  type Setup,
  type SignIn,
  type SignInKeeper,
  sameRepository,
} from "@lookover/contracts";
import { type AppStore, type Membership, type StoredApp, storedApp } from "./app-store.ts";
import { installationLines, membershipLines } from "./log-lines.ts";
import { type GhMember, membershipOf } from "./membership.ts";
import { said } from "./said.ts";
import type { SignInStore } from "./sign-in-store.ts";
import { connectionIdOf } from "./snapshot.ts";
import type { Timers } from "./timers.ts";

/** How often the installation's repositories are listed while it is installed: GitHub sends no webhook here. */
const DISCOVERY_MS = 5 * 60_000;
/** How soon it is listed again when GitHub refused the last listing: the poll's quiet cadence. */
export const DISCOVERY_RETRY_MS = 60_000;
/** How often the installation is read while the setup waits for the install: the "few seconds" the screen says. */
const INSTALL_CHECK_MS = 4_000;
/** How often the person's membership of the App's organisation is asked of their `gh` (ADR 0059). */
const MEMBERSHIP_MS = 60 * 60_000;

/** The repository ports the room reviews through: GitHub's, signing as the App. */
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

/** How the service reaches GitHub at the App level, and where its App comes from (ADR 0053). */
export interface GitHubSide {
  /** The App, its installation on the App's account, the installation's repositories. */
  installations: HostInstallations;
  /** The repository ports, signing as the App with these credentials. */
  connect(credentials: AppCredentials): HostPorts;
  /** `live.json`'s App, used as it is and never stored. Absent: the data folder's (`apps`). */
  given?: AppCredentials;
  /**
   * Who `given`'s App works for when GitHub says an organisation owns it: the person their own `gh` names (ADR 0059),
   * never the organisation; throws when it can't say. Absent: such an App is refused at start.
   */
  person?(): Promise<HostLogin>;
  /** The data folder's App store, one for the data folder: read at start and on Reconnect, written by `adopt`. */
  apps?: AppStore;
  /** `live.json`'s allow-list: only these are watched, whatever the installation lists. Absent: every one listed. */
  allowed?: readonly RepositoryRef[];
  /** `live.json` guards this run (ADR 0053): no App is ever created here, with or without its `app`. */
  liveConfig?: boolean;
  /** The shared App, signed in to (ADR 0066). Absent: no sign-in is offered, and only an own App is used. */
  shared?: SharedSide;
}

/**
 * The App as the service holds it now, or the person signed in to the shared App (`signed-in`, ADR 0066, with what
 * their sign-in reaches and its ports). `key`: how Lookover keeps its key, null for `live.json`'s. `membership`: the
 * last answer of the person's `gh` on an organisation's App, null with none yet. `unread`: `live.json`'s, which GitHub
 * refused to describe at start (down, or the key refused), so its slug and owner are not known yet.
 */
type AppNow =
  | { state: "none" }
  | { state: "signed-in"; person: HostLogin; accounts: HostAccounts; ports: HostPorts }
  | {
      state: "kept";
      app: StoredApp;
      credentials: AppCredentials;
      key: KeyProtection | null;
      membership: Membership | null;
    }
  | { state: "lost"; app: StoredApp; cause: ConnectionCause; membership: Membership | null }
  | { state: "unread"; credentials: AppCredentials; cause: ConnectionCause };

/** What can be listed: an App kept, or the person signed in to the shared App. */
type Listable = Extract<AppNow, { state: "kept" | "signed-in" }>;

/** What the installation lists: the accounts it is on (one on `own`), and the repositories watched of them. */
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
  /** Repositories the installation lists and the room doesn't watch: watched from now on, polled at once. */
  added(repos: RepositoryRef[]): Promise<void>;
  /** A repository the installation no longer lists: no longer watched, what it waited for dropped. */
  removed(repo: RepositoryRef): Promise<void>;
  /** The setup's GitHub step: the App's installation found, granting repositories or none. */
  installed(granted: boolean): void;
  /**
   * What a listing of the installation's repositories met (ADR 0053): GitHub answered (null), or refused for a cause
   * the connection then shows.
   */
  reached(cause: ConnectionCause | null): void;
  /** An account's cause cleared (ADR 0066): what waited on it can start. */
  accountBack(): void;
  /** The person's own `gh` asked for its account's membership of `organisation` (ADR 0059). */
  member(organisation: string): Promise<GhMember>;
  /** The hour's check found the person a member again (ADR 0059): GitHub listed again at once, as "Check again" does. */
  memberAgain(): void;
  log(line: string): void;
}

export interface Installation {
  /** The repository ports, as the App now held signs: what the room's parts are given, once. */
  ports: HostPorts;
  /**
   * The owner on GitHub: the person the App works for (ADR 0059), never its account when that is an organisation.
   * Read at each use, so an App adopted later is the owner's. Every "is it yours" asks it, by numeric id.
   */
  owner: { readonly id: number; readonly login: string };
  /** The App as the app shows it; null with none, and on `shared`. */
  app(): ConnectionApp | null;
  /** The App as it is kept; null with none. */
  stored(): StoredApp | null;
  /** The bot's login, `<slug>[bot]`; null with no App, and on `shared`. */
  bot(): string | null;
  /** The way Lookover is on GitHub (ADR 0066): `own` with an App held, `shared` signed in, null with neither. */
  way(): ConnectionWay | null;
  /** The connection's id once installed: the bot's on `own`, the person's on `shared`; null with neither. */
  connectionId(): ConnectionId | null;
  /** The person signed in to the shared App, held on `shared` (ADR 0066); null on `own` and with neither. */
  person(): HostLogin | null;
  /**
   * A sign-in to the shared App finished (ADR 0066): kept in the sign-in store in place of the last, then held, the
   * ports posting as its person from then on, and the connection told the way (`shared`, no bot, no App). Throws when
   * no shared App is offered, while an own App is held (it wins), or when the store can't keep it: nothing changes.
   */
  signedIn(signIn: SignIn): Promise<void>;
  /** How the App's key is kept, for Run checks: null with none, or `live.json`'s. */
  key(): KeyProtection | null;
  /**
   * Each account reached, with its installation and its own cause (ADR 0066), once listed; none before. One on `own`.
   */
  accounts(): ConnectionAccount[];
  /**
   * Which holding is held now (ADR 0066): a number that moves each time another sign-in or App is held. What an act
   * read under one (`refused`, `answered`) is that one's.
   */
  holding(): number;
  /**
   * An act on `repo` begun under the holding `at` refused with `cause`, its account's by the rule by kind (ADR 0066):
   * on `shared`, the account named by the repository's owner holds it, the connection told when it moved; true then,
   * its other accounts still used. False on `own` (or with no sign-in): the cause is the connection's. Begun under an
   * earlier holding, it is that one's: true, nothing told.
   */
  refused(repo: RepositoryRef, cause: AccountCause, at: number): boolean;
  /**
   * `repo` answered (its listing, begun under the holding `at`): its account's cause, when it held one, cleared and the
   * connection told. True when it cleared one, so what waited on the account can start; false, nothing cleared, when
   * begun under an earlier holding.
   */
  answered(repo: RepositoryRef, at: number): boolean;
  /**
   * Why the connection can't be used at start (ADR 0053): the App's key lost, or GitHub's refusal of what `open` read
   * (the App, its installation, its repositories); null otherwise.
   */
  down(): ConnectionCause | null;
  /**
   * At start: the App read, and, when `installed` (the setup says so), the installation's repositories, the
   * room's to watch. Null when nothing was listed (no App, one not installed yet, a lost key, GitHub's refusal, the
   * App not installed any more): the room keeps what it listed last, and `down` says why. A refusal is logged, never
   * thrown: the service starts when GitHub refuses it.
   */
  open(installed: boolean): Promise<RepositoryRef[] | null>;
  /**
   * After start, as the setup stands: the install waited for while the setup waits for it (or nothing was granted),
   * else the listing every 5 minutes once installed.
   */
  begin(setup: Setup): void;
  /**
   * "Reconnect", the timer, or the poller's asking: a lost key read again from the App store (`live.json`'s App
   * described), then the installation's repositories listed, each added or removed as the room needs, and what it met
   * told (`reached`). Throws GitHub's refusal, or `not_found` (cause `uninstalled`) when the App has no installation.
   */
  discover(): Promise<void>;
  /** The setup waits for the install: the installation read now, then every 4 s until it lists repositories. */
  waitForInstall(): void;
  /**
   * An App created or given (ADR 0053): kept in the App store, then signing the ports. `membership`: what the person's
   * `gh` just answered for an organisation's App ("Use an existing App" asks it), kept in the same write and held in
   * place of any answer before: not a member, every call refused at once. Throws when there is no App store
   * (`live.json` names the App) or the store can't keep it; nothing changes then.
   */
  adopt(app: StoredApp, key: string, membership?: Membership): Promise<void>;
  /**
   * The person's membership of the App's organisation asked of their own `gh` now (ADR 0059), as the hour's check
   * does; nothing for a personal App, which never asks. An answer for the person is kept with the App: no longer a
   * member, every call is refused with the cause `not-a-member` (told as `reached`); a member again, the App's ports
   * sign again. No answer for them leaves the last one. True when it made the person a member again, false otherwise;
   * never rejects.
   */
  checkMembership(): Promise<boolean>;
  /**
   * Nothing armed any more; a listing under way changes nothing once it answers. Settles once a membership answer
   * being kept with the App is.
   */
  stop(): Promise<void>;
}

/** The App as the app shows it: its account and the person it works for. */
const connectionAppOf = (app: StoredApp): ConnectionApp => ({
  id: app.id,
  slug: app.slug,
  account: { ...app.account },
  person: { ...app.person },
});

/**
 * A personal App as GitHub describes it (`HostApp`, a manifest's conversion), as the service keeps it: on its owner's
 * account, the person being that account (ADR 0059). Throws for an organisation's App: its person is never the
 * organisation, and only the person's own `gh` can say who they are.
 */
export const storedOf = ({ id, slug, owner }: Pick<HostApp, "id" | "slug" | "owner">): StoredApp => {
  if (owner.type !== "User")
    throw new Error(`${slug} belongs to the organisation ${owner.login}: only a personal App is taken here`);
  return storedApp(id, slug, owner, owner);
};

/** The bot of an App: GitHub names it after the slug. */
const botOf = (app: StoredApp) => `${app.slug}[bot]`;

/** Every call refused with `cause`: the ports of an App whose key is lost, or of none. */
const refusing = (cause: ConnectionCause, why: string): HostPorts =>
  whenReady(() => Promise.reject(new HostError("unauthorized", why, { connectionCause: cause })));

/**
 * Ports that wait for `ready` at each call, then call the ports it gives; refused as `ready` is. The ports of
 * `live.json`'s App not described yet: each call describes it first.
 */
function whenReady(ready: () => Promise<HostPorts>): HostPorts {
  const intake = () => ready().then((ports) => ports.intake);
  const writer = () => ready().then((ports) => ports.writer);
  return {
    intake: {
      listOpenChanges: (...a) => intake().then((p) => p.listOpenChanges(...a)),
      listComments: (...a) => intake().then((p) => p.listComments(...a)),
      getChange: (...a) => intake().then((p) => p.getChange(...a)),
      threads: (...a) => intake().then((p) => p.threads(...a)),
      poster: (...a) => intake().then((p) => p.poster(...a)),
      countCommits: (...a) => intake().then((p) => p.countCommits(...a)),
      fetchSpec: (...a) => intake().then((p) => p.fetchSpec(...a)),
    },
    writer: {
      createCheck: (...a) => writer().then((p) => p.createCheck(...a)),
      findCheck: (...a) => writer().then((p) => p.findCheck(...a)),
      updateCheck: (...a) => writer().then((p) => p.updateCheck(...a)),
      completeCheck: (...a) => writer().then((p) => p.completeCheck(...a)),
      publishReview: (...a) => writer().then((p) => p.publishReview(...a)),
      findReview: (...a) => writer().then((p) => p.findReview(...a)),
      upsertSummary: (...a) => writer().then((p) => p.upsertSummary(...a)),
      react: (...a) => writer().then((p) => p.react(...a)),
      reply: (...a) => writer().then((p) => p.reply(...a)),
      minimize: (...a) => writer().then((p) => p.minimize(...a)),
    },
  };
}

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
      upsertSummary: (...a) => writer().upsertSummary(...a),
      react: (...a) => writer().react(...a),
      reply: (...a) => writer().reply(...a),
      minimize: (...a) => writer().minimize(...a),
    },
  };
}

/** The App from the data folder's store: kept, lost or none. The cause of a lost key: a retry when the keychain didn't answer. */
async function fromStore(apps: AppStore | undefined): Promise<AppNow> {
  if (apps === undefined) return { state: "none" };
  const read = await apps.read();
  if (read.state === "none") return read;
  if (read.state === "lost") {
    const cause: ConnectionCause = read.why === "keychain" ? { kind: "unreachable" } : { kind: "key-lost" };
    return { state: "lost", app: read.app, cause, membership: read.membership };
  }
  return {
    state: "kept",
    app: read.app,
    credentials: { id: read.app.id, key: read.privateKey },
    key: read.protection,
    membership: read.membership,
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

/** The organisation whose App it is, by its login; null for a personal App. */
const organisationOf = (app: StoredApp): string | null =>
  app.account.type === "Organization" ? app.account.login : null;

/**
 * The cause the App held gives when `gh` last said the person is no longer a member of its organisation (ADR 0059);
 * null otherwise, and always for a personal App.
 */
function notAMemberCause(held: AppNow): ConnectionCause | null {
  if (held.state !== "kept" && held.state !== "lost") return null;
  const organisation = organisationOf(held.app);
  return organisation !== null && held.membership === "not-a-member"
    ? { kind: "not-a-member", organisation }
    : null;
}

/** A holding's work ended: another sign-in or App is held now, or the service stops. Nothing it read is applied. */
class Superseded extends Error {}

/** What a wait resolves to when the holding it waits under is left. */
const LEFT = Symbol("left");

export function createInstallation(d: InstallationDeps): Installation {
  const { side } = d;
  let held: AppNow = { state: "none" };
  let current: HostPorts = refusing({ kind: "key-lost" }, "No GitHub App is kept yet");
  /** Each account reached as last listed, with its own cause; none before the first listing. */
  let accounts: ConnectionAccount[] = [];
  let stopping = false;
  /**
   * Which holding this is: moved each time another sign-in or App is held (`signedIn`, `adopt`). A listing, or a
   * refusal the poller met, read under an earlier one is that one's, never applied to the one held now.
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
   * before the setup is done, so the install's check says it, and a new sign-in or an own App clears it.
   */
  let signedOutWaiting = false;
  /** Whether the setup said at start that the App is installed: `live.json`'s App described later is connected. */
  let installedAtStart = false;
  /** GitHub's refusal of what `open` listed, as the connection's cause; null when it listed, or wasn't asked. */
  let refusedAtStart: ConnectionCause | null = null;
  /** `live.json`'s App being described, while it is. */
  let describing: Promise<HostPorts> | null = null;

  /** The hour's membership check, while one is armed. */
  let memberTimer: (() => void) | null = null;
  /** The last membership answer being kept with the App: `stop` waits for it. */
  let keeping: Promise<void> = Promise.resolve();

  const hold = (app: AppNow): void => {
    held = app;
    const notAMember = notAMemberCause(app);
    if (app.state === "signed-in") current = app.ports;
    else if (app.state === "kept" && notAMember !== null)
      current = refusing(notAMember, membershipLines.refused(app.app.person.login, app.app.account.login));
    else if (app.state === "kept") current = side.connect(app.credentials);
    else if (app.state === "lost")
      current = refusing(app.cause, `The key of ${app.app.slug} no longer opens: add a new key`);
    else if (app.state === "unread") current = whenReady(described);
    else current = refusing({ kind: "key-lost" }, "No GitHub App is kept yet");
  };

  /** The App held, kept or lost; null with none, `live.json`'s not described yet, or on `shared`. */
  const appHeld = (): StoredApp | null => (held.state === "kept" || held.state === "lost" ? held.app : null);
  /** The person Lookover works for: the App's, or the one signed in to the shared App; null with neither yet. */
  const personHeld = (): HostLogin | null =>
    held.state === "signed-in" ? held.person : (appHeld()?.person ?? null);

  /**
   * What can be listed now: an App kept for a person still a member of its organisation, or the person signed in to
   * the shared App; null otherwise.
   */
  const listable = (): Listable | null =>
    held.state === "signed-in" || (held.state === "kept" && notAMemberCause(held) === null) ? held : null;

  /** The person signed in to the shared App, held: what their sign-in reaches, and the ports as them. */
  const signedInAs = (shared: SharedSide, person: HostLogin): AppNow => ({
    state: "signed-in",
    person: { id: person.id, login: person.login },
    accounts: shared.accounts(shared.signIns.keeper),
    ports: shared.connect(shared.signIns.keeper),
  });

  /**
   * The data folder's own App when it keeps one (ADR 0066: it wins), else its sign-in to the shared App, kept or no
   * longer opening (its ports then refuse as signed out), else none.
   */
  const ownOrShared = async (): Promise<AppNow> => {
    const own = await fromStore(side.apps);
    const { shared } = side;
    if (own.state !== "none" || shared === undefined) return own;
    const read = await shared.signIns.read();
    if (read.state === "none") return own;
    return signedInAs(shared, read.state === "kept" ? read.signIn.person : read.person);
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

  /**
   * The App the credentials sign as, described by GitHub: `live.json`'s. An organisation's works for the person
   * `side.person` names (ADR 0059); without it, `storedOf` refuses it. At start, the person's failure (`gh` signed
   * out) refuses the start; later, it is a `HostError` with GitHub unreachable as the connection's cause (the nearest
   * one contracts have: Reconnect tries again), so the poller and Reconnect meet only GitHub's refusals.
   */
  const given = async (credentials: AppCredentials, atStart: boolean): Promise<AppNow> => {
    const app = await side.installations.app(credentials);
    const { person } = side;
    const stored =
      app.owner.type === "User" || person === undefined
        ? storedOf(app)
        : storedApp(app.id, app.slug, app.owner, await personOf(person, atStart));
    // `live.json`'s App keeps no answer: its membership is asked again at each start.
    return { state: "kept", app: stored, credentials, key: null, membership: null };
  };
  const personOf = async (person: () => Promise<HostLogin>, atStart: boolean): Promise<HostLogin> => {
    try {
      return await person();
    } catch (error) {
      if (atStart || error instanceof HostError) throw error;
      throw new HostError("unavailable", said(error), { connectionCause: { kind: "unreachable" } });
    }
  };

  /**
   * `live.json`'s App at start: described by GitHub, else held unread, with the cause GitHub's refusal gives (GitHub
   * unreachable when it gives none, a rate limit say: Reconnect tries again).
   */
  const givenAtStart = async (credentials: AppCredentials): Promise<AppNow> => {
    try {
      return await given(credentials, true);
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
      d.log(`the GitHub App could not be read: ${said(error)}`);
      return { state: "unread", credentials, cause: connectionCauseOf(error) ?? { kind: "unreachable" } };
    }
  };

  /**
   * `live.json`'s App described, once at a time, at the first call that needs it: then its ports, and the connection
   * shows it (its bot, its App, and its id when the setup said it is installed). Refused as GitHub refuses.
   */
  const described = (): Promise<HostPorts> => {
    describing ??= describe().finally(() => {
      describing = null;
    });
    return describing;
  };
  async function describe(): Promise<HostPorts> {
    if (held.state !== "unread") return current;
    const now = await given(held.credentials, false);
    if (held.state !== "unread" || now.state !== "kept") return current;
    if (!(await admit(async () => now, { lostToo: false, tell: true }))) return current;
    armMembership();
    const bot = botOf(now.app);
    d.emit({
      type: "connection.changed",
      at: d.now(),
      patch: {
        bot,
        app: connectionAppOf(now.app),
        ...(installedAtStart ? { id: connectionIdOf(bot) } : {}),
      },
    });
    return current;
  }

  /** The repositories cut to the allow-list, when there is one. */
  const allowedOf = (listed: readonly RepositoryRef[]): RepositoryRef[] => {
    const { allowed } = side;
    return allowed === undefined
      ? [...listed]
      : listed.filter((r) => allowed.some((a) => sameRepository(a, r)));
  };

  /**
   * What the installation lists now, cut to the allow-list; null when the App isn't installed. On `shared`, every
   * account the sign-in reaches, each with its cause, their repositories together, with those the room watches on an
   * account with a cause kept (refused until it is mended, never departed); null when it reaches none.
   */
  const list = async (now: Listable): Promise<Listed | null> => {
    if (now.state === "signed-in") {
      const reached = await now.accounts.accounts();
      if (reached.length === 0) return null;
      const listed = reached.map(accountOfReached);
      const kept = d.watched().filter((repo) => (accountOf(listed, repo.owner)?.cause ?? null) !== null);
      return { accounts: listed, repos: [...allowedOf(reached.flatMap((a) => a.repositories)), ...kept] };
    }
    const found = await side.installations.installation(now.credentials);
    if (found === null) return null;
    return {
      accounts: [{ account: { ...found.account }, installationId: found.id, cause: null, owner: null }],
      repos: allowedOf(await side.installations.repositories(now.credentials, found.id)),
    };
  };

  /** The App, or the shared App on the person's accounts, installed nowhere it is looked for. */
  const uninstalled = (now: Listable) =>
    new HostError(
      "not_found",
      now.state === "signed-in"
        ? installationLines.notReached(now.person.login)
        : installationLines.notInstalled(now.app.slug, now.app.account),
      { connectionCause: { kind: "uninstalled", suspended: false } },
    );

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
   * `cause` (null: none) held by the account `repo` is on, on `shared`, the connection told when it moved; false
   * when the cause is the connection's (`own`, no sign-in, or no account listed is the repository's owner).
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
   * The room watches what the installation lists under the holding `at`: each gone removed, then the new ones added;
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
   * The next discovery, `ms` on (5 minutes unless said): what it throws is logged, and the one after comes a minute
   * on while GitHub refuses it, so a service that started while GitHub refused it comes back by itself.
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

  /**
   * A lost key read again from the App store (kept back, still lost, or no App left), or `live.json`'s App described,
   * which throws GitHub's refusal. A key back opens its ports only once `admit` asked the person's membership.
   */
  const reread = async (): Promise<void> => {
    if (held.state === "lost") await admit(() => fromStore(side.apps), { lostToo: false, tell: true });
    else if (held.state === "unread") await described();
  };

  /**
   * The App read again, then its installation's repositories listed and followed; false when no App is kept, or the
   * person is no longer a member of its organisation (nothing is read for them then: the connection says why already).
   */
  const listedAgain = async (at: number): Promise<boolean> => {
    await settled(at, reread);
    const now = listable();
    if (now === null) return false;
    // Another sign-in held meanwhile: what this one reached is not theirs (ADR 0066), and the work ends here.
    const listed = await settled(at, () => list(now));
    if (listed === null) {
      // On `shared`, no account reached any more departs every one, as one gone departs (ADR 0066); then refused.
      if (now.state === "signed-in") {
        installedAs([]);
        await follow([], at);
        still(at);
      }
      throw uninstalled(now);
    }
    installedAs(listed.accounts);
    await follow(listed.repos, at);
    still(at);
    return true;
  };

  /** The cause `not-a-member` when the App is kept for a person no longer a member; null otherwise. */
  const keptForNoMember = (): ConnectionCause | null =>
    held.state === "kept" ? notAMemberCause(held) : null;

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
            // Not listed for a person no longer a member: the connection says so, whatever it said before.
            const cause = listed ? null : keptForNoMember();
            if (listed || cause !== null) d.reached(cause);
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
   * The installation listed and followed; null when not installed yet, or when another sign-in or App was held while
   * it was read (what it read is not theirs: the wait goes on), "refused" when GitHub refused (logged once, not every
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

  /** The signed-out cause the install's check showed, cleared: the person signed in again, or an own App given. */
  const signedInAgain = (): EventBody => {
    signedOutWaiting = false;
    return { type: "connection.changed", at: d.now(), patch: { cause: null } };
  };

  /**
   * One check of the install: a lost key read again from the App store first, then listed, followed, and the setup
   * told; armed again until repositories are granted, while an App is held.
   */
  const check = (): Promise<void> =>
    serially(async (at) => {
      if (stopping || !(await readForCheck(at))) return;
      // Nothing listed for a person no longer a member (ADR 0059): the install is waited for until they are again.
      const now = listable();
      if (now === null) return;
      const listed = await followed(now, at);
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

  /** A lost key read again before an install's check, under the holding `at`: false, logged once, when refused. */
  const readForCheck = async (at: number): Promise<boolean> => {
    try {
      await settled(at, reread);
      return true;
    } catch (error) {
      if (error instanceof Superseded) throw error;
      if (!refused) d.log(`the GitHub App could not be read: ${said(error)}`);
      refused = true;
      return false;
    }
  };

  const down = (): ConnectionCause | null =>
    held.state === "lost" || held.state === "unread" ? held.cause : (notAMemberCause(held) ?? refusedAtStart);

  /**
   * The one way the App comes to be held from where it is kept (ADR 0059): the App store at start and when a lost key
   * is read again, `live.json`'s once GitHub describes it. An organisation's App kept has its person's membership
   * asked of their `gh` before it is held, so its ports never open on an answer older than now; no answer for them,
   * the last one kept stands. `lostToo`: asked of an App whose key is lost too (at start: then every hour while it
   * is). `tell`: the room told of a member lost. False, nothing held, when the App held moved meanwhile.
   */
  const admit = async (
    read: () => Promise<AppNow>,
    o: { lostToo: boolean; tell: boolean },
  ): Promise<boolean> => {
    const from = held;
    const next = await read();
    const asked = next.state === "kept" || (o.lostToo && next.state === "lost") ? next.app : null;
    const organisation = asked === null ? null : organisationOf(asked);
    const answer = asked === null || organisation === null ? null : await answerOrLog(asked, organisation);
    if (held !== from || stopping) return false;
    hold(next);
    if (answer !== null) await answered(answer, o.tell);
    return true;
  };
  /**
   * The person's membership asked of their `gh` (ADR 0059), on an organisation's App kept or whose key is lost;
   * `tell`: the room is told of a member lost (not at start: `down` says it then). True when the person is a member
   * again after not being one.
   */
  const askMembership = async (tell: boolean): Promise<boolean> => {
    const app = appHeld();
    const organisation = app === null ? null : organisationOf(app);
    if (app === null || organisation === null) return false;
    const answer = await answerFor(app, organisation);
    if (stopping || appHeld() !== app || answer === null) return false;
    return answered(answer, tell);
  };
  /** An answer for the person held with the App, logged and kept with it when it moved. True: a member again. */
  const answered = async (answer: Membership, tell: boolean): Promise<boolean> => {
    if (held.state !== "kept" && held.state !== "lost") return false;
    const { app, membership: lastAnswer } = held;
    const organisation = organisationOf(app);
    if (organisation === null || answer === lastAnswer) return false;
    hold({ ...held, membership: answer });
    const memberAgain = membershipMoved(app, organisation, lastAnswer, tell);
    await keepAnswer(answer);
    return memberAgain;
  };
  /** What the person's `gh` answers of their membership of `organisation`; null with no answer for them, logged. */
  const answerFor = async (app: StoredApp, organisation: string): Promise<Membership | null> => {
    const read = membershipOf(app.person, organisation, await d.member(organisation));
    if (!("unanswered" in read)) return read.membership;
    d.log(read.unanswered);
    return null;
  };
  /** `answerFor`, a `gh` that threw logged as no answer. */
  const answerOrLog = (app: StoredApp, organisation: string): Promise<Membership | null> =>
    answerFor(app, organisation).catch((error: unknown) => {
      d.log(membershipLines.unanswered(organisation, said(error)));
      return null;
    });
  /** The answer kept with the data folder's App; `live.json`'s keeps none. */
  const keepAnswer = async (membership: Membership): Promise<void> => {
    if (side.given !== undefined || side.apps === undefined) return;
    keeping = side.apps
      .keepMembership(membership)
      .catch((error: unknown) => d.log(membershipLines.notKept(said(error))));
    await keeping;
  };
  /**
   * What a new answer moved, logged; the room told of a member lost when `tell` and the App's key opens (a lost key's
   * cause stays the one shown until it is back). True: a member again.
   */
  const membershipMoved = (
    app: StoredApp,
    organisation: string,
    lastAnswer: Membership | null,
    tell: boolean,
  ): boolean => {
    const notAMember = notAMemberCause(held);
    if (notAMember !== null) {
      d.log(membershipLines.noLongerMember(app.person.login, organisation));
      if (tell && !stopping && held.state === "kept") d.reached(notAMember);
      return false;
    }
    if (lastAnswer === null) d.log(membershipLines.member(app.person.login, organisation));
    if (lastAnswer !== "not-a-member") return false;
    d.log(membershipLines.memberAgain(app.person.login, organisation));
    return true;
  };
  /** Why the membership couldn't be asked, when asking it threw. */
  const unansweredFor = (error: unknown): string =>
    membershipLines.unanswered(appHeld()?.account.login ?? "the organisation", said(error));
  const checkMembership = (): Promise<boolean> =>
    askMembership(true).catch((error: unknown) => {
      d.log(unansweredFor(error));
      return false;
    });

  /**
   * The membership an App adopted is held with (ADR 0059), and the last answer for it when it is the App kept: the
   * answer `gh` just gave for it (`asked`), else, for a new key of the App kept, its last one (a person no longer a
   * member stays so until gh says otherwise), else, for another organisation's App (GitHub's redirect back, a while
   * after "Create it on GitHub" asked), `gh` asked now, before its ports open. None for a personal App.
   */
  const adoptedAnswer = async (
    app: StoredApp,
    asked: Membership | null,
  ): Promise<{ lastAnswer: Membership | null; membership: Membership | null }> => {
    const organisation = organisationOf(app);
    const now = held.state === "kept" || held.state === "lost" ? held : null;
    const same = now !== null && now.app.id === app.id;
    const lastAnswer = same ? now.membership : null;
    if (organisation === null) return { lastAnswer, membership: null };
    if (asked !== null) return { lastAnswer, membership: asked };
    return { lastAnswer, membership: same ? lastAnswer : await answerOrLog(app, organisation) };
  };

  /** The hour's membership check armed, on an organisation's App: each runs, then arms the next. */
  const armMembership = (): void => {
    memberTimer?.();
    const app = appHeld();
    memberTimer =
      stopping || app === null || organisationOf(app) === null
        ? null
        : d.timers.after(MEMBERSHIP_MS, () => {
            memberTimer = null;
            void checkMembership()
              .then((memberAgain) => {
                if (memberAgain && !stopping) d.memberAgain();
              })
              .finally(armMembership);
          });
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
    app: () => {
      const app = appHeld();
      return app === null ? null : connectionAppOf(app);
    },
    stored: appHeld,
    bot: () => {
      const app = appHeld();
      return app === null ? null : botOf(app);
    },
    way: () => (held.state === "none" ? null : held.state === "signed-in" ? "shared" : "own"),
    connectionId: () => {
      if (held.state === "signed-in") return connectionIdOf(held.person.login);
      const app = appHeld();
      return app === null ? null : connectionIdOf(botOf(app));
    },
    person: () => (held.state === "signed-in" ? { ...held.person } : null),
    signedIn: async (signIn) => {
      const { shared } = side;
      if (shared === undefined) throw new Error("No shared App is offered here");
      const ownWins = () => {
        if (held.state !== "none" && held.state !== "signed-in")
          throw new Error("Lookover runs as its own App here: it wins over a sign-in");
      };
      ownWins();
      // What the last holding runs ends now, then the sign-in is held in the turn, nothing of the last one after it.
      moveHolding();
      await inTurn(async () => {
        ownWins();
        await shared.signIns.write(signIn);
        hold(signedInAs(shared, signIn.person));
        moveHolding();
        d.emit({
          type: "connection.changed",
          at: d.now(),
          patch: { way: "shared", bot: null, app: null, person: { ...signIn.person } },
        });
        if (signedOutWaiting) d.emit(signedInAgain());
      });
    },
    key: () => (held.state === "kept" ? held.key : null),
    accounts: () => accounts,
    holding: () => holding,
    refused: (repo, cause, at) => at !== holding || accountHolds(repo, cause),
    answered: (repo, at) =>
      at === holding && (accountOf(accounts, repo.owner)?.cause ?? null) !== null && accountHolds(repo, null),
    down,
    open: async (installed) => {
      installedAtStart = installed;
      // The person's membership, before anything is read for them: no longer a member, nothing is listed.
      await admit(() => (side.given === undefined ? ownOrShared() : givenAtStart(side.given)), {
        lostToo: true,
        tell: false,
      });
      const now = listable();
      if (now === null || !installed) return null;
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
    },
    begin: (setup) => {
      if (held.state === "none") return;
      armMembership();
      if (setup.github === "waiting-for-install" || setup.github === "nothing-granted") waitForInstall();
      // Refused at start: listed again a minute on, as after any refused listing.
      else if (setup.github === "done") armDiscovery(down() === null ? DISCOVERY_MS : DISCOVERY_RETRY_MS);
    },
    discover,
    waitForInstall,
    adopt: async (app, key, asked) => {
      const { apps } = side;
      if (apps === undefined) throw new Error("live.json names the App: Lookover keeps no other");
      // What the last holding runs ends now, then the App is held in the turn, nothing of the last one after it.
      moveHolding();
      await inTurn(async () => {
        const organisation = organisationOf(app);
        const { lastAnswer, membership } = await adoptedAnswer(app, asked ?? null);
        // Key and answer in one write.
        const { protection } = await apps.write(app, key, membership ?? undefined);
        hold({ state: "kept", app, credentials: { id: app.id, key }, key: protection, membership });
        moveHolding();
        d.emit({
          type: "connection.changed",
          at: d.now(),
          patch: { way: "own", app: connectionAppOf(app), bot: botOf(app), person: null },
        });
        if (signedOutWaiting) d.emit(signedInAgain());
        if (organisation !== null && membership !== null && membership !== lastAnswer)
          membershipMoved(app, organisation, lastAnswer, true);
        armMembership();
      });
    },
    checkMembership,
    stop: () => {
      stopping = true;
      timer?.();
      timer = null;
      memberTimer?.();
      memberTimer = null;
      return keeping;
    },
  };
}
