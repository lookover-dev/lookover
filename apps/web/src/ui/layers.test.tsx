// A layer that opens from its anchor (design-system.md, Menu and Elevation): closed by Esc or by a click on its scrim,
// focus goes back to its trigger; with a scrim, Tab never reaches the dimmed page, the layer closes as focus leaves.
// A menu's item that does something is drawn as an action: its icon before its words, in the icon's own place, so
// "Run all checks" under the status lines reads as a command, never as one more label (row 47, round 5).
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { focusLeaves, MenuItem, returnFocus } from "./layers.tsx";

/** An anchor holding its trigger and one item of its layer; the first button it finds is the trigger. */
function anchorOf() {
  const focused: string[] = [];
  const trigger = { focus: () => focused.push("trigger") };
  const inside = new Set(["trigger", "item"]);
  const anchor = {
    querySelector: (_selector: "button") => trigger,
    contains: (node: string) => inside.has(node),
  };
  return { anchor, focused };
}

test("closed by its scrim or Esc, the layer gives focus back to its trigger, never to the page", () => {
  const { anchor, focused } = anchorOf();
  returnFocus(anchor);
  expect(focused).toEqual(["trigger"]);
  expect(() => returnFocus(null)).not.toThrow();
});

test("with a scrim, focus moving out of the anchor closes the layer; moving within it, or nowhere, does not", () => {
  const { anchor } = anchorOf();
  // Tab past the layer's last item, into the dimmed page.
  expect(focusLeaves(anchor, "page link")).toBe(true);
  // From the trigger into the layer, or between its items.
  expect(focusLeaves(anchor, "item")).toBe(false);
  // A click on the layer's words, or another window: focus goes nowhere in the page, the layer stays.
  expect(focusLeaves(anchor, null)).toBe(false);
});

test("an item with an icon draws it first, in a place of its own, then its words", () => {
  const html = renderToStaticMarkup(
    <MenuItem icon="copy" onSelect={() => {}}>
      Copy diagnostics
    </MenuItem>,
  );
  expect(html).toMatch(/^<button type="button" class="act"><span class="act-ic"><svg class="ic "/);
  expect(html.replace(/<[^>]+>/g, "")).toBe("Copy diagnostics");
});

test("an item at work shows the loader in its icon's place, so its words never move", () => {
  const html = renderToStaticMarkup(
    <MenuItem icon="again" busy onSelect={() => {}}>
      Run all checks
    </MenuItem>,
  );
  expect(html).toContain('<span class="act-ic"><span class="eyes ');
  expect(html).not.toContain('class="ic ');
});

test("an item without an icon stays a plain item", () => {
  const html = renderToStaticMarkup(<MenuItem onSelect={() => {}}>Strictness</MenuItem>);
  expect(html).toBe('<button type="button">Strictness</button>');
});
