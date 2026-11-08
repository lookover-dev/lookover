// Setup's Repositories step at an organisation's size (design-system.md "Setup's grouped checklist", ADR 0082, 0083):
// past ten repositories, Repositories' search and a chevron collapsing each group, and a footer saying how many
// Continue sends; what a search hides or a group folds keeps its tick. The step's visit is the one the screen holds;
// a render reads it, and the step's controls change it, read from the screen's own tree.
import { expect, test } from "bun:test";
import { type Command, changeId } from "@lookover/contracts";
import type { ReactNode } from "react";
import { Button, Check, Search } from "../ui/basics.tsx";
import { app, change, elements, repo, screen, world } from "./repositories.test-support.tsx";
import { type SetupReposVisit, StepReposOn, setupReposVisit } from "./setup.tsx";

/** Eleven: sasensi's two, fernhill's nine, fernhill/web off. */
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

/** The step on `visit` as it renders, its rows' names, and its controls; what it sends goes to `sent`. */
function step(visit: SetupReposVisit, sent: Command[], state = world(ELEVEN)) {
  const store = app();
  store.repositoriesBar.see(state);
  let tree: ReactNode = null;
  const html = screen(
    store,
    state,
    () => {
      tree = StepReposOn({ visit });
      return tree;
    },
    (c) => sent.push(c),
  );
  const all = elements(tree);
  const fn = (found: unknown, what: string) => {
    if (typeof found !== "function") throw new Error(`no ${what} on the step`);
    return found;
  };
  const checks = all.filter((e) => e.type === Check);
  return {
    html,
    rows: checks.map((e) => String(e.props.label)),
    search: (value: string) =>
      fn(all.find((e) => e.type === Search)?.props.onChange, "search")({ target: { value } }),
    tick: (label: string, on: boolean) =>
      fn(checks.find((e) => String(e.props.label).startsWith(label))?.props.onChange, label)(on),
    collapse: (account: string) =>
      fn(all.find((e) => e.props["aria-label"] === `${account}'s repositories`)?.props.onClick, "chevron")(),
    continue: () =>
      fn(all.find((e) => e.type === Button && e.props.children === "Continue")?.props.onClick, "Continue")(),
  };
}

test("ten repositories or fewer: no search, no chevron, no count", () => {
  const { html } = step(setupReposVisit(), [], world(ELEVEN.slice(0, 10)));
  expect(html).not.toContain(SEARCH);
  expect(html).not.toContain("group-toggle");
  expect(html).not.toContain("9 of 10 to review");
});

test("past ten, a repository with nothing open says 0 open after its name, muted, as on Repositories", () => {
  const { html, rows } = step(setupReposVisit(), []);
  expect(html).not.toContain("–");
  expect(html).toContain('<b>docs</b><span class="t-small checklist-open open-zero">0 open</span></span>');
  expect(rows).toContain("fernhill/docs, 0 open pull requests");
});

test("past ten, a repository's open pull requests follow its name on its line, in Repositories' words", () => {
  const state = world(ELEVEN);
  state.changes = {
    [changeId("fernhill/api#3")]: change("fernhill/api", 3),
    [changeId("fernhill/api#4")]: change("fernhill/api", 4),
  };
  const { html, rows } = step(setupReposVisit(), [], state);
  expect(html).toContain('<b>api</b><span class="t-small checklist-open">2 open</span></span>');
  expect(rows).toContain("fernhill/api, 2 open pull requests");
});

test("ten or fewer, every repository says its open pull requests the same way, zero included", () => {
  const { html } = step(setupReposVisit(), [], world(ELEVEN.slice(0, 10)));
  expect(html.match(/<span class="t-small checklist-open open-zero">0 open<\/span>/g)?.length).toBe(10);
});

test("past ten: a tick hidden by the search and folded in its group is still what Continue sends", () => {
  const visit = setupReposVisit();
  const sent: Command[] = [];
  const first = step(visit, sent);
  expect(first.html).toContain(SEARCH);
  expect(first.html).toContain("10 of 11 to review");
  first.tick("fernhill/api", false);
  expect(step(visit, sent).html).toContain("9 of 11 to review");
  step(visit, sent).search("docs");
  const found = step(visit, sent);
  expect(found.rows).toEqual(["Review every repository in fernhill", "fernhill/docs, 0 open pull requests"]);
  found.collapse("fernhill");
  const folded = step(visit, sent);
  expect(folded.rows).toEqual(["Review every repository in fernhill"]);
  expect(folded.html).toContain('aria-label="fernhill&#x27;s repositories" aria-expanded="false"');
  expect(folded.html).toContain("9 of 11 to review");
  folded.continue();
  expect(sent).toEqual([
    {
      type: "setup.chooseRepos",
      enabled: ELEVEN.filter((r) => r.name !== "api" && r.name !== "web").map((r) => r.id),
    },
  ]);
});

/** Thirteen: sasensi's two, fernhill's eleven (web off), so fernhill starts folded. */
const THIRTEEN = [...ELEVEN, repo("fernhill", "billing"), repo("fernhill", "auth")];

test("past ten, a group of more than ten starts folded: its box chooses the account, its count says how many", () => {
  const visit = setupReposVisit();
  const sent: Command[] = [];
  const state = world(THIRTEEN);
  const first = step(visit, sent, state);
  // fernhill folded: its head's box alone, mixed as web is off; sasensi open.
  expect(first.rows).toEqual([
    "Review every repository in sasensi",
    "sasensi/ledger-api, 0 open pull requests",
    "sasensi/dotfiles, 0 open pull requests",
    "Review every repository in fernhill",
  ]);
  expect(first.html).toContain('aria-label="fernhill&#x27;s repositories" aria-expanded="false"');
  expect(first.html).toContain("10 of 11 to review");
  expect(first.html).toContain("All 2 to review");
  first.tick("Review every repository in fernhill", true);
  expect(step(visit, sent, state).html).toContain("All 11 to review");
  // Opened, it stays open while the step is shown.
  step(visit, sent, state).collapse("fernhill");
  expect(step(visit, sent, state).rows).toHaveLength(15);
  expect(step(visit, sent, state).html).toContain(
    'aria-label="fernhill&#x27;s repositories" aria-expanded="true"',
  );
});

test("past ten, an account's box is described by its count, so a screen reader hears how many are ticked", () => {
  const { html } = step(setupReposVisit(), [], world(THIRTEEN));
  const box = html.match(/<input[^>]*aria-label="Review every repository in fernhill"[^>]*>/)?.[0] ?? "";
  const id = box.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(id).toBeDefined();
  // The count it names holds every line it may say, the one shown alone not hidden from the screen reader.
  const count = html.slice(html.indexOf(`id="${id}"`));
  expect(count).toMatch(/^id="[^"]+"[^>]*><span class="held-detail">/);
  expect(count).toContain("<span>10 of 11 to review</span>");
});
