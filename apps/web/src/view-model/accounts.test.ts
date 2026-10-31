// What the accounts list says on the shared App (ADR 0067), for a given snapshot: each account reached with its
// repositories or its cause and its one fix, each account not reached with Install on or Ask to install on, each asked
// one waiting for an owner, and Install on another account last. Snapshots are built by hand: the view model reads
// state only.
import { expect, test } from "bun:test";
import {
  type Connection,
  type ConnectionAccount,
  type ConnectionApp,
  connectionId,
  DEMO_API,
  type DepartedRepository,
  type Engine,
  type EngineId,
  GITHUB_WEB,
  type Repository,
  type ResolvedSettings,
  repositoryId,
  type State,
  type UnreachedAccount,
} from "@lookover/contracts";
import { ACCOUNT_FIX_LABELS, accountRows, repositoryGroups } from "./accounts.ts";
import { addRepositoryLink, departedNotice } from "./onboarding.ts";

/** 2026-10-30 10:00 UTC; times are said in UTC here. */
const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const MIN = 60_000;
const UTC = "UTC";
const INSTALL = "https://github.com/apps/lookover-dev/installations/new";
/** What a reached row's detail holds besides its own: no repository, then every cause. */
const REACHED_HELD = [
  "No repository yet.",
  "Asks you to sign in with SSO.",
  "Suspended.",
  "No longer installed.",
];

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
      githubRefused: null,
      firstReviewChange: null,
    },
    engines: { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") },
    connection: {
      id: connectionId("github:sasensi"),
      state: "connected",
      cause: null,
      way: "shared",
      signIn: null,
      person: { id: 1, login: "sasensi" },
      bot: null,
      app: null,
      accounts: [],
      unreached: [],
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
      gh: null,
      ...connection,
    },
    service: {
      state: "running",
      since: NOW,
      version: "0.1.0",
      command: "lookover",
      agent: { path: { reach: "no", folder: "~/.local/bin" }, offer: "binary", skills: [] },
      startAtLogin: true,
      startsAtLogin: true,
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
      details: ["GitHub's page lists every account you belong to."],
      fix: { label: "Install on another account", href: INSTALL },
      again: null,
      asks: false,
    },
  ]);
});

test("no list before a sign-in, once signed out, and on your own App", () => {
  expect(rows(signedIn({ way: null, state: "not-connected", person: null }))).toEqual([]);
  expect(rows(signedIn({ state: "disconnected", cause: { kind: "signed-out" }, accounts: [own] }))).toEqual(
    [],
  );
  expect(
    rows(
      signedIn({ way: "own", person: null, bot: "sam-reviewer[bot]", accounts: [{ ...own, owner: null }] }),
    ),
  ).toEqual([]);
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
    details: ["2 repositories.", ...REACHED_HELD],
    fix: null,
    again: null,
    asks: false,
  });
  expect(row(state, "Ledger-Dev")?.detail).toBe("1 repository.");
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
    details: REACHED_HELD,
    fix: { label: "Choose repositories", href: "https://github.com/settings/installations/11" },
    again: null,
    asks: false,
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
    // Its own line first, then the others a reached row holds.
    details: ["Asks you to sign in with SSO.", "No repository yet.", "Suspended.", "No longer installed."],
    fix: { label: "Sign in with SSO", href: "https://github.com/orgs/ledger-dev/sso" },
    again: null,
    asks: false,
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
    details: ["Not installed."],
    fix: { label: "Install on sasensi", href: INSTALL },
    again: null,
    asks: false,
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
      details: [
        "Not installed. On GitHub, you ask its owners to install it.",
        `Waiting for an owner of ${login}, asked at 10:00. If you sent the request, GitHub emailed its owners.`,
      ],
      fix: {
        label: `Ask to install on ${login}`,
        href: INSTALL,
        command: { type: "connection.askToInstall", account: login },
      },
      again: null,
      asks: true,
    });
});

test("asked: waiting for an owner, since when, hedged; ask an owner, and GitHub's page again", () => {
  const state = signedIn({ unreached: [unreached("ledger-labs", false, NOW - 25 * MIN)] });
  expect(row(state, "ledger-labs")).toEqual({
    key: "ledger-labs",
    account: "ledger-labs",
    name: "ledger-labs",
    state: "waiting",
    detail:
      "Waiting for an owner of ledger-labs, asked at 09:35. If you sent the request, GitHub emailed its owners.",
    details: [
      "Waiting for an owner of ledger-labs, asked at 09:35. If you sent the request, GitHub emailed its owners.",
      "Not installed. On GitHub, you ask its owners to install it.",
      "Waiting for an owner of ledger-labs, asked at 10:00. If you sent the request, GitHub emailed its owners.",
    ],
    fix: {
      label: "Ask an owner of ledger-labs",
      href: "https://github.com/orgs/ledger-labs/people?query=role%3Aowner",
    },
    again: {
      label: "Ask again",
      href: INSTALL,
      command: { type: "connection.askToInstall", account: "ledger-labs" },
    },
    asks: true,
  });
  const yesterday = signedIn({ unreached: [unreached("ledger-labs", false, NOW - 20 * 60 * MIN)] });
  expect(row(yesterday, "ledger-labs")?.detail).toBe(
    "Waiting for an owner of ledger-labs, asked on Thu 29 Oct at 14:00. If you sent the request, GitHub emailed its owners.",
  );
});

// ---- held ----

test("the fix's place is as wide as one list of labels: an organisation arriving later moves no row above it", () => {
  // Wide enough for every label that names no account, and for one naming a login of a usual length.
  for (const label of [
    "Unsuspend it on GitHub",
    "Sign in with SSO",
    "Choose repositories",
    "Install on another account",
  ])
    expect(ACCOUNT_FIX_LABELS).toContain(label);
  expect(
    ACCOUNT_FIX_LABELS.some(
      (l) => l.startsWith("Ask to install on ") && l.length >= "Ask to install on ".length + 16,
    ),
  ).toBe(true);
  // Ask again keeps its own place.
  expect(ACCOUNT_FIX_LABELS).not.toContain("Ask again");
});

test("every detail a row can show, so a state changing in place moves nothing", () => {
  const list = accountRows(signedIn({ accounts: [own], unreached: [unreached("ledger-labs", false)] }), {
    timeZone: UTC,
  });
  for (const r of list.rows) expect(r.details).toContain(r.detail);
  expect(list.rows.find((r) => r.key === "ledger-labs")?.details).toContain(
    "Waiting for an owner of ledger-labs, asked at 10:00. If you sent the request, GitHub emailed its owners.",
  );
});

test("a row holds only what its own place in the list can say: reached rows aren't as tall as a waiting line", () => {
  const list = accountRows(
    signedIn({ accounts: [own], unreached: [unreached("ledger-labs", false), unreached("ledger-hq", true)] }),
    { timeZone: UTC },
  );
  // Reached, listed first: its repositories or its cause, never a line of an account not reached (which an account
  // reached only becomes by moving to the list's other part).
  const details = (key: string) => list.rows.find((r) => r.key === key)?.details;
  for (const line of details("sasensi") ?? []) expect(line).not.toMatch(/^Not installed|^Waiting/);
  expect(details("sasensi")).toContain("Asks you to sign in with SSO.");
  // Not reached, a member's: asked or waiting; never a reached account's cause.
  expect(details("ledger-labs")).toEqual([
    "Not installed. On GitHub, you ask its owners to install it.",
    "Waiting for an owner of ledger-labs, asked at 10:00. If you sent the request, GitHub emailed its owners.",
  ]);
  // Not reached, theirs: Install on it is all it offers, so it never waits for an owner.
  expect(details("ledger-hq")).toEqual(["Not installed."]);
});

test("only a member's account not reached keeps Ask again's place: no other row can wait for an owner", () => {
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
  expect(Object.fromEntries(list.rows.map((r) => [r.key, r.asks]))).toEqual({
    sasensi: false,
    "ledger-labs": true,
    "ledger-ops": true,
    "ledger-hq": false,
    another: false,
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
  expect(groups(state).map((g) => [g.key, g.head?.account, g.repos])).toEqual([
    ["sasensi", "sasensi", ["sasensi/ledger-api"]],
    // The account as GitHub writes it, its repositories in Repositories' order.
    ["Ledger-Dev", "Ledger-Dev", ["ledger-dev/billing", "ledger-dev/ledger-web"]],
  ]);
});

test("a group head with no cause says nothing more, and keeps every cause line's place and every fix's", () => {
  const [head] = repositoryGroups(signedIn({ accounts: [own] }, [repo("sasensi", "ledger-api")])).map(
    (g) => g.head,
  );
  expect(head).toEqual({
    account: "sasensi",
    state: "fine",
    cause: "",
    held: ["", "Asks you to sign in with SSO.", "Suspended.", "No longer installed."],
    fix: null,
    labels: ["Sign in with SSO", "Unsuspend it on GitHub", "Install on sasensi", "Ask an owner of sasensi"],
  });
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
  // The line said is held with the others: a cause coming or going moves nothing.
  expect(suspended?.held).toEqual([
    "",
    "Asks you to sign in with SSO.",
    "Suspended.",
    "No longer installed.",
    "Suspended by mira.",
  ]);
});

test("an account with no repository has no group; a repository on no account reached is grouped under its owner", () => {
  const state = signedIn({ accounts: [own, org("ledger-dev", null, true)] }, [
    repo("acme", "site"),
    repo("ledger-dev", "billing"),
  ]);
  expect(groups(state).map((g) => [g.key, g.head?.cause, g.head?.fix, g.repos])).toEqual([
    ["ledger-dev", "", null, ["ledger-dev/billing"]],
    ["acme", "", null, ["acme/site"]],
  ]);
});

test("on your own App, one group without a head", () => {
  const state = signedIn(
    { way: "own", person: null, bot: "sam-reviewer[bot]", accounts: [{ ...own, owner: null }] },
    [repo("sasensi", "ledger-api"), repo("sasensi", "billing")],
  );
  expect(groups(state)).toEqual([
    { key: "all", head: null, repos: ["sasensi/ledger-api", "sasensi/billing"] },
  ]);
  expect(repositoryGroups(signedIn({ way: "own", person: null }))).toEqual([]);
});

// ---- Add a repository, Add it back ----

const ownApp: ConnectionApp = {
  id: 9,
  slug: "lookover-q7x2ka",
  account: { id: 1, login: "sasensi", type: "User" },
  person: { id: 1, login: "sasensi" },
};

/** sasensi on their own App, installed on their account. */
const onOwnApp = () =>
  signedIn({ way: "own", person: null, app: ownApp, accounts: [{ ...own, owner: null }] }).connection;

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

test("Add a repository on your own App: its installation's settings, as before", () => {
  expect(addRepositoryLink(onOwnApp())).toBe("https://github.com/settings/installations/11");
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

test("Add it back on your own App: its installation's settings, as before", () => {
  expect(departedNotice(onOwnApp(), departed("sasensi", "x")).addBack).toBe(
    "https://github.com/settings/installations/11",
  );
});
