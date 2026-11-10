// Repositories' group heads (design-system.md "Repositories' group heads", "Sticky, collapsible group heads"; ADR
// 0082): the account's switch sends one command for the whole account, and the chevron collapses the group, which
// keeps its head and hides its rows, held while the app is open. The screen is rendered to markup; a control's wiring
// is read from the head's elements. How the rows fold (ADR 0087) is read on a page to click in, at the end.
import { expect, test } from "bun:test";
import { apply, type Command, repositoryId, type State } from "@lookover/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Switch } from "../ui/basics.tsx";
import { withDom } from "../ui/dom.test-support.tsx";
import { type RepositoryGroup, repositoryGroups } from "../view-model/accounts.ts";
import { RepositoriesChoice } from "../view-model/repositories.ts";
import { app, elements, foldNames, Providers, repo, screen, world } from "./repositories.test-support.tsx";
import { GroupHead, RepositoryGroupRows, uncoverBy } from "./repository-group.tsx";
import { RepositoriesOn } from "./settings.tsx";

test("a mixed account's switch sends one command naming every repository of the account, one not shown included", () => {
  // fernhill/web is off and left out by a search or filter: the switch still names it.
  const fernhill = repositoryGroups(world(), (r) => r.name !== "web")[1];
  if (fernhill === undefined) throw new Error("no fernhill group");
  expect(fernhill.repos.map((r) => r.name)).toEqual(["api", "cli"]);
  const sent: Command[] = [];
  const head = GroupHead({
    group: fernhill,
    collapsed: false,
    toggle: () => undefined,
    send: (c) => sent.push(c),
  });
  const [control] = elements(head).filter((e) => e.type === Switch);
  expect(control?.props.checked).toBe(false);
  const onChange = control?.props.onChange;
  if (typeof onChange !== "function") throw new Error("the account's switch has no onChange");
  onChange(true);
  expect(sent).toEqual([
    {
      type: "repos.setEnabled",
      repoIds: [repositoryId("fernhill/api"), repositoryId("fernhill/web"), repositoryId("fernhill/cli")],
      enabled: true,
    },
  ]);
});

test("the chevron is named for the account's repositories, says whether they are shown, and toggles its group", () => {
  const html = screen(app());
  expect(html).toContain('aria-label="fernhill&#x27;s repositories" aria-expanded="true"');
  expect(html).toContain('aria-label="sasensi&#x27;s repositories" aria-expanded="true"');
  const fernhill = repositoryGroups(world())[1];
  if (fernhill === undefined) throw new Error("no fernhill group");
  let toggled = 0;
  const head = GroupHead({
    group: fernhill,
    collapsed: true,
    toggle: () => toggled++,
    send: () => undefined,
  });
  const [chevron] = elements(head).filter((e) => e.props["aria-expanded"] !== undefined);
  expect(chevron?.props["aria-expanded"]).toBe(false);
  const onClick = chevron?.props.onClick;
  if (typeof onClick !== "function") throw new Error("the chevron has no onClick");
  onClick();
  expect(toggled).toBe(1);
});

test("a collapsed group keeps its head, its switch and count, and hides its rows; the others stay open", () => {
  const store = app();
  store.collapsed.toggle("fernhill");
  const html = screen(store);
  expect(html).toContain('aria-label="fernhill&#x27;s repositories" aria-expanded="false"');
  expect(html).toContain("2 of 3 reviewed");
  expect(html).toContain('aria-label="Review every repository in fernhill"');
  expect(html).not.toContain("fernhill/api");
  expect(html).not.toContain("fernhill/cli");
  expect(html).toContain("sasensi/ledger-api");
});

test("past ten repositories, a group of more than ten starts folded on the screen; opened, it stays open", () => {
  const state = world([
    repo("sasensi", "ledger-api"),
    ...Array.from({ length: 11 }, (_, i) => repo("fernhill", `repo-${i + 1}`)),
  ]);
  const store = app();
  const html = screen(store, state);
  expect(html).toContain('aria-label="fernhill&#x27;s repositories" aria-expanded="false"');
  expect(html).toContain("All 11 reviewed");
  expect(html).not.toContain("fernhill/repo-1");
  expect(html).toContain('aria-label="sasensi&#x27;s repositories" aria-expanded="true"');
  store.collapsed.toggle("fernhill", true);
  expect(screen(store, state)).toContain("fernhill/repo-11");
  // A reload is a new app: folded again.
  expect(screen(app(), state)).not.toContain("fernhill/repo-1");
});

test("the groups collapsed are kept across leaving the page and coming back while the app is open, never stored", () => {
  const store = app();
  store.collapsed.toggle("fernhill");
  screen(store);
  // Coming back: the page mounts again on the same app.
  expect(screen(store)).toContain('aria-label="fernhill&#x27;s repositories" aria-expanded="false"');
  // Opened again from its chevron.
  store.collapsed.toggle("fernhill");
  expect(screen(store)).toContain("fernhill/api");
  // A reload is a new app: every group open.
  store.collapsed.toggle("fernhill");
  const reloaded = app();
  expect(screen(reloaded)).toContain('aria-label="fernhill&#x27;s repositories" aria-expanded="true"');
});

test("a group's chevron on the screen collapses that group in the app's memory, and opens it again", () => {
  const store = app();
  // The screen's own tree, its groups' wiring read from it: its hooks are run by the component rendering it. Rendered
  // again after each click, as the page is.
  const groups = () => {
    let tree: ReactNode = null;
    screen(store, world(), () => {
      tree = RepositoriesOn({ choice: new RepositoriesChoice() });
      return tree;
    });
    return elements(tree).filter((e) => e.type === RepositoryGroupRows);
  };
  const click = () => {
    const toggle = groups()[1]?.props.toggle;
    if (typeof toggle !== "function") throw new Error("fernhill's group has no toggle");
    toggle();
  };
  expect(groups().map((g) => g.key)).toEqual(["sasensi", "fernhill"]);
  click();
  expect([...store.collapsed.get()]).toEqual([["fernhill", true]]);
  click();
  expect([...store.collapsed.get()]).toEqual([["fernhill", false]]);
});

test("a head's control focused while its group has scrolled past, stuck under the next head, scrolls back to it", () => {
  // Heads stick 51 px down and are 70 px tall. sasensi's group, collapsed, is its head alone, scrolled 600 px past:
  // its head is stuck at 51 to 121, fernhill's over it.
  expect(uncoverBy({ top: -549, bottom: -479 }, 121, 51)).toBe(-600);
  // Its head stuck while its own rows pass under it: shown, nothing scrolls.
  expect(uncoverBy({ top: -549, bottom: 400 }, 121, 51)).toBe(0);
  // In its place, not stuck: nothing scrolls.
  expect(uncoverBy({ top: 300, bottom: 370 }, 370, 51)).toBe(0);
});

test("an account of one repository has the same head as the others, the account's switch on it, its row its own", () => {
  const state = world([
    repo("sasensi", "ledger-api", false),
    repo("fernhill", "api"),
    repo("fernhill", "cli"),
  ]);
  const html = screen(app(), state);
  expect(html.match(/class="repos-group group-band"/g)).toHaveLength(2);
  expect(html).toContain("1 repository, not reviewed");
  expect(html).toContain("All 2 reviewed");
  const [mine] = repositoryGroups(state);
  if (mine === undefined) throw new Error("no sasensi group");
  const sent: Command[] = [];
  const head = GroupHead({
    group: mine,
    collapsed: false,
    toggle: () => undefined,
    send: (c) => sent.push(c),
  });
  const [control] = elements(head).filter((e) => e.type === Switch);
  expect(control?.props.checked).toBe(false);
  expect(control?.props.label).toBe("Review every repository in sasensi");
  const onChange = control?.props.onChange;
  if (typeof onChange !== "function") throw new Error("the head's switch has no onChange");
  onChange(true);
  // The account's command, as every head's.
  expect(sent).toEqual([
    { type: "repos.setEnabled", repoIds: [repositoryId("sasensi/ledger-api")], enabled: true },
  ]);
  // Every head its switch, every row its own (ADR 0083, round 4).
  expect(html.match(/aria-label="Review every repository in /g)).toHaveLength(2);
  expect(html.match(/aria-label="Review sasensi\/ledger-api"/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Review fernhill/api"');
});

/**
 * Where the first element `found` is in a tree of elements, its components left unrendered: each element down to it,
 * by type and key, else by its place among its siblings, which is how React tells it is the same element on a render.
 */
function placeOf(node: ReactNode, found: (e: ReactElement) => boolean, at = "0"): string[] | null {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) {
      const place = placeOf(child, found, String(i));
      if (place !== null) return place;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  const type = typeof node.type === "string" ? node.type : node.type.name;
  const here = `${type}:${node.key ?? at}`;
  if (found(node)) return [here];
  const below = placeOf(node.props.children, found);
  return below === null ? null : [here, ...below];
}

test("a group growing from one repository to two while the page is open keeps its head's switch, a row gaining its own", () => {
  const one = world([repo("sasensi", "ledger-api", false), repo("fernhill", "api")]);
  const two = world([
    repo("sasensi", "ledger-api", false),
    repo("sasensi", "dotfiles"),
    repo("fernhill", "api"),
  ]);
  const store = app();
  // On `state`: where sasensi's group is in the page's tree, where the switch is in its head, its name, and the markup.
  const on = (state: State) => {
    let tree: ReactNode = null;
    const html = screen(store, state, () => {
      tree = RepositoriesOn({ choice: new RepositoriesChoice() });
      return tree;
    });
    const isGroup = (e: ReactElement) => e.type === RepositoryGroupRows && e.key === "sasensi";
    const group = repositoryGroups(state).find((g) => g.key === "sasensi");
    if (group === undefined) throw new Error("no sasensi group");
    const head = GroupHead({ group, collapsed: false, toggle: () => undefined, send: () => undefined });
    return {
      group: placeOf(tree, isGroup),
      inHead: placeOf(head, (e) => e.type === Switch),
      label: elements(head).find((e) => e.type === Switch)?.props.label,
      html,
    };
  };
  const before = on(one);
  const after = on(two);
  // The same group, its switch in the same place in its head: React keeps the same input, focus and all.
  expect(after.group).toEqual(before.group);
  expect(before.inHead).not.toBeNull();
  expect(after.inHead).toEqual(before.inHead);
  // The account's on the head, before and after, and each row's own.
  expect(before.label).toBe("Review every repository in sasensi");
  expect(before.html.match(/aria-label="Review sasensi\//g)).toHaveLength(1);
  expect(after.label).toBe("Review every repository in sasensi");
  expect(after.html).toContain('aria-label="Review sasensi/ledger-api"');
  expect(after.html).toContain('aria-label="Review sasensi/dotfiles"');
});

test("a group of one's two switches, the head's and the row's, both flip when its repository changes", () => {
  const before = world([repo("sasensi", "ledger-api", false), repo("fernhill", "api")]);
  const after = apply(before, {
    seq: 1,
    type: "repo.changed",
    at: before.now,
    repoId: repositoryId("sasensi/ledger-api"),
    patch: { enabled: true },
  });
  /** Whether the switch named `label` is on in `html`. */
  const on = (html: string, label: string) => {
    const input = new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0];
    if (input === undefined) throw new Error(`no switch ${label}`);
    return / checked=""/.test(input);
  };
  const store = app();
  const switches = (state: State) => {
    const html = screen(store, state);
    return [on(html, "Review every repository in sasensi"), on(html, "Review sasensi/ledger-api")];
  };
  expect(switches(before)).toEqual([false, false]);
  expect(switches(after)).toEqual([true, true]);
});

/** A head's elements, its components left unrendered, with `head` changed. */
function headOf(change: Partial<RepositoryGroup["head"]>, collapsed = true): ReturnType<typeof elements> {
  const fernhill = repositoryGroups(world())[1];
  if (fernhill === undefined) throw new Error("no fernhill group");
  return elements(
    GroupHead({
      group: { ...fernhill, head: { ...fernhill.head, ...change } },
      collapsed,
      toggle: () => undefined,
      send: () => undefined,
    }),
  );
}
const classed = (els: ReturnType<typeof elements>, name: string) =>
  els.filter((e) => typeof e.props.className === "string" && e.props.className.split(" ").includes(name));

test("a head with no cause holds none: no cause line, no fix, no second row (ADR 0086)", () => {
  const head = headOf({});
  expect(classed(head, "repos-group-cause")).toEqual([]);
  expect(classed(head, "repos-group-fix")).toEqual([]);
  expect(classed(head, "repos-group-more")).toEqual([]);
  expect(elements(head).some((e) => e.props.details !== undefined)).toBe(false);
});

/** The elements of a head's first row, the one that sticks. */
const stuckRow = (head: ReturnType<typeof elements>) => elements(head.find((e) => e.type === "tr"));

test("a head a cause holds says it once with its fix, in a second row under the head, wide as on a phone", () => {
  const head = headOf({
    state: "needs-you",
    cause: "Asks you to sign in with SSO.",
    fix: { label: "Sign in with SSO", href: "https://github.com/orgs/fernhill/sso" },
    labels: ["Sign in with SSO", "Ask an owner of fernhill"],
  });
  expect(classed(head, "repos-group-cause").map((e) => e.props.children)).toEqual([
    "Asks you to sign in with SSO.",
  ]);
  const [more] = classed(head, "repos-group-more");
  expect(classed(elements(more), "repos-group-cause")).toHaveLength(1);
  // Only what every head has sticks: its first row holds no cause and no fix, the Pull requests cell empty, so a head
  // with a cause is as tall stuck as one with none, a cause on two lines included.
  expect(classed(stuckRow(head), "repos-group-fix")).toEqual([]);
});

test("a folded head under a filter says what the filter shows in its second row; open, nothing and no room for it", () => {
  const head = headOf({ shows: "2 repositories shown" });
  expect(classed(head, "repos-group-shows").map((e) => e.props.children)).toEqual(["2 repositories shown"]);
  expect(classed(stuckRow(head), "repos-group-shows")).toEqual([]);
  // Nothing under the count: the stuck part of every head is as tall (Lookover's F5).
  const [count] = classed(head, "repos-group-count");
  // The count alone, its own words: nothing held under it.
  expect(count?.props.children).toBe("2 of 3 reviewed");
  const open = headOf({ shows: null }, false);
  expect(classed(open, "repos-group-shows")).toEqual([]);
  expect(classed(open, "repos-group-more")).toEqual([]);
});

// A group folds by its rows (ADR 0087), on a page to click in: folding, its rows leave through the presence, then go;
// opening, they come in by the fold. A search or the filter takes and brings rows still.
const dom = withDom();
const exiting = (el: Element) => dom.exiting(el);

/** `account`'s rows on the page. */
const rowsOf = (account: string) =>
  [...dom.host().querySelectorAll<HTMLElement>("tr.clickable")].filter(
    (tr) => tr.querySelector(`a[href^="/repositories/${account}/"]`) !== null,
  );

/** fernhill's rows by name: `~` leaving (inert, hidden), `+` come in by the fold (its entry plays). */
const fernhill = () => foldNames(rowsOf("fernhill"));

const chevron = (account: string) => {
  const button = dom
    .host()
    .querySelector<HTMLButtonElement>(`button[aria-label="${account}'s repositories"]`);
  if (button === null) throw new Error(`no chevron for ${account}`);
  return button;
};

/** Repositories on `choice`, in a fresh app. */
async function page(state = world(), choice = new RepositoriesChoice()) {
  await dom.render(
    <Providers store={app()} state={state}>
      <RepositoriesOn choice={choice} />
    </Providers>,
  );
  return choice;
}

test("folding a group, its rows leave, inert and hidden, then go; opening it, they come in by the fold", async () => {
  await page();
  // There when the page first showed: still.
  expect(fernhill()).toEqual(["api", "web", "cli"]);
  const exits = rowsOf("fernhill").map(exiting);

  await dom.act(() => chevron("fernhill").click());
  expect(fernhill()).toEqual(["api~", "web~", "cli~"]);
  expect(rowsOf("sasensi")).toHaveLength(2);
  for (const exit of exits) await dom.act(() => exit.finish());
  expect(fernhill()).toEqual([]);

  await dom.act(() => chevron("fernhill").click());
  expect(fernhill()).toEqual(["api+", "web+", "cli+"]);
  await dom.unmount();
});

test("a row come in by the fold plays its entry once: over, it keeps none; folded and opened again, it plays anew", async () => {
  const entry = dom.entries(".fold-row[data-unfolded]");
  await page();
  await dom.act(() => chevron("fernhill").click());
  for (const exit of rowsOf("fernhill").map(exiting)) await dom.act(() => exit.finish());
  await dom.act(() => chevron("fernhill").click());
  expect(fernhill()).toEqual(["api+", "web+", "cli+"]);
  const [api, web, cli] = rowsOf("fernhill");
  await dom.act(() => entry(api).finish());
  await dom.act(() => entry(web).cancel());
  expect(fernhill()).toEqual(["api", "web", "cli+"]);
  await dom.act(() => entry(cli).finish());
  expect(fernhill()).toEqual(["api", "web", "cli"]);

  await dom.act(() => chevron("fernhill").click());
  await dom.act(() => chevron("fernhill").click());
  expect(fernhill()).toEqual(["api+", "web+", "cli+"]);
  await dom.unmount();
});

test("a group opened again while its rows leave keeps the same rows, come in by the fold", async () => {
  await page();
  const before = rowsOf("fernhill");
  before.map(exiting);
  await dom.act(() => chevron("fernhill").click());
  await dom.act(() => chevron("fernhill").click());
  expect(rowsOf("fernhill")).toEqual(before);
  expect(fernhill()).toEqual(["api+", "web+", "cli+"]);
  await dom.unmount();
});

test("a search or the filter takes rows at once and brings them still: no row leaves, none comes in", async () => {
  const state = world();
  const choice = await page(state);
  rowsOf("fernhill").map(exiting);
  await dom.act(() => choice.search(state, "api"));
  expect(fernhill()).toEqual(["api"]);
  await dom.act(() => choice.search(state, ""));
  expect(fernhill()).toEqual(["api", "web", "cli"]);

  rowsOf("fernhill").map(exiting);
  await dom.act(() => choice.filter(state, "off"));
  expect(fernhill()).toEqual(["web"]);
  await dom.act(() => choice.filter(state, "all"));
  expect(fernhill()).toEqual(["api", "web", "cli"]);
  await dom.unmount();
});

test("the filter changing while a group's rows leave takes them at once", async () => {
  const state = world();
  const choice = await page(state);
  rowsOf("fernhill").map(exiting);
  await dom.act(() => chevron("fernhill").click());
  expect(fernhill()).toEqual(["api~", "web~", "cli~"]);
  await dom.act(() => choice.filter(state, "reviewing"));
  expect(fernhill()).toEqual([]);
  await dom.unmount();
});

test("a search opening a folded group brings its rows still, and clearing it folds the group without motion", async () => {
  const state = world();
  const choice = await page(state);
  await dom.act(() => chevron("fernhill").click());
  expect(fernhill()).toEqual([]);
  // While the search has text, a folded group shows its matches, open.
  await dom.act(() => choice.search(state, "fernhill"));
  expect(fernhill()).toEqual(["api", "web", "cli"]);
  rowsOf("fernhill").map(exiting);
  await dom.act(() => choice.search(state, ""));
  expect(fernhill()).toEqual([]);
  await dom.unmount();
});

test("a group folded on first show shows no row, and opened, its rows come in by the fold", async () => {
  await page(
    world([
      repo("sasensi", "ledger-api"),
      ...Array.from({ length: 11 }, (_, i) => repo("fernhill", `repo-${i + 1}`)),
    ]),
  );
  expect(fernhill()).toEqual([]);
  await dom.act(() => chevron("fernhill").click());
  expect(fernhill()).toHaveLength(11);
  expect(fernhill().every((row) => row.endsWith("+"))).toBe(true);
  await dom.unmount();
});
