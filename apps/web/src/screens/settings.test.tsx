// Settings opened at a place (design-system.md "label"): a section's own place (#github, #agent) lands its group at
// the top, its label under the top bar; a setting's row (#when, #login) is brought to the middle, where it is lit.
import { expect, test } from "bun:test";
import { app, screen } from "./repositories.test-support.tsx";
import { openPlace, type Place, Settings } from "./settings.tsx";

const html = screen(app(), undefined, () => <Settings />);

/** Whether the element `id` sits in a section marked to land on (`data-landing`), read from the markup's sections. */
function inLanding(id: string): boolean {
  const at = html.indexOf(` id="${id}"`);
  expect(at).toBeGreaterThan(-1);
  const open: boolean[] = [];
  for (const tag of html.slice(0, at).matchAll(/<(\/?)section\b([^>]*)>/g)) {
    if (tag[1]) open.pop();
    else open.push(/\bdata-landing\b/.test(tag[2] ?? ""));
  }
  return open.includes(true);
}

/** Opens `#id` on an element shaped as the markup places it, and says what was scrolled, and how. */
function opened(id: string): { what: string; block: ScrollLogicalPosition | undefined } {
  const scrolled: { what: string; block: ScrollLogicalPosition | undefined }[] = [];
  const scrollable = (what: string) => ({
    scrollIntoView: (o?: ScrollIntoViewOptions) => scrolled.push({ what, block: o?.block }),
  });
  const group = scrollable("group");
  const target: Place = {
    ...scrollable("row"),
    closest: (selector: string) => (selector === "[data-landing]" && inLanding(id) ? group : null),
  };
  openPlace(target);
  expect(scrolled).toHaveLength(1);
  return scrolled[0] ?? { what: "", block: undefined };
}

test("a section's own place lands its group at the top", () => {
  expect(opened("github")).toEqual({ what: "group", block: "start" });
  expect(opened("agent")).toEqual({ what: "group", block: "start" });
});

test("a setting's row is centred, where it is lit", () => {
  expect(opened("when")).toEqual({ what: "row", block: "center" });
  expect(opened("login")).toEqual({ what: "row", block: "center" });
});

test("no place, no scroll", () => {
  expect(() => openPlace(null)).not.toThrow();
});

test("the coding agent's intro is balanced as setup's leads are, by its class (round 6)", () => {
  expect(html).toContain('<p class="t-small t-help section-intro">After each push');
});
