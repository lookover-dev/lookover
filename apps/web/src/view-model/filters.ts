// All reviews' outcome filters (#270, ADR 0070): the rows a filter and the search box leave, and which filters hold
// nothing. An empty filter is dimmed and can't be picked, in place and without a count, so the bar never moves as
// reviews come and go; "All" and the selected filter never are.

import { inTab, type Scope } from "./scope.ts";
import { authorLabel, type ChangeReview, changeLabel, status } from "./select.ts";
import { FILTER_OF, type Filter } from "./status.ts";

/** One option of the filter bar: dimmed when it holds no pull request. */
export interface FilterOption {
  value: Filter;
  label: string;
  disabled: boolean;
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs you" },
  { value: "open", label: "Findings open" },
  { value: "done", label: "Clean or settled" },
  { value: "skipped", label: "Skipped" },
];

function inFilter(filter: Filter, item: ChangeReview): boolean {
  return filter === "all" || FILTER_OF[status(item).kind] === filter;
}

/** Whether a row matches the search box: its title, number, author or status line, in any case. */
export function matchesSearch(item: ChangeReview, query: string, line: string): boolean {
  const q = query.trim().toLowerCase();
  return (
    !q ||
    `${item.change.title} ${changeLabel(item.change)} ${authorLabel(item.change)} ${line}`
      .toLowerCase()
      .includes(q)
  );
}

/**
 * All reviews' bar and rows, within the tab (Mine or Everyone, ADR 0078). Which filters hold something is read over
 * the tab's reviews, not the search box's rows, so typing never changes what can be picked.
 */
export function allReviews(
  all: ChangeReview[],
  scope: Scope,
  filter: Filter,
  query: string,
  line: (item: ChangeReview) => string,
): { options: FilterOption[]; rows: ChangeReview[] } {
  const items = inTab(scope, all);
  const options = FILTERS.map((f) => ({
    ...f,
    disabled: f.value !== "all" && f.value !== filter && !items.some((i) => inFilter(f.value, i)),
  }));
  const rows = items.filter((i) => inFilter(filter, i) && matchesSearch(i, query, line(i)));
  return { options, rows };
}
