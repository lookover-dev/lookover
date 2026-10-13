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
//   ends. One wait at a time; asked again while it runs, it reads now.
// - The person's membership (ADR 0059), on an organisation's App only: asked of their own `gh` (`member`) before the
//   App's ports open, every way they do (`admit`: at start, its key lost or not, a lost key back, `live.json`'s App
//   described; `adopt`: the answer "Use an existing App" just got, else for another App `gh` asked then), then every
//   hour, its key lost or not, and on "Check again" (`checkMembership`). Only an answer for the person counts, kept
//   with the data folder's App (`live.json`'s keeps none, asked again at each start): no longer an active member
//   (absent, or only invited), every call is refused with the cause `not-a-member` and nothing is listed, not even
//   while the install is waited for, until a later answer says they are one again; `gh` signed in as another
//   account, or unable to answer, leaves the last answer, the log saying why. A personal App never asks.
// Ordering: listings run one at a time (`serially`), so two never add the same repository twice. Once stopping,
// nothing is armed, and a listing that answers late changes nothing.
// Errors: `discover` throws the host's `HostError` (an installation that is gone: `not_found`, cause `uninstalled`);
// `open` only what isn't GitHub's (the App store unreadable); the timers log what theirs throw. `adopt` throws the App store's error, and nothing is changed then.
// It must never know: the queue, the poller or the setup's steps (the room's moves, given as `added`, `removed` and
// `installed`); and it never logs, sends or keeps a key anywhere but through the App store.
import {
  type AppCredentials,
  type ConnectionApp,
  type ConnectionCause,
  connectionCauseOf,
  type EventBody,
  type HostApp,
  HostError,
  type HostInstallations,
  type HostIntake,
  type HostLogin,
  type HostWriter,
  type KeyProtection,
  type RepositoryRef,
  type Setup,
  sameRepository,
} from "@lookover/contracts";
import { type AppStore, type Membership, type StoredApp, storedApp } from "./app-store.ts";
import { installationLines, membershipLines } from "./log-lines.ts";
import { type GhMember, membershipOf } from "./membership.ts";
import { said } from "./said.ts";
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
}

/**
 * The App as the service holds it now. `key`: how Lookover keeps its key, null for `live.json`'s. `membership`: the
 * last answer of the person's `gh` on an organisation's App, null with none yet. `unread`: `live.json`'s, which GitHub
 * refused to describe at start (down, or the key refused), so its slug and owner are not known yet.
 */
type AppNow =
  | { state: "none" }
  | {
      state: "kept";
      app: StoredApp;
      credentials: AppCredentials;
      key: KeyProtection | null;
      membership: Membership | null;
    }
  | { state: "lost"; app: StoredApp; cause: ConnectionCause; membership: Membership | null }
  | { state: "unread"; credentials: AppCredentials; cause: ConnectionCause };

/** What the installation lists: its id and the repositories watched of it. */
interface Listed {
  installationId: number;
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
  /** The App as the app shows it; null with none. */
  app(): ConnectionApp | null;
  /** The App as it is kept; null with none. */
  stored(): StoredApp | null;
  /** The bot's login, `<slug>[bot]`; null with no App. */
  bot(): string | null;
  /** How the App's key is kept, for Run checks: null with none, or `live.json`'s. */
  key(): KeyProtection | null;
  /** The installation's id, once listed; null before. */
  installationId(): number | null;
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

export function createInstallation(d: InstallationDeps): Installation {
  const { side } = d;
  let held: AppNow = { state: "none" };
  let current: HostPorts = refusing({ kind: "key-lost" }, "No GitHub App is kept yet");
  let installation: number | null = null;
  let stopping = false;
  /** The listings, one after the other; never rejects. */
  let chain: Promise<unknown> = Promise.resolve();
  /** The timer armed: the next discovery, or the install's next check; null when none is. */
  let timer: (() => void) | null = null;
  /** Whether the install is waited for, and whether its last check was refused (logged once). */
  let waiting = false;
  let refused = false;
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
    if (app.state === "kept" && notAMember !== null)
      current = refusing(notAMember, membershipLines.refused(app.app.person.login, app.app.account.login));
    else if (app.state === "kept") current = side.connect(app.credentials);
    else if (app.state === "lost")
      current = refusing(app.cause, `The key of ${app.app.slug} no longer opens: add a new key`);
    else if (app.state === "unread") current = whenReady(described);
    else current = refusing({ kind: "key-lost" }, "No GitHub App is kept yet");
  };

  /** The App held, kept or lost; null with none, or `live.json`'s not described yet. */
  const appHeld = (): StoredApp | null => (held.state === "kept" || held.state === "lost" ? held.app : null);

  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work);
    chain = next.catch(() => {});
    return next;
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

  /** What the installation lists now, cut to the allow-list; null when the App isn't installed. */
  const list = async (credentials: AppCredentials): Promise<Listed | null> => {
    const found = await side.installations.installation(credentials);
    if (found === null) return null;
    const listed = await side.installations.repositories(credentials, found.id);
    const { allowed } = side;
    const repos =
      allowed === undefined ? listed : listed.filter((r) => allowed.some((a) => sameRepository(a, r)));
    return { installationId: found.id, repos };
  };

  const uninstalled = ({ slug, account }: StoredApp) =>
    new HostError("not_found", installationLines.notInstalled(slug, account), {
      connectionCause: { kind: "uninstalled", suspended: false },
    });

  /**
   * The installation's id kept, sent when it moved, in every state: uninstalled and installed again while the setup
   * shows "nothing granted", the new id is the one its links lead to. Only the first found while the install is
   * waited for goes with the connection the setup makes (`installed`).
   */
  const installedAs = (id: number): void => {
    if (installation === id) return;
    const first = installation === null;
    installation = id;
    if (!(waiting && first))
      d.emit({ type: "connection.changed", at: d.now(), patch: { installationId: id } });
  };

  /** The room watches what the installation lists: each gone removed, then the new ones added. */
  const follow = async (repos: readonly RepositoryRef[]): Promise<void> => {
    const watched = d.watched();
    for (const repo of watched.filter((w) => !repos.some((r) => sameRepository(r, w)))) {
      if (stopping) return;
      await d.removed(repo);
    }
    const fresh = repos.filter((r) => !watched.some((w) => sameRepository(w, r)));
    if (fresh.length > 0 && !stopping) await d.added(fresh);
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
  const listedAgain = async (): Promise<boolean> => {
    await reread();
    if (held.state !== "kept" || notAMemberCause(held) !== null) return false;
    const app = held.app;
    const listed = await list(held.credentials);
    if (stopping) return false;
    if (listed === null) throw uninstalled(app);
    installedAs(listed.installationId);
    await follow(listed.repos);
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
    await serially(() =>
      listedAgain().then(
        (listed) => {
          // Not listed for a person no longer a member: the connection says so, whatever it said before.
          const cause = listed ? null : keptForNoMember();
          if (!stopping && (listed || cause !== null)) d.reached(cause);
        },
        (error: unknown) => {
          refusedFor(error);
          throw error;
        },
      ),
    );
  }

  /**
   * The installation listed and followed; null when not installed yet, "refused" when GitHub refused (logged once,
   * not every few seconds while it keeps refusing, and once when it answers again).
   */
  const followed = async (credentials: AppCredentials): Promise<Listed | null | "refused"> => {
    try {
      const listed = await list(credentials);
      if (listed !== null && !stopping) {
        installedAs(listed.installationId);
        await follow(listed.repos);
      }
      if (refused) d.log("the pull requests are listed again");
      refused = false;
      return listed;
    } catch (error) {
      if (!refused) d.log(`the pull requests could not be listed: ${said(error)}`);
      refused = true;
      return "refused";
    }
  };

  /**
   * One check of the install: a lost key read again from the App store first, then listed, followed, and the setup
   * told; armed again until repositories are granted, while an App is held.
   */
  const check = (): Promise<void> =>
    serially(async () => {
      if (stopping) return;
      const read = await reread().then(
        () => true,
        (error: unknown) => {
          if (!refused) d.log(`the GitHub App could not be read: ${said(error)}`);
          refused = true;
          return false;
        },
      );
      // Nothing listed for a person no longer a member (ADR 0059): the install is waited for until they are again.
      if (!read || held.state !== "kept" || keptForNoMember() !== null || stopping) return;
      const listed = await followed(held.credentials);
      if (listed === null || listed === "refused" || stopping) return;
      d.installed(listed.repos.length > 0);
      if (listed.repos.length > 0) waiting = false;
    }).finally(() => {
      if (stopping || held.state === "none") return;
      if (waiting) arm(INSTALL_CHECK_MS, () => void check());
      else armDiscovery();
    });

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
        return appHeld()?.person.id ?? 0;
      },
      get login() {
        return appHeld()?.person.login ?? "";
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
    key: () => (held.state === "kept" ? held.key : null),
    installationId: () => installation,
    down,
    open: async (installed) => {
      installedAtStart = installed;
      // The person's membership, before anything is read for them: no longer a member, nothing is listed.
      await admit(() => (side.given === undefined ? fromStore(side.apps) : givenAtStart(side.given)), {
        lostToo: true,
        tell: false,
      });
      if (held.state !== "kept" || !installed || notAMemberCause(held) !== null) return null;
      try {
        const listed = await list(held.credentials);
        if (listed === null) throw uninstalled(held.app);
        installation = listed.installationId;
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
      if (side.apps === undefined) throw new Error("live.json names the App: Lookover keeps no other");
      const organisation = organisationOf(app);
      const { lastAnswer, membership } = await adoptedAnswer(app, asked ?? null);
      // Key and answer in one write.
      const { protection } = await side.apps.write(app, key, membership ?? undefined);
      hold({ state: "kept", app, credentials: { id: app.id, key }, key: protection, membership });
      d.emit({
        type: "connection.changed",
        at: d.now(),
        patch: { app: connectionAppOf(app), bot: botOf(app) },
      });
      if (organisation !== null && membership !== null && membership !== lastAnswer)
        membershipMoved(app, organisation, lastAnswer, true);
      armMembership();
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
