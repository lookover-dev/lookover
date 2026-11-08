// Repositories' search and filter (design-system.md "Repositories' search and filter", ADR 0082): All reviews' bar on
// Repositories once more than ten repositories are watched, kept while the app is open. The search and the filter,
// one choice per visit of the page, apply when the person changes them: the rows they leave are worked out then, so a row whose switch moves stays
// where it is. Groups keep their order and their heads' count and switch; the empty ones are dropped. Setup's
// Repositories step takes the same search past ten repositories, with no filter (`setupRepoList`).
import type { Repository, RepositoryId, State } from "@lookover/contracts";
import { type RepositoryGroup, repositoryGroups, type SetupRepoGroup, setupRepoGroups } from "./accounts.ts";
import { HeldValue } from "./held.ts";
import { chosenRepos } from "./onboarding.ts";

export type RepositoryFilter = "all" | "reviewing" | "off";

/** One option of the filter: dimmed when no watched repository is behind it. */
interface RepositoryFilterOption {
  value: RepositoryFilter;
  label: string;
  disabled: boolean;
}

const FILTERS = {
  all: { value: "all", label: "All", keeps: () => true },
  reviewing: { value: "reviewing", label: "Reviewing", keeps: (r) => r.enabled },
  off: { value: "off", label: "Off", keeps: (r) => !r.enabled },
} satisfies { [F in RepositoryFilter]: { value: F; label: string; keeps: (r: Repository) => boolean } };

/** More repositories watched than this, and the bar shows. */
const BAR_FROM = 10;

export const REPOSITORIES_BAR = {
  filterLabel: "Show",
  search: "Search repositories",
} as const;

const EMPTY = { title: "No repository here", text: "Nothing matches this search or filter." } as const;

/** What the person chose on the bar, and what it left when they last changed it. */
export interface RepositoriesChoiceValue {
  filter: RepositoryFilter;
  query: string;
  /** The repositories the search and the filter left when either last changed; null: every one (All, no search). */
  held: ReadonlySet<RepositoryId> | null;
  /** The groups collapsed from their chevron since the search last changed, while it has text. */
  collapsedInSearch: ReadonlySet<string>;
}

/**
 * Whether the bar shows, held for the app while it is open, as Mine and Everyone are (`ListScope`): the store's `see`
 * on every state it takes shows it once more than ten repositories are watched, and nothing hides it again, leaving the
 * page included. The value changes only once.
 */
export class RepositoriesBar extends HeldValue<boolean> {
  constructor() {
    super(false);
  }

  see(state: Pick<State, "repos">): void {
    if (!this.get() && state.repos.length > BAR_FROM) this.set(true);
  }
}

/** Whether a repository matches the search: its account and its name, `owner/name`, in any case. */
const matches = (r: Repository, query: string): boolean =>
  `${r.owner}/${r.name}`.toLowerCase().includes(query.trim().toLowerCase());

const searching = (query: string): boolean => query.trim() !== "";

/**
 * The bar's choice for one visit of the page: All and no search at first. `filter` and `search` work out the rows
 * left from the state at that moment, so a row whose switch moves afterwards stays until the next change. The value is
 * replaced only when it changes.
 */
export class RepositoriesChoice extends HeldValue<RepositoriesChoiceValue> {
  constructor() {
    super({ filter: "all", query: "", held: null, collapsedInSearch: new Set() });
  }

  filter = (state: Pick<State, "repos">, filter: RepositoryFilter): void => {
    this.choose(state, filter, this.get().query);
  };

  search = (state: Pick<State, "repos">, query: string): void => {
    this.choose(state, this.get().filter, query);
  };

  /** A group's chevron while the search has text: collapses it, or opens it again, until the search changes. */
  collapseInSearch = (key: string): void => {
    const value = this.get();
    const next = new Set(value.collapsedInSearch);
    if (!next.delete(key)) next.add(key);
    this.set({ ...value, collapsedInSearch: next });
  };

  private choose(state: Pick<State, "repos">, filter: RepositoryFilter, query: string): void {
    const held =
      filter === "all" && !searching(query)
        ? null
        : new Set(state.repos.filter((r) => FILTERS[filter].keeps(r) && matches(r, query)).map((r) => r.id));
    this.set({ filter, query, held, collapsedInSearch: new Set() });
  }
}

/**
 * Whether a group starts folded on Repositories (ADR 0083, round 4): past ten repositories, with more than one group, a
 * group of more than ten, so a large organisation's page shows its accounts first. Never the only group.
 */
const foldsAtFirst = (watched: number, groups: number, group: { total: number }): boolean =>
  watched > BAR_FROM && groups > 1 && group.total > BAR_FROM;

/**
 * A group's head under a filter: the account's count as ever, and how many of its repositories the filter shows, a
 * line of its own ("10 shown"), so the two never read as one claim ("None of 12 reviewed · 10 reviewing", the account
 * switched off after the filter was chosen) and the account's name keeps its width beside the count. Said while it is
 * folded (open, its rows say it), held empty while open, so every head under the filter is as tall: a table cell
 * sticks for the whole table, and a taller head stuck under a later one showed from under it (Lookover's F5).
 */
const withMatching = (group: RepositoryGroup, folded: boolean): RepositoryGroup => ({
  ...group,
  head: { ...group.head, shows: { line: `${group.repos.length} shown`, said: folded } },
});

/**
 * What Repositories lists under its bar: the filter's options, dimmed over every watched repository (a search never
 * changes what can be picked); each group the choice leaves, folded as the person chose from its chevron (`collapsed`)
 * or else as its rule starts it (`foldsAtFirst`), or, while the search has text, as the search's own chevrons say, a
 * folded group's head under a filter saying how many of it the filter shows; and the empty line when the search or the
 * filter left no group.
 */
export function repositoriesList(
  state: State,
  choice: RepositoriesChoiceValue,
  collapsed: ReadonlyMap<string, boolean>,
): {
  options: RepositoryFilterOption[];
  groups: { group: RepositoryGroup; collapsed: boolean }[];
  searching: boolean;
  empty: { title: string; text: string } | null;
  /**
   * Each group shown for the first time, not held in `collapsed` yet, with the fold its rule starts it with: the page
   * holds them (`CollapsedGroups.remember`), so a group's first fold is decided once while the app is open and one
   * growing past ten while watched never folds by itself. None while the search has text: its folds are its own.
   */
  firstFolds: ReadonlyMap<string, boolean>;
} {
  const options = Object.values(FILTERS).map(({ value, label, keeps }) => ({
    value,
    label,
    disabled: value !== "all" && value !== choice.filter && !state.repos.some(keeps),
  }));
  const all = repositoryGroups(state).length;
  const { groups, searching, nothingLeft } = chosenGroups(
    choice,
    collapsed,
    (shown) => repositoryGroups(state, shown),
    (group) => foldsAtFirst(state.repos.length, all, group),
  );
  const said = groups.map(({ group, collapsed }) => ({
    group: !searching && choice.filter !== "all" ? withMatching(group, collapsed) : group,
    collapsed,
  }));
  return {
    options,
    groups: said,
    searching,
    empty: nothingLeft ? EMPTY : null,
    firstFolds: firstFoldsOf(groups, collapsed, searching),
  };
}

/** Each group shown and not held in `collapsed` yet, with the fold its rule starts it with; none while searching. */
const firstFoldsOf = (
  groups: readonly { group: { key: string }; collapsed: boolean }[],
  collapsed: ReadonlyMap<string, boolean>,
  searching: boolean,
): ReadonlyMap<string, boolean> =>
  new Map(
    searching
      ? []
      : groups.filter(({ group }) => !collapsed.has(group.key)).map((g) => [g.group.key, g.collapsed]),
  );

/**
 * The groups a choice leaves, from `groupsOf` the rows it shows: each collapsed as `collapsed` says, else as `atFirst`
 * starts it, or, while the search has text, as the search's own chevrons say. `nothingLeft`: the search or the filter
 * left no group (nothing watched at all, with nothing chosen, has none to blame: the list under its heads as before).
 */
function chosenGroups<G extends { key: string }>(
  choice: RepositoriesChoiceValue,
  collapsed: ReadonlyMap<string, boolean>,
  groupsOf: (shown: (r: Repository) => boolean) => G[],
  atFirst: (group: G) => boolean,
): { groups: { group: G; collapsed: boolean }[]; searching: boolean; nothingLeft: boolean } {
  const { held } = choice;
  const inSearch = searching(choice.query);
  const groups = groupsOf(held === null ? () => true : (r) => held.has(r.id)).map((group) => ({
    group,
    collapsed: inSearch
      ? choice.collapsedInSearch.has(group.key)
      : (collapsed.get(group.key) ?? atFirst(group)),
  }));
  return { groups, searching: inSearch, nothingLeft: groups.length === 0 && held !== null };
}

const SETUP_EMPTY = { title: "No repository here", text: "Nothing matches this search." } as const;

/** Every repository, no search: the step at ten repositories or fewer. */
const NO_CHOICE = new RepositoriesChoice().get();

/** What setup's footer says of `ticked` of `total` repositories, in Repositories' words (`countLine`). */
function toReviewLine(ticked: number, total: number): string {
  if (ticked === 0) return "None to review";
  if (total < 2) return "1 to review";
  if (ticked === total) return `All ${total} to review`;
  return `${ticked} of ${total} to review`;
}

/**
 * What setup's Repositories step lists (design-system.md "Setup's grouped checklist", ADR 0082, 0083). Once `bar`
 * shows (more than ten repositories, held as on Repositories), the rows its search leaves, each group collapsed as
 * `collapsed` says, else as Repositories' rule starts it (`foldsAtFirst`: a group of more than ten; round 6), or, while
 * the search has text, as the search's own chevrons say; before, every row, no group collapsed. The ticks are the
 * step's `choices`, whatever is shown: a group's box and size, `enabled` (what Continue sends) and `count` (the
 * footer's line) are every repository's.
 */
export function setupRepoList(
  state: State,
  choices: ReadonlyMap<RepositoryId, boolean>,
  bar: { shown: boolean; choice: RepositoriesChoiceValue; collapsed: ReadonlyMap<string, boolean> },
): {
  searchable: boolean;
  searching: boolean;
  groups: { group: SetupRepoGroup; collapsed: boolean }[];
  empty: { title: string; text: string } | null;
  enabled: RepositoryId[];
  count: string;
  /** Each group's first fold, as on Repositories (`repositoriesList`): the step holds them for its visit. */
  firstFolds: ReadonlyMap<string, boolean>;
} {
  const collapsed = bar.shown ? bar.collapsed : new Map<string, boolean>();
  const all = repositoryGroups(state).length;
  const { groups, searching, nothingLeft } = chosenGroups(
    bar.shown ? bar.choice : NO_CHOICE,
    collapsed,
    (shown) => setupRepoGroups(state, choices, shown),
    // Past ten, Repositories' rule (round 6 reversed round 5's "setup keeps its groups open"); before, none folds.
    (group) => bar.shown && foldsAtFirst(state.repos.length, all, group),
  );
  const enabled = chosenRepos(state.repos, choices);
  return {
    searchable: bar.shown,
    searching,
    groups,
    // Held from the step's first sight, bar or not: a step growing past ten folds no group it showed open.
    firstFolds: firstFoldsOf(groups, bar.collapsed, searching),
    empty: nothingLeft ? SETUP_EMPTY : null,
    enabled,
    count: toReviewLine(enabled.length, state.repos.length),
  };
}
