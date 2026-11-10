// A panel's error stays in its panel (ADR 0085, design-system.md "Failed panel"): where it threw, one line says what
// couldn't be shown and one button reloads; the status pill's keeps the pill's box, so the top bar never moves.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Failed } from "./boundary.tsx";

const RELOAD = '<button type="button" class="btn btn-secondary btn-sm ">Reload</button>';

test("a failed panel is one line saying what couldn't be shown, then Reload", () => {
  const html = renderToStaticMarkup(<Failed what="page" />);
  expect(html).toBe(
    `<div class="failed" role="alert"><span>This page couldn&#x27;t be shown.</span>${RELOAD}</div>`,
  );
});

test("in place of the whole window, it is the same line and Reload, in the middle of the window", () => {
  const html = renderToStaticMarkup(<Failed what="app" look="whole" />);
  expect(html).toBe(
    `<div class="failed whole" role="alert"><span>Lookover couldn&#x27;t be shown.</span>${RELOAD}</div>`,
  );
});

test("a failed status pill is the pill's own box in the pill's anchor, its dot pink, its click a reload", () => {
  const html = renderToStaticMarkup(<Failed what="status" look="pill" />);
  expect(html).toBe(
    '<div class="anchor"><button type="button" class="pill" aria-label="The status couldn&#x27;t be shown. Reload">' +
      '<i class="need"></i>Status failed · Reload</button></div>',
  );
});
