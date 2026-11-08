// Repositories' group heads (design-system.md "Repositories' group heads", "Sticky, collapsible group heads"; ADR
// 0082): the account's switch sends one command for the whole account, and the chevron collapses the group, which
// keeps its head and hides its rows, held while the app is open. The screen is rendered to markup; a control's wiring
// is read from the head's elements, there being no page to click in here.
import { expect, test } from "bun:test";
import { apply, type Command, repositoryId, type State } from "@lookover/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Switch } from "../ui/basics.tsx";
import { repositoryGroups } from "../view-model/accounts.ts";
import { RepositoriesChoice } from "../view-model/repositories.ts";
import { app, elements, repo, screen, world } from "./repositories.test-support.tsx";
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

test("a head under a filter has what the filter shows on a line of its own under the count, said folded, held open", () => {
  const fernhill = repositoryGroups(world())[1];
  if (fernhill === undefined) throw new Error("no fernhill group");
  const shows = (said: { line: string; said: boolean } | null) =>
    elements(
      GroupHead({
        group: { ...fernhill, head: { ...fernhill.head, shows: said } },
        collapsed: true,
        toggle: () => undefined,
        send: () => undefined,
      }),
    ).find((e) => e.props.className === "repos-group-shows");
  const folded = shows({ line: "2 shown", said: true });
  expect([folded?.props.children, folded?.props["aria-hidden"]]).toEqual(["2 shown", undefined]);
  // Open, the line is held, hidden, so the head is as tall as a folded one: a later head stuck covers it whole.
  const open = shows({ line: "2 shown", said: false });
  expect([open?.props.children, open?.props["aria-hidden"]]).toEqual(["2 shown", true]);
  expect(shows(null)).toBeUndefined();
});
