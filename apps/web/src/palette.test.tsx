// The command palette's rows (design-system.md "Command palette"): a pull request's row is two lines, its title whole
// on the first, its repository and number whole on the second, so neither is cut; any other row is one line, its value
// on the right.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PaletteRow } from "./shell.tsx";

const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

test("a pull request's row: its title on the first line, its repository and number on the second, none cut", () => {
  const html = renderToStaticMarkup(
    <PaletteRow
      item={{ label: "Kinder words in the payment errors", meta: "sasensi/lookover-sandbox #192" }}
    />,
  );
  expect(text(html)).toBe("|Kinder words in the payment errors|sasensi/lookover-sandbox #192|");
  expect(html).toContain('<span class="cmdk-title">');
  expect(html).toContain('<span class="cmdk-meta">sasensi/lookover-sandbox #192</span>');
});

test("any other row is one line, its value on the right", () => {
  const html = renderToStaticMarkup(<PaletteRow item={{ label: "Strictness", hint: "Recommended" }} />);
  expect(html).toBe('<span class="cmdk-label">Strictness</span><span class="r">Recommended</span>');
});

test("a row's key is a key cap at the row's end, never a value in the value column", () => {
  const html = renderToStaticMarkup(<PaletteRow item={{ label: "Show keyboard shortcuts", kbd: "?" }} />);
  expect(html).toBe('<span class="cmdk-label">Show keyboard shortcuts</span><kbd class="kbd">?</kbd>');
});
