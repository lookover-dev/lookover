// The connection to the Git host: GitHub in v1, through the owner's own App and its bot (ADR 0008, ADR 0030,
// ADR 0053): the App, its installation on the App's account (the owner's own, or an organisation's, ADR 0059), and
// why GitHub can't be used when it can't.
import type { GhChoices } from "./gh.ts";
import type { AccountCause, HostAccount, HostLogin } from "./github-app.ts";
import type { ConnectionId } from "./ids.ts";
import type { DeviceCode } from "./sign-in.ts";

/**
 * Why the connection can't be used (ADR 0053), each with one fix the app offers. `unreachable`: GitHub could not be
 * reached or answered with an error of its own ("Reconnect GitHub"). `uninstalled`: the App is no longer installed on
 * its account, or its installation is `suspended` ("Install it on GitHub", a link to the install page, or to
 * the installation's settings when suspended). `key-refused`: GitHub refused the App's key; `why` is what GitHub
 * named, when it did: a key revoked on GitHub, the App deleted, or the computer's clock too far off ("Add a new
 * key"). `key-lost`: the key Lookover kept no longer opens, its keychain entry gone ("Add a new key" too).
 * `not-a-member`: the person's own `gh` says they are no longer an active member of `organisation` (its login), the
 * organisation whose App it is (ADR 0059): the App still works, but Lookover runs for that person, so reviews stop
 * until an admin adds them back ("Check again", `gh.check`) or another App is set up. `signed-out`: GitHub refused to
 * renew the person's sign-in to the shared App (its refresh token expired, revoked or spent), or refused a token just
 * renewed (ADR 0066): only a new sign-in brings it back. `sso`: `organisation` (its login) protects its resources with
 * SAML single sign-on, and the person's sign-in has no active SSO session there (ADR 0066): one account's cause, never
 * the connection's, its other accounts still used ("Sign in with SSO", GitHub's `url` for it when it gave one, else
 * the organisation's SSO page). With the shared App, one rule by kind: `uninstalled` and `sso` on an act on one
 * repository are that repository's account's; every other kind is the connection's. A suspension names who suspended
 * it (`suspendedBy`, their login) when GitHub said (ADR 0067: `suspended_by` on `/user/installations`); absent when
 * it didn't, or when the cause isn't a suspension of the shared App's.
 */
export type ConnectionCause =
  | { kind: "unreachable" }
  | { kind: "uninstalled"; suspended: boolean; suspendedBy?: string }
  | { kind: "key-refused"; why: KeyRefusal | null }
  | { kind: "key-lost" }
  | { kind: "not-a-member"; organisation: string }
  | { kind: "signed-out" }
  | { kind: "sso"; organisation: string; url: string | null };

/** What GitHub said of a key it refused, when it said. */
export type KeyRefusal = "revoked" | "app-deleted" | "clock";

/**
 * An account Lookover reaches (ADR 0066): the account, the installation there (what its settings link names), and why
 * its repositories can't be used now, null when they can. The connection's own cause (`Connection.cause`) holds for
 * every account; this one for this account alone, its other accounts still used. On `own` its cause stays null: the
 * App's one installation is the connection's, and its causes the connection's.
 */
export interface ConnectionAccount {
  account: HostAccount;
  installationId: number;
  cause: AccountCause | null;
  /**
   * Whether the person owns the account (ADR 0067): true for their own account, and for an organisation the person's
   * own `gh` says they own; false for one it says they are a member of; null when nobody said (no `gh`, another
   * person's, or one that couldn't answer), and always on `own`. The app shows a member's fix for null.
   */
  owner: boolean | null;
}

/**
 * An account of the person's the shared App doesn't reach (ADR 0067): their own account while the App isn't installed
 * there (`kind` `user`, `owner` true), or an organisation their own `gh` names as one of their active memberships
 * (`kind` `organisation`, `owner` as `gh` gave their role; null when it couldn't say). `askedAt` is when the person
 * asked to install it there ("Ask to install on <org>", `connection.askToInstall`), ms since the epoch, null when
 * they didn't: while it holds, the app says "Waiting for an owner of <org>". GitHub never says whether an owner saw
 * the request: this is Lookover's own memory, forgotten once the account is reached or another person signs in.
 */
export interface UnreachedAccount {
  account: HostLogin;
  kind: "user" | "organisation";
  owner: boolean | null;
  askedAt: number | null;
}

/**
 * Why `connection.askToInstall` was refused (ADR 0067), answered as the 409's `askToInstall`: `not-shared`, Lookover
 * isn't signed in to the shared App here (its own App, or neither way yet); `not-named`, the account isn't one of
 * `Connection.unreached` (already reached, or never named); `owner`, the person owns it, so they install it, they
 * don't ask.
 */
export type AskToInstallRefusal = "not-shared" | "not-named" | "owner";

/** Whether two logins name one account: GitHub ignores their case. */
export const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The account in `accounts` that `owner` (a repository's owner, by its login: GitHub's ignore case) names, if any. */
export const accountOf = (
  accounts: readonly ConnectionAccount[],
  owner: string,
): ConnectionAccount | undefined => accounts.find((a) => sameLogin(a.account.login, owner));

/** The own App's one installation (ADR 0066): its connection's one account, if it is installed. */
export const ownInstallation = (accounts: readonly ConnectionAccount[]): ConnectionAccount | undefined =>
  accounts[0];

/** The owner's App, as the app shows and links to it: never its key. */
export interface ConnectionApp {
  /** GitHub's id of the App, the one "Use an existing App" asks for. */
  id: number;
  /** Its slug: the bot is `<slug>[bot]`, and `lookover wait` takes it as `LOOKOVER_APP`. */
  slug: string;
  /**
   * The account the App belongs to (ADR 0059): the owner's own, or an organisation's. Its settings pages, and its
   * installation's, are on it (`githubLinks`).
   */
  account: HostAccount;
  /**
   * The owner: the person Lookover works for, whose changes, requests and replies are theirs (ADR 0059). On a
   * personal account, the account itself.
   */
  person: HostLogin;
}

/**
 * How Lookover is on GitHub (ADR 0066): `shared`, the person signed in to the shared App, Lookover posting as them;
 * `own`, Use your own App, Lookover posting as its bot. A data folder with its own App is on `own`, even with a
 * sign-in beside it.
 */
export type ConnectionWay = "shared" | "own";

export interface Connection {
  /**
   * Null until installed: `github:<bot>` on `own`, `github:<person's login>` on `shared` (ADR 0066), once one account
   * is reached.
   */
  id: ConnectionId | null;
  state: "not-connected" | "connected" | "disconnected";
  /** Why it is `disconnected`; null in every other state. */
  cause: ConnectionCause | null;
  /** The way Lookover is on GitHub; null before either: the setup's GitHub step offers both. */
  way: ConnectionWay | null;
  /**
   * A sign-in to the shared App waiting for its code (ADR 0066): the code, GitHub's page to enter it on, until when;
   * null when none waits. The setup shows it, and Sign in again later.
   */
  signIn: DeviceCode | null;
  /**
   * The person signed in to the shared App (ADR 0066), as GitHub named them, from the moment the sign-in is kept,
   * before any account is reached; null on `own` (its person is the App's) and before a sign-in.
   */
  person: HostLogin | null;
  /** The own App's bot, `<slug>[bot]`; null before it, and always on `shared`, where the person posts. */
  bot: string | null;
  /** The own App once one is created or given; null before, and on `shared`. */
  app: ConnectionApp | null;
  /**
   * Each account Lookover reaches (ADR 0066), in GitHub's order, once installed: on `own` the App's installation on
   * its account, one; on `shared` every installation of the shared App the person's sign-in reaches. None before
   * installed. An account with a cause keeps its repositories watched, refused until the cause is mended; one no
   * longer reached at all is gone from here, its repositories with it.
   */
  accounts: ConnectionAccount[];
  /**
   * The person's accounts the shared App doesn't reach (ADR 0067), on `shared` only (always empty on `own` and before
   * a sign-in): their own account first when the App isn't installed there, then the organisations their own `gh`
   * names, in `gh`'s order. None of them is in `accounts`; one reached leaves this list.
   */
  unreached: UnreachedAccount[];
  /**
   * GitHub's web address, every link to GitHub is built from (`githubLinks`): `GITHUB_WEB` in live mode; in demo mode
   * the service's own fake of it (`DEMO_API.github`), so nothing the demo shows opens github.com.
   */
  web: string;
  since: number;
  /**
   * Until when the host asked Lookover to wait (its rate limit, ADR 0043): nothing is read from it before then.
   * Null when it asks nothing.
   */
  limitUntil: number | null;
  /**
   * The person's own `gh` as last read (ADR 0059): who it is signed in as and the organisations where they are an
   * admin, the places "Create your App" offers beside your own account. Null until read: the setup's GitHub step
   * asks for it (`gh.check`, its Check again), and "Create it on GitHub" on an organisation reads it again.
   */
  gh: GhChoices | null;
}
