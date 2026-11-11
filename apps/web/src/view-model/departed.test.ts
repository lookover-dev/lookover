// Departed repositories said by how they went (ADR 0082): an account gone, while the connection is up, is one No
// access notice with the accounts list's fix for it; the rest are quiet, one alone or, from two up, the summary, held
// a summary down to one while the app is open. Snapshots are built by hand: the view model reads state only.
import { expect, test } from "bun:test";
import {
  type Connection,
  type ConnectionAccount,
  type DepartedRepository,
  repositoryId,
  type State,
  type UnreachedAccount,
} from "@lookover/contracts";
import { repo, world } from "../screens/repositories.test-support.tsx";
import { departedSaid, departedShown, LeftSummary } from "./departed.ts";

const INSTALL = "https://github.com/apps/lookover-dev/installations/new";

const departed = (owner: string, name: string): DepartedRepository => ({
  id: repositoryId(`${owner}/${name}`),
  owner,
  name,
  at: 0,
});

const org = (login: string, cause: ConnectionAccount["cause"] = null): ConnectionAccount => ({
  account: { id: 400 + login.length, login, type: "Organization" },
  installationId: 40 + login.length,
  cause,
  owner: true,
  granted: [],
});

const unreached = (
  login: string,
  owner: boolean | null,
  askedAt: number | null = null,
): UnreachedAccount => ({
  account: { id: 500 + login.length, login },
  kind: "organisation",
  owner,
  askedAt,
});

/** sasensi and fernhill reached, fernhill's api and cli watched; `gone` departed, the connection over `connection`. */
function at(gone: DepartedRepository[], connection: Partial<Connection> = {}): State {
  const state = world([repo("sasensi", "ledger-api"), repo("fernhill", "api"), repo("fernhill", "cli")]);
  return { ...state, departed: gone, connection: { ...state.connection, ...connection } };
}

/** fernhill's two gone from its installation, ledger-labs' two with the account. */
const MIXED = [
  departed("fernhill", "legacy-portal"),
  departed("ledger-labs", "ledger-sdk"),
  departed("fernhill", "onboarding"),
  departed("ledger-labs", "ledger-cli"),
];

test("connected: an account no longer reached with nothing left watched is one No access notice; the rest are quiet", () => {
  const said = departedSaid(at(MIXED, { unreached: [unreached("ledger-labs", true)] }));
  expect(said.gone).toEqual([
    {
      key: "ledger-labs",
      label: "No access",
      text: "Lookover no longer has access to ledger-labs. Its 2 repositories are no longer reviewed.",
      repoIds: [repositoryId("ledger-labs/ledger-sdk"), repositoryId("ledger-labs/ledger-cli")],
      fix: { label: "Install on ledger-labs", href: INSTALL, command: { type: "connection.look" } },
    },
  ]);
  expect(said.quiet.map((r) => String(r.id))).toEqual(["fernhill/legacy-portal", "fernhill/onboarding"]);
});

test("one repository of an account gone: its one repository said so", () => {
  const said = departedSaid(at([departed("ledger-labs", "ledger-sdk")]));
  expect(said.gone.map((g) => g.text)).toEqual([
    "Lookover no longer has access to ledger-labs. Its repository is no longer reviewed.",
  ]);
});

test("the connection down, uninstalled everywhere or signed out: every departed repository is quiet, the band speaks", () => {
  for (const cause of [{ kind: "uninstalled", suspended: false }, { kind: "signed-out" }] as const) {
    const said = departedSaid(at(MIXED, { state: "disconnected", cause, accounts: [] }));
    expect(said.gone).toEqual([]);
    expect(said.quiet).toHaveLength(4);
  }
  // GitHub unreachable: the band waits, nothing is said gone.
  expect(departedSaid(at(MIXED, { state: "disconnected", cause: { kind: "unreachable" } })).gone).toEqual([]);
});

test("a suspended account, or one with a cause, keeps its repositories: never gone, whatever departed of it", () => {
  for (const cause of [
    { kind: "uninstalled", suspended: true },
    { kind: "uninstalled", suspended: false },
    { kind: "sso", organisation: "ledger-labs", url: null },
  ] as const) {
    const base = at([departed("ledger-labs", "ledger-sdk")]);
    const state = {
      ...base,
      repos: [...base.repos, repo("ledger-labs", "ledger-cli")],
      connection: { ...base.connection, accounts: [...base.connection.accounts, org("ledger-labs", cause)] },
    };
    expect(departedSaid(state).gone).toEqual([]);
    // Even with none of its repositories watched any more, it is still reached.
    expect(departedSaid({ ...state, repos: base.repos }).gone).toEqual([]);
  }
});

test("an account still reached whose every repository departed is quiet", () => {
  const base = at([departed("ledger-dev", "ledger-docs"), departed("ledger-dev", "ledger-ui")]);
  const state = {
    ...base,
    connection: { ...base.connection, accounts: [...base.connection.accounts, org("ledger-dev")] },
  };
  const said = departedSaid(state);
  expect(said.gone).toEqual([]);
  expect(said.quiet).toHaveLength(2);
});

test("an account not reached with one of its repositories still watched is not gone: the rest of it is quiet", () => {
  const base = at([departed("acme", "site")]);
  expect(departedSaid({ ...base, repos: [...base.repos, repo("acme", "web")] }).gone).toEqual([]);
});

test("No access's fix is the accounts list's for that login: owner, member, asked; else Install on", () => {
  const fixOf = (u: UnreachedAccount[]) =>
    departedSaid(at([departed("ledger-labs", "ledger-sdk")], { unreached: u })).gone[0]?.fix;
  expect(fixOf([unreached("ledger-labs", true)])).toEqual({
    label: "Install on ledger-labs",
    href: INSTALL,
    command: { type: "connection.look" },
  });
  expect(fixOf([unreached("ledger-labs", false)])).toEqual({
    label: "Ask to install on ledger-labs",
    href: INSTALL,
    command: { type: "connection.askToInstall", account: "ledger-labs" },
  });
  expect(fixOf([unreached("ledger-labs", null, 1)])).toEqual({
    label: "Ask an owner of ledger-labs",
    href: "https://github.com/orgs/ledger-labs/people?query=role%3Aowner",
  });
  // Not named by `gh` at all: Install on, GitHub's page lists every account.
  expect(fixOf([])).toEqual({
    label: "Install on ledger-labs",
    href: INSTALL,
    command: { type: "connection.look" },
  });
});

test("the quiet ones: none, one alone, from two up the summary, one sentence, with the ids it shows", () => {
  const quiet = (gone: DepartedRepository[], held = false) => departedShown(at(gone), held).quiet;
  expect(quiet([])).toEqual({ kind: "none" });
  expect(quiet([departed("fernhill", "docs")])).toMatchObject({
    kind: "one",
    repo: { id: repositoryId("fernhill/docs") },
  });
  expect(quiet([departed("fernhill", "docs"), departed("fernhill", "web")])).toEqual({
    kind: "summary",
    summary: "2 repositories left the App's installation.",
    toggle: {
      show: "Show",
      hide: "Hide",
      showName: "Show the 2 repositories",
      hideName: "Hide the 2 repositories",
    },
    lines: [
      { id: repositoryId("fernhill/docs"), name: "fernhill/docs", dismiss: "Dismiss fernhill/docs" },
      { id: repositoryId("fernhill/web"), name: "fernhill/web", dismiss: "Dismiss fernhill/web" },
    ],
    repoIds: [repositoryId("fernhill/docs"), repositoryId("fernhill/web")],
  });
  // Held a summary: one left is still said as one.
  expect(quiet([departed("fernhill", "docs")], true)).toMatchObject({
    kind: "summary",
    summary: "1 repository left the App's installation.",
    toggle: {
      show: "Show",
      hide: "Hide",
      showName: "Show the repository",
      hideName: "Hide the repository",
    },
  });
  expect(quiet([], true)).toEqual({ kind: "none" });
});

test("the summary, once shown, is held down to one while the app is open; none left lets it go", () => {
  const summary = new LeftSummary();
  const two = at([departed("fernhill", "docs"), departed("fernhill", "web")]);
  const one = at([departed("fernhill", "docs")]);
  summary.see(one);
  expect(summary.get()).toBe(false);
  summary.see(two);
  expect(summary.get()).toBe(true);
  summary.see(one);
  expect(summary.get()).toBe(true);
  summary.see(at([]));
  expect(summary.get()).toBe(false);
  summary.see(one);
  expect(summary.get()).toBe(false);
  // An account gone counts nothing quiet.
  summary.see(at([departed("ledger-labs", "a"), departed("ledger-labs", "b")]));
  expect(summary.get()).toBe(false);
});
