// The person's accounts on the shared App, said once (ADR 0067): what setup's "Your accounts", Settings › GitHub, the
// alert band, the status menu, the pill and Repositories' group heads say of each account, and its one fix. Each
// account reached (`Connection.accounts`, GitHub's order) with its repositories or its cause; each one not reached
// (`Connection.unreached`, the person's own account first, then `gh`'s organisations) with Install on it when the
// person owns it, else Ask to install on it, which keeps the ask (`connection.askToInstall`) as GitHub's page opens;
// each one asked, waiting for an owner, hedged, since GitHub tells only the App whether a request was sent; and
// Install on another account last, GitHub's own page listing every account. An organisation nobody said the person
// owns gets a member's fix. GitHub's word for an organisation's role is used: owner, never admin. Before a sign-in and
// once signed out, there is no list. Signed in is the person kept and not signed out since (`signedIn`): the shared
// App is the one way in (ADR 0073), so nothing else of the connection says it. Every link is built on
// `Connection.web`, so demo mode stays on GitHub's fake. Every group on Repositories has a switch on its head and says
// how many are reviewed, always of the whole account (ADR 0082): the account's switch, a group of one's included, each
// row keeping its own (ADR 0083, round 4); setup's Repositories step lists the same groups, each of two or more with a
// checkbox ticked, mixed or not from the step's choices.
import {
  type AccountCause,
  accountOf,
  type Command,
  type Connection,
  type ConnectionAccount,
  type ConnectionCause,
  githubLinks,
  type HostLogin,
  type Repository,
  type RepositoryId,
  SHARED_APP,
  type State,
  sameLogin,
} from "@lookover/contracts";
import { agoSentence, metaLine, plural, startsAt } from "./format.ts";
import { HeldValue } from "./held.ts";

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
 * Where an account stands: `installed`, its repositories used; `reading`, installed, its repositories read for the
 * first time while setup's GitHub step waits on them; `needs-you`, a cause holds it (SSO, suspended, gone);
 * `not-installed`, the App isn't on it; `waiting`, asked, for an owner; `looking`, the person's own while their
 * accounts aren't listed yet; `another`, Install on another account's row.
 */
type AccountRowState =
  | "installed"
  | "reading"
  | "needs-you"
  | "not-installed"
  | "waiting"
  | "looking"
  | "another";

export interface AccountRow {
  /** The row's key: the account's login, or `another`. */
  key: string;
  /** The account's login, as GitHub writes it; null on Install on another account's row. */
  account: string | null;
  /** What the row is named by: the login, or Another account. */
  name: string;
  state: AccountRowState;
  /**
   * One line: its repositories, its cause, or what it waits for. The row is as tall as it is, holding no other detail
   * (ADR 0086): a longer one arriving grows its own row.
   */
  detail: string;
  /** Its one fix, or its one action. */
  fix: AccountLink | null;
  /**
   * Every label its fix can show in its part of the list, the fix's own among them, a login past a usual length held
   * at that length: the fix's place is as wide as the widest and no wider (width, never height), so a state changing in
   * place moves nothing beside it and the button stays as wide as its own label.
   */
  labels: string[];
  /** The labels of `labels` shown with Ask again beside them: their room holds Ask again's square too. */
  againLabels: string[];
  /** While waiting for an owner: GitHub's page again, the ask kept again. */
  again: AccountLink | null;
  /**
   * What the fix's place says when the row has no fix: Installed, on an account installed and used, so no row looks
   * unfinished. Null on every row with a fix.
   */
  status: string | null;
}

/**
 * The mark before a row's detail, its state said by an icon as well as its words (design-system.md "Accounts list"):
 * `repositories`, installed (its repositories' line, or their first read); `not-installed`, the person's own to
 * install; `ask`, a member's, whose owners are asked; `waiting`, asked; `needs-you`, a cause holds it; `looking`, the
 * accounts not listed yet; `another`, Install on another account's row.
 */
export type AccountMark =
  | "repositories"
  | "not-installed"
  | "ask"
  | "waiting"
  | "needs-you"
  | "looking"
  | "another";

export function accountMark(row: AccountRow): AccountMark {
  switch (row.state) {
    case "installed":
    case "reading":
      return "repositories";
    // A member's fix keeps the ask as GitHub's page opens; the person's own never asks.
    case "not-installed":
      return row.fix?.command === undefined ? "not-installed" : "ask";
    default:
      return row.state;
  }
}

export interface AccountsList {
  rows: AccountRow[];
}

const ANOTHER = "Install on another account";
/** What Install on another account's row is named by, where an account's row names its login. */
const ANOTHER_ACCOUNT = "Another account";
/** The ghost beside a waiting row's fix: its place is kept on every row, so a row asked moves nothing. */
const ASK_AGAIN = "Ask again";
const SSO = "Sign in with SSO";
const UNSUSPEND = "Unsuspend it on GitHub";
/** An account installed with no repository yet: its installation's settings, where the person picks them. */
const CHOOSE = "Choose repositories";
/** Where an installed account's fix would be: it has none, and says so. */
const INSTALLED = "Installed";

const installOn = (login: string) => `Install on ${login}`;
const askToInstallOn = (login: string) => `Ask to install on ${login}`;
const askAnOwnerOf = (login: string) => `Ask an owner of ${login}`;

/**
 * A login as a fix's place holds it: whole up to a long login of a usual kind, 16 characters, cut there past it
 * (GitHub allows 39), so a long login's label is cut with an ellipsis and never squeezes its row's detail.
 */
const heldLogin = (login: string) => login.slice(0, 16);

/**
 * The labels a row's fix place holds where it is in the list: a reached account's (no repository yet, SSO, then what
 * suspended and gone ask of an owner or of a member), one not reached the person owns (Install on it, never waiting),
 * a member's (asked, then waiting with Ask again beside).
 */
function reachedLabels(owns: boolean, login: string): Pick<AccountRow, "labels" | "againLabels"> {
  const held = heldLogin(login);
  return {
    labels: owns ? [CHOOSE, SSO, UNSUSPEND, installOn(held)] : [CHOOSE, SSO, askAnOwnerOf(held)],
    againLabels: [],
  };
}
function unreachedLabels(owns: boolean, login: string): Pick<AccountRow, "labels" | "againLabels"> {
  const held = heldLogin(login);
  return owns
    ? { labels: [installOn(held)], againLabels: [] }
    : { labels: [askToInstallOn(held), askAnOwnerOf(held)], againLabels: [askAnOwnerOf(held)] };
}

const DETAIL = {
  none: "No repository yet.",
  /** Installed, its repositories not read yet: setup's GitHub step waits on their first read (ADR 0086). */
  reading: "Reading its repositories…",
  /** The person's own, while their accounts aren't listed yet: nothing is said missing (ADR 0086, #670). */
  looking: "Looking…",
  /** The person's own, while GitHub refused the listing out of reach: it only waits (ADR 0070). */
  unreachable: "GitHub can't be reached. Lookover tries again every minute.",
  gone: "No longer installed.",
  notInstalled: "Not installed.",
  ask: "Not installed. On GitHub, you ask its owners to install it.",
  another: "GitHub's page lists every account you belong to.",
} as const;

const suspendedText = (by: string | undefined) => (by === undefined ? "Suspended." : `Suspended by ${by}.`);

/** SSO asked, on the organisation's own row; on another's row (`organisation`), the organisation named first. */
const ssoText = (organisation?: string) =>
  organisation === undefined
    ? "Asks you to sign in with SSO."
    : `${organisation} asks you to sign in with SSO.`;

/**
 * The line each cause of an account reached says, by its kind, a suspended installation apart (who suspended it
 * unsaid).
 */
const CAUSE_LINES = {
  sso: ssoText(),
  suspended: suspendedText(undefined),
  uninstalled: DETAIL.gone,
} as const satisfies Record<AccountCause["kind"] | "suspended", string>;

/**
 * "Waiting for an owner, asked at 09:35. If you sent the request, GitHub emailed its owners.": the login heads the
 * row, so the line names none and fits two lines beside the fix's place in setup whatever the account.
 */
const waitingText = (asked: string) =>
  `Waiting for an owner, asked ${asked}. If you sent the request, GitHub emailed its owners.`;

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

/**
 * The accounts list's fix for an account by its login, when it is one not reached: Install on it, Ask to install on
 * it or Ask an owner of it, as its row has it; else Install on it, GitHub's install page, where an owner installs it
 * and a member can ask (ADR 0082's No access notice).
 */
export function unreachedFix(state: State, login: string): AccountLink {
  const row = accountRows(state).rows.find(
    (r) =>
      r.account !== null &&
      sameLogin(r.account, login) &&
      (r.state === "not-installed" || r.state === "waiting"),
  );
  return row?.fix ?? { label: installOn(login), href: installPage(state.connection) };
}

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
 * only an account not reached has). `a` is an account reached, or the person's own while their accounts' listing is
 * refused (its installation unknown: unsuspended where the person's repositories are chosen).
 */
export function accountFix(
  connection: Pick<Connection, "person" | "web" | "accounts">,
  a: Pick<ConnectionAccount, "owner"> & { account: HostLogin },
  cause: AccountCause,
): { label: string; href: string } {
  const { login } = a.account;
  if (cause.kind === "sso") return ssoFix(connection, cause.organisation, cause.url);
  if (!ownsAccount(connection, a)) return askAnOwner(connection, login);
  return cause.suspended
    ? { label: UNSUSPEND, href: sharedRepositoriesLink(connection, login) }
    : { label: installOn(login), href: installPage(connection) };
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

/** A cause's line on its account's row; on another's (`elsewhere`: the person's own), SSO names its organisation. */
function causeDetail(cause: AccountCause, elsewhere = false): string {
  if (cause.kind === "sso") return elsewhere ? ssoText(cause.organisation) : CAUSE_LINES.sso;
  return cause.suspended ? suspendedText(cause.suspendedBy) : CAUSE_LINES.uninstalled;
}

/**
 * Whether the repositories are being read for the first time: setup's GitHub step waits on the first read of every
 * repository of the accounts listed (ADR 0083, ADR 0086). The step's accounts line and an account's row both say so.
 */
export const readingRepositories = ({ setup, connection }: Pick<State, "setup" | "connection">): boolean =>
  setup.github === "waiting-for-install" && connection.listed && connection.accounts.length > 0;

function reachedRow(state: State, a: ConnectionAccount): AccountRow {
  const { connection } = state;
  const login = a.account.login;
  const said = {
    key: login,
    account: login,
    name: login,
    again: null,
    status: null,
    ...reachedLabels(ownsAccount(connection, a), login),
  };
  if (a.cause !== null) {
    const detail = causeDetail(a.cause);
    return {
      ...said,
      state: "needs-you",
      detail,
      fix: accountFix(connection, a, a.cause),
    };
  }
  const n = state.repos.filter(
    (r) => accountOf(connection.accounts, r.owner)?.account.id === a.account.id,
  ).length;
  // Setup's GitHub step waits for every repository's first read: one not read yet isn't "No repository yet".
  if (n === 0 && readingRepositories(state))
    return { ...said, state: "reading", detail: DETAIL.reading, fix: null };
  const detail = n === 0 ? DETAIL.none : `${plural(n, "repository", "repositories")}.`;
  return {
    ...said,
    state: "installed",
    detail,
    ...(n === 0
      ? { fix: { label: CHOOSE, href: sharedRepositoriesLink(connection, login) } }
      : { fix: null, status: INSTALLED }),
  };
}

/**
 * A row of an account not reached. One the person owns offers Install on it, never an ask: it never waits for an
 * owner. A member's asks, then waits.
 */
function unreachedRow(
  state: State,
  u: Connection["unreached"][number],
  timeZone: string | undefined,
): AccountRow {
  const { connection } = state;
  const login = u.account.login;
  const owns = ownsAccount(connection, u);
  const said = { key: login, account: login, name: login, status: null, ...unreachedLabels(owns, login) };
  if (owns)
    return {
      ...said,
      state: "not-installed",
      detail: DETAIL.notInstalled,
      fix: { label: installOn(login), href: installPage(connection) },
      again: null,
    };
  if (u.askedAt === null)
    return {
      ...said,
      state: "not-installed",
      detail: DETAIL.ask,
      fix: ask(connection, askToInstallOn(login), login),
      again: null,
    };
  return {
    ...said,
    state: "waiting",
    detail: waitingText(startsAt(state.now, u.askedAt, timeZone)),
    fix: askAnOwner(connection, login),
    again: ask(connection, ASK_AGAIN, login),
  };
}

/** The cause said as signed out (ADR 0073). */
export type SignedOutCause = Extract<ConnectionCause, { kind: "signed-out" }>;

/**
 * Whether the person is signed out: a sign-in is the one way back (ADR 0073). The list, the band, the status menu and
 * the sign-in's code all ask this one.
 */
export const saidSignedOut = (cause: ConnectionCause | null): cause is SignedOutCause =>
  cause?.kind === "signed-out";

/** Whether the person is signed in now: kept, and not signed out since. The list's accounts are theirs. */
export const signedIn = ({ person, cause }: Pick<Connection, "person" | "cause">): boolean =>
  person !== null && !saidSignedOut(cause);

/**
 * The person's own row while their accounts aren't listed under this sign-in (`Connection.listed`, ADR 0086): their
 * login, looking, no action, so no account is said missing before GitHub has answered (#670).
 */
const lookingRow = (login: string): AccountRow => ({
  key: login,
  account: login,
  name: login,
  state: "looking",
  detail: DETAIL.looking,
  fix: null,
  labels: [],
  againLabels: [],
  again: null,
  status: null,
});

/** A cause the connection can hold while the person is signed in. */
type SignedInCause = Exclude<ConnectionCause, SignedOutCause>;

/**
 * The line and fix of a cause that refused the listing of the person's accounts (ADR 0086: a refused listing shows its
 * cause instead of looking): GitHub out of reach only waits, Lookover trying again by itself, so no fix; any other,
 * said and mended as on an account the person owns (`causeDetail`, `accountFix`), on their own row.
 */
function refusedListing(
  connection: Connection,
  person: HostLogin,
  cause: SignedInCause,
): Pick<AccountRow, "detail" | "fix"> {
  if (cause.kind === "unreachable") return { detail: DETAIL.unreachable, fix: null };
  return {
    detail: causeDetail(cause, true),
    fix: accountFix(connection, { account: person, owner: true }, cause),
  };
}

/**
 * The accounts list at the state the service says: reached first in GitHub's order, then the ones not reached in
 * the order the service gave, then Install on another account; empty before a sign-in and once signed out; the
 * person's own row alone until their accounts are listed, looking, or saying the cause that refused the listing with
 * its fix. `timeZone`, the zone a time is said in (the browser's by default).
 */
export function accountRows(state: State, o: { timeZone?: string } = {}): AccountsList {
  const { connection } = state;
  if (!signedIn(connection)) return { rows: [] };
  if (!connection.listed && connection.person !== null) {
    const looking = lookingRow(connection.person.login);
    // Only this sign-in's listing says what refused it, whatever the repositories' polls say: the connection's cause
    // can be left from before it (Sign in again while uninstalled), and nothing is said missing before the listing
    // answers (ADR 0086). Every refused listing sets it: the start's, discovery's, the install check's.
    const cause = connection.listingCause;
    if (cause === null || saidSignedOut(cause)) return { rows: [looking] };
    const said = refusedListing(connection, connection.person, cause);
    return {
      rows: [{ ...looking, ...said, state: "needs-you", labels: said.fix === null ? [] : [said.fix.label] }],
    };
  }
  const another: AccountRow = {
    key: "another",
    account: null,
    name: ANOTHER_ACCOUNT,
    state: "another",
    detail: DETAIL.another,
    fix: { label: ANOTHER, href: installPage(connection) },
    labels: [ANOTHER],
    againLabels: [],
    again: null,
    status: null,
  };
  const rows = [
    ...connection.accounts.map((a) => reachedRow(state, a)),
    ...connection.unreached.map((u) => unreachedRow(state, u, o.timeZone)),
    another,
  ];
  return { rows };
}

/**
 * A group of Repositories' head (design-system.md "Repositories' group heads"): the account, how many of its
 * repositories are reviewed, its cause's line (null with none: a head with no problem holds no room for one, ADR 0086)
 * and its one fix, its place as wide as every label `accountFix` can return for it.
 */
interface RepositoryGroupHead {
  /** The account's login, as GitHub writes it (the repositories' owner when no account reached is theirs). */
  account: string;
  /** The chevron's name: what it shows and hides. */
  toggleLabel: string;
  /** "3 of 40 reviewed", "All 40 reviewed", "None of 40 reviewed"; of a group of one, "1 repository, reviewed" or "not reviewed". */
  count: string;
  /**
   * Under Repositories' filter, a folded group's head says how many of it the filter shows ("10 repositories shown"), where a cause
   * goes; null while it is open (its rows say it) and with no filter.
   */
  shows: string | null;
  /** `needs-you` while a cause holds the account, else `fine`. */
  state: "fine" | "needs-you";
  cause: string | null;
  fix: { label: string; href: string } | null;
  /**
   * Every label `accountFix` can return for the account, by who owns it, a login past a usual length held at the
   * accounts list's 16 characters: the fix's place is as wide as the widest. None on an account not reached.
   */
  labels: string[];
}

/** What a group's switch sends, `enabled` added as it is switched: the account's command. */
type SwitchCommand = Omit<Extract<Command, { type: "repos.setEnabled" }>, "enabled">;

export interface RepositoryGroup {
  /** The account's login. */
  key: string;
  head: RepositoryGroupHead;
  /** The account's repositories shown, in Repositories' order. */
  repos: Repository[];
  /** How many of the account's repositories are reviewed, and of how many: all of them, whatever is shown. */
  reviewed: number;
  total: number;
  /** Every one of them reviewed: the account's switch is on. A mixed account's is off (ADR 0082). */
  allOn: boolean;
  /**
   * The head's switch, naming every repository of the account, and the command it sends with `enabled` added: the
   * account's (`repos.setEnabled`), a group of one's included, so every head is alike and every row keeps its own
   * (ADR 0083, round 4). None for an account with no repository.
   */
  control: {
    label: string;
    repoIds: [RepositoryId, ...RepositoryId[]];
    command: SwitchCommand;
  } | null;
}

/**
 * What a head says of `reviewed` of `total` repositories reviewed; of one, whether it is, naming the repository so the
 * count reads as its row's, never as a pull request reviewed (ADR 0083, round 6).
 */
function countLine(reviewed: number, total: number): string {
  if (total < 2) return reviewed === 0 ? "1 repository, not reviewed" : "1 repository, reviewed";
  if (reviewed === total) return `All ${total} reviewed`;
  if (reviewed === 0) return `None of ${total} reviewed`;
  return `${reviewed} of ${total} reviewed`;
}

function groupHead(
  connection: Connection,
  login: string,
  a: ConnectionAccount | undefined,
  reviewed: number,
  total: number,
): RepositoryGroupHead {
  const cause = a?.cause ?? null;
  return {
    account: login,
    toggleLabel: `${login}'s repositories`,
    count: countLine(reviewed, total),
    shows: null,
    state: cause === null ? "fine" : "needs-you",
    cause: cause === null ? null : causeDetail(cause),
    fix: a === undefined || cause === null ? null : accountFix(connection, a, cause),
    labels: a === undefined ? [] : headLabels(ownsAccount(connection, a), login),
  };
}

/**
 * The labels a head's fix place holds (`accountFix`'s, by who owns the account): SSO, then suspended and gone, an
 * owner's own fixes or a member's ask of an owner.
 */
function headLabels(owns: boolean, login: string): string[] {
  const held = heldLogin(login);
  return owns ? [SSO, UNSUSPEND, installOn(held)] : [SSO, askAnOwnerOf(held)];
}

/** An account's group: its switch and count from every repository of it, its rows only those `shown`. */
function accountGroup(
  connection: Connection,
  key: string,
  a: ConnectionAccount | undefined,
  repos: Repository[],
  shown: (r: Repository) => boolean,
): RepositoryGroup {
  const total = repos.length;
  const reviewed = repos.filter((r) => r.enabled).length;
  return {
    key,
    head: groupHead(connection, key, a, reviewed, total),
    repos: repos.filter(shown),
    reviewed,
    total,
    allOn: reviewed === total,
    control: groupControl(key, repos),
  };
}

/** A group's switch (`RepositoryGroup["control"]`): the account's, a group of one's included. */
function groupControl(key: string, repos: Repository[]): RepositoryGroup["control"] {
  const [one, ...others] = repos;
  if (one === undefined) return null;
  const repoIds: [RepositoryId, ...RepositoryId[]] = [one.id, ...others.map((r) => r.id)];
  return {
    label: `Review every repository in ${key}`,
    repoIds,
    command: { type: "repos.setEnabled", repoIds },
  };
}

/**
 * Repositories' rows by account (ADR 0067): one group per account with a repository, in the accounts list's order
 * (GitHub's), then any repository on no account reached, under its owner, each group's repositories in Repositories'
 * order. `shown` keeps the rows a search or a filter leaves (every one by default), never changing a group's count or
 * its switch; a group with no row shown is dropped, as one with no repository.
 */
export function repositoryGroups(
  state: State,
  shown: (r: Repository) => boolean = () => true,
): RepositoryGroup[] {
  const { connection, repos } = state;
  const accounts = new Map<string, { key: string; a?: ConnectionAccount; repos: Repository[] }>();
  for (const a of connection.accounts)
    accounts.set(a.account.login.toLowerCase(), { key: a.account.login, a, repos: [] });
  for (const r of repos) {
    const id = r.owner.toLowerCase();
    const found = accounts.get(id) ?? { key: r.owner, repos: [] };
    accounts.set(id, found);
    found.repos.push(r);
  }
  return [...accounts.values()]
    .map((g) => accountGroup(connection, g.key, g.a, g.repos, shown))
    .filter((g) => g.repos.length > 0);
}

/** How many pull requests are open on a repository. */
export function openChangeCount(state: State, repoId: RepositoryId): number {
  return Object.values(state.changes).filter((p) => p.repoId === repoId).length;
}

/** A repository's open pull requests on its page's line: "no open pull requests", "1 open pull request", "3 open pull requests". */
function openPullRequests(n: number): string {
  return n === 0 ? "no open pull requests" : plural(n, "open pull request");
}

/**
 * A repository's open pull requests where a column or a row names them: "2 open", zero said as "0 open", told apart by
 * `zero` (muted), never left blank: a dash and a blank both read as missing; zero is data (ADR 0083, round 5).
 */
function openCount(n: number): { open: string; zero: boolean } {
  return { open: `${n} open`, zero: n === 0 };
}

/** A repository as Repositories and its page say where it stands: reviewed or not, its open pull requests, its last review. */
export interface RepositoryStanding {
  enabled: boolean;
  open: number;
  /** When its last review ended, null when none did. */
  lastAt: number | null;
}

/**
 * Repositories' Pull requests cell (design-system.md "Table"): reviewed, the count ("2 open": the column names the pull
 * requests), zero included ("0 open", `zero`: muted, so the few rows with any stand out), then the last review. Not
 * reviewed: those words alone.
 */
export function pullRequestsCell(
  r: RepositoryStanding,
  now: number,
): { on: true; open: string; zero: boolean; last: string | null } | { on: false; text: string } {
  if (!r.enabled) return { on: false, text: "not reviewed" };
  return {
    on: true,
    ...openCount(r.open),
    last: r.lastAt === null ? null : `last review ${agoSentence(now, r.lastAt)}`,
  };
}

/** A repository's page's line under its name: "Reviewing · 1 open pull request · last review 3 min ago", dots held. */
export function repositoryStanding(r: RepositoryStanding, now: number): string {
  if (!r.enabled) return metaLine(["Off", "pull requests here are not reviewed"]);
  return metaLine([
    "Reviewing",
    openPullRequests(r.open),
    ...(r.lastAt === null ? [] : [`last review ${agoSentence(now, r.lastAt)}`]),
  ]);
}

/** A repository on setup's Repositories step, ticked or not. */
interface SetupRepoRow {
  repo: Repository;
  ticked: boolean;
  /** Its open pull requests, shown beside its name, in Repositories' words ("2 open", "0 open"). */
  open: string;
  /** None open: `open` muted, as on Repositories. */
  zero: boolean;
  /** Its checkbox's name: the repository in full (two accounts may each have one by that name), then its open pull requests. */
  label: string;
}

/** An account's group on setup's Repositories step: its rows and its checkbox's state from the step's choices. */
export interface SetupRepoGroup {
  /** The account's login. */
  key: string;
  /** Its chevron's name, Repositories' own (`RepositoryGroup["head"]["toggleLabel"]`). */
  toggleLabel: string;
  /** How many repositories the account has, shown or not (what Repositories' rule folds by). */
  total: number;
  /** How many repositories it lists, shown beside its login while the step lists ten or fewer. */
  size: string;
  /**
   * How many of its repositories are ticked, of how many, shown beside its login past ten, where a group may be folded
   * ("9 of 11 to review"; ADR 0083, round 6), and `counts`, every line it may say, so a tick changes no width.
   */
  count: string;
  counts: string[];
  rows: SetupRepoRow[];
  /** All of its repositories ticked, some (the checkbox mixed) or none. */
  ticked: "all" | "some" | "none";
  /** The account's checkbox, naming every repository of the account; none for a group of one. */
  control: RepositoryGroup["control"];
}

/**
 * Setup's Repositories step (ADR 0082): Repositories' groups, each repository ticked as the owner chose here, else as
 * the service has it (as `chosenRepos` reads the choices), and each group's checkbox all, some or none ticked. `shown`
 * keeps the rows a search leaves (every one by default), never changing a group's size or its checkbox, which are the
 * whole account's; a group with no row shown is dropped.
 */
export function setupRepoGroups(
  state: State,
  choices: ReadonlyMap<RepositoryId, boolean>,
  shown: (r: Repository) => boolean = () => true,
): SetupRepoGroup[] {
  return repositoryGroups(state)
    .map((g): SetupRepoGroup => {
      const rows = g.repos.map((repo) => {
        const open = openChangeCount(state, repo.id);
        return {
          repo,
          ticked: choices.get(repo.id) ?? repo.enabled,
          ...openCount(open),
          label: `${repo.id}, ${plural(open, "open pull request")}`,
        };
      });
      const n = rows.filter((r) => r.ticked).length;
      return {
        key: g.key,
        toggleLabel: g.head.toggleLabel,
        total: rows.length,
        size: plural(rows.length, "repository", "repositories"),
        count: toReviewHead(n, rows.length),
        counts: Array.from({ length: rows.length + 1 }, (_, k) => toReviewHead(k, rows.length)),
        rows: rows.filter((r) => shown(r.repo)),
        ticked: n === rows.length ? "all" : n === 0 ? "none" : "some",
        control: g.total > 1 ? g.control : null,
      };
    })
    .filter((g) => g.rows.length > 0);
}

/** A setup head's count of `ticked` of its `total`, in Repositories' head's shape (`countLine`) and setup's words. */
function toReviewHead(ticked: number, total: number): string {
  if (total < 2) return ticked === 0 ? "1 repository, not to review" : "1 repository, to review";
  if (ticked === total) return `All ${total} to review`;
  if (ticked === 0) return `None of ${total} to review`;
  return `${ticked} of ${total} to review`;
}

/** The step's choices with every one of `repoIds` ticked (`on`) or unticked; the choices given stay as they are. */
export function tickAccount(
  choices: ReadonlyMap<RepositoryId, boolean>,
  repoIds: readonly RepositoryId[],
  on: boolean,
): ReadonlyMap<RepositoryId, boolean> {
  const next = new Map(choices);
  for (const id of repoIds) next.set(id, on);
  return next;
}

/** What the owner ticked or unticked on setup's Repositories step, for one visit of it; the rest follows the service. */
export class SetupTicks extends HeldValue<ReadonlyMap<RepositoryId, boolean>> {
  constructor() {
    super(new Map());
  }

  /** Ticks (`on`) or unticks every one of `repoIds`: a repository's box, or its account's. */
  tick = (repoIds: readonly RepositoryId[], on: boolean): void => {
    this.set(tickAccount(this.get(), repoIds, on));
  };
}
