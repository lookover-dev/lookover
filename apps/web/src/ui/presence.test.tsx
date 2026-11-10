// What leaves stays until its motion ends (ADR 0087, design-system.md "Motion"), in a real DOM: a leaving thing is in
// the page, inert and hidden, while its own animations run, and gone once they have finished or been cancelled; gone
// at once when none runs. The change itself is never delayed: focus is back when the person closes.
//
// happy-dom builds no CSS animation and ignores `getAnimations`' `subtree` option, but `el.animate()` runs, with
// `finished` and `finish()`: each test starts a long animation on the item's own element (as a CSS exit would be
// running, `dom.exiting`) and ends it by hand. The DOM is `withDom`'s, this file's only.
import { beforeAll, expect, test } from "bun:test";
import { useEffect, useState } from "react";
import { withDom } from "./dom.test-support.tsx";

type Act = typeof import("react").act;
type Ui = typeof import("./presence.tsx");
type Layers = typeof import("./layers.tsx");

const dom = withDom();
const { render, unmount, exiting } = dom;
let act: Act;
let ui: Ui;
let layers: Layers;
let host: HTMLElement;

beforeAll(async () => {
  act = (await import("react")).act;
  ui = await import("./presence.tsx");
  layers = await import("./layers.tsx");
  host = dom.host();
});

/** The element a test found, or the test fails there. */
function found<E extends Element>(el: E | null | undefined): E {
  if (!el) throw new Error("not in the page");
  return el;
}

/** Ends an animation as the browser would at its last frame, and lets the presence hear of it. */
const end = (animation: Animation, how: "finish" | "cancel" = "finish") => dom.act(() => animation[how]());

function One({ present, exits = true }: { present: boolean; exits?: boolean }) {
  return (
    <ui.Presence present={present} exits={exits}>
      {({ leaving, mark }) => (
        <div className={leaving ? "item leaving" : "item"} {...mark}>
          The menu
        </div>
      )}
    </ui.Presence>
  );
}

const item = () => host.querySelector<HTMLElement>(".item");

test("a thing set absent stays, leaving, inert and hidden, while its animation runs, and is gone after", async () => {
  await render(<One present />);
  const el = item();
  expect(el?.className).toBe("item");
  expect(el?.hasAttribute("inert")).toBe(false);
  expect(el?.hasAttribute("data-leaving")).toBe(false);
  const exit = exiting(found(el));

  await render(<One present={false} />);
  expect(item()).toBe(el);
  expect(el?.className).toBe("item leaving");
  expect(el?.hasAttribute("data-leaving")).toBe(true);
  expect(el?.hasAttribute("inert")).toBe(true);
  expect(el?.getAttribute("aria-hidden")).toBe("true");

  await end(exit);
  expect(item()).toBeNull();
  await unmount();
});

test("with no animation running, it is gone at once", async () => {
  await render(<One present />);
  await render(<One present={false} />);
  expect(item()).toBeNull();
  await unmount();
});

test("a cancelled animation counts as done", async () => {
  await render(<One present />);
  const exit = exiting(found(item()));
  await render(<One present={false} />);
  expect(item()).not.toBeNull();
  await end(exit, "cancel");
  expect(item()).toBeNull();
  await unmount();
});

test("a leave held by a paused animation goes once the page's timeline is twice the longest motion token on", async () => {
  // The token as the page's stylesheet sets it, short so the test waits little.
  document.documentElement.style.setProperty("--d-4", "10ms");
  try {
    await render(<One present />);
    const exit = exiting(found(item()));
    await render(<One present={false} />);
    exit.pause();
    expect(item()).not.toBeNull();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    expect(item()).toBeNull();
    await unmount();
  } finally {
    document.documentElement.style.removeProperty("--d-4");
  }
});

test("a thing that comes back while leaving is the same element, no longer leaving, and stays", async () => {
  await render(<One present />);
  const el = item();
  const exit = exiting(found(el));
  await render(<One present={false} />);
  await render(<One present />);
  expect(item()).toBe(el);
  expect(el?.className).toBe("item");
  expect(el?.hasAttribute("inert")).toBe(false);
  expect(el?.hasAttribute("aria-hidden")).toBe(false);
  // The exit it had started ends (the browser cancels it as the entry plays again): it stays.
  await end(exit, "cancel");
  expect(item()).toBe(el);
  await unmount();
});

test("a removal marked as not animated goes at once, even with an animation running", async () => {
  await render(<One present exits={false} />);
  exiting(found(item()));
  await render(<One present={false} exits={false} />);
  expect(item()).toBeNull();
  await unmount();
});

type Row = { id: string; why: string };
function Rows({ rows, exits }: { rows: Row[]; exits: boolean | ((row: Row) => boolean) }) {
  return (
    <ul>
      <ui.PresenceList items={rows} keyOf={(r) => r.id} exits={exits}>
        {(row, { leaving, mark }) => (
          <li className={leaving ? "leaving" : undefined} data-id={row.id} {...mark}>
            {row.id}
          </li>
        )}
      </ui.PresenceList>
    </ul>
  );
}
const ids = () =>
  [...host.querySelectorAll("li")].map((li) => `${li.dataset.id}${li.dataset.leaving === "" ? "~" : ""}`);
const li = (id: string) => found(host.querySelector<HTMLElement>(`li[data-id="${id}"]`));

test("in a list, a removed item keeps its place until it has left; one removed without motion goes at once", async () => {
  const a = { id: "a", why: "" };
  const b = { id: "b", why: "moved" };
  const c = { id: "c", why: "search" };
  const d = { id: "d", why: "" };
  const moves = (row: Row) => row.why === "moved";
  await render(<Rows rows={[a, b, c, d]} exits={moves} />);
  const exitB = exiting(li("b"));
  exiting(li("c"));

  await render(<Rows rows={[a, d]} exits={moves} />);
  expect(ids()).toEqual(["a", "b~", "d"]);

  // A new item arrives while b leaves: b stays where it was, between a and d.
  await render(<Rows rows={[a, d, { id: "e", why: "" }]} exits={moves} />);
  expect(ids()).toEqual(["a", "b~", "d", "e"]);

  await end(exitB);
  expect(ids()).toEqual(["a", "d", "e"]);
  await unmount();
});

test("an item still leaving goes at once when a later render removes without motion (a search during a fold's exit)", async () => {
  const rows = [
    { id: "a", why: "" },
    { id: "b", why: "" },
  ];
  await render(<Rows rows={rows} exits />);
  exiting(li("b"));
  await render(<Rows rows={rows.slice(0, 1)} exits />);
  expect(ids()).toEqual(["a", "b~"]);
  await render(<Rows rows={rows.slice(0, 1)} exits={false} />);
  expect(ids()).toEqual(["a"]);
  await unmount();
});

test("an item that comes back to a list while leaving is the same element", async () => {
  const rows = [
    { id: "a", why: "" },
    { id: "b", why: "" },
  ];
  await render(<Rows rows={rows} exits />);
  const b = li("b");
  const exit = exiting(b);
  await render(<Rows rows={rows.slice(0, 1)} exits />);
  expect(ids()).toEqual(["a", "b~"]);
  await render(<Rows rows={rows} exits />);
  expect(ids()).toEqual(["a", "b"]);
  expect(li("b")).toBe(b);
  await end(exit, "cancel");
  expect(ids()).toEqual(["a", "b"]);
  await unmount();
});

function Emptied({ rows, exits }: { rows: Row[]; exits: boolean }) {
  return (
    <ui.PresenceList items={rows} keyOf={(r) => r.id} exits={exits} empty={<p className="none">None</p>}>
      {(row, { leaving, mark }) => (
        <li className={leaving ? "leaving" : undefined} data-id={row.id} {...mark}>
          {row.id}
        </li>
      )}
    </ui.PresenceList>
  );
}
const none = () => host.querySelector(".none");

test("what a list says when empty shows once nothing is in it, present or leaving; at once if removed without motion", async () => {
  const rows = [{ id: "a", why: "" }];
  await render(<Emptied rows={rows} exits />);
  expect(none()).toBeNull();
  const exit = exiting(li("a"));
  await render(<Emptied rows={[]} exits />);
  expect(ids()).toEqual(["a~"]);
  expect(none()).toBeNull();
  await end(exit);
  expect(ids()).toEqual([]);
  expect(none()).not.toBeNull();

  await render(<Emptied rows={rows} exits />);
  expect(none()).toBeNull();
  exiting(li("a"));
  await render(<Emptied rows={[]} exits={false} />);
  expect(ids()).toEqual([]);
  expect(none()).not.toBeNull();
  await unmount();
});

function Arrival({ id }: { id: string }) {
  const arrived = ui.useArrived();
  return <i data-id={id} data-arrived={arrived ? "" : undefined} />;
}
const arrived = () =>
  [...host.querySelectorAll("i")].map((i) => `${i.dataset.id}${i.dataset.arrived === "" ? "+" : ""}`);

test("the first-paint gate marks only what mounted after its first commit", async () => {
  await render(
    <ui.FirstPaint>
      <Arrival id="first" />
    </ui.FirstPaint>,
  );
  expect(arrived()).toEqual(["first"]);
  await render(
    <ui.FirstPaint>
      <Arrival id="first" />
      <Arrival id="later" />
    </ui.FirstPaint>,
  );
  expect(arrived()).toEqual(["first", "later+"]);
  await unmount();
  // Outside a gate nothing is marked: a thing rendered alone never plays an entry.
  await render(<Arrival id="alone" />);
  expect(arrived()).toEqual(["alone"]);
  await unmount();
});

function Menu() {
  return (
    <layers.Layer
      scrim
      trigger={(props) => (
        <button type="button" className="trigger" {...props}>
          Status
        </button>
      )}
    >
      {() => (
        <button type="button" className="first">
          Run all checks
        </button>
      )}
    </layers.Layer>
  );
}
const panel = () => host.querySelector<HTMLElement>(".layer");
const press = (key: string) =>
  act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

test("a menu closed by Esc gives focus back at once and leaves with its scrim; reopened while leaving, it takes focus", async () => {
  await render(<Menu />);
  const trigger = found(host.querySelector<HTMLButtonElement>(".trigger"));
  await act(async () => trigger.click());
  const layer = found(panel());
  expect(document.activeElement?.className).toBe("first");
  const exit = exiting(layer);

  await press("Escape");
  // Focus is back on the trigger while the menu still fades: the motion never holds the person.
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(panel()).toBe(layer);
  expect(layer.className).toContain("leaving");
  expect(host.querySelector(".scrim")?.hasAttribute("data-leaving")).toBe(true);

  // Opened again before it has left: the same menu, no longer leaving, and focus goes in as on any opening.
  await act(async () => trigger.click());
  expect(panel()).toBe(layer);
  expect(layer.hasAttribute("data-leaving")).toBe(false);
  expect(document.activeElement?.className).toBe("first");

  await press("Escape");
  await end(exit);
  expect(panel()).toBeNull();
  expect(host.querySelector(".scrim")).toBeNull();
  await unmount();
});

const mounts: number[] = [];
function Counted() {
  const [id] = useState(() => mounts.length + 1);
  useEffect(() => {
    mounts.push(id);
  }, [id]);
  return (
    <button type="button" className="first">
      Run all checks
    </button>
  );
}

test("a menu reopened while leaving is the same panel with fresh content: what failed or held state starts again", async () => {
  mounts.length = 0;
  await render(
    <layers.Layer
      trigger={(props) => (
        <button type="button" className="trigger" {...props}>
          Status
        </button>
      )}
    >
      {() => <Counted />}
    </layers.Layer>,
  );
  const trigger = found(host.querySelector<HTMLButtonElement>(".trigger"));
  await act(async () => trigger.click());
  const layer = found(panel());
  const exit = exiting(layer);
  await press("Escape");
  await act(async () => trigger.click());
  expect(panel()).toBe(layer);
  expect(mounts).toEqual([1, 2]);
  expect(document.activeElement?.className).toBe("first");
  await press("Escape");
  await end(exit);
  await unmount();
});

function Picking() {
  const [value, setValue] = useState("claude");
  return (
    <layers.Select
      label="Reviewer"
      value={value}
      onChange={setValue}
      options={[
        { value: "claude", label: "Claude" },
        { value: "codex", label: "Codex" },
      ]}
    />
  );
}
const listbox = () => host.querySelector<HTMLElement>("[role='listbox']");
const option = (label: string) =>
  found([...host.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent === label));

test("a select's list leaves on Esc and on a pick, focus back on its button at once; reopened while leaving, focus on the pick", async () => {
  await render(<Picking />);
  const button = found(host.querySelector<HTMLButtonElement>("button[aria-haspopup='listbox']"));
  await act(async () => button.click());
  const list = found(listbox());
  expect(document.activeElement).toBe(option("Claude"));
  const exit = exiting(list);

  await act(async () => {
    option("Claude").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(document.activeElement).toBe(button);
  expect(listbox()).toBe(list);
  expect(list.hasAttribute("data-leaving")).toBe(true);

  await act(async () => button.click());
  expect(listbox()).toBe(list);
  expect(list.hasAttribute("data-leaving")).toBe(false);
  await act(async () => option("Codex").click());
  expect(document.activeElement).toBe(button);
  expect(button.textContent).toBe("Codex");
  expect(list.hasAttribute("data-leaving")).toBe(true);

  // Opened again before it has left: the same list, focus on what was just picked.
  await act(async () => button.click());
  expect(listbox()).toBe(list);
  expect(document.activeElement).toBe(option("Codex"));

  await act(async () => button.click());
  await end(exit);
  expect(listbox()).toBeNull();
  await unmount();
});

function Toasting() {
  const toast = layers.useToast();
  return (
    <button
      type="button"
      className="say"
      onClick={() => toast({ text: "Copied.", action: { label: "Undo", run: () => {} } })}
    >
      Say
    </button>
  );
}

test("a dismissed toast leaves by its own animation, with no timer of its own", async () => {
  await render(
    <layers.ToastProvider>
      <Toasting />
    </layers.ToastProvider>,
  );
  await act(async () => host.querySelector<HTMLButtonElement>(".say")?.click());
  const toast = found(host.querySelector<HTMLElement>(".toast"));
  expect(toast.textContent).toContain("Copied.");
  const exit = exiting(toast);

  await act(async () => toast.querySelector("button")?.click());
  expect(host.querySelector(".toast")).toBe(toast);
  expect(toast.className).toContain("leaving");
  expect(toast.hasAttribute("inert")).toBe(true);
  // Long after any hand-tuned timer would have run, it is still there: its animation decides.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(host.querySelector(".toast")).toBe(toast);

  await end(exit);
  expect(host.querySelector(".toast")).toBeNull();
  await unmount();
});
