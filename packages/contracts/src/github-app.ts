// The owner's GitHub App and its installation (ADR 0022, ADR 0053): what the manifest flow converts, what GitHub
// says of the App and of where it is installed, the port the service reads them through, the refusals the setup
// shows, and the addresses of GitHub's pages the app links to. Never a key in anything the service sends: the key
// goes in once (`ManifestConversion`, `AppCredentials`, `connection.useApp`) and stays in the service.
import type { ConnectionCause } from "./connection.ts";
import type { GhRefusal } from "./gh.ts";
import type { RepositoryRef } from "./host.ts";

/** GitHub's web address in live mode: every link to GitHub is built on `Connection.web`, which is this there. */
export const GITHUB_WEB = "https://github.com";

/** A permission of the App, as GitHub names it in a manifest and in its answer for the App. */
export type AppPermission = "metadata" | "contents" | "pull_requests" | "checks" | "issues";

/** How much of a permission the App holds, in GitHub's words. */
export type PermissionLevel = "read" | "write" | "admin";

/**
 * Exactly the permissions Lookover's App asks for (ADR 0022, unchanged since, ADR 0043): the manifest asks for these,
 * and "Use an existing App" refuses an App holding less, naming each one short. No Contents: write.
 */
export const APP_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  checks: "write",
  issues: "write",
} as const satisfies Record<AppPermission, PermissionLevel>;

/** An account on GitHub as the App-level calls give it: the App's owner, an installation's account. */
export interface HostAccount extends HostLogin {
  /** A person's account (`User`) or an organisation's: an App and its installation are on either (ADR 0059). */
  type: "User" | "Organization";
}

/**
 * A GitHub account by its numeric id and its login, as the App-level calls and the person's own `gh` name it: the
 * person Lookover works for, the owner (ADR 0059), whose changes, requests and replies are theirs (on a personal App
 * its account itself, on an organisation's never the organisation), or an organisation `gh` lists.
 */
export interface HostLogin {
  id: number;
  login: string;
}
/** The App as GitHub describes it (`GET /app`, or the manifest conversion's answer). */
export interface HostApp {
  id: number;
  slug: string;
  owner: HostAccount;
  /** What it holds, by GitHub's permission name: any it doesn't hold is absent. */
  permissions: Partial<Record<string, PermissionLevel>>;
}

/** The App's id and its private key (the PEM text), as the service hands them to the host: never logged or sent on. */
export interface AppCredentials {
  id: number;
  key: string;
}

/** What GitHub gives for a manifest's code: the App it created and its private key. Its client and webhook secrets are dropped. */
export interface ManifestConversion {
  app: HostApp;
  key: string;
}

/** The App's installation on an account (`GET /app/installations`). */
export interface HostInstallation {
  id: number;
  account: HostAccount;
  /** Suspended on GitHub: nothing can be read or posted until the owner lifts it. */
  suspended: boolean;
}

/**
 * The App level of the Git host (ADR 0053): what the service reads to onboard and to follow the installation, beside
 * `HostIntake` and `HostWriter`, which act inside one repository. Each call refuses with a `HostError` whose
 * `connectionCause` says what the connection shows (`connectionCauseOf`).
 * - `convertManifest`: the App GitHub created from a manifest, given the code its redirect carries (used once, within
 *   the hour GitHub gives); no credentials, since the code is one.
 * - `app`: the App the credentials sign as: refused `unauthorized` (cause `key-refused`) when GitHub doesn't take them.
 * - `installation`: the App's installation on its owner's account, null when there is none; any other is ignored.
 * - `repositories`: the repositories that installation grants, archived ones left out, in GitHub's order.
 */
export interface HostInstallations {
  convertManifest(code: string): Promise<ManifestConversion>;
  app(credentials: AppCredentials): Promise<HostApp>;
  installation(credentials: AppCredentials): Promise<HostInstallation | null>;
  repositories(credentials: AppCredentials, installationId: number): Promise<RepositoryRef[]>;
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
 * The shared App's level as the person signed in to it reaches it (ADR 0066), beside `HostInstallations`, the own
 * App's: the person's token comes from their sign-in, never with a call. Each call refuses with a `HostError` whose
 * `connectionCause` is the connection's (`signed-out`, `unreachable`): what is one account's (`uninstalled`, `sso`)
 * is in its `cause`, never thrown.
 * - `person`: who is signed in (`GET /user`).
 * - `accounts`: every installation of the shared App the person reaches, on every account, each with the repositories
 *   it grants them, in GitHub's order.
 */
export interface HostAccounts {
  person(): Promise<HostLogin>;
  accounts(): Promise<ReachedAccount[]>;
}

/**
 * Why the manifest flow stopped short, as the setup's GitHub step shows it until the owner tries again (ADR 0053).
 * `unreachable`: back from GitHub, its conversion could not reach GitHub; the flow stays open within the hour, so it
 * can be tried again. `expired`: GitHub's code or the flow ran out, or was used: start again from Lookover.
 * `refused`: GitHub refused the conversion. `elsewhere`: GitHub made the App on another account than the one chosen
 * (ADR 0059); Lookover doesn't keep it, and it can be deleted on GitHub.
 */
export type SetupGitHubRefusal = "unreachable" | "expired" | "refused" | "elsewhere";

/**
 * Why `connection.useApp` refused (ADR 0053), answered with the command as data the app words; never the key.
 * `not-a-key`: the file holds no private key. `key-refused`: GitHub refused the App's token (a wrong id, or a key of
 * another App). An organisation's App is taken for the person its own `gh` is signed in as, when they are an active
 * member of it (ADR 0059), else refused as `gh` says: `gh-missing`, no `gh` on this computer; `gh-signed-out`, `gh`
 * signed in to no account; `gh-unanswered`, `gh` couldn't answer, with why (never `gh`'s own words); `not-a-member`,
 * the account `gh` is signed in as (`person`, its login) isn't an active member of the App's organisation
 * (`organisation`, its login): invited and not joined yet (`invited`), or not a member at all. A new key for the
 * organisation's App kept keeps its person: `another-person`, `gh` is signed in as another account (`person`) than
 * the one the App is kept for (`kept`), both logins; when `gh` can't say, the key is taken. A personal App never asks
 * `gh`. `missing-permissions`: the App lacks some of `APP_PERMISSIONS`, each named. `another-app`: another App is
 * kept in this data folder (one App per data folder). `unreachable`: GitHub could not be reached. `live-config`:
 * `live.json` names the App, which the developers' runs never change (ADR 0045).
 */
export type UseAppRefusal =
  | { kind: "not-a-key" }
  | { kind: "key-refused" }
  | GhRefusal
  | { kind: "not-a-member"; organisation: string; person: string; invited: boolean }
  | { kind: "another-person"; person: string; kept: string }
  | { kind: "missing-permissions"; missing: AppPermission[] }
  | { kind: "another-app" }
  | { kind: "unreachable" }
  | { kind: "live-config" };

/**
 * Why no App may be made here at all, as `connection.createApp`, the manifest page and GitHub's redirect back say it:
 * `live-config`, the developers' runs never create an App (ADR 0045, ADR 0053); `already-made`, an App is kept
 * already.
 */
export type NoNewApp = "live-config" | "already-made";

/**
 * Why `connection.createApp` refused: no App may be made here (`NoNewApp`), or not on the organisation asked for (ADR
 * 0059), as the person's own `gh` said when asked: no answer (`GhRefusal`: not installed, signed out, or unable to
 * answer, with why), or `not-an-admin`, the organisation isn't one `gh` lists as the person's to admin (a member only,
 * or none of theirs). Your own account needs no `gh`, and is never refused for it.
 */
export type CreateAppRefusal = { kind: NoNewApp } | GhRefusal | { kind: "not-an-admin" };

/**
 * How the App's key is kept (ADR 0053), as Run checks says it: `keychain`, encrypted under a data key in the OS
 * keychain; `user-file`, unencrypted in a user-only file, the keychain out of reach. Null when Lookover keeps no key:
 * none yet, or `live.json`'s, read where it is.
 */
export type KeyProtection = "keychain" | "user-file";

/**
 * A private key's armour, of any kind (`-----BEGIN RSA PRIVATE KEY-----`, PKCS#8's `-----BEGIN PRIVATE KEY-----`, …):
 * what "Use an existing App" takes as a key, what the fake GitHub signs with, and what the leak checks look for.
 */
export const PRIVATE_KEY_ARMOUR = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

/**
 * Where an account's settings pages are (ADR 0059): a user's under `/settings`, an organisation's under
 * `/organizations/<login>/settings`.
 */
const settingsOf = (web: string, account: Pick<HostAccount, "login" | "type">): string =>
  account.type === "Organization" ? `${web}/organizations/${account.login}/settings` : `${web}/settings`;

/** The signed-in person's own account, whose settings are `/settings` whatever their login. */
const PERSONAL = { login: "", type: "User" } as const;

/**
 * GitHub's pages the app links to, built on `Connection.web` so demo mode stays on its fake. The App's and its
 * installation's settings are on the App's account: the organisation's pages when it is one (ADR 0059).
 */
export const githubLinks = {
  /**
   * Where the App is installed, or its repositories chosen: "Install it on GitHub", "Open GitHub again", and on
   * `shared` "Install on <account>", "Ask to install on <org>" and "Install on another account" (ADR 0067): GitHub's
   * documented page, where the person picks the account, never the undocumented `target_id` deep link.
   */
  install: (web: string, slug: string) => `${web}/apps/${slug}/installations/new`,
  /** The installation's settings: "Add a repository", a suspended installation's fix. */
  installation: (web: string, account: Pick<HostAccount, "login" | "type">, installationId: number) =>
    `${settingsOf(web, account)}/installations/${installationId}`,
  /** The App's settings, where a new key is generated: "Add a new key". */
  app: (web: string, account: Pick<HostAccount, "login" | "type">, slug: string) =>
    `${settingsOf(web, account)}/apps/${slug}`,
  /**
   * Where the manifest is posted, with the flow's state: your own account's "new App" page, or the organisation's of
   * that login (ADR 0059).
   */
  newApp: (web: string, organisation: string | null, state: string) =>
    `${settingsOf(web, organisation === null ? PERSONAL : { login: organisation, type: "Organization" })}/apps/new?state=${encodeURIComponent(state)}`,
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
