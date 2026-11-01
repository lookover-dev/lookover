// All reviews' outcome filters (#270, ADR 0070): the rows a filter and the search box leave, and which filters hold
// nothing. An empty filter is dimmed and can't be picked, in place and without a count, so the bar never moves as
// reviews come and go; "All" and the selected filter never are.
import { authorLabel, type ChangeReview, changeLabel, status } from "./select.ts";
import type { DisplayStatus } from "./status.ts";

export type Filter = "all" | "needs" | "open" | "done" | "skipped";

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

/** The statuses each filter holds; waiting and running reviews are only in All. */
const IN_FILTER: Record<Filter, DisplayStatus["kind"][] | null> = {
  all: null,
  needs: ["needs-you", "failed"],
  open: ["to-fix"],
  done: ["settled"],
  skipped: ["skipped", "not-asked", "cancelled"],
};

function inFilter(filter: Filter, item: ChangeReview): boolean {
  const wanted = IN_FILTER[filter];
  return !wanted || wanted.includes(status(item).kind);
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
 * All reviews' bar and rows. Which filters hold something is read over every review, not the search box's rows, so
 * typing never changes what can be picked.
 */
export function allReviews(
  items: ChangeReview[],
  filter: Filter,
  query: string,
  line: (item: ChangeReview) => string,
): { options: FilterOption[]; rows: ChangeReview[] } {
  const options = FILTERS.map((f) => ({
    ...f,
    disabled: f.value !== "all" && f.value !== filter && !items.some((i) => inFilter(f.value, i)),
  }));
  const rows = items.filter((i) => inFilter(filter, i) && matchesSearch(i, query, line(i)));
  return { options, rows };
}
