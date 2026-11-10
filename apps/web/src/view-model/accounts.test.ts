// What the accounts list says on the shared App (ADR 0067), for a given snapshot: each account reached with its
// repositories or its cause and its one fix, each account not reached with Install on or Ask to install on, each asked
// one waiting for an owner, and Install on another account last. Snapshots are built by hand: the view model reads
// state only.
import { expect, test } from "bun:test";
import {
  type Change,
  type Connection,
  type ConnectionAccount,
  changeId,
  commitSha,
  connectionId,
  DEMO_API,
  type DepartedRepository,
  type Engine,
  type EngineId,
  GITHUB_WEB,
  type Repository,
  type RepositoryId,
  type ResolvedSettings,
  repositoryId,
  type State,
  type UnreachedAccount,
} from "@lookover/contracts";
import {
  accountMark,
  accountRows,
  pullRequestsCell,
  repositoryGroups,
  repositoryStanding,
  setupRepoGroups,
  tickAccount,
} from "./accounts.ts";
import { SEPARATOR } from "./format.ts";
import { addRepositoryLink, chosenRepos, departedNotice } from "./onboarding.ts";

/** 2026-10-30 10:00 UTC; times are said in UTC here. */
const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const MIN = 60_000;
const UTC = "UTC";
const INSTALL = "https://github.com/apps/lookover-dev/installations/new";
const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

function engine(id: EngineId, name: string): Engine {
  return {
    id,
    name,
    cli: id,
    version: "1.0.0",
    state: "ready",
    detail: "",
    unusable: null,
    since: NOW,
    limitUntil: null,
    signingIn: false,
  };
}

const repo = (owner: string, name: string): Repository => ({
  id: repositoryId(`${owner}/${name}`),
  owner,
  name,
  enabled: true,
  settings: DEFAULTS,
});

/** sasensi signed in to the shared App, connected, with `connection` over it. */
function signedIn(connection: Partial<Connection> = {}, repos: Repository[] = []): State {
  return {
    seq: 0,
    now: NOW,
    setup: {
      done: true,
      step: "background",
      reached: "background",
      github: "done",
      firstReviewChange: null,
    },
    engines: { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") },
    connection: {
      id: connectionId("github:sasensi"),
      state: "connected",
      cause: null,
      signIn: null,
      person: { id: 1, login: "sasensi" },
      accounts: [],
      listed: true,
      listingCause: null,
      unreached: [],
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
      ...connection,
    },
    service: {
      state: "running",
      since: NOW,
      version: "0.1.0",
      command: "lookover",
      agent: { path: { reach: "no", folder: "~/.local/bin" }, offer: "binary", skills: [] },
      startAtLogin: true,
      atLogin: "this",
      loginItem: "os",
      paused: null,
      remote: false,
      unlocked: false,
      checks: null,
    },
    settings: DEFAULTS,
    repos,
    departed: [],
    rules: [],
    changes: {},
    reviews: {},
  };
}

const own: ConnectionAccount = {
  account: { id: 1, login: "sasensi", type: "User" },
  installationId: 11,
  cause: null,
  owner: true,
};

const org = (
  login: string,
  cause: ConnectionAccount["cause"],
  owner: boolean | null,
  installationId = 22,
): ConnectionAccount => ({
  account: { id: 400 + installationId, login, type: "Organization" },
  installationId,
  cause,
  owner,
});

const unreached = (
  account: string,
  owner: boolean | null,
  askedAt: number | null = null,
  kind: UnreachedAccount["kind"] = "organisation",
): UnreachedAccount => ({
  account: { id: account === "sasensi" ? 1 : 500 + account.length, login: account },
  kind,
  owner,
  askedAt,
});

const rows = (state: State) => accountRows(state, { timeZone: UTC }).rows;
const row = (state: State, account: string) => rows(state).find((r) => r.account === account);

// ---- the order ----

test("reached accounts first in GitHub's order, then the ones not reached in gh's, then Install on another account", () => {
  const state = signedIn({
    accounts: [own, org("ledger-dev", null, true)],
    unreached: [unreached("ledger-co", true), unreached("ledger-labs", false)],
  });
  expect(rows(state).map((r) => r.key)).toEqual([
    "sasensi",
    "ledger-dev",
    "ledger-co",
    "ledger-labs",
    "another",
  ]);
});

test("Install on another account is always last, to GitHub's own page, even with nothing else to name", () => {
  const list = rows(signedIn());
  expect(list).toEqual([
    {
      key: "another",
      account: null,
      // Its row names no account: the list says it as one.
      name: "Another account",
      state: "another",
      detail: "GitHub's page lists every account you belong to.",
      fix: { label: "Install on another account", href: INSTALL },
      labels: ["Install on another account"],
      againLabels: [],
      again: null,
      status: null,
    },
  ]);
});

test("no list before a sign-in, once signed out, or with nobody signed in", () => {
  expect(rows(signedIn({ state: "not-connected", person: null }))).toEqual([]);
  expect(rows(signedIn({ state: "disconnected", cause: { kind: "signed-out" }, accounts: [own] }))).toEqual(
    [],
  );
  // Nobody signed in, accounts or not: no list (ADR 0073).
  expect(rows(signedIn({ person: null, accounts: [{ ...own, owner: null }] }))).toEqual([]);
});

test("not listed yet under a new sign-in, the connection's cause left from before it: your own row looking, nothing said missing (ADR 0086)", () => {
  // Sign in again while the poller held `uninstalled`: only this sign-in's listing says what refused it.
  const list = accountRows(
    signedIn({
      state: "disconnected",
      cause: { kind: "uninstalled", suspended: false },
      accounts: [],
      listed: false,
      listingCause: null,
    }),
  );
  expect(list.rows.map((r) => [r.name, r.state, r.detail, r.fix, r.labels])).toEqual([
    ["sasensi", "looking", "Looking…", null, []],
  ]);
});

// ---- reached ----

test("an account reached says how many of the repositories are its", () => {
  const state = signedIn({ accounts: [own, org("Ledger-Dev", null, true)] }, [
    repo("sasensi", "ledger-api"),
    repo("ledger-dev", "billing"),
    repo("sasensi", "ledger-web"),
  ]);
  expect(row(state, "sasensi")).toEqual({
    key: "sasensi",
    account: "sasensi",
    name: "sasensi",
    state: "installed",
    detail: "2 repositories.",
    fix: null,
    labels: ["Choose repositories", "Sign in with SSO", "Unsuspend it on GitHub", "Install on sasensi"],
    againLabels: [],
    again: null,
    status: "Installed",
  });
  expect(row(state, "Ledger-Dev")?.detail).toBe("1 repository.");
});

test("an account installed and used says so where a fix would be; every row with a fix, or no account, says nothing there", () => {
  const state = signedIn(
    {
      accounts: [
        own,
        org("ledger-dev", null, true),
        org("ledger-ops", { kind: "sso", organisation: "ledger-ops", url: null }, false, 33),
      ],
      unreached: [unreached("ledger-labs", true), unreached("ledger-hq", false, NOW)],
    },
    [repo("sasensi", "ledger-api")],
  );
  expect(Object.fromEntries(rows(state).map((r) => [r.key, r.status]))).toEqual({
    sasensi: "Installed",
    // Installed with no repository: Choose repositories is its fix.
    "ledger-dev": null,
    "ledger-ops": null,
    "ledger-labs": null,
    "ledger-hq": null,
    another: null,
  });
});

test("each row's detail carries its state's mark: its repositories, not installed, ask its owners, waiting, a cause, another", () => {
  const state = signedIn(
    {
      accounts: [
        own,
        org("ledger-dev", null, true),
        org("ledger-ops", { kind: "sso", organisation: "ledger-ops", url: null }, false, 33),
      ],
      unreached: [
        unreached("ledger-labs", true),
        unreached("ledger-co", false),
        unreached("ledger-hq", false, NOW),
      ],
    },
    [repo("sasensi", "ledger-api")],
  );
  expect(Object.fromEntries(rows(state).map((r) => [r.key, accountMark(r)]))).toEqual({
    sasensi: "repositories",
    // Installed with no repository: still its repositories' line.
    "ledger-dev": "repositories",
    "ledger-ops": "needs-you",
    "ledger-labs": "not-installed",
    "ledger-co": "ask",
    "ledger-hq": "waiting",
    another: "another",
  });
});

test("an account installed with no repository yet: Choose repositories, its installation's settings when the person owns it", () => {
  const state = signedIn({
    accounts: [own, org("ledger-dev", null, true), org("ledger-labs", null, false, 33)],
  });
  expect(row(state, "sasensi")).toEqual({
    key: "sasensi",
    account: "sasensi",
    name: "sasensi",
    state: "installed",
    detail: "No repository yet.",
    fix: { label: "Choose repositories", href: "https://github.com/settings/installations/11" },
    labels: ["Choose repositories", "Sign in with SSO", "Unsuspend it on GitHub", "Install on sasensi"],
    againLabels: [],
    again: null,
    status: null,
  });
  expect(row(state, "ledger-dev")?.fix).toEqual({
    label: "Choose repositories",
    href: "https://github.com/organizations/ledger-dev/settings/installations/22",
  });
  // A member's, or nobody said: GitHub's install page, which shows Configure on an installed account.
  expect(row(state, "ledger-labs")?.fix).toEqual({ label: "Choose repositories", href: INSTALL });
});

test("an account asking for SSO: its SSO page, GitHub's own when the 403 gave one", () => {
  const sso = (url: string | null) =>
    signedIn({ accounts: [own, org("ledger-dev", { kind: "sso", organisation: "ledger-dev", url }, false)] });
  expect(row(sso(null), "ledger-dev")).toEqual({
    key: "ledger-dev",
    account: "ledger-dev",
    name: "ledger-dev",
    state: "needs-you",
    detail: "Asks you to sign in with SSO.",
    fix: { label: "Sign in with SSO", href: "https://github.com/orgs/ledger-dev/sso" },
    labels: ["Choose repositories", "Sign in with SSO", "Ask an owner of ledger-dev"],
    againLabels: [],
    again: null,
    status: null,
  });
  expect(
    row(sso("https://github.com/orgs/ledger-dev/sso?authorization_request=x"), "ledger-dev")?.fix,
  ).toEqual({
    label: "Sign in with SSO",
    href: "https://github.com/orgs/ledger-dev/sso?authorization_request=x",
  });
});

test("suspended on an account the person owns: Unsuspend it on GitHub, the installation's settings", () => {
  const state = signedIn({
    accounts: [{ ...own, cause: { kind: "uninstalled", suspended: true } }, org("ledger-dev", null, true)],
  });
  expect(row(state, "sasensi")).toMatchObject({
    state: "needs-you",
    detail: "Suspended.",
    fix: { label: "Unsuspend it on GitHub", href: "https://github.com/settings/installations/11" },
  });
  const owned = signedIn({ accounts: [org("ledger-dev", { kind: "uninstalled", suspended: true }, true)] });
  expect(row(owned, "ledger-dev")?.fix).toEqual({
    label: "Unsuspend it on GitHub",
    href: "https://github.com/organizations/ledger-dev/settings/installations/22",
  });
});

test("suspended on an organisation the person doesn't own: ask an owner, naming who suspended it when GitHub said", () => {
  const by = signedIn({
    accounts: [org("ledger-dev", { kind: "uninstalled", suspended: true, suspendedBy: "mira" }, false)],
  });
  expect(row(by, "ledger-dev")).toMatchObject({
    state: "needs-you",
    detail: "Suspended by mira.",
    fix: {
      label: "Ask an owner of ledger-dev",
      href: "https://github.com/orgs/ledger-dev/people?query=role%3Aowner",
    },
  });
  // Nobody said whether the person owns it: a member's fix.
  const unknown = signedIn({ accounts: [org("ledger-dev", { kind: "uninstalled", suspended: true }, null)] });
  expect(row(unknown, "ledger-dev")).toMatchObject({
    detail: "Suspended.",
    fix: { label: "Ask an owner of ledger-dev" },
  });
});

test("an installation gone but still listed: installed again by an owner, asked for by a member", () => {
  const gone = (owner: boolean | null) =>
    signedIn({ accounts: [org("ledger-dev", { kind: "uninstalled", suspended: false }, owner)] });
  expect(row(gone(true), "ledger-dev")).toMatchObject({
    state: "needs-you",
    detail: "No longer installed.",
    fix: { label: "Install on ledger-dev", href: INSTALL },
  });
  // A member asks an owner: Ask to install on keeps an ask, and only an account not reached has one.
  expect(row(gone(false), "ledger-dev")).toMatchObject({
    detail: "No longer installed.",
    fix: {
      label: "Ask an owner of ledger-dev",
      href: "https://github.com/orgs/ledger-dev/people?query=role%3Aowner",
    },
  });
  expect(row(gone(false), "ledger-dev")?.fix).not.toHaveProperty("command");
});

// ---- not reached ----

test("the person's own account not reached: Install on it", () => {
  const state = signedIn({ unreached: [unreached("sasensi", true, null, "user")] });
  expect(row(state, "sasensi")).toEqual({
    key: "sasensi",
    account: "sasensi",
    name: "sasensi",
    state: "not-installed",
    detail: "Not installed.",
    fix: { label: "Install on sasensi", href: INSTALL },
    labels: ["Install on sasensi"],
    againLabels: [],
    again: null,
    status: null,
  });
});

test("an organisation the person owns: Install on it; one they're a member of, or nobody said: Ask to install, which keeps the ask", () => {
  const state = signedIn({
    unreached: [unreached("ledger-co", true), unreached("ledger-labs", false), unreached("ledger-ops", null)],
  });
  expect(row(state, "ledger-co")).toMatchObject({
    state: "not-installed",
    detail: "Not installed.",
    fix: { label: "Install on ledger-co", href: INSTALL },
  });
  expect(row(state, "ledger-co")?.fix).not.toHaveProperty("command");
  for (const login of ["ledger-labs", "ledger-ops"])
    expect(row(state, login)).toEqual({
      key: login,
      account: login,
      name: login,
      state: "not-installed",
      detail: "Not installed. On GitHub, you ask its owners to install it.",
      fix: {
        label: `Ask to install on ${login}`,
        href: INSTALL,
        command: { type: "connection.askToInstall", account: login },
      },
      labels: [`Ask to install on ${login}`, `Ask an owner of ${login}`],
      againLabels: [`Ask an owner of ${login}`],
      again: null,
      status: null,
    });
});

test("asked: waiting for an owner, since when, hedged; ask an owner, and GitHub's page again", () => {
  const state = signedIn({ unreached: [unreached("ledger-labs", false, NOW - 25 * MIN)] });
  expect(row(state, "ledger-labs")).toEqual({
    key: "ledger-labs",
    account: "ledger-labs",
    name: "ledger-labs",
    state: "waiting",
    detail: "Waiting for an owner, asked at 09:35. If you sent the request, GitHub emailed its owners.",
    fix: {
      label: "Ask an owner of ledger-labs",
      href: "https://github.com/orgs/ledger-labs/people?query=role%3Aowner",
    },
    labels: ["Ask to install on ledger-labs", "Ask an owner of ledger-labs"],
    againLabels: ["Ask an owner of ledger-labs"],
    again: {
      label: "Ask again",
      href: INSTALL,
      command: { type: "connection.askToInstall", account: "ledger-labs" },
    },
    status: null,
  });
  const yesterday = signedIn({ unreached: [unreached("ledger-labs", false, NOW - 20 * 60 * MIN)] });
  expect(row(yesterday, "ledger-labs")?.detail).toBe(
    "Waiting for an owner, asked on Thu 29 Oct at 14:00. If you sent the request, GitHub emailed its owners.",
  );
});

// ---- held ----

test("a row's fix place holds every label its own fix can show where it is in the list, and no other row's", () => {
  const state = signedIn({
    accounts: [own, org("ledger-dev", null, false)],
    unreached: [unreached("ledger-labs", true), unreached("ledger-hq", false, NOW)],
  });
  expect(Object.fromEntries(rows(state).map((r) => [r.key, r.labels]))).toEqual({
    // Reached and owned: no repository yet, SSO, suspended, gone.
    sasensi: ["Choose repositories", "Sign in with SSO", "Unsuspend it on GitHub", "Install on sasensi"],
    // Reached, a member's: an owner is asked for what an owner would do.
    "ledger-dev": ["Choose repositories", "Sign in with SSO", "Ask an owner of ledger-dev"],
    // Not reached, the person's own: it never waits.
    "ledger-labs": ["Install on ledger-labs"],
    // Not reached, a member's: asked, then waiting.
    "ledger-hq": ["Ask to install on ledger-hq", "Ask an owner of ledger-hq"],
    another: ["Install on another account"],
  });
  for (const r of rows(state)) if (r.fix !== null) expect(r.labels).toContain(r.fix.label);
});

test("only a member's row not reached holds Ask again's square beside a fix: the one it waits with", () => {
  const state = signedIn({
    accounts: [org("ledger-dev", null, false)],
    unreached: [unreached("ledger-labs", true), unreached("ledger-hq", false)],
  });
  expect(Object.fromEntries(rows(state).map((r) => [r.key, r.againLabels]))).toEqual({
    "ledger-dev": [],
    "ledger-labs": [],
    "ledger-hq": ["Ask an owner of ledger-hq"],
    another: [],
  });
});

test("a login longer than a usual one is held at 16 characters: its fix's label is cut, never the row's detail", () => {
  const login = "ledger-holdings-europe-west";
  const r = row(signedIn({ unreached: [unreached(login, true)] }), login);
  expect(r?.fix?.label).toBe(`Install on ${login}`);
  expect(r?.labels).toEqual(["Install on ledger-holdings-"]);
});

test("a row holds no detail it doesn't show: as tall as its own line, whatever it could say (ADR 0086)", () => {
  const list = accountRows(
    signedIn({
      accounts: [own],
      unreached: [
        unreached("ledger-labs", false),
        unreached("ledger-hq", true),
        unreached("ledger-ops", false, NOW),
      ],
    }),
    { timeZone: UTC },
  );
  for (const r of list.rows) expect(r).not.toHaveProperty("details");
});

test("a waiting row's line names no login: the login heads the row, so it fits two lines in setup's column whatever the account", () => {
  // 103 characters: the older day's form, two lines beside the fix's place in setup.
  const login = "x".repeat(39);
  const waiting = row(signedIn({ unreached: [unreached(login, false, NOW - 20 * 60 * MIN)] }), login);
  expect(waiting?.detail).not.toContain(login);
  expect(waiting?.detail.length).toBeLessThanOrEqual(103);
});

test("only a row waiting for an owner has Ask again: every row keeps its place, the screen's (github-app.test.tsx)", () => {
  const list = accountRows(
    signedIn({
      accounts: [own],
      unreached: [
        unreached("ledger-labs", false),
        unreached("ledger-ops", null, NOW),
        unreached("ledger-hq", true),
      ],
    }),
    { timeZone: UTC },
  );
  expect(Object.fromEntries(list.rows.map((r) => [r.key, r.again?.label ?? null]))).toEqual({
    sasensi: null,
    "ledger-labs": null,
    "ledger-ops": "Ask again",
    "ledger-hq": null,
    another: null,
  });
});

test("every link is built on the connection's web address: demo mode's stays on GitHub's fake", () => {
  const state = signedIn({ web: DEMO_API.github, unreached: [unreached("ledger-labs", false, NOW)] });
  expect(row(state, "ledger-labs")?.fix?.href).toBe(
    `${DEMO_API.github}/orgs/ledger-labs/people?query=role%3Aowner`,
  );
  expect(rows(state).at(-1)?.fix?.href).toBe(`${DEMO_API.github}/apps/lookover-dev/installations/new`);
});

// ---- Repositories' group heads ----

const groups = (state: State) =>
  repositoryGroups(state).map((g) => ({
    key: g.key,
    head: g.head,
    repos: g.repos.map((r): string => `${r.owner}/${r.name}`),
  }));

test("on the shared App, Repositories groups its rows by account, in the accounts list's order", () => {
  const state = signedIn({ accounts: [own, org("Ledger-Dev", null, false)] }, [
    repo("ledger-dev", "billing"),
    repo("sasensi", "ledger-api"),
    repo("ledger-dev", "ledger-web"),
  ]);
  expect(groups(state).map((g) => [g.key, g.head.account, g.repos])).toEqual([
    ["sasensi", "sasensi", ["sasensi/ledger-api"]],
    // The account as GitHub writes it, its repositories in Repositories' order.
    ["Ledger-Dev", "Ledger-Dev", ["ledger-dev/billing", "ledger-dev/ledger-web"]],
  ]);
});

test("a group head with no cause says nothing more and holds no cause; its fix's place, every fix its account can have", () => {
  const [head] = repositoryGroups(signedIn({ accounts: [own] }, [repo("sasensi", "ledger-api")])).map(
    (g) => g.head,
  );
  expect(head).toEqual({
    account: "sasensi",
    toggleLabel: "sasensi's repositories",
    state: "fine",
    cause: null,
    fix: null,
    // The person's own: SSO, suspended, gone; never an owner asked.
    labels: ["Sign in with SSO", "Unsuspend it on GitHub", "Install on sasensi"],
    count: "1 repository, reviewed",
    shows: null,
  });
});

test("a head's fix place holds a member's fixes on a member's account, and a long login at 16 characters", () => {
  const login = "northwind-platform-infrastructure-group";
  const state = signedIn(
    {
      accounts: [
        org("ledger-dev", null, false),
        org(login, { kind: "sso", organisation: login, url: null }, true, 33),
      ],
    },
    [repo("ledger-dev", "billing"), repo(login, "api-gateway")],
  );
  const [member, long] = repositoryGroups(state).map((g) => g.head);
  expect(member?.labels).toEqual(["Sign in with SSO", "Ask an owner of ledger-dev"]);
  // The label said is whole, cut with an ellipsis on the screen; its place holds the accounts list's 16 characters.
  expect(long?.labels).toEqual(["Sign in with SSO", "Unsuspend it on GitHub", "Install on northwind-platfo"]);
});

test("a group head says its account's cause and its one fix, the accounts list's", () => {
  const state = signedIn(
    {
      accounts: [
        { ...own, cause: { kind: "uninstalled", suspended: true } },
        org("ledger-dev", { kind: "sso", organisation: "ledger-dev", url: null }, false),
        org("ledger-ops", { kind: "uninstalled", suspended: true, suspendedBy: "mira" }, false, 33),
      ],
    },
    [repo("sasensi", "ledger-api"), repo("ledger-dev", "billing"), repo("ledger-ops", "deploy")],
  );
  const [mine, sso, suspended] = repositoryGroups(state).map((g) => g.head);
  expect(mine).toMatchObject({
    state: "needs-you",
    cause: "Suspended.",
    fix: { label: "Unsuspend it on GitHub", href: "https://github.com/settings/installations/11" },
  });
  expect(sso).toMatchObject({
    cause: "Asks you to sign in with SSO.",
    fix: { label: "Sign in with SSO", href: "https://github.com/orgs/ledger-dev/sso" },
  });
  expect(suspended).toMatchObject({
    cause: "Suspended by mira.",
    fix: {
      label: "Ask an owner of ledger-ops",
      href: "https://github.com/orgs/ledger-ops/people?query=role%3Aowner",
    },
  });
  // Only the line said: a head holds no other cause's.
  expect(suspended).not.toHaveProperty("held");
});

test("an account with no repository has no group; a repository on no account reached is grouped under its owner", () => {
  const state = signedIn({ accounts: [own, org("ledger-dev", null, true)] }, [
    repo("acme", "site"),
    repo("ledger-dev", "billing"),
  ]);
  expect(groups(state).map((g) => [g.key, g.head.cause, g.head.fix, g.repos])).toEqual([
    ["ledger-dev", null, null, ["ledger-dev/billing"]],
    ["acme", null, null, ["acme/site"]],
  ]);
  // Under its owner, no account reached: no fix can show, so its place holds none.
  expect(groups(state)[1]?.head.labels).toEqual([]);
});

// ---- The account's switch and count (ADR 0082) ----

const off = (owner: string, name: string): Repository => ({ ...repo(owner, name), enabled: false });

test("a group of two or more says how many of its repositories are reviewed, and has the account's switch", () => {
  const state = signedIn({ accounts: [own, org("fernhill", null, false)] }, [
    repo("fernhill", "api"),
    off("fernhill", "web"),
    repo("fernhill", "cli"),
    repo("sasensi", "ledger-api"),
    repo("sasensi", "dotfiles"),
  ]);
  const [mine, fernhill] = repositoryGroups(state);
  expect(fernhill).toMatchObject({ reviewed: 2, total: 3, allOn: false });
  expect(fernhill?.head.count).toBe("2 of 3 reviewed");
  // A mixed account's switch is off (`allOn`); it names every repository of the account.
  expect(fernhill?.control).toEqual({
    label: "Review every repository in fernhill",
    repoIds: [repositoryId("fernhill/api"), repositoryId("fernhill/web"), repositoryId("fernhill/cli")],
    command: {
      type: "repos.setEnabled",
      repoIds: [repositoryId("fernhill/api"), repositoryId("fernhill/web"), repositoryId("fernhill/cli")],
    },
  });
  expect(mine).toMatchObject({ reviewed: 2, total: 2, allOn: true });
  expect(mine?.head.count).toBe("All 2 reviewed");
});

test("an account with none reviewed says so, and its switch is off", () => {
  const state = signedIn({ accounts: [org("fernhill", null, false)] }, [
    off("fernhill", "api"),
    off("fernhill", "web"),
  ]);
  const [fernhill] = repositoryGroups(state);
  expect(fernhill).toMatchObject({ reviewed: 0, total: 2, allOn: false });
  expect(fernhill?.head.count).toBe("None of 2 reviewed");
});

test("a group's count is its own words, never held at every count its total can say (ADR 0086)", () => {
  const state = signedIn({ accounts: [org("fernhill", null, false)] }, [
    repo("fernhill", "api"),
    off("fernhill", "web"),
    repo("fernhill", "cli"),
  ]);
  expect(repositoryGroups(state)[0]?.head).not.toHaveProperty("counts");
});

test("a group of one has its count and the account's switch on its head, as every group (ADR 0083, round 4)", () => {
  const state = signedIn({ accounts: [own] }, [off("sasensi", "ledger-api")]);
  const [mine] = repositoryGroups(state);
  expect(mine).toMatchObject({ reviewed: 0, total: 1, allOn: false });
  // The account's switch, as on every head: its row keeps its own.
  expect(mine?.control).toEqual({
    label: "Review every repository in sasensi",
    repoIds: [repositoryId("sasensi/ledger-api")],
    command: { type: "repos.setEnabled", repoIds: [repositoryId("sasensi/ledger-api")] },
  });
  expect(mine?.head.count).toBe("1 repository, not reviewed");
});

test("the count and the switch are of the whole account, whatever the rows shown", () => {
  const state = signedIn({ accounts: [own, org("fernhill", null, false)] }, [
    repo("fernhill", "api"),
    off("fernhill", "web"),
    repo("fernhill", "cli"),
    repo("sasensi", "ledger-api"),
  ]);
  const onlyOff = (r: Repository) => !r.enabled;
  const shown = repositoryGroups(state, onlyOff);
  // A group with no row left is dropped; the others keep only their rows shown.
  expect(shown.map((g) => [g.key, g.repos.map((r) => r.name)])).toEqual([["fernhill", ["web"]]]);
  const [fernhill] = shown;
  expect(fernhill).toMatchObject({ reviewed: 2, total: 3, allOn: false });
  expect(fernhill?.head.count).toBe("2 of 3 reviewed");
  expect(fernhill?.control?.repoIds).toEqual([
    repositoryId("fernhill/api"),
    repositoryId("fernhill/web"),
    repositoryId("fernhill/cli"),
  ]);
});

// ---- Setup's Repositories step, grouped (ADR 0082) ----

test("setup's step lists the same groups as Repositories, each repository ticked from the step's choices", () => {
  const state = signedIn({ accounts: [own, org("fernhill", null, false)] }, [
    repo("fernhill", "api"),
    off("fernhill", "web"),
    repo("sasensi", "ledger-api"),
  ]);
  const unticked = new Map([[repositoryId("fernhill/api"), false]]);
  const steps = setupRepoGroups(state, unticked);
  expect(steps.map((g) => g.key)).toEqual(repositoryGroups(state).map((g) => g.key));
  expect(steps.map((g) => g.rows.map((r) => [r.repo.name, r.ticked]))).toEqual([
    [["ledger-api", true]],
    // Unticked here; off on the service and not ticked here.
    [
      ["api", false],
      ["web", false],
    ],
  ]);
});

test("an account's checkbox is ticked when all are, unticked when none, mixed when some", () => {
  const state = signedIn({ accounts: [org("fernhill", null, false)] }, [
    repo("fernhill", "api"),
    repo("fernhill", "web"),
    repo("fernhill", "cli"),
  ]);
  const [api, web, cli] = [
    repositoryId("fernhill/api"),
    repositoryId("fernhill/web"),
    repositoryId("fernhill/cli"),
  ];
  const ticked = (...unticked: RepositoryId[]) =>
    setupRepoGroups(state, new Map(unticked.map((id) => [id, false])))[0]?.ticked;
  expect(ticked()).toBe("all");
  expect(ticked(web)).toBe("some");
  expect(ticked(api, web, cli)).toBe("none");
  expect(setupRepoGroups(state, new Map())[0]?.control).toEqual({
    label: "Review every repository in fernhill",
    repoIds: [api, web, cli],
    command: { type: "repos.setEnabled", repoIds: [api, web, cli] },
  });
});

test("setup's step says each account's size, each repository's open pull requests, and names each in full", () => {
  const base = signedIn({ accounts: [own, org("fernhill", null, false)] }, [
    repo("fernhill", "api"),
    repo("fernhill", "web"),
    repo("sasensi", "api"),
  ]);
  const opened = (n: number, repoId: RepositoryId): Change => ({
    id: changeId(`${repoId}#${n}`),
    repoId,
    number: n,
    title: `Change ${n}`,
    openedBy: "sasensi",
    author: "agent",
    writtenBy: "claude",
    headSha: commitSha("a1f9c2e"),
    openedAt: NOW,
    draft: false,
    fork: false,
    newCommits: 0,
  });
  const fernhillApi = repositoryId("fernhill/api");
  const mineApi = repositoryId("sasensi/api");
  const state: State = {
    ...base,
    changes: Object.fromEntries(
      [opened(1, fernhillApi), opened(2, fernhillApi), opened(3, mineApi)].map((c) => [c.id, c]),
    ),
  };
  const said = setupRepoGroups(state, new Map()).map((g) => [
    g.size,
    g.rows.map((r) => [r.open, r.zero, r.label]),
  ]);
  // Repositories' words, "2 open", zero said and told apart; the box's name says it in full.
  expect(said).toEqual([
    ["1 repository", [["1 open", false, "sasensi/api, 1 open pull request"]]],
    [
      "2 repositories",
      [
        ["2 open", false, "fernhill/api, 2 open pull requests"],
        ["0 open", true, "fernhill/web, 0 open pull requests"],
      ],
    ],
  ]);
});

test("a group of one has no account checkbox in setup", () => {
  const [mine] = setupRepoGroups(signedIn({ accounts: [own] }, [repo("sasensi", "ledger-api")]), new Map());
  expect(mine?.control).toBeNull();
});

test("ticking an account sets each of its repositories' choices, and leaves the others'", () => {
  const state = signedIn({ accounts: [own, org("fernhill", null, false)] }, [
    repo("fernhill", "api"),
    repo("fernhill", "web"),
    repo("sasensi", "ledger-api"),
  ]);
  const [api, web, mine] = [
    repositoryId("fernhill/api"),
    repositoryId("fernhill/web"),
    repositoryId("sasensi/ledger-api"),
  ];
  const mixed = new Map([
    [web, false],
    [mine, false],
  ]);
  const fernhill = setupRepoGroups(state, mixed)[1];
  const repoIds = fernhill?.control?.repoIds ?? [];
  // A mixed account's checkbox ticks them all.
  const all = tickAccount(mixed, repoIds, true);
  expect(chosenRepos(state.repos, all)).toEqual([api, web]);
  expect(setupRepoGroups(state, all)[1]?.ticked).toBe("all");
  // Ticked, it unticks them all.
  const none = tickAccount(all, repoIds, false);
  expect(chosenRepos(state.repos, none)).toEqual([]);
  expect(setupRepoGroups(state, none)[1]?.ticked).toBe("none");
  // The choices given are not changed.
  expect([...mixed]).toEqual([
    [web, false],
    [mine, false],
  ]);
});

// ---- Add a repository, Add it back ----

const departed = (owner: string, name: string): DepartedRepository => ({
  id: repositoryId(`${owner}/${name}`),
  owner,
  name,
  at: NOW,
});

const GONE = { kind: "uninstalled", suspended: false } as const;
const SUSPENDED = { kind: "uninstalled", suspended: true } as const;

test("Add a repository on the shared App: the installation's settings when exactly one account is the person's and installed", () => {
  const { connection } = signedIn({ accounts: [org("ledger-dev", null, false), own] });
  expect(addRepositoryLink(connection)).toBe("https://github.com/settings/installations/11");
  // A suspended installation is still there: its settings list its repositories.
  const suspended = signedIn({ accounts: [org("ledger-dev", null, null), { ...own, cause: SUSPENDED }] });
  expect(addRepositoryLink(suspended.connection)).toBe("https://github.com/settings/installations/11");
  // The person's own account no longer installed: the one left that they own and is installed.
  const gone = signedIn({ accounts: [{ ...own, cause: GONE }, org("ledger-dev", null, true, 22)] });
  expect(addRepositoryLink(gone.connection)).toBe(
    "https://github.com/organizations/ledger-dev/settings/installations/22",
  );
});

test("Add a repository on the shared App with two accounts the person owns, or none installed: GitHub's install page", () => {
  const two = signedIn({ accounts: [org("ledger-dev", null, true, 22), own] }).connection;
  expect(addRepositoryLink(two)).toBe(INSTALL);
  const gone = signedIn({ accounts: [{ ...own, cause: GONE }, org("ledger-dev", null, false)] }).connection;
  expect(addRepositoryLink(gone)).toBe(INSTALL);
});

test("Add a repository on the shared App with no account reached the person owns: GitHub's install page", () => {
  expect(addRepositoryLink(signedIn({ accounts: [org("ledger-dev", null, null)] }).connection)).toBe(INSTALL);
  expect(addRepositoryLink(signedIn().connection)).toBe(INSTALL);
  expect(addRepositoryLink(signedIn({ web: DEMO_API.github }).connection)).toBe(
    `${DEMO_API.github}/apps/lookover-dev/installations/new`,
  );
});

test("Add a repository on the shared App is hidden while nobody is signed in to it", () => {
  const signedOut = signedIn({
    state: "disconnected",
    cause: { kind: "signed-out" },
    accounts: [own],
  }).connection;
  expect(addRepositoryLink(signedOut)).toBeNull();
  expect(addRepositoryLink(signedIn({ person: null, accounts: [] }).connection)).toBeNull();
});

test("Add it back on the shared App: its account's installation settings when the person owns it, else GitHub's install page", () => {
  const { connection } = signedIn({ accounts: [own, org("ledger-dev", null, false)] });
  expect(departedNotice(connection, departed("sasensi", "ledger-api")).addBack).toBe(
    "https://github.com/settings/installations/11",
  );
  expect(departedNotice(connection, departed("ledger-dev", "billing")).addBack).toBe(INSTALL);
  // Its account no longer reached: GitHub's page lists every account.
  expect(departedNotice(connection, departed("acme", "site")).addBack).toBe(INSTALL);
});

test("Add it back on the shared App: GitHub's install page when its account is no longer installed, its settings when suspended", () => {
  const gone = signedIn({ accounts: [{ ...own, cause: GONE }] }).connection;
  expect(departedNotice(gone, departed("sasensi", "ledger-api")).addBack).toBe(INSTALL);
  const suspended = signedIn({ accounts: [{ ...own, cause: SUSPENDED }] }).connection;
  expect(departedNotice(suspended, departed("sasensi", "ledger-api")).addBack).toBe(
    "https://github.com/settings/installations/11",
  );
  // Two accounts the person owns: Add it back still names its own.
  const two = signedIn({ accounts: [own, org("ledger-dev", null, true, 22)] }).connection;
  expect(departedNotice(two, departed("ledger-dev", "billing")).addBack).toBe(
    "https://github.com/organizations/ledger-dev/settings/installations/22",
  );
});

const NOW_PR = Date.UTC(2026, 10, 7, 10, 0, 0);

test("Repositories' Pull requests cell: the count, zero included and told apart, then the last review", () => {
  expect(pullRequestsCell({ enabled: true, open: 2, lastAt: NOW_PR - 3 * MIN }, NOW_PR)).toEqual({
    on: true,
    open: "2 open",
    zero: false,
    last: "last review 3 min ago",
  });
  // Zero is data: said in the same place and words as two, muted by `zero`; a dash or a blank read as missing.
  expect(pullRequestsCell({ enabled: true, open: 0, lastAt: NOW_PR - 3 * MIN }, NOW_PR)).toEqual({
    on: true,
    open: "0 open",
    zero: true,
    last: "last review 3 min ago",
  });
  expect(pullRequestsCell({ enabled: true, open: 0, lastAt: null }, NOW_PR)).toEqual({
    on: true,
    open: "0 open",
    zero: true,
    last: null,
  });
  expect(pullRequestsCell({ enabled: false, open: 4, lastAt: null }, NOW_PR)).toEqual({
    on: false,
    text: "not reviewed",
  });
});

test("a repository's page says whether it is reviewed, its open pull requests and its last review, dots held", () => {
  expect(repositoryStanding({ enabled: true, open: 1, lastAt: NOW_PR - 3 * MIN }, NOW_PR)).toBe(
    ["Reviewing", "1 open pull request", "last review 3 min ago"].join(SEPARATOR),
  );
  expect(repositoryStanding({ enabled: true, open: 0, lastAt: null }, NOW_PR)).toBe(
    ["Reviewing", "no open pull requests"].join(SEPARATOR),
  );
  expect(repositoryStanding({ enabled: false, open: 3, lastAt: null }, NOW_PR)).toBe(
    ["Off", "pull requests here are not reviewed"].join(SEPARATOR),
  );
});
