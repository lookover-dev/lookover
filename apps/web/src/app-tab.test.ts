import { expect, test } from "bun:test";
import { type OpenTab, tabWhenTaken } from "./app-tab.ts";

const PAGE = "http://127.0.0.1:4321/app-flow/manifest";

/** A browser's `window.open`, recorded: the tab it gives, or none when the browser blocks it. */
function browser(blocks = false) {
  const opened: [string, string, string | undefined][] = [];
  const tab: { opener: unknown; location: { href: string }; closed: boolean; close(): void } = {
    opener: "this page",
    location: { href: "about:blank" },
    closed: false,
    close: () => {
      tab.closed = true;
    },
  };
  const open: OpenTab = (url, target, features) => {
    opened.push([url, target, features]);
    return blocks ? null : tab;
  };
  return { open, opened, tab };
}

test("the tab opens at once, blank and cut from this page, while the click may still open one", () => {
  const { open, opened, tab } = browser();
  tabWhenTaken(open, PAGE);
  expect(opened).toEqual([["", "_blank", undefined]]);
  expect(tab.opener).toBeNull();
  expect(tab.location.href).toBe("about:blank");
});

test("the service took the place: the tab goes to the page", () => {
  const { open, opened, tab } = browser();
  tabWhenTaken(open, PAGE).sent();
  expect(tab.location.href).toBe(PAGE);
  expect(tab.closed).toBe(false);
  expect(opened).toHaveLength(1);
});

test("the service refused: the tab closes, and the step says why", () => {
  const { open, tab } = browser();
  tabWhenTaken(open, PAGE).refused();
  expect(tab.closed).toBe(true);
  expect(tab.location.href).toBe("about:blank");
});

test("a browser that blocked the blank tab: the page opens once taken, and nothing when refused", () => {
  const taken = browser(true);
  tabWhenTaken(taken.open, PAGE).sent();
  expect(taken.opened).toEqual([
    ["", "_blank", undefined],
    [PAGE, "_blank", "noopener"],
  ]);
  const refused = browser(true);
  tabWhenTaken(refused.open, PAGE).refused();
  expect(refused.opened).toHaveLength(1);
});
