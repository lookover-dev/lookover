// The person's accounts on the shared App, said once (ADR 0067): what setup's "Your accounts", Settings › GitHub, the
// alert band, the status menu, the pill and Repositories' group heads say of each account, and its one fix. Each
// account reached (`Connection.accounts`, GitHub's order) with its repositories or its cause; each one not reached
// (`Connection.unreached`, the person's own account first, then `gh`'s organisations) with Install on it when the
// person owns it, else Ask to install on it, which keeps the ask (`connection.askToInstall`) as GitHub's page opens;
// each one asked, waiting for an owner, hedged, since GitHub tells only the App whether a request was sent; and
// Install on another account last, GitHub's own page listing every account. An organisation nobody said the person
// owns gets a member's fix. GitHub's word for an organisation's role is used: owner, never admin. On `own`, before a
// sign-in and once signed out, there is no list: the App's one installation, or the sign-in, is the connection's.
// Every link is built on `Connection.web`, so demo mode stays on GitHub's fake.
import {
  type AccountCause,
  accountOf,
  type Command,
  type Connection,
  type ConnectionAccount,
  githubLinks,
  type HostLogin,
  type Repository,
  SHARED_APP,
  type State,
} from "@lookover/contracts";
import { plural, startsAt } from "./format.ts";

/**
 * One of an account's links: GitHub's page, opened in a new tab, with the command sent as it opens when there is one
 * (Ask to install's, which keeps that the person asked).
 */
export interface AccountLink {
  label: string;
  href: string;
  command?: Extract<Command, { type: "connection.askToInstall" }>;
}

/**
 * Where an account stands: `installed`, its repositories used; `needs-you`, a cause holds it (SSO, suspended, gone);
 * `not-installed`, the App isn't on it; `waiting`, asked, for an owner; `another`, Install on another account's row.
 */
type AccountRowState = "installed" | "needs-you" | "not-installed" | "waiting" | "another";

export interface AccountRow {
  /** The row's key: the account's login, or `another`. */
  key: string;
  /** The account's login, as GitHub writes it; null on Install on another account's row. */
  account: string | null;
  /** What the row is named by: the login, or Another account. */
  name: string;
  state: AccountRowState;
  /** One line: its repositories, its cause, or what it waits for. */
  detail: string;
  /**
   * Every detail the row can show in its part of the list, whatever state it moves to there, `detail` among them: the
   * row is as tall as the tallest, so a state changing in place moves nothing.
   */
  details: string[];
  /** Its one fix, or its one action. */
  fix: AccountLink | null;
  /** While waiting for an owner: GitHub's page again, the ask kept again. */
  again: AccountLink | null;
  /**
   * Whether the row can wait for an owner where it is in the list (a member's account not reached, asked or not): it
   * keeps Ask again's place, so being asked moves nothing. No other row has that place.
   */
  asks: boolean;
}

export interface AccountsList {
  rows: AccountRow[];
}

const ANOTHER = "Install on another account";
/** What Install on another account's row is named by, where an account's row names its login. */
const ANOTHER_ACCOUNT = "Another account";
/** The ghost beside a waiting row's fix: its place is kept on every row, so a row asked moves nothing. */
export const ASK_AGAIN = "Ask again";
const SSO = "Sign in with SSO";
const UNSUSPEND = "Unsuspend it on GitHub";
/** An account installed with no repository yet: its installation's settings, where the person picks them. */
const CHOOSE = "Choose repositories";

const installOn = (login: string) => `Install on ${login}`;
const askToInstallOn = (login: string) => `Ask to install on ${login}`;
const askAnOwnerOf = (login: string) => `Ask an owner of ${login}`;

const DETAIL = {
  none: "No repository yet.",
  sso: "Asks you to sign in with SSO.",
  gone: "No longer installed.",
  notInstalled: "Not installed.",
  ask: "Not installed. On GitHub, you ask its owners to install it.",
  another: "GitHub's page lists every account you belong to.",
} as const;

const suspendedText = (by: string | undefined) => (by === undefined ? "Suspended." : `Suspended by ${by}.`);

/**
 * The line each cause of an account reached says, by its kind, a suspended installation apart (who suspended it
 * unsaid): every line a row or a group head holds, so a cause coming or going moves nothing.
 */
const CAUSE_LINES = {
  sso: DETAIL.sso,
  suspended: suspendedText(undefined),
  uninstalled: DETAIL.gone,
} as const satisfies Record<AccountCause["kind"] | "suspended", string>;

/** "Waiting for an owner of ledger-dev, asked at 09:35. If you sent the request, GitHub emailed its owners." */
const waitingText = (login: string, asked: string) =>
  `Waiting for an owner of ${login}, asked ${asked}. If you sent the request, GitHub emailed its owners.`;

/**
 * Whether the person owns an account, reached or not (ADR 0067): what the service said, or their own account by its
 * id; nobody said is a member's. Who an account's problem says changes it on GitHub.
 */
export const ownsAccount = (
  { person }: Pick<Connection, "person">,
  { account, owner }: { account: HostLogin; owner: boolean | null },
): boolean => owner === true || (person !== null && person.id === account.id);

/** GitHub's install page, where the person picks the account, and Install becomes Request where they can't install. */
const installPage = ({ web }: Pick<Connection, "web">) => githubLinks.install(web, SHARED_APP.slug);

/** Ask an owner of `login`: the organisation's owners on GitHub, for a member to ask without a request kept. */
const askAnOwner = ({ web }: Pick<Connection, "web">, login: string) => ({
  label: askAnOwnerOf(login),
  href: githubLinks.owners(web, login),
});

/** Sign in with SSO: the page GitHub's 403 named, else the organisation's own SSO page. */
export const ssoFix = ({ web }: Pick<Connection, "web">, organisation: string, url: string | null) => ({
  label: SSO,
  href: url ?? githubLinks.sso(web, organisation),
});

/**
 * The shared App installed on none of the person's accounts: the accounts list's first fix, Install on their own
 * account (always listed first), else Install on another account; GitHub's install page either way.
 */
export const installFirstFix = (connection: Pick<Connection, "person" | "web">) => ({
  label: connection.person === null ? ANOTHER : installOn(connection.person.login),
  href: installPage(connection),
});

/** Ask to install on `login`: GitHub's install page, and the ask kept as it opens. */
const ask = (connection: Pick<Connection, "web">, label: string, login: string): AccountLink => ({
  label,
  href: installPage(connection),
  command: { type: "connection.askToInstall", account: login },
});

/**
 * The one fix of an account reached that a cause holds (ADR 0067's table), the same in every place: SSO, its page
 * (the 403's, else the organisation's); suspended, Unsuspend it on GitHub when the person owns it, else ask an owner;
 * no longer installed, Install on it when the person owns it, else ask an owner (Ask to install on keeps an ask, which
 * only an account not reached has).
 */
export function accountFix(
  connection: Pick<Connection, "person" | "web">,
  a: ConnectionAccount,
  cause: AccountCause,
): { label: string; href: string } {
  const { account, installationId } = a;
  if (cause.kind === "sso") return ssoFix(connection, cause.organisation, cause.url);
  if (!ownsAccount(connection, a)) return askAnOwner(connection, account.login);
  return cause.suspended
    ? { label: UNSUSPEND, href: githubLinks.installation(connection.web, account, installationId) }
    : { label: installOn(account.login), href: installPage(connection) };
}

/** Whether the App is still installed on an account reached: any cause but no longer installed (a suspended one is). */
const installed = ({ cause }: ConnectionAccount): boolean =>
  cause === null || cause.kind === "sso" || cause.suspended;

/**
 * Where an account's repositories are chosen on the shared App ("Add a repository", "Add it back"): the installation's
 * settings on `account` when it is reached, installed and the person owns it; with no `account`, on the one account
 * reached that is so, when exactly one is. Else GitHub's install page, which lists every account, shows Configure on
 * the installed ones and offers Request where the person can't install.
 */
export function sharedRepositoriesLink(
  connection: Pick<Connection, "person" | "web" | "accounts">,
  account?: string,
): string {
  const reached = account === undefined ? connection.accounts : [accountOf(connection.accounts, account)];
  const owned = reached.filter(
    (a): a is ConnectionAccount => a !== undefined && installed(a) && ownsAccount(connection, a),
  );
  const [only] = owned;
  return only === undefined || owned.length > 1
    ? installPage(connection)
    : githubLinks.installation(connection.web, only.account, only.installationId);
}

function causeDetail(cause: AccountCause): string {
  if (cause.kind === "sso") return CAUSE_LINES.sso;
  return cause.suspended ? suspendedText(cause.suspendedBy) : CAUSE_LINES.uninstalled;
}

/**
 * Every detail a reached account's row can show: its own, no repository and every cause. Never a line of an account
 * not reached: an account crossing over moves to the list's other part, so its height can't hold the rows under it
 * still anyway.
 */
const reachedDetails = (detail: string) => [...new Set([detail, DETAIL.none, ...Object.values(CAUSE_LINES)])];

function reachedRow(state: State, a: ConnectionAccount): AccountRow {
  const { connection } = state;
  const login = a.account.login;
  const said = { key: login, account: login, name: login, again: null, asks: false };
  if (a.cause !== null) {
    const detail = causeDetail(a.cause);
    return {
      ...said,
      state: "needs-you",
      detail,
      details: reachedDetails(detail),
      fix: accountFix(connection, a, a.cause),
    };
  }
  const n = state.repos.filter(
    (r) => accountOf(connection.accounts, r.owner)?.account.id === a.account.id,
  ).length;
  const detail = n === 0 ? DETAIL.none : `${plural(n, "repository", "repositories")}.`;
  return {
    ...said,
    state: "installed",
    detail,
    details: reachedDetails(detail),
    fix: n === 0 ? { label: CHOOSE, href: sharedRepositoriesLink(connection, login) } : null,
  };
}

/**
 * A row of an account not reached. One the person owns offers Install on it, never an ask: it never waits for an
 * owner, so "Not installed." is all it holds. A member's holds its asked and waiting lines (`now` said as asked now).
 */
function unreachedRow(
  state: State,
  u: Connection["unreached"][number],
  timeZone: string | undefined,
): AccountRow {
  const { connection } = state;
  const login = u.account.login;
  const said = { key: login, account: login, name: login };
  if (ownsAccount(connection, u))
    return {
      ...said,
      state: "not-installed",
      detail: DETAIL.notInstalled,
      details: [DETAIL.notInstalled],
      fix: { label: installOn(login), href: installPage(connection) },
      again: null,
      asks: false,
    };
  const asked = (detail: string) => [
    ...new Set([detail, DETAIL.ask, waitingText(login, startsAt(state.now, state.now, timeZone))]),
  ];
  if (u.askedAt === null)
    return {
      ...said,
      state: "not-installed",
      detail: DETAIL.ask,
      details: asked(DETAIL.ask),
      fix: ask(connection, askToInstallOn(login), login),
      again: null,
      asks: true,
    };
  const detail = waitingText(login, startsAt(state.now, u.askedAt, timeZone));
  return {
    ...said,
    state: "waiting",
    detail,
    details: asked(detail),
    fix: askAnOwner(connection, login),
    again: ask(connection, ASK_AGAIN, login),
    asks: true,
  };
}

/**
 * A long login of a usual kind, 16 characters: what the fix's place is sized for, so its width never waits on the
 * accounts `gh` names later. GitHub allows 39; a label naming a wider login is cut.
 */
const USUAL_LOGIN = "x".repeat(16);

/**
 * The labels an account row's fix place is as wide as, the same whatever the rows: each fix an account can show, on a
 * usual login, and every label naming no account. A row appended moves only what is under it; a label naming a longer
 * login is cut.
 */
export const ACCOUNT_FIX_LABELS: readonly string[] = [
  installOn(USUAL_LOGIN),
  askToInstallOn(USUAL_LOGIN),
  askAnOwnerOf(USUAL_LOGIN),
  UNSUSPEND,
  SSO,
  CHOOSE,
  ANOTHER,
];

/** Whether the person is signed in to the shared App now: the list's accounts are theirs. */
export const signedInToShared = ({ way, person, cause }: Pick<Connection, "way" | "person" | "cause">) =>
  way === "shared" && person !== null && cause?.kind !== "signed-out";

/**
 * The accounts list at the state the service says: reached first in GitHub's order, then the ones not reached in
 * the order the service gave, then Install on another account; empty off the shared App, before a sign-in and once
 * signed out. `timeZone`, the zone a time is said in (the browser's by default).
 */
export function accountRows(state: State, o: { timeZone?: string } = {}): AccountsList {
  const { connection } = state;
  if (!signedInToShared(connection)) return { rows: [] };
  const another: AccountRow = {
    key: "another",
    account: null,
    name: ANOTHER_ACCOUNT,
    state: "another",
    detail: DETAIL.another,
    details: [DETAIL.another],
    fix: { label: ANOTHER, href: installPage(connection) },
    again: null,
    asks: false,
  };
  const rows = [
    ...connection.accounts.map((a) => reachedRow(state, a)),
    ...connection.unreached.map((u) => unreachedRow(state, u, o.timeZone)),
    another,
  ];
  return { rows };
}

/**
 * A group of Repositories' head (design-system.md "Repositories' group heads"): the account, its cause's line ("" with
 * none) held with every line a cause can say, and its one fix, its place as wide as every label `accountFix` can
 * return for it.
 */
export interface RepositoryGroupHead {
  /** The account's login, as GitHub writes it (the repositories' owner when no account reached is theirs). */
  account: string;
  /** `needs-you` while a cause holds the account, else `fine`. */
  state: "fine" | "needs-you";
  cause: string;
  held: string[];
  fix: { label: string; href: string } | null;
  labels: string[];
}

export interface RepositoryGroup {
  /** The account's login, or `all` for the one group on `own`. */
  key: string;
  /** Null on `own`: its one group has no head. */
  head: RepositoryGroupHead | null;
  repos: Repository[];
}

/** Every line a head's cause can say, `own` (the one said now) among them. */
const causeLines = (own: string) => [...new Set(["", ...Object.values(CAUSE_LINES), own])];

function groupHead(
  connection: Connection,
  login: string,
  a: ConnectionAccount | undefined,
): RepositoryGroupHead {
  const cause = a?.cause ?? null;
  const line = cause === null ? "" : causeDetail(cause);
  return {
    account: login,
    state: cause === null ? "fine" : "needs-you",
    cause: line,
    held: causeLines(line),
    fix: a === undefined || cause === null ? null : accountFix(connection, a, cause),
    labels: [SSO, UNSUSPEND, installOn(login), askAnOwnerOf(login)],
  };
}

/**
 * Repositories' rows by account (ADR 0067). On `shared`, one group per account with a repository, in the accounts
 * list's order (GitHub's), then any repository on no account reached, under its owner, each group's repositories in
 * Repositories' order; on `own`, one group without a head. No repository, no group.
 */
export function repositoryGroups(state: State): RepositoryGroup[] {
  const { connection, repos } = state;
  if (repos.length === 0) return [];
  if (connection.way !== "shared") return [{ key: "all", head: null, repos }];
  const groups = new Map<string, RepositoryGroup>();
  for (const a of connection.accounts) {
    const login = a.account.login;
    groups.set(login.toLowerCase(), { key: login, head: groupHead(connection, login, a), repos: [] });
  }
  for (const r of repos) {
    const id = r.owner.toLowerCase();
    let group = groups.get(id);
    if (group === undefined) {
      group = { key: r.owner, head: groupHead(connection, r.owner, undefined), repos: [] };
      groups.set(id, group);
    }
    group.repos.push(r);
  }
  return [...groups.values()].filter((g) => g.repos.length > 0);
}
