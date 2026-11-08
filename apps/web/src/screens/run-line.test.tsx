// A running review's line, "reading the code · 1 min 12 s" (design-system.md "Row"): when the line wraps, the dot
// and the running time go down together, never a dot left at the end of a line. The no-break space alone may not
// hold the time's box, laid out as one inline grid, so the two are kept in one span that does not wrap.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SEPARATOR } from "../view-model/format.ts";
import { RunLine } from "./common.tsx";

test("the dot before a running time never ends a line: the two sit in one span that does not wrap", () => {
  const html = renderToStaticMarkup(<RunLine parts={{ doing: "reading the code", time: "1 min 12 s" }} />);
  expect(
    html.startsWith(`reading the code<span class="nowrap">${SEPARATOR}<span class="time-running">`),
  ).toBe(true);
});
