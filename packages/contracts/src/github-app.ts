// The shared App's installations as the person signed in to it reaches them (ADR 0066, ADR 0073): the accounts it is
// installed on, the port the service reads them through, and the addresses of GitHub's pages the app links to.
import type { ConnectionCause } from "./connection.ts";
import type { RepositoryRef } from "./host.ts";

/** GitHub's web address in live mode: every link to GitHub is built on `Connection.web`, which is this there. */
export const GITHUB_WEB = "https://github.com";

/** An account on GitHub as an installation names it: a person's or an organisation's. */
export interface HostAccount extends HostLogin {
  /** A person's account (`User`) or an organisation's: the shared App is installed on either (ADR 0059). */
  type: "User" | "Organization";
}

/**
 * A GitHub account by its numeric id and its login, as the installations and the person's own `gh` name it: the
 * person Lookover works for, the owner (ADR 0059), whose changes, requests and replies are theirs (never an
 * organisation), or an organisation `gh` lists.
 */
export interface HostLogin {
  id: number;
  login: string;
}

/** The shared App's installation on an account (`GET /user/installations`). */
export interface HostInstallation {
  id: number;
  account: HostAccount;
  /** Suspended on GitHub: nothing can be read or posted until an owner lifts it. */
  suspended: boolean;
}

/**
 * Why one account the person reaches can't be used while the connection can (ADR 0066): its installation suspended
 * (`uninstalled`, `suspended` true), or its organisation asking for SAML SSO the sign-in hasn't (`sso`). The same
 * rule by kind holds for a `HostError`'s `connectionCause` on an act on one repository: `uninstalled` and `sso` are
 * the repository's account's, every other kind the connection's.
 */
export type AccountCause = Extract<ConnectionCause, { kind: "uninstalled" | "sso" }>;

/** An account the person's sign-in reaches through the shared App (ADR 0066): its installation and what it grants. */
export interface ReachedAccount {
  installation: HostInstallation;
  /**
   * The repositories the installation grants the person, archived ones and any off the list left out, as GitHub
   * names them (owner and name its own, never typed ones); none while `cause` holds.
   */
  repositories: RepositoryRef[];
  /** Why the account's repositories can't be used now; null when they can. */
  cause: AccountCause | null;
}

/**
 * The shared App's level as the person signed in to it reaches it (ADR 0066): the person's token comes from their
 * sign-in, never with a call. Each call refuses with a `HostError` whose `connectionCause` is the connection's
 * (`signed-out`, `unreachable`): what is one account's (`uninstalled`, `sso`) is in its `cause`, never thrown.
 * - `person`: who is signed in (`GET /user`).
 * - `accounts`: every installation of the shared App the person reaches, on every account, each with the repositories
 *   it grants them, in GitHub's order.
 */
export interface HostAccounts {
  person(): Promise<HostLogin>;
  accounts(): Promise<ReachedAccount[]>;
}

/**
 * Where an account's settings pages are (ADR 0059): a user's under `/settings`, an organisation's under
 * `/organizations/<login>/settings`.
 */
const settingsOf = (web: string, account: Pick<HostAccount, "login" | "type">): string =>
  account.type === "Organization" ? `${web}/organizations/${account.login}/settings` : `${web}/settings`;

/**
 * GitHub's pages the app links to, built on `Connection.web` so demo mode stays on its fake. An installation's
 * settings are on its account: the organisation's pages when it is one (ADR 0059).
 */
export const githubLinks = {
  /**
   * Where the shared App is installed, or its repositories chosen: "Install on <account>", "Ask to install on <org>"
   * and "Install on another account" (ADR 0067): GitHub's documented page, where the person picks the account, never
   * the undocumented `target_id` deep link.
   */
  install: (web: string, slug: string) => `${web}/apps/${slug}/installations/new`,
  /** The installation's settings: "Add a repository", a suspended installation's fix. */
  installation: (web: string, account: Pick<HostAccount, "login" | "type">, installationId: number) =>
    `${settingsOf(web, account)}/installations/${installationId}`,
  /** An organisation's single sign-on page (ADR 0066): "Sign in with SSO" when GitHub gave no page of its own. */
  sso: (web: string, organisation: string) => `${web}/orgs/${organisation}/sso`,
  /**
   * An organisation's people, filtered to its owners (ADR 0067): who to ask while an install waits for an owner, or
   * to lift a suspension the person can't.
   */
  owners: (web: string, organisation: string) => `${web}/orgs/${organisation}/people?query=role%3Aowner`,
  /** A pull request: "Open on GitHub". */
  pullRequest: (web: string, repo: RepositoryRef, number: number) =>
    `${web}/${repo.owner}/${repo.name}/pull/${number}`,
} as const;
