// A disclosure starts closed, or open when asked (`defaultOpen`), read once as it appears (design-system.md,
// Disclosure; ADR 0070): Settings' "Use an existing App" while the key is refused.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Disclosure } from "./basics.tsx";

const shown = (defaultOpen = false) =>
  renderToStaticMarkup(
    <Disclosure summary="Use an existing App" defaultOpen={defaultOpen}>
      <p>Its form.</p>
    </Disclosure>,
  );

test("closed by default: its content kept out of reach", () => {
  const html = shown();
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("inert");
  expect(html).not.toContain(" open");
});

test("asked to start open: open, its content in reach", () => {
  const html = shown(true);
  expect(html).toContain('aria-expanded="true"');
  expect(html).not.toContain("inert");
  expect(html).toContain('class="disc  open"');
});
