// The connection to the Git host: GitHub in v1, through the shared App a person signs in to (ADR 0066, ADR 0073):
// who is signed in, the accounts their sign-in reaches and those it doesn't, and why GitHub can't be used when it
// can't.
import type { AccountCause, HostAccount, HostLogin } from "./github-app.ts";
import type { ConnectionId } from "./ids.ts";
import type { DeviceCode } from "./sign-in.ts";

/**
 * Why the connection can't be used (ADR 0053), each with one fix the app offers but the one that only waits.
 * `unreachable`: GitHub could not be reached or answered with an error of its own: a wait with no fix, Lookover reading
 * it again every minute (ADR 0070). `uninstalled`: the shared App is no longer installed on an account, or its
 * installation is `suspended` ("Install it on GitHub", a link to the install page, or to the installation's settings
 * when suspended). `signed-out`: GitHub refused the person's credentials: it refused to renew their sign-in (its
 * refresh token expired, revoked or spent), or refused a token just renewed, or any other credentials (ADR 0066):
 * only a new sign-in brings it back. `sso`: `organisation` (its login) protects its resources with SAML single
 * sign-on, and the person's sign-in has no active SSO session there (ADR 0066): one account's cause, never the
 * connection's, its other accounts still used ("Sign in with SSO", GitHub's `url` for it when it gave one, else the
 * organisation's SSO page). One rule by kind: `uninstalled` and `sso` on an act on one repository are that
 * repository's account's; every other kind is the connection's. A suspension names who suspended it (`suspendedBy`,
 * their login) when GitHub said (ADR 0067: `suspended_by` on `/user/installations`); absent when it didn't.
 */
export type ConnectionCause =
  | { kind: "unreachable" }
  | { kind: "uninstalled"; suspended: boolean; suspendedBy?: string }
  | { kind: "signed-out" }
  | { kind: "sso"; organisation: string; url: string | null };

/**
 * An account Lookover reaches (ADR 0066): the account, the installation there (what its settings link names), and why
 * its repositories can't be used now, null when they can. The connection's own cause (`Connection.cause`) holds for
 * every account; this one for this account alone, its other accounts still used.
 */
export interface ConnectionAccount {
  account: HostAccount;
  installationId: number;
  cause: AccountCause | null;
  /**
   * Whether the person owns the account (ADR 0067): true for their own account, and for an organisation the person's
   * own `gh` says they own; false for one it says they are a member of; null when nobody said (no `gh`, another
   * person's, or one that couldn't answer). The app shows a member's fix for null.
   */
  owner: boolean | null;
}

/**
 * An account of the person's the shared App doesn't reach (ADR 0067): their own account while the App isn't installed
 * there (`kind` `user`, `owner` true), or an organisation their own `gh` names as one of their active memberships
 * (`kind` `organisation`, `owner` as `gh` gave their role; null when it couldn't say). `askedAt` is when the person
 * asked to install it there ("Ask to install on <org>", `connection.askToInstall`), ms since the epoch, null when
 * they didn't: while it holds, the app says "Waiting for an owner" on its row. GitHub never says whether an owner saw
 * the request: this is Lookover's own memory, forgotten once the account is reached or another person signs in.
 */
export interface UnreachedAccount {
  account: HostLogin;
  kind: "user" | "organisation";
  owner: boolean | null;
  askedAt: number | null;
}

/**
 * Why `connection.askToInstall` was refused (ADR 0067), answered as the 409's `askToInstall`: `signed-out`, nobody is
 * signed in to the shared App here yet; `not-named`, the account isn't one of `Connection.unreached` (already reached,
 * or never named); `owner`, the person owns it, so they install it, they don't ask.
 */
export type AskToInstallRefusal = "signed-out" | "not-named" | "owner";

/** Whether two logins name one account: GitHub ignores their case. */
export const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The account in `accounts` that `owner` (a repository's owner, by its login: GitHub's ignore case) names, if any. */
export const accountOf = (
  accounts: readonly ConnectionAccount[],
  owner: string,
): ConnectionAccount | undefined => accounts.find((a) => sameLogin(a.account.login, owner));

export interface Connection {
  /** Null until installed: `github:<person's login>` (ADR 0066), once one account is reached. */
  id: ConnectionId | null;
  state: "not-connected" | "connected" | "disconnected";
  /** Why it is `disconnected`; null in every other state. */
  cause: ConnectionCause | null;
  /**
   * A sign-in to the shared App waiting for its code (ADR 0066): the code, GitHub's page to enter it on, until when;
   * null when none waits. The setup shows it, and Sign in again later.
   */
  signIn: DeviceCode | null;
  /**
   * The person signed in to the shared App (ADR 0066), as GitHub named them, from the moment the sign-in is kept,
   * before any account is reached; null before a sign-in: the setup's GitHub step offers one.
   */
  person: HostLogin | null;
  /**
   * Each account Lookover reaches (ADR 0066), in GitHub's order, once installed: every installation of the shared App
   * the person's sign-in reaches. None before installed. An account with a cause keeps its repositories watched,
   * refused until the cause is mended; one no longer reached at all is gone from here, its repositories with it.
   */
  accounts: ConnectionAccount[];
  /**
   * The person's accounts the shared App doesn't reach (ADR 0067), always empty before a sign-in: their own account
   * first when the App isn't installed there, then the organisations their own `gh` names, in `gh`'s order. None of
   * them is in `accounts`; one reached leaves this list.
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
}
