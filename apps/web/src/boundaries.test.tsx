// A panel's error stays in its panel (ADR 0085, #671), in a real DOM: error boundaries don't run under
// renderToStaticMarkup. The owner's state after an update held a "Run all checks" result 0.3.0 wrote, its service item
// without `atLogin`; opening the status menu turned the whole window black. Here the menu says it alone failed, and the
// top bar still takes the person elsewhere.
//
// The DOM is `withDom`'s, this file's only. The app is imported once it is there.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { LookoverApi, State } from "@lookover/contracts";
import { world } from "./screens/repositories.test-support.tsx";
import { withDom } from "./ui/dom.test-support.tsx";

const dom = withDom();
let mount: (state: State) => Promise<{ root: HTMLElement; unmount: () => Promise<void> }>;
const errors: unknown[][] = [];
const consoleError = console.error;

beforeAll(async () => {
  console.error = (...args: unknown[]) => errors.push(args);
  const { MemoryRouter } = await import("react-router-dom");
  const { App } = await import("./app.tsx");
  const { Store } = await import("./store.tsx");
  mount = async (state) => {
    const api: LookoverApi = {
      snapshot: () => Promise.resolve(state),
      subscribe: () => () => undefined,
      send: () => Promise.resolve(),
      logs: () => Promise.resolve([]),
      subscribeLogs: () => () => undefined,
    };
    await dom.render(
      <MemoryRouter>
        <App store={new Store(api)} embedded={false} dev={null} mode="program" />
      </MemoryRouter>,
    );
    return { root: dom.host(), unmount: dom.unmount };
  };
});

afterAll(() => {
  console.error = consoleError;
});

/** The service's check item as 0.3.0 stored it (#671): `startsAtLogin`, no `atLogin`. Not this version's type. */
const OLD_SERVICE_ITEM = {
  check: "service",
  state: "running",
  startAtLogin: true,
  startsAtLogin: true,
  loginItem: "os",
};

/**
 * The snapshot the service sent after the update, as the app reads it: JSON, cast to `State` by being read (the
 * `JSON.parse` of `HttpApi.snapshot`), the old item in its checks.
 */
const afterTheUpdate = (): State => {
  const state = world();
  const checks = { at: state.now, running: false, items: [OLD_SERVICE_ITEM] };
  return JSON.parse(JSON.stringify({ ...state, service: { ...state.service, checks } }));
};

test("a status menu that can't read its checks says so alone, and the top bar still navigates", async () => {
  const { root, unmount } = await mount(afterTheUpdate());
  const pill = root.querySelector<HTMLElement>("[data-pill]");
  expect(pill).not.toBeNull();

  await dom.act(() => pill?.click());
  expect(root.querySelector(".pill-menu")?.textContent).toContain("The status menu couldn't be shown.");
  expect(root.querySelector(".pill-menu button")?.textContent).toBe("Reload");
  // Only the menu failed: the pill, the top bar and the page under it are all there.
  expect(root.querySelector("[data-pill]")).not.toBeNull();
  expect(root.querySelector(".route")?.children.length).toBeGreaterThan(0);
  expect(root.textContent).not.toContain("This page couldn't be shown.");

  const repositories = [...root.querySelectorAll<HTMLAnchorElement>(".navtop a")].find(
    (a) => a.textContent === "Repositories",
  );
  await dom.act(() => repositories?.click());
  expect(root.querySelector(".navtop a[aria-current='page']")?.textContent).toBe("Repositories");
  expect(root.querySelector(".route h1, .route .sentence")?.textContent ?? "").not.toBe("");

  // The error went to the console, said by the place that failed, and nothing else did: React's report of the error
  // it caught carries the error itself; no warning of React's (a key, an act, a prop) came with it.
  await unmount();
  const ours = errors.find((args) => args[0] === "The status menu couldn't be shown.");
  expect(ours?.[1]).toBeInstanceOf(TypeError);
  const caught = ours?.[1];
  const others = errors.filter((args) => args !== ours && !args.includes(caught));
  expect(others).toEqual([]);
});

// A dialog taken out of the page while open gives the focus back to nothing; closed by its own close(), the browser
// gives it back to where it was before the dialog opened. happy-dom doesn't do the second: the close itself is checked.
test("the palette closes as a dialog closes, in place, and is mounted again when it opens again", async () => {
  errors.length = 0;
  const { root, unmount } = await mount(world());

  await dom.act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })));
  const dialog = root.ownerDocument.querySelector<HTMLDialogElement>("dialog.cmdk");
  expect(dialog?.open).toBe(true);

  // Its fade, as the CSS transition would run on it (happy-dom builds none): the presence keeps it while it runs.
  dom.exiting(dialog);
  await dom.act(() => dialog?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  // The same dialog, closed by its own close() and fading: not taken out of the page while it was open.
  const after = root.ownerDocument.querySelector<HTMLDialogElement>("dialog.cmdk");
  expect(after).toBe(dialog);
  expect(after?.open).toBe(false);
  expect(after?.hasAttribute("inert")).toBe(true);

  // Opened again while it fades, it is mounted again: a palette that failed would try again, and its input has focus.
  await dom.act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })));
  const open = root.ownerDocument.querySelectorAll<HTMLDialogElement>("dialog.cmdk");
  expect(open.length).toBe(1);
  const again = open[0];
  expect(again?.open).toBe(true);
  expect(again).not.toBe(dialog);
  expect(document.activeElement).toBe(again?.querySelector("input") ?? null);
  await unmount();
  expect(errors).toEqual([]);
});

test("a palette that fades out still shows what it showed: Review a pull request… never turns into the full palette", async () => {
  errors.length = 0;
  const { root, unmount } = await mount(world());
  const review = [...root.querySelectorAll("button")].find((b) => b.textContent === "Review a pull request…");
  await dom.act(() => review?.click());
  const dialog = root.ownerDocument.querySelector<HTMLDialogElement>("dialog.cmdk");
  // This world holds no pull request to ask a review of: the palette says so, and none of the full palette's rows.
  const shown = dialog?.querySelector(".menu")?.textContent;
  expect(shown).toBe("Nothing matches “”.");
  const fade = dom.exiting(dialog);

  // Esc: the browser closes it, and its rows stay as they were while it fades, none of the full palette's added.
  await dom.act(() => dialog?.close());
  expect(dialog?.hasAttribute("data-leaving")).toBe(true);
  expect(dialog?.querySelector(".menu")?.textContent).toBe(shown);

  await dom.act(() => fade.finish());
  expect(root.ownerDocument.querySelector("dialog.cmdk")).toBeNull();
  await unmount();
  expect(errors).toEqual([]);
});
