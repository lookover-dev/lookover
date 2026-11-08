// Repositories' search and filter (design-system.md "Repositories' search and filter", ADR 0082): shown once more than
// ten repositories are watched and kept while the app is open; the groups a search and a filter leave, in order, the
// empty ones dropped; applied when the person changes them, so a row switched under a filter stays.
import { expect, test } from "bun:test";
import {
  connectionId,
  type DepartedRepository,
  GITHUB_WEB,
  type Repository,
  type RepositoryId,
  type ResolvedSettings,
  repositoryId,
  type State,
} from "@lookover/contracts";
import { CollapsedGroups } from "./collapsed.ts";
import { chosenRepos } from "./onboarding.ts";
import { RepositoriesBar, RepositoriesChoice, repositoriesList, setupRepoList } from "./repositories.ts";

const NOW = Date.UTC(2026, 10, 7, 10, 0, 0);

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

const repo = (owner: string, name: string, enabled = true): Repository => ({
  id: repositoryId(`${owner}/${name}`),
  owner,
  name,
  enabled,
  settings: DEFAULTS,
});

const gone = (owner: string, name: string): DepartedRepository => ({
  id: repositoryId(`${owner}/${name}`),
  owner,
  name,
  at: NOW,
});

/** sasensi signed in with sasensi, Fernhill and ledger-dev reached, watching `repos`. */
function world(repos: Repository[], departed: DepartedRepository[] = []): State {
  const engine = {
    cli: "",
    version: null,
    state: "ready" as const,
    detail: "",
    unusable: null,
    since: NOW,
    limitUntil: null,
    signingIn: false,
  };
  const account = (id: number, login: string) => ({
    account: { id, login, type: "Organization" as const },
    installationId: id + 10,
    cause: null,
    owner: true,
  });
  return {
    seq: 0,
    now: NOW,
    setup: { done: true, step: "background", reached: "background", github: "done", firstReviewChange: null },
    engines: {
      claude: { ...engine, id: "claude", name: "Claude" },
      codex: { ...engine, id: "codex", name: "Codex" },
    },
    connection: {
      id: connectionId("github:sasensi"),
      state: "connected",
      cause: null,
      signIn: null,
      person: { id: 1, login: "sasensi" },
      // GitHub writes Fernhill with a capital; its repositories' owner is in lower case.
      accounts: [account(1, "sasensi"), account(2, "Fernhill"), account(3, "ledger-dev")],
      unreached: [],
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
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
    departed,
    rules: [],
    changes: {},
    reviews: {},
  };
}

/** Eleven watched: sasensi's two, Fernhill's six (web and site off), ledger-dev's three. */
const ELEVEN = [
  repo("sasensi", "ledger-api"),
  repo("sasensi", "dotfiles"),
  repo("fernhill", "api"),
  repo("fernhill", "web", false),
  repo("fernhill", "cli"),
  repo("fernhill", "site", false),
  repo("fernhill", "infra"),
  repo("fernhill", "docs"),
  repo("ledger-dev", "billing"),
  repo("ledger-dev", "ledger-web"),
  repo("ledger-dev", "ledger-docs"),
];

/** What the list shows: each group's account, its rows and its count. */
const shown = (state: State, choice: RepositoriesChoice) =>
  repositoriesList(state, choice.get(), new Map()).groups.map(({ group }) => [
    group.key,
    group.repos.map((r) => r.name),
    group.head.count,
  ]);

/** Whether the bar shows on a latch that saw `states` one after the other, as the store takes them. */
const barAfter = (...states: State[]): boolean => {
  const bar = new RepositoriesBar();
  for (const s of states) bar.see(s);
  return bar.get();
};

test("the search and the filter show once more than ten repositories are watched, departed ones not counted", () => {
  const ten = ELEVEN.slice(0, 10);
  expect(barAfter(world(ten))).toBe(false);
  expect(barAfter(world(ten, [gone("fernhill", "legacy"), gone("fernhill", "old")]))).toBe(false);
  expect(barAfter(world(ELEVEN))).toBe(true);
});

test("once shown, the search and the filter are never taken away while the app is open", () => {
  // Two leave the App's installation: nine are left, the bar stays.
  expect(barAfter(world(ELEVEN), world(ELEVEN.slice(0, 9)))).toBe(true);
});

test("the bar's latch tells its listeners once, when the bar first shows", () => {
  const bar = new RepositoriesBar();
  let told = 0;
  bar.subscribe(() => {
    told++;
  });
  bar.see(world(ELEVEN.slice(0, 9)));
  bar.see(world(ELEVEN));
  bar.see(world(ELEVEN));
  expect(told).toBe(1);
});

test("the Off filter keeps the groups' order and drops the groups with nothing off; the counts stay the account's", () => {
  const state = world(ELEVEN);
  const choice = new RepositoriesChoice();
  choice.filter(state, "off");
  expect(shown(state, choice)).toEqual([["Fernhill", ["web", "site"], "4 of 6 reviewed"]]);
  choice.filter(state, "reviewing");
  expect(shown(state, choice)).toEqual([
    ["sasensi", ["ledger-api", "dotfiles"], "All 2 reviewed"],
    ["Fernhill", ["api", "cli", "infra", "docs"], "4 of 6 reviewed"],
    ["ledger-dev", ["billing", "ledger-web", "ledger-docs"], "All 3 reviewed"],
  ]);
});

test("the search matches the repository's name and its account's, in any case", () => {
  const state = world(ELEVEN);
  const choice = new RepositoriesChoice();
  choice.search(state, "DOCS");
  expect(shown(state, choice)).toEqual([
    ["Fernhill", ["docs"], "4 of 6 reviewed"],
    ["ledger-dev", ["ledger-docs"], "All 3 reviewed"],
  ]);
  choice.search(state, "  fernHILL ");
  expect(shown(state, choice).map(([key, names]) => [key, names])).toEqual([
    ["Fernhill", ["api", "web", "cli", "site", "infra", "docs"]],
  ]);
  // The search and the filter together.
  choice.filter(state, "off");
  expect(shown(state, choice).map(([key, names]) => [key, names])).toEqual([["Fernhill", ["web", "site"]]]);
});

test("nothing left says All reviews' empty line", () => {
  const state = world(ELEVEN);
  const choice = new RepositoriesChoice();
  expect(repositoriesList(state, choice.get(), new Map()).empty).toBeNull();
  choice.search(state, "nowhere");
  const list = repositoriesList(state, choice.get(), new Map());
  expect(list.groups).toEqual([]);
  expect(list.empty).toEqual({ title: "No repository here", text: "Nothing matches this search or filter." });
});

test("nothing watched, with no search and All: no empty line, no search or filter to blame", () => {
  const list = repositoriesList(world([]), new RepositoriesChoice().get(), new Map());
  expect(list.groups).toEqual([]);
  expect(list.empty).toBeNull();
});

test("an option with nothing behind it is dimmed in place; All and the pressed one never are", () => {
  const allOn = world(ELEVEN.map((r) => ({ ...r, enabled: true })));
  const choice = new RepositoriesChoice();
  expect(repositoriesList(allOn, choice.get(), new Map()).options).toEqual([
    { value: "all", label: "All", disabled: false },
    { value: "reviewing", label: "Reviewing", disabled: false },
    { value: "off", label: "Off", disabled: true },
  ]);
  // Every repository switched on while Off is pressed: Off stays pickable, its list empty.
  const state = world(ELEVEN);
  choice.filter(state, "off");
  expect(repositoriesList(allOn, choice.get(), new Map()).options[2]).toEqual({
    value: "off",
    label: "Off",
    disabled: false,
  });
  // A search never changes what can be picked.
  choice.filter(state, "all");
  choice.search(state, "fernhill/web");
  expect(repositoriesList(state, choice.get(), new Map()).options.map((o) => o.disabled)).toEqual([
    false,
    false,
    false,
  ]);
});

test("a row switched under a filter stays until the search or the filter changes", () => {
  const before = world(ELEVEN);
  const choice = new RepositoriesChoice();
  choice.filter(before, "off");
  // fernhill/web switched on: still listed under Off, its head's count moved.
  const after = world(ELEVEN.map((r) => (r.name === "web" ? { ...r, enabled: true } : r)));
  expect(shown(after, choice)).toEqual([["Fernhill", ["web", "site"], "5 of 6 reviewed"]]);
  // The search changes: the filter applies again.
  choice.search(after, "f");
  expect(shown(after, choice)).toEqual([["Fernhill", ["site"], "5 of 6 reviewed"]]);
  // So does a filter picked again.
  const later = world(after.repos.map((r) => (r.name === "billing" ? { ...r, enabled: false } : r)));
  expect(shown(later, choice)).toEqual([["Fernhill", ["site"], "5 of 6 reviewed"]]);
  choice.search(later, "");
  choice.filter(later, "off");
  expect(shown(later, choice).map(([key, names]) => [key, names])).toEqual([
    ["Fernhill", ["site"]],
    ["ledger-dev", ["billing"]],
  ]);
});

test("a repository leaving while the rows are held under a filter leaves its row, and its group once empty", () => {
  const state = world(ELEVEN);
  const choice = new RepositoriesChoice();
  choice.filter(state, "off");
  expect(shown(state, choice)).toEqual([["Fernhill", ["web", "site"], "4 of 6 reviewed"]]);
  // fernhill/web leaves the App's installation: no row is left behind for it.
  const webGone = world(
    state.repos.filter((r) => r.name !== "web"),
    [gone("fernhill", "web")],
  );
  expect(shown(webGone, choice)).toEqual([["Fernhill", ["site"], "4 of 5 reviewed"]]);
  // fernhill/site leaves too: Fernhill has no row left under Off, and its group is dropped.
  const bothGone = world(
    webGone.repos.filter((r) => r.name !== "site"),
    [gone("fernhill", "web"), gone("fernhill", "site")],
  );
  expect(shown(bothGone, choice)).toEqual([]);
  expect(repositoriesList(bothGone, choice.get(), new Map()).empty).not.toBeNull();
});

test("All with no search lists every repository, one arriving included", () => {
  const choice = new RepositoriesChoice();
  choice.filter(world(ELEVEN), "all");
  const more = world([...ELEVEN, repo("ledger-dev", "ledger-app")]);
  expect(shown(more, choice).at(-1)?.[1]).toEqual(["billing", "ledger-web", "ledger-docs", "ledger-app"]);
});

test("while the search has text a collapsed group shows its matches; one collapsed during the search opens at the next change", () => {
  const state = world(ELEVEN);
  const choice = new RepositoriesChoice();
  const collapsed = new Map([["Fernhill", true]]);
  const open = () =>
    repositoriesList(state, choice.get(), collapsed).groups.map(({ group, collapsed }) => [
      group.key,
      collapsed,
    ]);
  expect(open()).toEqual([
    ["sasensi", false],
    ["Fernhill", true],
    ["ledger-dev", false],
  ]);
  choice.search(state, "docs");
  expect(open()).toEqual([
    ["Fernhill", false],
    ["ledger-dev", false],
  ]);
  // Collapsed during the search, from its chevron.
  choice.collapseInSearch("ledger-dev");
  expect(open()).toEqual([
    ["Fernhill", false],
    ["ledger-dev", true],
  ]);
  choice.search(state, "doc");
  expect(open()).toEqual([
    ["Fernhill", false],
    ["ledger-dev", false],
  ]);
  // A filter changed during the search opens it again too.
  choice.collapseInSearch("ledger-dev");
  choice.filter(state, "reviewing");
  expect(open()).toEqual([
    ["Fernhill", false],
    ["ledger-dev", false],
  ]);
  choice.filter(state, "all");
  // The search cleared: the groups collapsed before are collapsed again.
  choice.search(state, "");
  expect(open()[1]).toEqual(["Fernhill", true]);
});

// ---- Large groups start folded (ADR 0083, round 4) ----

/** sasensi's two, then Fernhill's `n` (the first two off), then ledger-dev's three. */
const withFernhill = (n: number): Repository[] => [
  repo("sasensi", "ledger-api"),
  repo("sasensi", "dotfiles"),
  ...Array.from({ length: n }, (_, i) => repo("fernhill", `repo-${i + 1}`, i >= 2)),
  repo("ledger-dev", "billing"),
  repo("ledger-dev", "ledger-web"),
  repo("ledger-dev", "ledger-docs"),
];

/** Each group's account and whether it is folded, on the app's `collapsed` and the page's `choice`. */
const folded = (state: State, choice = new RepositoriesChoice(), collapsed = new CollapsedGroups()) =>
  repositoriesList(state, choice.get(), collapsed.get()).groups.map(({ group, collapsed }) => [
    group.key,
    collapsed,
  ]);

test("past ten repositories, with more than one account, a group of more than ten starts folded", () => {
  expect(folded(world(withFernhill(11)))).toEqual([
    ["sasensi", false],
    ["Fernhill", true],
    ["ledger-dev", false],
  ]);
  // Ten in a group is not more than ten: every group open.
  expect(folded(world(withFernhill(10))).map(([, f]) => f)).toEqual([false, false, false]);
});

test("a group's first fold is decided once, the first time the page shows it: one growing past ten stays open", () => {
  const collapsed = new CollapsedGroups();
  const choice = new RepositoriesChoice();
  // The page holds each group's first fold as it shows it.
  const seen = (state: State) => {
    const list = repositoriesList(state, choice.get(), collapsed.get());
    collapsed.remember(list.firstFolds);
    return list.groups.map(({ group, collapsed }) => [group.key, collapsed]);
  };
  expect(seen(world(withFernhill(10)))).toEqual([
    ["sasensi", false],
    ["Fernhill", false],
    ["ledger-dev", false],
  ]);
  // Fernhill grows from ten to eleven while the page is open: it stays as it was first shown.
  expect(seen(world(withFernhill(11)))[1]).toEqual(["Fernhill", false]);
  // A group first shown past ten still starts folded, and stays so.
  const other = new CollapsedGroups();
  const first = repositoriesList(world(withFernhill(11)), choice.get(), other.get());
  expect(first.firstFolds.get("Fernhill")).toBe(true);
  other.remember(first.firstFolds);
  expect(folded(world(withFernhill(10)), choice, other)[1]).toEqual(["Fernhill", true]);
  // Nothing new to hold once every group shown is held; a search's folds are its own, never held.
  expect(repositoriesList(world(withFernhill(11)), choice.get(), other.get()).firstFolds.size).toBe(0);
  choice.search(world(withFernhill(11)), "repo");
  expect(repositoriesList(world(withFernhill(11)), choice.get(), new Map()).firstFolds.size).toBe(0);
});

test("the only group never starts folded, however large", () => {
  const alone = withFernhill(20).filter((r) => r.owner === "fernhill");
  expect(folded(world(alone))).toEqual([["Fernhill", false]]);
});

test("a group the person opens stays open while the app is open; one folded by hand stays folded", () => {
  const state = world(withFernhill(12));
  const collapsed = new CollapsedGroups();
  // Its chevron, as the page sends it: the group folded now.
  collapsed.toggle("Fernhill", true);
  expect(folded(state, undefined, collapsed)[1]).toEqual(["Fernhill", false]);
  // More repositories arrive: still open.
  expect(folded(world(withFernhill(30)), undefined, collapsed)[1]).toEqual(["Fernhill", false]);
  // Folded again, then a small group folded by hand.
  collapsed.toggle("Fernhill", false);
  collapsed.toggle("sasensi", false);
  expect(folded(state, undefined, collapsed)).toEqual([
    ["sasensi", true],
    ["Fernhill", true],
    ["ledger-dev", false],
  ]);
  // A new app (a reload): back to the rule.
  expect(folded(state)[0]).toEqual(["sasensi", false]);
});

test("a search shows a folded group's matches, open; cleared, it is folded again", () => {
  const state = world(withFernhill(12));
  const choice = new RepositoriesChoice();
  choice.search(state, "repo-1");
  expect(folded(state, choice)).toEqual([["Fernhill", false]]);
  choice.search(state, "");
  expect(folded(state, choice)[1]).toEqual(["Fernhill", true]);
});

test("the filter keeps a folded group folded, its head saying apart how many of it the filter shows", () => {
  const state = world(withFernhill(12));
  const choice = new RepositoriesChoice();
  const heads = (from = state) =>
    repositoriesList(from, choice.get(), new Map()).groups.map(({ group, collapsed }) => [
      group.key,
      collapsed,
      group.head.count,
      group.head.shows,
    ]);
  choice.filter(state, "off");
  expect(heads()).toEqual([["Fernhill", true, "10 of 12 reviewed", { line: "2 shown", said: true }]]);
  choice.filter(state, "reviewing");
  // An open head holds the line empty, so every head under the filter is as tall (Lookover's F5).
  expect(heads()).toEqual([
    ["sasensi", false, "All 2 reviewed", { line: "2 shown", said: false }],
    ["Fernhill", true, "10 of 12 reviewed", { line: "10 shown", said: true }],
    ["ledger-dev", false, "All 3 reviewed", { line: "3 shown", said: false }],
  ]);
  // Its count is the account's alone, held at every count; what the filter shows is a line of its own.
  const [, fernhill] = repositoriesList(state, choice.get(), new Map()).groups;
  expect(fernhill?.group.head.counts).toContain("All 12 reviewed");
  // The account switched off under Reviewing: the rows it left stay, and the head never says "None reviewed · 10 reviewing".
  const off = world(withFernhill(12).map((r) => (r.owner === "fernhill" ? { ...r, enabled: false } : r)));
  expect(heads(off)[1]).toEqual(["Fernhill", true, "None of 12 reviewed", { line: "10 shown", said: true }]);
  // Opened, its rows say what the filter shows: the head says the account's count alone, the line held.
  const opened = repositoriesList(state, choice.get(), new Map([["Fernhill", false]])).groups[1];
  expect([opened?.group.head.count, opened?.group.head.shows]).toEqual([
    "10 of 12 reviewed",
    { line: "10 shown", said: false },
  ]);
  choice.filter(state, "all");
  expect(heads()[1]).toEqual(["Fernhill", true, "10 of 12 reviewed", null]);
});

// ---- Setup's Repositories step past ten (ADR 0082, 0083) ----

/** What setup's step lists: each group's account, its rows, whether it is collapsed. */
const setupShown = (list: ReturnType<typeof setupRepoList>) =>
  list.groups.map(({ group, collapsed }) => [group.key, group.rows.map((r) => r.repo.name), collapsed]);

test("setup's step with ten repositories or fewer has no search and never collapses a group", () => {
  const state = world(ELEVEN.slice(0, 10));
  const choice = new RepositoriesChoice();
  const list = setupRepoList(state, new Map(), {
    shown: barAfter(state),
    choice: choice.get(),
    collapsed: new Map([["Fernhill", true]]),
  });
  expect(list.searchable).toBe(false);
  expect(list.groups.every((g) => !g.collapsed)).toBe(true);
});

test("setup's step past ten searches by repository and account; groups of ten or fewer start open", () => {
  const state = world(ELEVEN);
  const choice = new RepositoriesChoice();
  const list = () =>
    setupRepoList(state, new Map(), { shown: barAfter(state), choice: choice.get(), collapsed: new Map() });
  expect(list().searchable).toBe(true);
  expect(setupShown(list()).map(([, , collapsed]) => collapsed)).toEqual([false, false, false]);
  choice.search(state, "DOCS");
  expect(setupShown(list())).toEqual([
    ["Fernhill", ["docs"], false],
    ["ledger-dev", ["ledger-docs"], false],
  ]);
  choice.search(state, "ledger-dev");
  expect(setupShown(list())).toEqual([["ledger-dev", ["billing", "ledger-web", "ledger-docs"], false]]);
  choice.search(state, "nowhere");
  expect(list().groups).toEqual([]);
  expect(list().empty).toEqual({ title: "No repository here", text: "Nothing matches this search." });
});

test("setup's collapsed groups show their matches while searching, and fold again once the search is cleared", () => {
  const state = world(ELEVEN);
  const choice = new RepositoriesChoice();
  const collapsed = new Map([["Fernhill", true]]);
  const list = () => setupRepoList(state, new Map(), { shown: true, choice: choice.get(), collapsed });
  expect(setupShown(list())[1]).toEqual(["Fernhill", ["api", "web", "cli", "site", "infra", "docs"], true]);
  choice.search(state, "docs");
  expect(setupShown(list())[0]).toEqual(["Fernhill", ["docs"], false]);
  choice.collapseInSearch("Fernhill");
  expect(setupShown(list())[0]?.[2]).toBe(true);
  choice.search(state, "");
  expect(setupShown(list())[1]?.[2]).toBe(true);
});

test("setup's ticks survive a search and a collapse: the account's box and Continue count every repository", () => {
  const state = world(ELEVEN);
  const choice = new RepositoriesChoice();
  // fernhill/api unticked, then a search that hides it, then Fernhill collapsed.
  const choices = new Map([[repositoryId("fernhill/api"), false]]);
  choice.search(state, "docs");
  const fernhill = setupRepoList(state, choices, { shown: true, choice: choice.get(), collapsed: new Map() })
    .groups[0]?.group;
  expect(fernhill?.rows.map((r) => r.repo.name)).toEqual(["docs"]);
  // Of the whole account: web and site off on the service, api unticked here.
  expect(fernhill?.ticked).toBe("some");
  expect(fernhill?.size).toBe("6 repositories");
  expect(fernhill?.control?.repoIds).toHaveLength(6);
  choice.search(state, "");
  const folded = setupRepoList(state, choices, {
    shown: true,
    choice: choice.get(),
    collapsed: new Map([["Fernhill", true]]),
  });
  expect(folded.groups[1]?.group.ticked).toBe("some");
  expect(chosenRepos(state.repos, choices)).not.toContain(repositoryId("fernhill/api"));
  expect(chosenRepos(state.repos, choices)).toContain(repositoryId("fernhill/docs"));
});

test("setup's footer says how many Continue sends, of every repository, in Repositories' words", () => {
  const state = world(ELEVEN);
  const list = (choices: ReadonlyMap<RepositoryId, boolean>) =>
    setupRepoList(state, choices, {
      shown: true,
      choice: new RepositoriesChoice().get(),
      collapsed: new Map(),
    });
  // Fernhill's web and site are off on the service.
  expect(list(new Map()).count).toBe("9 of 11 to review");
  expect(list(new Map()).enabled).toEqual(chosenRepos(state.repos, new Map()));
  const on = new Map([
    [repositoryId("fernhill/web"), true],
    [repositoryId("fernhill/site"), true],
  ]);
  expect(list(on).count).toBe("All 11 to review");
  expect(list(new Map(ELEVEN.map((r) => [r.id, false]))).count).toBe("None to review");
});

test("setup's chevrons are named as Repositories' own", () => {
  const state = world(ELEVEN);
  const choice = new RepositoriesChoice().get();
  const setup = setupRepoList(state, new Map(), { shown: true, choice, collapsed: new Map() });
  const repositories = repositoriesList(state, choice, new Map());
  expect(setup.groups.map(({ group }) => group.toggleLabel)).toEqual(
    repositories.groups.map(({ group }) => group.head.toggleLabel),
  );
});

// ---- Setup's step folds past ten, as Repositories (ADR 0083, round 6) ----

/** Setup's groups on the step's own `collapsed`, the bar shown: each account and whether it is folded. */
const setupFolded = (state: State, collapsed = new CollapsedGroups()) =>
  setupRepoList(state, new Map(), {
    shown: true,
    choice: new RepositoriesChoice().get(),
    collapsed: collapsed.get(),
  }).groups.map(({ group, collapsed }) => [group.key, collapsed]);

test("setup's step past ten folds a group of more than ten, as Repositories, never the only group", () => {
  expect(setupFolded(world(withFernhill(11)))).toEqual([
    ["sasensi", false],
    ["Fernhill", true],
    ["ledger-dev", false],
  ]);
  expect(setupFolded(world(withFernhill(10))).map(([, f]) => f)).toEqual([false, false, false]);
  const alone = withFernhill(20).filter((r) => r.owner === "fernhill");
  expect(setupFolded(world(alone))).toEqual([["Fernhill", false]]);
  // Ten or fewer: no bar, nothing folds.
  const small = setupRepoList(world(withFernhill(11)), new Map(), {
    shown: false,
    choice: new RepositoriesChoice().get(),
    collapsed: new Map(),
  });
  expect(small.groups.every((g) => !g.collapsed)).toBe(true);
});

test("a setup group the person opens stays open while the step is shown, more repositories arriving too", () => {
  const collapsed = new CollapsedGroups();
  const first = setupRepoList(world(withFernhill(12)), new Map(), {
    shown: true,
    choice: new RepositoriesChoice().get(),
    collapsed: collapsed.get(),
  });
  expect(first.firstFolds.get("Fernhill")).toBe(true);
  collapsed.remember(first.firstFolds);
  // Its chevron, as the step sends it: the group folded now.
  collapsed.toggle("Fernhill", true);
  expect(setupFolded(world(withFernhill(12)), collapsed)[1]).toEqual(["Fernhill", false]);
  expect(setupFolded(world(withFernhill(30)), collapsed)[1]).toEqual(["Fernhill", false]);
  // One growing past ten while the step is shown never folds by itself.
  const growing = new CollapsedGroups();
  growing.remember(
    setupRepoList(world(withFernhill(10)), new Map(), {
      shown: true,
      choice: new RepositoriesChoice().get(),
      collapsed: growing.get(),
    }).firstFolds,
  );
  expect(setupFolded(world(withFernhill(11)), growing)[1]).toEqual(["Fernhill", false]);
});

test("past ten, a setup head's count says how many of its account are ticked, whatever its box", () => {
  const state = world([...withFernhill(11), repo("solo", "only", false)]);
  const heads = (choices: ReadonlyMap<RepositoryId, boolean>) =>
    setupRepoList(state, choices, {
      shown: true,
      choice: new RepositoriesChoice().get(),
      collapsed: new Map(),
    }).groups.map(({ group }) => [group.key, group.ticked, group.count]);
  // Fernhill's first two are off on the service.
  expect(heads(new Map())).toEqual([
    ["sasensi", "all", "All 2 to review"],
    ["Fernhill", "some", "9 of 11 to review"],
    ["ledger-dev", "all", "All 3 to review"],
    ["solo", "none", "1 repository, not to review"],
  ]);
  const off = new Map([...withFernhill(11), repo("solo", "only")].map((r) => [r.id, r.owner === "solo"]));
  expect(heads(off).map(([, , count]) => count)).toEqual([
    "None of 2 to review",
    "None of 11 to review",
    "None of 3 to review",
    "1 repository, to review",
  ]);
  // Every count the head may say, held so a tick changes no width.
  const fernhill = setupRepoList(state, new Map(), {
    shown: true,
    choice: new RepositoriesChoice().get(),
    collapsed: new Map(),
  }).groups[1]?.group;
  expect(fernhill?.counts).toHaveLength(12);
  expect(fernhill?.counts).toContain("All 11 to review");
});

test("a setup step that opened with ten repositories and grows to fourteen folds no group by itself", () => {
  const step = (n: number) => [
    repo("sasensi", "ledger-api"),
    repo("sasensi", "dotfiles"),
    ...Array.from({ length: n }, (_, i) => repo("fernhill", `repo-${i + 1}`)),
  ];
  const bar = new RepositoriesBar();
  const collapsed = new CollapsedGroups();
  const choice = new RepositoriesChoice();
  // The step as it shows each state: the bar seen, each group's first fold held.
  const seen = (state: State) => {
    bar.see(state);
    const list = setupRepoList(state, new Map(), {
      shown: bar.get(),
      choice: choice.get(),
      collapsed: collapsed.get(),
    });
    collapsed.remember(list.firstFolds);
    return list;
  };
  expect(seen(world(step(8))).searchable).toBe(false);
  const grown = seen(world(step(12)));
  expect(grown.searchable).toBe(true);
  expect(grown.groups.map(({ group, collapsed }) => [group.key, collapsed])).toEqual([
    ["sasensi", false],
    ["Fernhill", false],
  ]);
});
