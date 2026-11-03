// A disclosure starts closed, or open when asked (`defaultOpen`), read once as it appears (design-system.md,
// Disclosure; ADR 0070).
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Disclosure } from "./basics.tsx";

const shown = (defaultOpen = false) =>
  renderToStaticMarkup(
    <Disclosure summary="Why wasn't it reviewed?" defaultOpen={defaultOpen}>
      <p>Its reason.</p>
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
