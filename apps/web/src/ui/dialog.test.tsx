// A dialog closes at once and fades out (ADR 0087 "A dialog closes at once"), in a real DOM: the native close() runs
// when the person closes it, so the browser gives focus back and the page under it is live; the dialog stays in the
// page, closed, inert and marked leaving, while its fade runs, and is gone after. Gone at once when no fade runs (a
// browser that can't transition `display`, reduced motion).
//
// happy-dom builds no CSS transition: each test starts a long animation on the dialog itself, as its fade would run,
// and ends it by hand. It doesn't give focus back on close() either: the browser does, proved by the frames shots'
// acts (scripts/proof-shots.ts, `frames-palette-closing`). The DOM is `withDom`'s, this file's only; the layers are
// imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import { useState } from "react";
import { withDom } from "./dom.test-support.tsx";

type Layers = typeof import("./layers.tsx");

const dom = withDom();
const { render, unmount, act, exiting } = dom;
let layers: Layers;

beforeAll(async () => {
  layers = await import("./layers.tsx");
});

function found<E extends Element>(el: E | null | undefined): E {
  if (!el) throw new Error("not in the page");
  return el;
}

/** Ends the fade as the browser would at its last frame, and lets the presence hear of it. */
const end = (animation: Animation) => act(() => animation.finish());

/** A page with a button that opens a dialog holding an input. */
function Page() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      <layers.Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">
        <input className="field" aria-label="Search" />
      </layers.Dialog>
    </>
  );
}

const dialog = () => dom.host().querySelector<HTMLDialogElement>("dialog.dlg");
const opener = () => found(dom.host().querySelector<HTMLButtonElement>(".opener"));

test("a dialog closed by Esc is closed at once and leaves, inert, holding its content while it fades; gone after", async () => {
  await render(<Page />);
  expect(dialog()).toBeNull();
  await act(() => opener().click());
  const d = found(dialog());
  expect(d.open).toBe(true);
  expect(d.hasAttribute("inert")).toBe(false);
  const fade = exiting(d);

  // Esc: the browser closes the dialog itself, then says so by its close event.
  await act(() => d.close());
  expect(dialog()).toBe(d);
  expect(d.open).toBe(false);
  expect(d.className).toContain("leaving");
  expect(d.hasAttribute("inert")).toBe(true);
  expect(d.textContent).toContain("Keyboard shortcuts");
  expect(d.querySelector(".field")).not.toBeNull();

  await end(fade);
  expect(dialog()).toBeNull();
  await unmount();
});

test("a click outside closes it by its own close() in the same act, the dialog left in the page while it fades", async () => {
  await render(<Page />);
  await act(() => opener().click());
  const d = found(dialog());
  const fade = exiting(d);

  // A click on the backdrop is a click on the dialog itself.
  await act(() => d.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(dialog()).toBe(d);
  expect(d.open).toBe(false);
  expect(d.hasAttribute("inert")).toBe(true);
  await end(fade);
  expect(dialog()).toBeNull();
  await unmount();
});

test("with no fade running, a closed dialog is gone at once", async () => {
  await render(<Page />);
  await act(() => opener().click());
  const d = found(dialog());
  await act(() => d.close());
  expect(dialog()).toBeNull();
  // Closed before it was taken out: never removed from the page while open.
  expect(d.open).toBe(false);
  await unmount();
});

// Focus going in is the browser's showModal(), which happy-dom doesn't do: the palette's input takes it, proved in
// `boundaries.test.tsx` and by the `palette-reopened` shot.
test("reopened while it fades, it is the same dialog, open again, no longer leaving nor inert", async () => {
  await render(<Page />);
  await act(() => opener().click());
  const d = found(dialog());
  const fade = exiting(d);
  await act(() => d.close());
  expect(d.open).toBe(false);

  await act(() => opener().click());
  expect(dialog()).toBe(d);
  expect(d.open).toBe(true);
  expect(d.className).not.toContain("leaving");
  expect(d.hasAttribute("inert")).toBe(false);

  // Its old fade ending holds nothing: it is open, and stays.
  await end(fade);
  expect(dialog()).toBe(d);
  expect(d.open).toBe(true);
  await unmount();
});
