// Repositories' search and filter on the screen (design-system.md "Repositories' search and filter", ADR 0082): the
// bar held while the app is open, a row switched under a filter kept until the search or the filter changes, a search
// showing its matches in a collapsed group, and the empty line in the table's place. The page's choice is the one the
// screen holds for a visit; a render reads it, and the bar's controls change it, read from the screen's own tree.
import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { Search, Segmented } from "../ui/basics.tsx";
import { RepositoriesChoice } from "../view-model/repositories.ts";
import { app, elements, repo, screen, world } from "./repositories.test-support.tsx";
import { RepositoriesOn } from "./settings.tsx";

/** Eleven watched: sasensi's two, fernhill's nine, fernhill/web off. */
const ELEVEN = [
  repo("sasensi", "ledger-api"),
  repo("sasensi", "dotfiles"),
  repo("fernhill", "api"),
  repo("fernhill", "web", false),
  repo("fernhill", "cli"),
  repo("fernhill", "site"),
  repo("fernhill", "infra"),
  repo("fernhill", "docs"),
  repo("fernhill", "mobile"),
  repo("fernhill", "design"),
  repo("fernhill", "data"),
];

const SEARCH = 'aria-label="Search repositories"';

/** The page on `choice` as it renders, and its bar's controls. */
function page(choice: RepositoriesChoice, state = world(ELEVEN), store = app()) {
  // The state the page renders, taken by the store first, as the store does with each one (`store.test.ts`).
  store.repositoriesBar.see(state);
  let tree: ReactNode = null;
  const html = screen(store, state, () => {
    tree = RepositoriesOn({ choice });
    return tree;
  });
  const all = elements(tree);
  const filter = all.find((e) => e.type === Segmented)?.props.onChange;
  const search = all.find((e) => e.type === Search)?.props.onChange;
  return {
    html,
    filter: (value: string) => {
      if (typeof filter !== "function") throw new Error("no filter on the page");
      filter(value);
    },
    search: (value: string) => {
      if (typeof search !== "function") throw new Error("no search on the page");
      search({ target: { value } });
    },
  };
}

test("ten repositories watched or fewer: no search and no filter", () => {
  const { html } = page(new RepositoriesChoice(), world(ELEVEN.slice(0, 10)));
  expect(html).not.toContain(SEARCH);
  expect(html).not.toContain('aria-label="Show"');
});

test("more than ten: the filter and the search, never taken away while the app is open", () => {
  const store = app();
  const choice = new RepositoriesChoice();
  const { html } = page(choice, world(ELEVEN), store);
  expect(html).toContain('aria-label="Show"');
  expect(html).toContain(SEARCH);
  // Two leave while the page is open: nine are left, the bar stays.
  expect(page(choice, world(ELEVEN.slice(0, 9)), store).html).toContain(SEARCH);
  // The page left and visited again with nine: the bar is still there, its search and filter new.
  const again = page(new RepositoriesChoice(), world(ELEVEN.slice(0, 9)), store).html;
  expect(again).toContain(SEARCH);
  expect(again).toContain('value=""');
  // Another app, opened on nine: no bar.
  expect(page(new RepositoriesChoice(), world(ELEVEN.slice(0, 9))).html).not.toContain(SEARCH);
});

test("a row switched under Off stays until the filter or the search changes", () => {
  const choice = new RepositoriesChoice();
  page(choice).filter("off");
  const off = page(choice).html;
  expect(off).toContain("fernhill/web");
  expect(off).not.toContain("fernhill/api");
  // fernhill/web switched on, as its switch sends: it stays where it is.
  const switched = world(ELEVEN.map((r) => (r.name === "web" ? { ...r, enabled: true } : r)));
  const kept = page(choice, switched);
  expect(kept.html).toContain("fernhill/web");
  // A search typed: the filter applies again, nothing is off.
  kept.search("f");
  const after = page(choice, switched).html;
  expect(after).not.toContain("fernhill/web");
  expect(after).toContain("No repository here");
});

test("a row switched under Reviewing stays until the filter changes", () => {
  const choice = new RepositoriesChoice();
  page(choice).filter("reviewing");
  const switched = world(ELEVEN.map((r) => (r.name === "api" ? { ...r, enabled: false } : r)));
  const kept = page(choice, switched);
  expect(kept.html).toContain("fernhill/api");
  kept.filter("reviewing");
  expect(page(choice, switched).html).not.toContain("fernhill/api");
});

test("a search shows its matches in a collapsed group; cleared, the group is collapsed again", () => {
  const store = app();
  store.collapsed.toggle("fernhill");
  const choice = new RepositoriesChoice();
  expect(page(choice, world(ELEVEN), store).html).not.toContain("fernhill/docs");
  page(choice, world(ELEVEN), store).search("DOCS");
  const found = page(choice, world(ELEVEN), store).html;
  expect(found).toContain("fernhill/docs");
  expect(found).toContain('aria-label="fernhill&#x27;s repositories" aria-expanded="true"');
  page(choice, world(ELEVEN), store).search("");
  expect(page(choice, world(ELEVEN), store).html).toContain(
    'aria-label="fernhill&#x27;s repositories" aria-expanded="false"',
  );
});

test("nothing left: the empty line in the table's place, the bar still above it", () => {
  const choice = new RepositoriesChoice();
  page(choice).search("nowhere");
  const { html } = page(choice);
  expect(html).toContain(SEARCH);
  expect(html).toContain("No repository here");
  expect(html).toContain("Nothing matches this search or filter.");
  expect(html).not.toContain("<table");
});
