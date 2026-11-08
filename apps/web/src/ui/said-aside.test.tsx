// What is said to a screen reader and not seen (design-system.md "Visually hidden"): a status line that announces what
// comes.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusLine } from "./basics.tsx";

test("a status line is always there, visually hidden, so a screen reader hears what comes into it", () => {
  expect(renderToStaticMarkup(<StatusLine>Couldn't write the skill.</StatusLine>)).toBe(
    '<p class="visually-hidden" role="status">Couldn&#x27;t write the skill.</p>',
  );
  expect(renderToStaticMarkup(<StatusLine>{""}</StatusLine>)).toBe(
    '<p class="visually-hidden" role="status"></p>',
  );
});
